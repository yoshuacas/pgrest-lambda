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
history conformance/results/history.json: 5 run(s), baseline baseline 135/1153
wrote /home/ec2-user/pgrest-lambda/compatreport/index.html (153,310 bytes)
pass rate 550/1199 = 45.9%  [extracted 1539, needs-config 124, skipped 35, blocked 173, out-of-scope 8]
72 gap slugs, 27 DSQL drop families
vs baseline baseline: +415 passed, −369 failed, denominator +46
```

That 550 is the current published measurement. It was produced by re-running the
suite from scratch rather than reusing an agent's reported number, and the case
delta was cross-checked by matching case ids between the baseline and current
result files: 422 cases went from non-pass to pass and 7 went the other way, a
net +415 that agrees with the totals above.

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
file*. That is a real residual measurement error, and it is why 7 cases show as
regressions against the baseline (`SingularSpec:78`, `UpsertSpec:430` and
similar): a mutation earlier in the file now succeeds where it used to fail, and
a later read in the same file sees the changed row. `--reset-mutations` restores
after every mutating case and is the faithful analogue, but at ~8 s per case it
is too slow for a full-suite run. Treat the published number as carrying a small
downward bias from this, not an upward one.

The DSQL connection needs a fresh IAM token (valid 1 h) — see
`conformance/CONTRACTS.md` for the exact environment.

## What the report shows

1. **Progress since the baseline** — every run in `history.json` as a row
   (passed, failed, ran, rate, the flags it was measured with), then baseline vs
   current per category with the change in passing cases and in the
   denominator. Categories below their baseline are named, never dropped.
2. **Headline** — pass rate as `passed / (passed + failed)`, with the
   denominator spelled out in words plus the commit and run timestamp. The four
   excluded groups — `needsConfig`, `skipped`, `blocked` and `outOfScope` — are
   reported next to the rate, never inside it, and never as passes.
3. **By category** — total / passed / failed / blocked / excluded per category,
   plus the baseline count and the change, sorted by gap size.
4. **Gaps ranked by cases**, each labelled `engine-fixable`,
   `dsql-substitute-needed` or `out-of-scope`, with the most common measured
   symptom quoted verbatim.
5. **Aurora DSQL limitations** — grouped from `load-report.json`: what could not
   be created and which test categories that cost.
6. **Not counted** — the needs-config / skipped / blocked / out-of-scope cases
   itemised, so the headline cannot be read as better than it is.
   `needs-config` is a case whose expectation depends on a server setting the
   engine does not expose yet (`db-pre-request`, `db-max-rows`, ...); it is held
   out of the denominator for the same reason a skip is.

## What is editorial, and where it lives

Everything in the report is computed from the input files — including the
verdict paragraphs and the progress narrative — except two things, both at the
top of `conformance/report/build-report.mjs`:

- `DSQL_SUBSTITUTE_NEEDED` / `OUT_OF_SCOPE_FAILURES` — the fixability labels.
  Any gap with at least one `fail` case that is not in those sets is labelled
  `engine-fixable`; any gap with no `fail` cases is `out-of-scope`.
- `GAP_NOTES` — one short explanation per large gap. Gaps without a note show
  only the measured symptom.

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
- Two full runs of the same commit differ by a handful of cases (measured: 420,
  425, 547 and 550 across four runs, the last two on the same code). The cause is
  DSQL optimistic-concurrency conflicts during the fixture reload. Do not present
  a difference of that size as progress.
- Do not compare percentages across different runner flags. The published
  headline states the case delta instead, because the baseline was measured
  without `--reload-per-spec` and the current run with it. The flag-matched pair
  is in the trend file: 135/1153 → 443/1199.
