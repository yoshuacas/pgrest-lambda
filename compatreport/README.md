# compatreport

`index.html` is the PostgREST compatibility report for pgrest-lambda: how much of
the upstream PostgREST test suite the engine passes when run against a live
Aurora DSQL cluster. It is generated — do not edit it by hand.

The file is self-contained. Open it directly from disk (`file://`); it fetches
nothing, loads no chart library, and carries its own dataset inlined as JSON in
a `<script type="application/json" id="report-data">` tag at the end of the
document.

## Regenerate

```bash
node conformance/report/build-report.mjs \
  --label "<what this run is>" \
  --tree "<short sha of the tree measured>" \
  --flags "--target dsql --concurrency 1 --reload-per-spec"
```

Reads:

- `conformance/results/latest.json` — run results (CONTRACTS.md §3): totals,
  per-category counts, one record per case with `status` and `gap`.
- `conformance/fixtures/load-report.json` — fixture load report
  (CONTRACTS.md §2): every construct dropped because DSQL cannot create it,
  with a reason and the test categories it affects.
- `conformance/results/history.json` — the trend (see below). Read for the
  baseline, then written back with this run added.
- `conformance/cedar/results/latest.json` — the Cedar equivalence run, if it
  exists (`--cedar` points elsewhere). Rendered as its own section and never
  added to the pass rate; the generator re-checks from the results file that
  every upstream case behind it is still failing, and says so.

Writes `compatreport/index.html` and prints the headline numbers, so a
regeneration is verifiable from the terminal:

```
history conformance/results/history.json: 18 run(s), baseline baseline 135/1153
wrote /home/ec2-user/pgrest-lambda/compatreport/index.html (208,010 bytes)
pass rate 1074/1358 = 79.1%  [extracted 1539, needs-config 2, skipped 35, blocked 129, out-of-scope 15]
48 gap slugs, 27 DSQL drop families
13 order-dependent failures kept as failures
cedar equivalence (separate measurement, never added): 24/28 hold, 26 with no fair equivalent, 54 upstream cases covered and still all failing above
same tree, 4 runs with these flags: 1068, 1068, 1074, 1080 of 1358 — published 1074
vs baseline baseline: +939 passed, −734 failed, denominator +205
id-matched vs baseline: +946 pass, -7 regress (1539 shared ids)
id-matched vs 68b09a4 2026-08-21T11:54:33Z (same flags): +8 pass, -1 regress
noise vs 2488109 (same tree, same flags): 10 cases differ
```

That 1,074 of 1,358 is the current published measurement, on tree `2488109`;
the previous published measurement was 1,069 of the same 1,358 on commit
`5586e94`. Four runs of the `2488109` tree exist and they span 1,068 to 1,080 —
the rule the published number follows is worth stating: when several runs of one
tree disagree, publish one that was not measured by the pass that wrote the code,
and prefer the middle of the range to the top of it. Here that rules out the
1,080 (highest) and leaves 1,074, the midpoint. Every run stays in the trend file
with its own row, so the spread is visible instead of being read as progress, and
the generator prints it: the `same tree` line above is computed from the trend,
not written by hand.

The 12-case spread is wider than the 1,069 → 1,074 difference between the two
publications, which is the whole point of printing it. All 11 cases that changed
verdict between them are `row-order-unspecified`, checked case by case, so the
right reading of this wave is that the rate did not move.

`--tree` is what makes that line possible. A results file records the commit the
runner saw, which is not always the commit that ends up containing the code: a
run measured on a working tree before the integration commit exists reports the
previous commit. Passing `--tree` records which tree was measured, so the
generator can tell a repeat measurement of the same code (noise) from a
measurement of different code (progress). Without it, a 12-case difference
between two runs of one tree is presented as engine work.

