// Report: the trend file that turns the compatibility report from a snapshot
// into a progress record. history.json holds one entry per measured run
// (build-report.mjs header comment); runs[0] is the baseline.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeCounts, entryFromResults, appendRun, buildTrend,
  idMatchedDelta, rowOrderFailures, isolationEvidence,
} from '../report/build-report.mjs';

function results(over = {}) {
  return {
    generatedAt: '2026-08-19T10:00:00Z',
    target: 'dsql',
    commit: 'abc1234',
    totals: {
      total: 10, passed: 2, failed: 6, skipped: 1, needsConfig: 1,
      blocked: 0, outOfScope: 0, errored: 0,
    },
    byCategory: {
      select: { total: 6, passed: 2, failed: 4 },
      rpc: { total: 4, passed: 0, failed: 2, skipped: 1, needsConfig: 1 },
    },
    cases: [],
    ...over,
  };
}

describe('normalizeCounts', () => {
  it('defaults the keys an older results file predates', () => {
    // The baseline run was measured before needs-config existed as a status.
    const c = normalizeCounts({ total: 3, passed: 1, failed: 2 });
    assert.equal(c.needsConfig, 0);
    assert.equal(c.outOfScope, 0);
    assert.equal(c.errored, 0);
    assert.equal(c.passed, 1);
  });

  it('keeps only counts, so a whole results file cannot leak into the trend', () => {
    const c = normalizeCounts({ passed: 1, cases: [{ id: 'x' }], gaps: { a: 1 } });
    assert.deepEqual(Object.keys(c).sort(), [
      'blocked', 'errored', 'failed', 'needsConfig',
      'outOfScope', 'passed', 'skipped', 'total',
    ]);
  });
});

describe('entryFromResults', () => {
  it('records the label, flags and note the caller supplied', () => {
    const e = entryFromResults(results(), {
      label: 'baseline', flags: '--target dsql', note: 'first measurement',
    });
    assert.equal(e.label, 'baseline');
    assert.equal(e.flags, '--target dsql');
    assert.equal(e.note, 'first measurement');
    assert.equal(e.generatedAt, '2026-08-19T10:00:00Z');
    assert.equal(e.commit, 'abc1234');
    assert.equal(e.totals.passed, 2);
    assert.deepEqual(Object.keys(e.byCategory).sort(), ['rpc', 'select']);
  });

  it('falls back to the commit as the label and null for unrecorded flags', () => {
    const e = entryFromResults(results());
    assert.equal(e.label, 'abc1234');
    assert.equal(e.flags, null);
  });

  it('stores the results path relative to the repo', () => {
    const e = entryFromResults(results(), {
      resultsPath: '/home/ec2-user/pgrest-lambda/conformance/results/latest.json',
    });
    // Only meaningful if the path is inside the repo; otherwise it is a
    // relative walk-up, which is still a stable reference.
    assert.ok(!e.results.startsWith('/'));
    assert.match(e.results, /latest\.json$/);
  });
});

describe('appendRun', () => {
  it('appends a new run and keeps the trend oldest first', () => {
    let h = { runs: [] };
    h = appendRun(h, entryFromResults(results({ generatedAt: '2026-08-19T12:00:00Z' }), { label: 'b' }));
    h = appendRun(h, entryFromResults(results({ generatedAt: '2026-08-19T09:00:00Z' }), { label: 'a' }));
    assert.deepEqual(h.runs.map((r) => r.label), ['a', 'b']);
  });

  it('starts a trend from nothing', () => {
    const h = appendRun(undefined, entryFromResults(results(), { label: 'only' }));
    assert.equal(h.runs.length, 1);
    assert.match(h.description, /one entry per measured conformance run/i);
  });

  it('replaces the same run rather than double-counting it', () => {
    // Rebuilding the report from one results file must not grow the trend.
    const first = entryFromResults(results(), { label: 'x' });
    const again = entryFromResults(results({ totals: { total: 10, passed: 5, failed: 3 } }), { label: 'x' });
    const h = appendRun(appendRun({ runs: [] }, first), again);
    assert.equal(h.runs.length, 1);
    assert.equal(h.runs[0].totals.passed, 5);
  });

  it('treats the same label at a different timestamp as a new run', () => {
    const h = appendRun(
      appendRun({ runs: [] }, entryFromResults(results(), { label: 'nightly' })),
      entryFromResults(results({ generatedAt: '2026-08-20T10:00:00Z' }), { label: 'nightly' }),
    );
    assert.equal(h.runs.length, 2);
  });

  it('does not mutate the history it was given', () => {
    const h = { runs: [entryFromResults(results(), { label: 'a' })] };
    appendRun(h, entryFromResults(results({ generatedAt: '2026-08-20T10:00:00Z' }), { label: 'b' }));
    assert.equal(h.runs.length, 1);
  });
});

