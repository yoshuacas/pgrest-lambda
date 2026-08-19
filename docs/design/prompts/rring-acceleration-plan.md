# rring Acceleration Plan — Deep Evaluation & Feature Proposals

## Part 1: Current State Evaluation

### Architecture at a Glance
- **14 crates**, ~10,310 LOC Rust + 6,714 LOC integration tests (494 `#[test]` total)
- Nightly Rust (`#![feature(let_chains)]`)
- Linear pipeline: `start` → `design` → `task` → `work` → `review` → `iter`

### V-13 Real-World Performance Profile (pgrest-lambda)

| Phase | Duration | Agent Calls |
|-------|----------|-------------|
| Design generation | ~3m 25s | 1 |
| Task decomposition | ~3m 25s | 1 |
| **Cycle 1 work** (4 tasks) | ~20m 6s | 4 |
| Code review | ~3m 52s | 1 |
| Task decomposition (cycle 2) | ~3m 8s | 1 |
| **Cycle 2 work** (5 fix tasks) | ~6m 3s | 5 |
| **TOTAL** | **~37 min** | **13 agent calls** |

**Average task time:** 5m (cycle 1 impl), 1m 13s (cycle 2 fixes)
**Slowest single task:** 11m 7s (config & handler wiring — large scope)
**Zero failures/conflicts** — clean run

### Where Time Goes

```
Agent execution:     ~90% of wall time (13 calls × ~2.8 min avg)
Git operations:      ~5% (5-11 subprocess spawns per work iteration)
File I/O:            ~3% (directory scanning, file reads)
Validation:          ~2% (redundant fs scans, git status checks)
```

**The agent is the bottleneck.** Everything else is noise. But the *number of agent calls* and the *quality of what gets passed to them* directly affects total time.

---

## Part 2: Bottleneck Analysis

### 🔴 Critical — Agent Call Volume