The `vs baseline` line is a totals difference across different runner flags, so
it is not the claim the report leads with. The `id-matched` lines are: they match
case ids between two result files and count movements in each direction
separately, never netted. Against the baseline, 946 cases went from non-pass to
pass and 7 went the other way. Against the comparable `eeb1ac9` run, 134 went to
pass and 5 went the other way: `JsonOperatorSpec:248`, `QuerySpec:571`,
`QuerySpec:1265` and `EmbedDisambiguationSpec:278`, all order-only, plus
`QuerySpec:521`, a false pass the engine stopped producing
(it used to reject any unknown filter column, which happened to match upstream's
400 for a case where returning rows is the correct answer on this database). None
of the five is an engine regression, and that was checked rather than assumed:
the four order-only cases move in both directions between runs of one tree, and
`QuerySpec:521` was read against upstream's own assertion. The same check on an
earlier wave found `UpsertSpec:417`, which passes when `UpsertSpec` is re-run with
`--reset-touched` — a mutation earlier in the same spec file changing the row a
later read asserts on, not an engine defect.

Options:

```bash
node conformance/report/build-report.mjs \
  --results conformance/results/run-2026-08-19T15-51-47-373Z.json \
  --load-report conformance/fixtures/load-report.json \
  --history conformance/results/history.json \
  --label baseline --flags "" --note "why this run exists" \
  --tree 5586e94 \        # which tree was measured, when it is not `commit`
  --cedar conformance/cedar/results/latest.json \
  --history-only \        # update the trend, write no HTML
  --no-history \          # report with no baseline column at all
  --out /tmp/compat.html
```

## The trend file

`conformance/results/history.json` holds one entry per measured run, oldest
first:

```json
{
  "description": "One entry per measured conformance run, oldest first. ...",
  "runs": [
    {
      "label": "baseline",
      "generatedAt": "2026-08-19T10:44:42Z",
      "commit": "3fbf941",
      "target": "dsql",
      "results": "conformance/results/run-2026-08-19T10-44-42-130Z.json",
      "flags": null,
      "note": "Pre-improvement baseline ...",
      "totals": { "total": 1539, "passed": 135, "failed": 1018, "skipped": 257,
                  "needsConfig": 0, "blocked": 122, "outOfScope": 7, "errored": 0 },
      "byCategory": { "select": { "total": 72, "passed": 16, "failed": 44, "...": 0 } }
    }
  ]
}
```

Rules that keep the trend usable:

- `runs[0]` is the baseline the report compares against. Never delete an entry
  to make a delta look better; add the new run and let the table show both.
- An entry is keyed by `label` + `generatedAt`, so rebuilding the report from
  the same results file replaces that entry instead of appending a duplicate.
  Give every run a distinct `--label`. Labelling a run with a timestamp
  (`5586e94 2026-08-21T11:09:15Z`) is the cheapest way to guarantee that, and it
  keeps several runs of one tree distinguishable in the table.
- `tree` records which working tree the run measured, when that differs from
  `commit`. Runs sharing a `tree` and a `flags` string are repeat measurements of
  the same code: the report groups them as a spread instead of reporting the
  difference between them as progress.
- Only counts are stored, never case bodies — the file stays small enough to
  read in a diff.
- `flags` records the runner flags and any engine environment the run was
  measured with. Two runs measured with different flags are not comparable and
  the report says so in place of the comparison caveat.
- Entries from before a status existed keep 0 for it (the baseline predates
  `needs-config`), which is why the report quotes counts alongside rates.
- Point `results` at the immutable timestamped run file, never at
  `conformance/results/latest.json`. `latest.json` is overwritten by the next
  run, and the report reads these files back to compute id-matched deltas. It
  warns on stderr and skips the delta when a file's `generatedAt` disagrees with
  the entry that names it.