describe('buildTrend', () => {
  const baseline = entryFromResults(results(), { label: 'baseline', flags: null });
  const current = entryFromResults(
    results({
      generatedAt: '2026-08-19T16:00:00Z',
      totals: {
        total: 10, passed: 5, failed: 4, skipped: 0, needsConfig: 1, blocked: 0, outOfScope: 0,
      },
      byCategory: {
        select: { total: 6, passed: 4, failed: 2 },
        rpc: { total: 4, passed: 1, failed: 2, needsConfig: 1 },
        embedding: { total: 2, passed: 0, failed: 0, blocked: 2 },
      },
    }),
    { label: 'current', flags: '--reload-per-spec' },
  );

  it('is null with no runs', () => {
    assert.equal(buildTrend([]), null);
    assert.equal(buildTrend(null), null);
  });

  it('flags a single run as a self-comparison instead of a fake delta', () => {
    const tr = buildTrend([baseline]);
    assert.equal(tr.isSelfComparison, true);
    assert.equal(tr.deltaPassed, 0);
  });

  it('compares the first run with the last', () => {
    const tr = buildTrend([baseline, current]);
    assert.equal(tr.baseline.label, 'baseline');
    assert.equal(tr.current.label, 'current');
    assert.equal(tr.deltaPassed, 3);
    assert.equal(tr.deltaFailed, -2);
    // ran = passed + failed: 8 at baseline, 9 now.
    assert.equal(tr.baseline.ran, 8);
    assert.equal(tr.current.ran, 9);
    assert.equal(tr.deltaRan, 1);
    assert.ok(Math.abs(tr.current.rate - 5 / 9) < 1e-9);
  });

  it('reports the rate as passed / (passed + failed), never over the extracted total', () => {
    const tr = buildTrend([baseline, current]);
    assert.ok(Math.abs(tr.baseline.rate - 2 / 8) < 1e-9);
    assert.notEqual(tr.baseline.rate, 2 / 10);
  });

  it('marks runs measured with different flags as not comparable', () => {
    assert.equal(buildTrend([baseline, current]).sameFlags, false);
    const matched = { ...current, flags: null };
    assert.equal(buildTrend([baseline, matched]).sameFlags, true);
  });

  it('sorts categories by the change in passing cases', () => {
    const tr = buildTrend([baseline, current]);
    assert.deepEqual(tr.categories.map((c) => c.name), ['select', 'rpc', 'embedding']);
    assert.equal(tr.categories[0].deltaPassed, 2);
    assert.equal(tr.improved, 2);
  });

  it('marks a category the baseline never measured', () => {
    const tr = buildTrend([baseline, current]);
    const embedding = tr.categories.find((c) => c.name === 'embedding');
    assert.equal(embedding.measuredAtBaseline, false);
    assert.equal(embedding.baselineRan, 0);
    assert.equal(embedding.baselineRate, null);
    assert.equal(embedding.rate, null); // 0 ran now as well: 2 blocked
  });

  it('lists categories that fell below their baseline instead of hiding them', () => {
    const worse = entryFromResults(
      results({
        generatedAt: '2026-08-19T17:00:00Z',
        byCategory: { select: { total: 6, passed: 1, failed: 5 }, rpc: { total: 4, passed: 0, failed: 2 } },
      }),
      { label: 'worse' },
    );
    const tr = buildTrend([baseline, worse]);
    assert.deepEqual(tr.regressed.map((c) => c.name), ['select']);
    assert.equal(tr.regressed[0].deltaPassed, -1);
  });

  it('keeps every run in the trend, not just the two endpoints', () => {
    const middle = entryFromResults(results({ generatedAt: '2026-08-19T13:00:00Z' }), { label: 'mid' });
    const tr = buildTrend([baseline, middle, current]);
    assert.deepEqual(tr.runs.map((r) => r.label), ['baseline', 'mid', 'current']);
    assert.equal(tr.baseline.label, 'baseline');
    assert.equal(tr.current.label, 'current');
  });
});

