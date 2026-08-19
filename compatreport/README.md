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

Writes `compatreport/index.html` and prints the headline numbers, so a
regeneration is verifiable from the terminal:

```
history conformance/results/history.json: 8 run(s), baseline baseline 135/1153
wrote /home/ec2-user/pgrest-lambda/compatreport/index.html (181,591 bytes)
pass rate 945/1285 = 73.5%  [extracted 1539, needs-config 16, skipped 35, blocked 188, out-of-scope 15]
59 gap slugs, 27 DSQL drop families
11 order-dependent failures kept as failures
vs baseline baseline: +810 passed, −678 failed, denominator +132
id-matched vs baseline: +816 pass, -6 regress (1539 shared ids)
id-matched vs verified, per-spec reload (same flags): +400 pass, -5 regress
noise vs eeb1ac9 verification re-run (same tree, same flags): 11 cases differ
```

That 945 of 1,285 is the current published measurement, from commit `eeb1ac9`.
Three full runs of that tree exist: the pass that wrote the code measured 943 of
1,285, the pass that checked it measured 948, and a third run measured 945. The
published number is the third, and the rule it follows is worth stating: when
several runs of one tree disagree, publish one that was not measured by the pass
that wrote the code, and prefer the middle of the range to the top of it. All
three are in the trend file. They disagree on about 11 of 1,539 cases, which is
the run-to-run noise, and the report says so instead of reading the spread as
progress.

The `vs baseline` line is a totals difference across different runner flags, so
it is not the claim the report leads with. The `id-matched` lines are: they match
case ids between two result files and count movements in each direction
separately, never netted. Against the baseline, 816 cases went from non-pass to
pass and 6 went the other way: `NullsStripSpec:117`, `SingularSpec:78`,
`SingularSpec:93`, `UpsertSpec:417`, `UpsertSpec:430` and `UpsertSpec:479`.
Against the comparable 550-case run, 400 went to pass and 5 went the other way:
`QuerySpec:75`, `QuerySpec:80`, `QuerySpec:1305` and `QuerySpec:1313`, all
order-only, plus `UpsertSpec:417`. None of the six is an engine regression, and
that was checked rather than assumed — re-running `UpsertSpec` with
`--reset-touched` makes `UpsertSpec:417` pass, which identifies it as a mutation
earlier in the same spec file changing the row this later read asserts on.

Options:

```bash
node conformance/report/build-report.mjs \
  --results conformance/results/run-2026-08-19T15-51-47-373Z.json \
  --load-report conformance/fixtures/load-report.json \
  --history conformance/results/history.json \
  --label baseline --flags "" --note "why this run exists" \
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
  Give every run a distinct `--label`.
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
  One entry in that base configuration changes the score: the runner boots the
  engine with `bulkMutationGuard: 'off'`, because the engine's default `on`
  refuses a filterless `PATCH`/`DELETE` and upstream has no such guard unless
  `pg_safeupdate` is loaded. It is worth about a dozen cases: 10 filterless
  `PATCH`/`DELETE` assertions in `UpdateSpec` and `UnicodeSpec` pass in this run
  and would answer `PGRST106` with the guard on. Read
  `conformance/runner/run.mjs` for the rest of that config, and for the 12
  spec ranges the runner measures under upstream's own non-default settings.

## Full refresh (new measurement, then report)

The report only reformats what the runner measured. To move the numbers you must
re-run the suite:

```bash
# fixtures must be loaded first; load-report.json is written by that step
PGREST_RELATIONSHIPS_PATH=$PWD/conformance/fixtures/relationships.json \
  node conformance/runner/run.mjs --target dsql --concurrency 1 --reload-per-spec
node conformance/report/build-report.mjs \
  --label "$(git rev-parse --short HEAD) $(date -u +%FT%TZ)" \
  --flags "--target dsql --concurrency 1 --reload-per-spec, PGREST_RELATIONSHIPS_PATH set"
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
findings. Add a probe there rather than editing the table by hand — a
hand-maintained row drifts, and the first version of this table reported
`Prefer: tx=rollback` at 14 of 15 when no extracted case sends that header at all
(the number belonged to `tx=commit`).

`PGREST_RELATIONSHIPS_PATH` matters more than any other setting here. DSQL
cannot store foreign keys, so `pg_constraint` reports none and the engine has
nothing to resolve embedding with unless it is handed the declared-relationship
manifest the fixture transform reconstructs. Measured on the same commit and the
same first 60 embedding cases: 3 of 58 passed without the variable, 22 of 58
with it. A run that leaves it unset is measuring an unconfigured engine.

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

## What the report shows

1. **Progress since the baseline** — every run in `history.json` as a row
   (passed, failed, ran, rate, the flags it was measured with), then baseline vs
   current per category with the change in passing cases and in the
   denominator. Categories below their baseline are named, never dropped. The
   baseline-vs-current rate pair is printed only when the two runs share flags.
   Under it, the id-matched tables: case-id transitions against the baseline,
   against the newest earlier run with the same flags, and against another run of
   the same tree if there is one.
2. **Headline** — pass rate as `passed / (passed + failed)`, with the
   denominator spelled out in words plus the commit and run timestamp. The four
   excluded groups — `needsConfig`, `skipped`, `blocked` and `outOfScope` — are
   reported next to the rate, never inside it, and never as passes. The verdict
   leads with the id-matched case delta, not with a percentage-point jump.
3. **How to read this number** — the three bounds on the measurement: the
   residual bias from per-spec (rather than per-request) fixture isolation and
   why the reset flags do not remove it; the order-dependent assertions kept as
   failures; what is permanently impossible on DSQL, counted from
   `load-report.json`; and the cases that left the denominator since the last
   comparable run, with the rate recomputed as if they had not.
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

## What is editorial, and where it lives

Everything in the report is computed from the input files — including the
verdict paragraphs and the progress narrative — except three things, all at the
top of `conformance/report/build-report.mjs`:

- `DSQL_SUBSTITUTE_NEEDED` / `OUT_OF_SCOPE_FAILURES` — the fixability labels.
  Any gap with at least one `fail` case that is not in those sets is labelled
  `engine-fixable`; any gap with no `fail` cases is `out-of-scope`.
- `GAP_NOTES` — one short explanation per large gap. Gaps without a note show
  only the measured symptom.
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
- Record the flags and the engine environment in the trend entry. Comparing a
  run measured one way against a run measured another way is how a report starts
  lying without anybody editing a number.
- Add runs to the trend, never replace them. The rate has fallen between runs
  before and will again; a trend that only goes up is a trend somebody curated.
- Two full runs of the same commit differ by a handful of cases. Measured: 547
  and 550 on one tree, then 943, 945 and 948 on another, disagreeing on about 11
  of 1,539 cases. The cause is DSQL optimistic-concurrency conflicts during the
  fixture reload and the order the storage layer returns unordered rows in. Do not
  present a difference of that size as progress.
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
  Keep them all in the trend so the spread is visible. This run does that: 943
  from the pass that wrote the code, 948 from the pass that verified it, 945 from a
  third run, and 945 published.
- Report what left the denominator. A case moved from `fail` to `blocked` or
  `out-of-scope` between two runs raises the rate without any engine work, so the
  report counts those moves and recomputes the rate with them added back as
  failures (945/1285 = 73.5% published, 945/1294 = 73.0% with all nine).