- `flags` records the runner flags, not the runner's base engine configuration.
  Two entries in that base configuration change the score, and both make the
  engine match how upstream runs its own suite rather than how a deployment runs:
  - `bulkMutationGuard: 'off'`, because the engine's default `on` refuses a
    filterless `PATCH`/`DELETE` and upstream has no such guard unless
    `pg_safeupdate` is loaded. Worth about a dozen cases: 10 filterless
    `PATCH`/`DELETE` assertions in `UpdateSpec` and `UnicodeSpec` pass with it
    off and would answer `PGRST106` with it on.
  - `dbTxEnd: 'rollback-allow-override'`, which is what upstream's
    `SpecHelper.hs` sets (`configDbTxRollbackAll` + `configDbTxAllowOverride`):
    every mutating request is undone unless it sends `Prefer: tx=commit`, so a
    mutating case stops changing the fixtures the cases after it read. The
    engine's own default is `commit`. Worth 41 cases when it was turned on —
    itemised in the audit section of the report — none of them a query feature.

  Read `conformance/runner/run.mjs` for the rest of that config, and for the 29
  spec ranges across 25 spec files that the runner measures under upstream's own
  non-default settings (`ENGINE_CONFIGS`).

## Full refresh (new measurement, then report)

The report only reformats what the runner measured. To move the numbers you must
re-run the suite:

```bash
# fixtures must be loaded first; load-report.json is written by that step
PGREST_RELATIONSHIPS_PATH=$PWD/conformance/fixtures/relationships.json \
  node conformance/runner/run.mjs --target dsql --concurrency 1 --reload-per-spec
node conformance/report/build-report.mjs \
  --results conformance/results/run-<timestamp>.json \
  --label "$(git rev-parse --short HEAD) <timestamp>" \
  --tree "$(git rev-parse --short HEAD)" \
  --flags "--target dsql --concurrency 1 --reload-per-spec, PGREST_RELATIONSHIPS_PATH set" \
  --note "what this wave changed, and anything about the run the flags do not say"
```

The compatibility page in `docs/reference/` also carries a table grouped by
request feature rather than by upstream spec file — whether you can rely on
`order=`, `columns=` or `fts` as a client, which is not answerable from the
per-category table. Regenerate it with:

```bash
node conformance/report/feature-table.mjs \
  --results conformance/results/latest.json --markdown
```

Each row is one predicate over the extracted case, listed beside the row in
`conformance/report/feature-table.mjs`, so a reader can check the rule as well as
the number. A predicate that matches nothing prints `0 / 0` rather than being
dropped: a feature with no measurement and a feature with no passes are different
findings. Two rows read `0 / 0` in the published run — `Prefer: tx=rollback`,
which no extracted case sends, and `Server-Timing`, which the engine sends and no
extracted case asserts. When a wave makes a feature work that has no probe, add
the probe and a test in
`conformance/__tests__/report-feature-table.test.mjs` that asserts the predicate
matches something, so a row cannot decay into a silent `0 / 0`. Add a probe there rather than editing the table by hand — a
hand-maintained row drifts, and the first version of this table reported
`Prefer: tx=rollback` at 14 of 15 when no extracted case sends that header at all
(the number belonged to `tx=commit`).

`PGREST_RELATIONSHIPS_PATH` matters more than any other setting here. DSQL
cannot store foreign keys, so `pg_constraint` reports none and the engine has
nothing to resolve embedding with unless it is handed the declared-relationship
manifest the fixture transform reconstructs. Measured on the same commit and the
same first 60 embedding cases: 3 of 58 passed without the variable, 22 of 58
with it. A run that leaves it unset is measuring an unconfigured engine.

`PGREST_REPRESENTATIONS_PATH` is the same kind of substitute for a second
thing DSQL cannot store. PostgREST reads data representations from `pg_cast` —
an implicit, function-backed cast between a domain and `json`/`text` — and DSQL
rejects `CREATE CAST`, so all 15 casts upstream's `schema.sql` defines are
dropped at load time while every cast function loads. `conformance/fixtures/`
`representations.json` declares those 15 pairs, and the runner points the
variable at it by default for `--target dsql` (an explicit value still wins).
Without it every representation path in the engine is a no-op and the
`datarep_*` cases are scored against the untransformed column value.

`--reload-per-spec` reloads the fixtures once per spec file, and it is what the
committed numbers are measured with. Without it, the cases that mutate data leave
rows behind for every spec that runs after them, and the reading specs are scored
against a database no upstream example ever sees. Measured on the same commit
with everything else held constant: **443/1199 without the flag, 550/1199 with
it** — a 107-case difference that is entirely reading specs finding rows an
earlier spec inserted. It costs about 7 s per spec file (~2 min on the full
suite) and needs `--concurrency 1`.

