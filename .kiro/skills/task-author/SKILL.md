---
name: task-author
description: Analyze a design document and create BDD-style implementation tasks. Use when breaking down a design doc into ordered task files in a tasks/ subdirectory.
---

## Purpose

Read a design document and produce a set of numbered task files
in a subdirectory under `tasks/` (named after the design) following
the project's BDD-driven task conventions.

## Process

### 1. Read conventions

- Read `tasks/README.md` to understand the task format, naming,
  and BDD workflow.
- Read completed tasks from any `tasks/*/completed/` directories
  to calibrate the level of detail, structure, and tone.

### 2. Analyze the design document

Read the design document specified by the user. Identify:

- **Discrete behaviors** — each user-facing behavior or validation
  rule that can be expressed as a given/when/then test scenario.
- **Dependencies** — which behaviors depend on which data model
  changes, service methods, or prior behaviors being in place.
- **Implementation order** — a topological sort of tasks that
  respects dependencies while keeping each task small enough for
  a single agent iteration.

### 3. Create task subdirectory

Derive a short kebab-case name from the design document (e.g.,
`docs/design/some-feature.md` → `tasks/some-feature/`).
Create the subdirectory.

### 4. Create Task 01: End-to-End Tests

Write `tasks/<design-name>/01-e2e-tests.md` containing:

- **Agent** — the name of the implementation agent that should
  handle this task (e.g., `implementer`).
- A reference to the design document being implemented (e.g.,
  `Design: docs/design/feature-name.md`).
- An objective stating the feature under test.
- The test file path to create.
- Every test case derived from the design's CX specification and
  validation rules, in given/when/then style.
- Notes on test isolation, shared setup, and which tests use CLI
  vs API directly.
- Acceptance criteria: all tests compile, all tests fail with
  clear messages.
- Conflict criteria: conditions under which the
  agent should escalate instead of proceeding.
  For Task 01, the primary criterion is: if any
  test that should fail instead passes, the agent
  must first diagnose why (following the
  implementer prompt's "Unexpected test results"
  guidance) and attempt to rewrite the test to
  target the intended code path. Escalation is
  the last resort, not the first response.

### 5. Create subsequent tasks (02+)

For each remaining unit of work, create
`tasks/<design-name>/NN-short-name.md` containing:

- **Agent** — the name of the implementation agent that should
  handle this task (e.g., `implementer`). Choose the agent whose
  skills best match the task's domain. If unsure, use `implementer`.
- **Design** — reference to the design document (e.g.,
  `docs/design/feature-name.md`).
- **Objective** — one sentence.
- **Target Tests** — which tests from Task 01 this task makes pass.
- **Implementation** — where and how to make the change, with
  enough detail that the implementing agent can work from the
  task alone. Reference actual types and file paths from the
  codebase when possible.
- **Test Requirements** — any unit tests to add beyond the E2E
  tests.
- **Acceptance Criteria** — target tests pass, existing tests
  still pass, no warnings.
- **Conflict Criteria** — conditions specific to
  this task that should trigger escalation (e.g.,
  "if all target tests pass before any changes,
  investigate whether the tests are false
  positives").

### 6. Document dependencies

If any task depends on another beyond simple numeric ordering,
note the dependency explicitly in the task file (e.g.,
"Depends on: Task 03").

## Guidelines

- Keep tasks small — one concept per task.
- Task filenames: `NN-short-description.md`, zero-padded.
- Every validation rule and error message in the design should
  map to at least one test in Task 01 and one subsequent task.
- Read relevant source code to reference real types and paths.
- Do not create tasks for work already completed.
- When a task depends on assumptions about codebase
  behavior (e.g., "the generator produces clean
  values"), note the assumption explicitly in the
  task file so the implementer can verify it and
  escalate if it does not hold.
- When a refactoring task involves handlers or functions with
  significantly different complexity levels, either split them
  into separate tasks (simple handlers in one, complex handlers
  in another) or explicitly describe the extraction strategy for
  the complex cases — including return type decisions and how to
  handle branches that don't fit the simple pattern. Do not
  describe a uniform approach when some cases are non-trivial.
- Include a **Conflict Criteria** section in every
  task file listing conditions under which the
  implementing agent should escalate rather than
  proceed. At minimum:
  - For Task 01: "If any test that is expected to
    fail instead passes, first diagnose why by
    following the 'Unexpected test results' steps
    in the implementer prompt: investigate the
    code path, verify the assertion targets the
    right behavior, and attempt to rewrite the
    test to isolate the intended path. Only
    escalate if you cannot construct a well-formed
    test that targets the desired behavior."
  - For subsequent tasks: "If all target tests
    already pass before any code changes are made,
    investigate whether the tests are true
    positives before marking the task complete."
  - Task-specific criteria based on the design's
    assumptions (e.g., "If the generator already
    produces correct PKs for this path, escalate —
    the design assumes it does not").