describe('idMatchedDelta', () => {
  // Two runs measured with different flags have different denominators, so the
  // totals delta is not a case-level claim. Matching ids is.
  const before = [
    { id: 'a:1', status: 'fail' },
    { id: 'a:2', status: 'pass' },
    { id: 'a:3', status: 'skip' },
    { id: 'a:4', status: 'fail' },
    { id: 'a:5', status: 'fail' },
  ];
  const after = [
    { id: 'a:1', status: 'pass' },
    { id: 'a:2', status: 'fail' },
    { id: 'a:3', status: 'pass' },
    { id: 'a:4', status: 'blocked' },
    { id: 'a:6', status: 'pass' },
  ];

  it('counts a non-pass becoming a pass as gained, and the reverse as lost', () => {
    const d = idMatchedDelta(before, after);
    assert.equal(d.gained, 2); // a:1 fail->pass, a:3 skip->pass
    assert.equal(d.lost, 1); // a:2 pass->fail
  });

  it('never nets gains against losses', () => {
    const d = idMatchedDelta(before, after);
    assert.equal(d.gained - d.lost, 1);
    assert.notEqual(d.gained, 1);
  });

  it('does not count a case that only left the denominator as a gain', () => {
    // a:4 went fail -> blocked: it stopped failing without passing.
    const d = idMatchedDelta(before, after);
    const moved = d.transitions.find(([k]) => k === 'fail → blocked');
    assert.deepEqual(moved, ['fail → blocked', 1]);
  });

  it('reports ids present in only one of the two runs instead of matching them', () => {
    const d = idMatchedDelta(before, after);
    assert.equal(d.matched, 4);
    assert.equal(d.onlyInCurrent, 1); // a:6
    assert.equal(d.onlyInBaseline, 1); // a:5
  });

  it('sorts transitions by size so the largest movement reads first', () => {
    const d = idMatchedDelta(
      [{ id: '1', status: 'fail' }, { id: '2', status: 'fail' }, { id: '3', status: 'skip' }],
      [{ id: '1', status: 'pass' }, { id: '2', status: 'pass' }, { id: '3', status: 'pass' }],
    );
    assert.deepEqual(d.transitions[0], ['fail → pass', 2]);
  });
});

describe('rowOrderFailures', () => {
  it('counts only the order-dependent cases that are still failures', () => {
    const r = rowOrderFailures([
      { id: 'q:1', gap: 'row-order-unspecified', status: 'fail' },
      { id: 'q:2', gap: 'row-order-unspecified', status: 'pass' },
      { id: 'q:3', gap: 'body-mismatch-filters', status: 'fail' },
      { id: 'q:4', gap: 'row-order-unspecified', status: 'fail' },
    ]);
    assert.equal(r.count, 2);
    assert.deepEqual(r.ids, ['q:1', 'q:4']);
  });

  it('is empty rather than undefined with no cases', () => {
    assert.deepEqual(rowOrderFailures([]), { count: 0, ids: [] });
    assert.deepEqual(rowOrderFailures(null), { count: 0, ids: [] });
  });
});

describe('isolationEvidence', () => {
  const run = (over) => ({
    label: 'r', commit: 'aaa', flags: '--target dsql, PGREST_RELATIONSHIPS_PATH set', ...over,
  });

  it('pairs two runs on one commit that differ only by --reload-per-spec', () => {
    const withFlag = run({
      label: 'with', flags: '--target dsql --reload-per-spec, PGREST_RELATIONSHIPS_PATH set',
    });
    const without = run({ label: 'without' });
    const ev = isolationEvidence([without, withFlag]);
    assert.equal(ev.withReload.label, 'with');
    assert.equal(ev.withoutReload.label, 'without');
  });

  it('refuses a pair from different commits, which would mix in engine work', () => {
    const ev = isolationEvidence([
      run({ label: 'without', commit: 'bbb' }),
      run({ label: 'with', flags: '--target dsql --reload-per-spec, PGREST_RELATIONSHIPS_PATH set' }),
    ]);
    assert.equal(ev.withReload, null);
    assert.equal(ev.withoutReload, null);
  });

  it('refuses a pair whose other flags differ', () => {
    const ev = isolationEvidence([
      run({ label: 'without', flags: '--target dsql' }),
      run({ label: 'with', flags: '--target dsql --reload-per-spec, PGREST_RELATIONSHIPS_PATH set' }),
    ]);
    assert.equal(ev.withReload, null);
  });

  it('prefers the newest qualifying pair', () => {
    const ev = isolationEvidence([
      run({ label: 'old-without' }),
      run({ label: 'old-with', flags: '--target dsql --reload-per-spec, PGREST_RELATIONSHIPS_PATH set' }),
      run({ label: 'new-without', commit: 'ccc' }),
      run({
        label: 'new-with',
        commit: 'ccc',
        flags: '--target dsql --reload-per-spec, PGREST_RELATIONSHIPS_PATH set',
      }),
    ]);
    assert.equal(ev.withReload.label, 'new-with');
    assert.equal(ev.withoutReload.label, 'new-without');
  });
});