This is weaker than upstream, and the gap matters when reading the score.
Upstream sets `configDbTxRollbackAll = True` (`test/spec/SpecHelper.hs`), which
rolls back **every request**, so no upstream example ever sees another example's
writes. We cannot do that: Aurora DSQL has no `SAVEPOINT` and the engine holds no
open transaction across a request. Per-spec reload is the closest cheap
approximation, so mutation cases can still pollute *later cases in the same spec
file*. That is a real residual measurement error, and it is why a handful of
cases show as regressions against the baseline: a mutation earlier in the file
now succeeds where it used to fail, and a later read in the same file sees the
changed row (`UpsertSpec:417` is the worked example in the report).

Two flags exist for the faithful analogue and **neither is on in the published
run**: `--reset-touched` restores only the tables a mutating case touched, and
`--reset-mutations` restores after every mutating case. Both default to off, both
need `--concurrency 1`, and at seconds per case they are too slow for a
full-suite run. A three-spec control run with the targeted reset moved 11 cases
fail→pass and 4 pass→fail, so the bias does not resolve in one direction; that
control is not in the trend, because it is not a full-suite measurement. Treat
the published number as carrying a residual error from per-spec isolation, sign
unknown, of that order.

The DSQL connection needs a fresh IAM token (valid 1 h) — see
`conformance/CONTRACTS.md` for the exact environment.

## Tables the fixtures never populate

Every reset the runner has is a re-application of `07-data.sql`, and that file is
`DELETE`-then-`INSERT` per table. It restores the tables it writes to and no
others. `conformance/fixtures/dsql/*.sql` creates 215 tables and `07-data.sql`
writes to 149 of them; the other 66 are empty the moment the fixture load
finishes, and nothing ever cleared them again — not `--reload-per-spec`, not
`--reset-mutations`, not a `--reset-touched` full-reload fallback. A row a
mutating case inserted into one of those tables survived the reload, the run, and
every run after it, on the same cluster, indefinitely.

The worked example is `InsertSpec:596`: `POST /simple_pk2` with `k='棋圍'`,
asserting 201. `simple_pk2` is created by `03-schema.sql` and never populated by
`07-data.sql`, so the case passes on the run that first inserts the row and fails
`23505 duplicate key value violates unique constraint "simple_pk2_pkey"` on every
run after. Deleting the row by hand made it pass again. That is a measurement that
can only be right once per cluster lifetime, and it drifts one way: down.

The fix is a sweep that empties those tables wherever a reload happens, and once
before the first case. The set is derived on every run from the fixture SQL —
`CREATE TABLE` across `conformance/fixtures/dsql/*.sql` minus the tables
`07-data.sql` writes to — so it cannot go stale when a fixture file gains a
table. No fixture file but `07-data.sql` inserts and none creates a table `AS
SELECT`, which is what makes "created and never written by `07-data.sql`" the
same set as "empty after a load". One `count(*)` probe covers all 66 in a single
round trip and only the tables actually holding rows are deleted from, so the
sweep costs one query per reload in the normal case. A run prints what it found:

```
[runner] cleared 17 leftover row(s) from public.items3, public.insertonly,
  public.simple_pk2, public.tbl_w_json, public.channels, public.evil_friends,
  public.evil_friends_with_column_default before the first case
[runner] unpopulated-table sweeps: 5 over 66 table(s) the fixtures never
  populate, 26 leftover row(s) cleared
```

Measured, on one cluster, with the engine tree frozen (a copy of the working
tree, so the only difference between the two runners is the sweep), flags
`--target dsql --concurrency 1 --reload-per-spec` over `InsertSpec`,
`UpsertSpec`, `UpdateSpec`, `DeleteSpec` — 228 cases, 202 in the denominator:

| run | runner | passed |
| --- | --- | --- |
| 1 | without the sweep, leftovers cleared beforehand | 144 / 202 |
| 2 | without the sweep, leftovers from run 1 present | 143 / 202 |
| 3 | with the sweep, same leftovers present | 144 / 202 |
| 4 | with the sweep, repeated | 144 / 202 |

Id-matched, never netted: run 1 → 2 moved one case pass→fail (`InsertSpec:596`)
and none the other way; run 2 → 3 moved that one case fail→pass and none the
other way; run 3 → 4 moved nothing in either direction. Without the sweep the
number decays on the second run and stays decayed; with it, two consecutive runs
agree.

The blast radius outside those four specs was measured rather than assumed. 12
extracted cases send a mutating request straight at a table the fixtures never
populate (10 in `InsertSpec`, 1 in `UpdateSpec`, 1 in `ErrorSpec`), plus any RPC
whose body writes to one; 19 send a read at one, in `ComputedRelsSpec` (4),
`EmbedDisambiguationSpec` (10), `QuerySpec` (3) and `RelatedQueriesSpec` (2).
Running `InsertSpec` first to leave 9 rows in 7 of those tables, then those four
reading specs: 300/385 with the leftovers present, 298/385 after the sweep. The
two that moved are `QuerySpec:571` and `QuerySpec:1305`, both row-order
assertions, and both flip on their own — three runs of each case under the
*unmodified* runner produced both a pass and a fail for each. So the honest count
for those specs is nothing attributable in either direction, not "−2".

Residual error left after the fix:

- Sequence and identity counters are still not restored. Upstream gets fresh
  ones because `schema.sql` recreates the schema; a data-only reload cannot, so a
  case asserting a generated id still drifts with the number of prior inserts.
  Only `node conformance/fixtures/load.mjs` resets those.
- The sweep runs at the start of a run and after every reload. A `--reset-touched`
  run performing only targeted restores therefore guarantees emptiness for the
  tables that run dirtied (the targeted restore already empties a touched table
  the fixtures never populate), not for a table some earlier run dirtied and this
  one never touches — the start-of-run sweep is what covers that.
- The published 945/1285 was measured before this fix, on a cluster with an
  unknown amount of accumulated leftover data, so it carries a downward bias of
  unknown size bounded by the cases named above. The evidence here comes from a
  different cluster (one per agent), so it does not say how many of the published
  945 were affected — only that the same hole was open in that run.
- Per-spec (rather than per-request) isolation is unchanged and is still the
  larger residual error. This fix removes drift *between* runs; it does not make
  a mutating case invisible to a later case in the same spec file.

## What the report shows

1. **Progress since the baseline** — every run in `history.json` as a row
   (passed, failed, ran, rate, the flags it was measured with), then baseline vs
   current per category with the change in passing cases and in the
   denominator. Categories below their baseline are named, never dropped. The
   baseline-vs-current rate pair is printed only when the two runs share flags.
   Under it, the id-matched tables: case-id transitions against the baseline,
   against the newest earlier run with the same flags *and a different tree*, and
   against every other run of the same tree, followed by "the same tree, measured
   N times" — one row per run of the published tree, the span between the lowest
   and the highest, and why the published one was chosen.
2. **Headline** — pass rate as `passed / (passed + failed)`, with the
   denominator spelled out in words plus the commit and run timestamp. The four
   excluded groups — `needsConfig`, `skipped`, `blocked` and `outOfScope` — are
   reported next to the rate, never inside it, and never as passes. The verdict
   leads with the id-matched case delta, not with a percentage-point jump.
3. **How to read this number** — the bounds on the measurement: the
   residual bias from per-spec (rather than per-request) fixture isolation and
   why the reset flags do not remove it; the order-dependent assertions kept as
   failures; what is permanently impossible on DSQL, counted from
   `load-report.json`; the cases that left the denominator since the last
   comparable run, with the rate recomputed as if they had not; and what an
   audit of the published run found out about *how* some passes are reached.
4. **By category** — total / passed / failed / blocked / excluded per category,
   plus the baseline count and the change, sorted by gap size.