**Problem:** 13 agent calls for a single feature. Each call has:
- Cold start overhead (process spawn + model loading)
- Redundant context gathering (each agent re-reads AGENTS.md, skills, steering files)
- No memory between tasks (task 03 doesn't know what task 02 did beyond git state)

**Breakdown of the 13 calls:**
1. Designer (1) — could be skipped for small features
2. Tasker (1) — structural overhead
3. Implementer ×4 — the actual work
4. Reviewer (1) — essential quality gate
5. Tasker again (1) — generates fix tasks from review
6. Bug-fixer ×5 — fix tasks from review

**The review cycle added 6 calls but caught a real security bug (NaN bypass).** The cycle is valuable — the question is whether it can be faster.

### 🟡 Medium — Redundant FS Operations in Work Loop

Each iteration of the work loop scans `tasks/` **3-4 times**:
1. `count_remaining_tasks_scoped()` — dir scan
2. `find_conflict_files()` — dir scan
3. `pick_next_task()` — dir scan + read each file + read completed/
4. `find_conflict_files()` post-agent — dir scan again

Plus 5-11 git subprocess spawns per iteration.

**Impact:** Minor (~5% of time) but indicates design debt. A single "task state snapshot" could serve all four needs.

### 🟡 Medium — Sequential Task Execution

Tasks with no dependencies between them execute one-at-a-time. In V-13:
- Tasks 01-04 were sequential (01 = tests, 02 depends on 01, etc.)
- Tasks 05-09 (fixes) were independent — could have run in parallel

**Potential time saving:** Cycle 2 went from 6min → could be ~1.5min with 4-way parallelism.

### 🟢 Low — Hardcoded Configuration

- Default model: `us.anthropic.claude-opus-4-6-v1` (hardcoded)
- Maintainer threshold: 5 commits (hardcoded)
- Fix attempts: exactly 1 (hardcoded, not configurable)
- Max iterations: 10 (configurable via `-n`)
- No token budget management for review (full git diff loaded into memory)

---

## Part 3: Feature Proposals — Acceleration Roadmap

### Tier 1: High Impact / Moderate Effort

#### F-01: Parallel Task Execution
**Problem:** Independent tasks run sequentially. Fix tasks are almost always independent.
**Proposal:** Analyze dependency graph at work start. Tasks with satisfied (or no) deps run in parallel up to a configurable concurrency limit.
**Expected impact:** 2-4x speedup on fix cycles, 1.5-2x on impl cycles with independent tasks.
**Complexity:** Medium — needs per-task git branches or working directory isolation.
**Risk:** Git conflicts between parallel tasks. Mitigation: merge-commit after each parallel batch, or use worktrees.

#### F-02: Smart Task Scoping (Reduce Agent Calls)
**Problem:** The tasker often creates fine-grained tasks that could be batched. 5 single-file fix tasks could be 1-2 compound tasks.
**Proposal:** Add a task complexity estimator. If a task is <N lines of change and has no deps, batch it with adjacent similar tasks. Configurable granularity: `fine` (current), `medium` (2-3 tasks merged), `coarse` (single mega-task).
**Expected impact:** Reduce agent calls by 30-50% on fix cycles.
**Complexity:** Medium — needs prompt changes + batching logic.

#### F-03: Incremental Review (Diff-Only)
**Problem:** Review reads the entire git diff from merge-base. On iteration cycles, the reviewer re-reads code it already reviewed.
**Proposal:** Track reviewed commit SHAs. On re-review, pass only the diff since last review, plus a summary of previous findings.
**Expected impact:** Faster review agent responses (smaller context = faster inference).
**Complexity:** Low — store last-reviewed SHA, diff against it.

#### F-04: Task State Cache
**Problem:** 3-4 redundant directory scans per work iteration.
**Proposal:** Build a `TaskState` struct at loop start, update it in-memory as tasks complete. Single source of truth for remaining/completed/blocked/conflict status.
**Expected impact:** Eliminates redundant I/O. More importantly, enables parallel execution (F-01) and smarter decisions.
**Complexity:** Low — refactor existing code, no new features.

### Tier 2: High Impact / High Effort

#### F-05: Agent Session Persistence (Warm Context)
**Problem:** Each agent call is a cold start. The implementer for task 03 doesn't know what task 02 changed without reading git state.
**Proposal:** Use Claude Code's conversation mode (not `--print`) with a persistent session across tasks in the same work cycle. Pass task instructions as follow-up messages.
**Expected impact:** Faster responses (warm context), better cross-task awareness, fewer redundant file reads.
**Complexity:** High — needs protocol change from print-mode to interactive mode, output parsing changes.
**Risk:** Session accumulation may degrade quality. Mitigation: configurable session reset interval.

#### F-06: Model Routing (Right-Size Agent Calls)
**Problem:** Every agent call uses the same model (opus). Fix tasks like "update a docs file" don't need opus-level intelligence.
**Proposal:** Configurable model per agent role. Default: opus for designer/reviewer, sonnet for implementer/tasker/bug-fixer. Override per-task based on estimated complexity.
**Expected impact:** 2-5x faster inference on simple tasks, significant cost reduction.
**Complexity:** Medium — model field already exists in agent run, just needs per-role config.

#### F-07: Speculative Execution
**Problem:** Design → Task → Work is strictly sequential. The tasker can't start until design is fully written.
**Proposal:** Stream design output. As soon as the first section is complete, start decomposing it into tasks speculatively. If the design changes later sections, re-task only affected parts.
**Expected impact:** Overlaps design + task phases (~3-6 min saved per feature).
**Complexity:** High — needs streaming design parser + incremental task generation.

### Tier 3: Quality Multipliers

#### F-08: Structured Logging & Metrics
**Problem:** No runtime logs. All timing inferred from git commits. No visibility into agent token usage, error rates, or retry patterns.
**Proposal:** Emit structured JSON logs to `~/.rring/logs/` with: timestamps, agent call duration, token counts (from Claude stream-json), validation results, git operation timing.
**Expected impact:** Enables data-driven optimization. Identify which task types are slow, which fail, where retries happen.
**Complexity:** Low — agent-run already captures stream output, just needs metric extraction.

#### F-09: Pre-flight Validation
**Problem:** Work loop discovers issues mid-run (no upstream branch, Unicode in task files, tasks in wrong directory).
**Proposal:** `rring preflight` command that validates everything before the first agent call: branch tracking, task file encoding, task directory location, agent availability, model access.
**Expected impact:** Eliminates wasted agent calls on environment issues.
**Complexity:** Low — consolidate existing checks into a pre-run phase.

#### F-10: Review-Aware Task Generation
**Problem:** After review, the tasker generates new tasks that sometimes overlap with or duplicate existing completed work.
**Proposal:** Pass the full list of completed task summaries + their git diffs to the tasker during cycle 2+. This gives it awareness of what was already done, preventing duplicate work.
**Expected impact:** Higher quality fix tasks, fewer unnecessary agent calls.
**Complexity:** Low — just enrich the tasker prompt with completed task context.

#### F-11: Configurable Fix Budget
**Problem:** Exactly 1 fix attempt per task, hardcoded. Some tasks need 2 attempts, others need 0.
**Proposal:** Configurable `max_fix_attempts` (default 2). After each fix, re-validate. If still failing after budget exhausted, escalate to conflict.
**Expected impact:** Fewer hard failures, more tasks completed without manual intervention.
**Complexity:** Low — small loop change in work().

---

## Part 4: Prioritized Implementation Plan

### Phase 1: Quick Wins (1-2 days each)
1. **F-04: Task State Cache** — foundation for everything else
2. **F-08: Structured Logging** — data before optimization
3. **F-09: Pre-flight Validation** — eliminate wasted runs
4. **F-11: Configurable Fix Budget** — resilience

### Phase 2: Core Acceleration (3-5 days each)
5. **F-06: Model Routing** — right-size every call
6. **F-03: Incremental Review** — faster review cycles
7. **F-10: Review-Aware Tasks** — smarter iteration
8. **F-02: Smart Task Scoping** — fewer calls per feature

### Phase 3: Architectural (1-2 weeks each)
9. **F-01: Parallel Task Execution** — the big speedup
10. **F-05: Agent Session Persistence** — warm context
11. **F-07: Speculative Execution** — overlap phases

### Projected Impact (all phases)

| Metric | Current (V-13) | After Phase 1 | After Phase 2 | After Phase 3 |
|--------|----------------|---------------|----------------|----------------|
| Total time | ~37 min | ~35 min | ~22 min | ~12-15 min |
| Agent calls | 13 | 13 | 8-10 | 6-8 |
| Fix cycle time | 9 min | 8 min | 5 min | 2-3 min |
| Failure recovery | manual | auto-retry | auto-retry | auto-retry |
| Observability | git timestamps | structured logs | + metrics | + dashboards |

---

## Part 5: Known Issues to Fix First

1. **Broken test in rring-agent-run** — `build_claude_args_always_skip_permissions` passes wrong number of args (missing `project_dir`). Compile error.
2. **tasks/ vs docs/tasks/ mismatch** — tasker creates under docs/tasks/, work expects tasks/. Should auto-symlink or configure.
3. **Unicode byte-boundary panic** — `rring-project` string slicing crashes on multi-byte UTF-8. Needs proper char boundary handling.
4. **54 failing integration tests** (environment-dependent) — test infrastructure needs work.
5. **rring-core is empty** — placeholder crate with 1 LOC. Either use it or remove it.