5. **Gaps ranked by cases**, each labelled `engine-fixable`,
   `dsql-substitute-needed` or `out-of-scope`, with the most common measured
   symptom quoted verbatim.
6. **Aurora DSQL limitations** — grouped from `load-report.json`: what could not
   be created and which test categories that cost.
7. **Not counted** — the needs-config / skipped / blocked / out-of-scope cases
   itemised, so the headline cannot be read as better than it is.
   `needs-config` is a case whose expectation depends on a server setting the
   engine does not expose yet (`db-pre-request`, `db-max-rows`, ...); it is held
   out of the denominator for the same reason a skip is.
8. **Cedar equivalence** — a separate measurement in a boxed section of its own:
   equivalent behaviour through a different mechanism, with the list of things a
   reader should not read into it. It is never averaged into the pass rate, and
   the section states that the upstream cases behind it are still failures in the
   rate above — checked against the results file, not asserted.

## What is editorial, and where it lives

Everything in the report is computed from the input files — including the
verdict paragraphs and the progress narrative — except six things, all at the
top of `conformance/report/build-report.mjs`:

- `DSQL_SUBSTITUTE_NEEDED` / `OUT_OF_SCOPE_FAILURES` — the fixability labels.
  Any gap with at least one `fail` case that is not in those sets is labelled
  `engine-fixable`; any gap with no `fail` cases is `out-of-scope`. Change a label
  only when the gap genuinely changed category, and when moving one *out* of
  `engine-fixable` say why in its `GAP_NOTES` entry: the label decides how much
  of the remaining work the report presents as workable, so a quiet relabel is a
  way of shrinking the backlog without fixing anything. The same rule cuts the
  other way for a gap this project owns: `harness-supplies-unverified-identity` is
  a fidelity gap between the conformance harness and the deployed authorizer, and
  it is deliberately in neither set, so it takes the default label and stays a
  counted failure. Putting a gap of ours into `dsql-substitute-needed` would blame
  DSQL for it; putting it into `OUT_OF_SCOPE_FAILURES` would lift the rate.
- `GAP_NOTES` — one short explanation per large gap. Gaps without a note show
  only the measured symptom.
- `AUDITED_DISCLOSURES` — what an adversarial audit of the published run found
  about how a pass was reached, which no input file can compute (a setting no
  code path reads; gains that depend on a declared manifest). Each entry cites
  what was run. Nothing here changes a status or is netted off the rate.
- `PUBLISHED_RUN_CHOICE` — why this results file and not another run of the same
  tree. The spread beside it is computed; the reasoning is not.
- `CEDAR_DO_NOT_READ` — what the Cedar equivalence score does not mean.
- `PERMANENT_ON_DSQL` — one `why` and one `substitute` sentence per fixture-drop
  family that DSQL will never accept. The counts beside them come from
  `load-report.json`; only the sentences are written by hand, and the table says
  so. Families whose drop is a consequence of another (a trigger dropped because
  its plpgsql function was) are left out on purpose, so the table is not padded.

`dropFamily()` and `skipFamily()` collapse the ~100 distinct fixture-drop
reasons and the extraction skip reasons into readable families. Add a rule there
when a new reason appears; unmatched reasons fall through as their own row
rather than being hidden, so nothing disappears silently.

## Honesty rules for this report

- The rate is always `passed / (passed + failed)`. Never widen the denominator
  exclusions to flatter it, and never quote a rate computed against a smaller
  denominator.
- A case whose fixture DSQL cannot create is `blocked`, never `failed` and never
  `passed`.
- A skipped or needs-config case is a harness or configuration limitation, not a
  pass. Closing one moves cases into the denominator, and they will usually fail
  first — which is why the rate can fall while the engine improves. Quote the
  denominator with the rate, always.
- Measure with `--reload-per-spec`. A number from a run without it is scored
  against fixture data that earlier mutating specs have changed, and it moves
  when unrelated specs start passing.
- A reset has to leave every table in the state a fixture load leaves it in,
  including the 66 the fixtures create and never populate. Re-applying
  `07-data.sql` alone does not: it never touches those tables, so a row a
  mutating case wrote into one outlives the run and the case fails on every
  later run against that cluster. See "Tables the fixtures never populate" —
  a rate that falls because the cluster remembers is not a measurement.
- Record the flags and the engine environment in the trend entry. Comparing a
  run measured one way against a run measured another way is how a report starts
  lying without anybody editing a number.
- Add runs to the trend, never replace them. The rate has fallen between runs
  before and will again; a trend that only goes up is a trend somebody curated.
- Two full runs of the same commit differ by a handful of cases. Measured: 547
  and 550 on one tree, 943, 945 and 948 on another, 1,066, 1,069, 1,073 and 1,073
  on a third, and 1,068, 1,068, 1,074 and 1,080 on a fourth — a spread of 7 cases
  in the third tree and 12 in the fourth, disagreeing on 8 to 18 of 1,539 in every
  tree measured so far. The spread is not shrinking as the engine improves; it
  widens as more cases reach the point of returning rows at all. The cause is DSQL
  optimistic-concurrency conflicts during the fixture reload, the order the
  storage layer returns unordered rows in, and identity-sequence state a data-only
  reload cannot restore. Do not present a difference of that size as progress —
  and note that two runs can agree on the total and disagree on which cases
  passed, so equal totals are not a reproduction.
- Do not compare percentages across different runner flags. The verdict leads
  with the id-matched case delta for exactly that reason, and the generator prints
  no rate pair at all when the two runs' flags differ — a percentage-point jump
  would credit the engine with the flag's effect. Comparing rates is fine between
  runs whose `flags` strings match: 550/1199 → 945/1285 is such a pair. Keep the
  `flags` string byte-identical between comparable runs and put anything else in
  `--note`: widening the string to describe the engine config silently drops the
  run out of every flag-matched comparison the generator can make.
- When several runs measure the same tree, do not publish the one measured by the
  pass that wrote the code, and prefer the middle of the range to the top of it.
  Keep them all in the trend so the spread is visible. The `eeb1ac9` run did
  that: 943 from the pass that wrote the code, 948 from the pass that verified it,
  945 from a third run, and 945 published. The `5586e94` run did it again: 1,066
  from the pass that wrote the code, 1,073 and 1,073 from an audit pass, 1,069
  from that pass's last run, and 1,069 published — the two rules together leave
  exactly one candidate, and it is not the flattering one. The `2488109` run
  measured 1,068, 1,068, 1,074 and 1,080 and published 1,074, the midpoint. When
  the spread is wide enough to swallow the difference from the previous
  publication, say so in the page rather than letting the reader infer progress:
  every case that changed verdict between 1,069 and 1,074 is order-only.
- Report what left the denominator. A case moved from `fail` to `blocked` or
  `out-of-scope` between two runs raises the rate without any engine work, so the
  report counts those moves and recomputes the rate with them added back as
  failures (945/1285 = 73.5% published, 945/1294 = 73.0% with all nine). The
  published 1,074/1,358 run has the same denominator as the 1,069 before it — no
  case entered or left it — so there is nothing to add back this time. The wave
  before it moved 74 cases *into* the denominator (60 from `blocked`, 14 from
  `needs-config`) and 1 out (`InsertSpec:171`, `fail` → `blocked`), which is why
  that rate rose 5 points while the pass count rose 124.
- A counterfactual rate is not a published rate. Reattributing the 60 cases that
  entered the denominator would read 1,074/1,298 = 82.7%; it appears once, in the
  paragraph that explains the denominator, labelled as not the published number.
  Never quote it anywhere a reader could mistake it for the measurement.
- A second measurement stays a second measurement. The Cedar equivalence score
  (24 of 28 equivalences hold, 26 of 54 upstream cases with no fair equivalent) is
  equivalent behaviour through a different mechanism. It is never averaged into
  the PostgREST rate, the upstream cases behind it stay failures in that rate, and
  the section reporting it has to say what a reader should not read into it —
  including that this project chose the cases, wrote the policies and wrote the
  runner, so it has no external referee the way the PostgREST rate does.
