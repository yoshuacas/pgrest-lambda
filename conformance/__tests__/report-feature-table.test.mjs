// Report: the request-feature view of the results. Every row is a predicate
// over an extracted case, so the risk is not arithmetic — it is a predicate
// that quietly matches nothing and still prints a plausible number, which is
// how the first hand-written version of this table came to report
// `Prefer: tx=rollback` at 14 of 15 when no extracted case sends that header.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FEATURES, featureTable, loadCases } from '../report/feature-table.mjs';

function testCase(id, request, expected = {}) {
  return { id, request: { method: 'GET', path: '/items', query: '', headers: {}, ...request }, expected };
}

function run(cases) {
  return { cases: cases.map(([id, status]) => ({ id, status })) };
}

const probe = (name) => FEATURES.find(([label]) => label === name)[1];

describe('feature predicates', () => {
  it('anchors an operator on `=` so a column named after it does not match', () => {
    // ?isolation=eq.high names a column containing "is"; it is not the `is`
    // operator, which is always `=is.` or `=not.is.`.
    const isOp = probe('`is` operator');
    assert.equal(isOp(testCase('a', { query: 'isolation=eq.high' })), false);
    assert.equal(isOp(testCase('b', { query: 'col=is.null' })), true);
    assert.equal(isOp(testCase('c', { query: 'col=not.is.null' })), true);
  });

  it('matches a text-search operator that carries a configuration', () => {
    // PostgREST puts the config in parentheses — ?col=fts(english).word — so a
    // rule requiring `fts.` misses most of the upstream cases.
    const fts = probe('`fts` / `plfts` / `phfts` / `wfts`');
    assert.equal(fts(testCase('a', { query: 'text_search_vector=fts(english).impossible' })), true);
    assert.equal(fts(testCase('b', { query: 'text_search_vector=fts.impossible' })), true);
    assert.equal(fts(testCase('c', { query: 'text_search_vector=plfts(german).Art' })), true);
    assert.equal(fts(testCase('d', { query: 'select=fts_column' })), false);
  });

  it('reads an embed order from the dotted parameter, not from inside the embed', () => {
    // ?select=clients(*)&clients.order=name is how PostgREST orders an embed.
    const embedOrder = probe('`order` on an embedded resource');
    assert.equal(embedOrder(testCase('a', { query: 'select=clients(*)&clients.order=name' })), true);
    assert.equal(embedOrder(testCase('b', { query: 'order=name' })), false);
  });

  it('detects a header case-insensitively, the way a server must', () => {
    const range = probe('`Range` request header');
    assert.equal(range(testCase('a', { headers: { range: '0-1' } })), true);
    assert.equal(range(testCase('b', { headers: { Range: '0-1' } })), true);
    assert.equal(range(testCase('c', {})), false);
  });

  it('reads a disambiguating embed hint without matching the two join modifiers', () => {
    // `!inner` and `!left` say how to join; anything else after `!` names the
    // foreign key or table to join through, which is a different feature.
    const hint = probe('Disambiguating embed hint (`!fk`)');
    assert.equal(hint(testCase('a', { query: 'select=*,projects!client_id(*)' })), true);
    assert.equal(hint(testCase('b', { query: 'select=*,projects!inner(*)' })), false);
    assert.equal(hint(testCase('c', { query: 'select=*,projects!left(*)' })), false);
    assert.equal(hint(testCase('d', { query: 'select=*,projects(*)' })), false);
  });

  it('counts embed depth from nested parentheses', () => {
    const two = probe('Embed nested two or more levels deep');
    const three = probe('Embed nested three or more levels deep');
    const flat = testCase('a', { query: 'select=*,projects(*)' });
    const deep2 = testCase('b', { query: 'select=*,projects(*,tasks(*))' });
    const deep3 = testCase('c', { query: 'select=*,clients(*,projects(*,tasks(*)))' });
    assert.deepEqual([two(flat), three(flat)], [false, false]);
    assert.deepEqual([two(deep2), three(deep2)], [true, false]);
    assert.deepEqual([two(deep3), three(deep3)], [true, true]);
    // Sibling embeds are one level each, however many of them there are.
    assert.equal(two(testCase('d', { query: 'select=*,projects(*),tasks(*)' })), false);
  });

  it('tells a filter on an embed apart from an order on one', () => {
    const filter = probe('Filter on an embedded resource');
    const order = probe('`order` on an embedded resource');
    const c = testCase('a', { query: 'select=*,projects(*)&projects.id=eq.1' });
    assert.equal(filter(c), true);
    assert.equal(order(c), false);
    assert.equal(filter(testCase('b', { query: 'id=eq.1' })), false);
  });

  it('matches each Prefer token this wave added on its own token, not on the header', () => {
    const handling = probe('`Prefer: handling=strict` / `handling=lenient`');
    const missing = probe('`Prefer: missing=default`');
    const maxAffected = probe('`Prefer: max-affected`');
    const strict = testCase('a', { headers: { Prefer: 'handling=strict' } });
    assert.deepEqual([handling(strict), missing(strict), maxAffected(strict)], [true, false, false]);
    assert.equal(handling(testCase('b', { headers: { Prefer: 'handling=lenient' } })), true);
    assert.equal(missing(testCase('c', { headers: { Prefer: 'missing=default' } })), true);
    assert.equal(maxAffected(testCase('d', { headers: { Prefer: 'max-affected=1' } })), true);
    assert.equal(handling(testCase('e', { headers: { Prefer: 'return=representation' } })), false);
  });

  it('reads an asserted response header off the expectation, not the request', () => {
    const vary = probe('`Vary` asserted on the response');
    const applied = probe('`Preference-Applied` asserted on the response');
    assert.equal(vary(testCase('a', {}, { headers: { Vary: 'Accept-Profile' } })), true);
    assert.equal(vary(testCase('b', { headers: { Vary: 'Accept' } })), false);
    assert.equal(applied(testCase('c', {}, { headers: { 'preference-applied': 'tx=commit' } })), true);
    assert.equal(applied(testCase('d', {}, {})), false);
  });

  it('separates the two RPC methods', () => {
    const get = probe('RPC via `GET /rpc/...`');
    const post = probe('RPC via `POST /rpc/...`');
    const c = testCase('a', { method: 'POST', path: '/rpc/getitemrange' });
    assert.equal(post(c), true);
    assert.equal(get(c), false);
    assert.equal(get(testCase('b', { method: 'GET', path: '/items' })), false);
  });
});

describe('featureTable', () => {
  const byId = new Map([
    ['p', testCase('p', { headers: { Prefer: 'count=exact' } })],
    ['f', testCase('f', { headers: { Prefer: 'count=exact' } })],
    ['b', testCase('b', { headers: { Prefer: 'count=exact' } })],
  ]);

  it('counts pass and fail in the denominator and holds everything else out', () => {
    const rows = featureTable(run([['p', 'pass'], ['f', 'fail'], ['b', 'blocked']]), byId);
    const row = rows.find((r) => r.name === '`Prefer: count=exact`');
    assert.deepEqual(
      { passed: row.passed, ran: row.ran, excluded: row.excluded, rate: row.rate },
      { passed: 1, ran: 2, excluded: 1, rate: 50 },
    );
  });

  it('reports a rate of null, never 0%, for a feature with no measurement', () => {
    // 0% says "we tried and nothing worked". null says "nothing ran". The
    // array and range operators are the real instance: DSQL stores no array
    // or range column, so every upstream case for them is blocked.
    const rows = featureTable(run([['p', 'pass']]), byId);
    const row = rows.find((r) => r.name === '`cs`, `cd`, `ov`, `sl`, `sr`, `adj`');
    assert.equal(row.ran, 0);
    assert.equal(row.rate, null);
  });

  it('counts a result whose case id is not in the case files, rather than dropping it', () => {
    const rows = featureTable(run([['ghost', 'pass']]), byId);
    assert.ok(rows.every((r) => r.unmatched === 1));
    assert.ok(rows.every((r) => r.ran === 0));
  });

  it('sorts by rate and puts the unmeasured features last', () => {
    const rows = featureTable(run([['p', 'pass'], ['f', 'fail']]), byId);
    const rates = rows.map((r) => r.rate);
    const measured = rates.filter((r) => r !== null);
    assert.deepEqual(measured, [...measured].sort((a, b) => b - a));
    assert.equal(rates.slice(measured.length).every((r) => r === null), true);
  });
});

describe('against the real case files', () => {
  const byId = loadCases();

  it('gives every feature a distinct label, so no row can shadow another', () => {
    const labels = FEATURES.map(([name]) => name);
    assert.equal(new Set(labels).size, labels.length);
  });

  it('states the detection basis for every row, so the rule can be checked', () => {
    for (const [name, , basis] of FEATURES) {
      assert.equal(typeof basis, 'string', `${name} has no basis`);
      assert.ok(basis.length > 0, `${name} has an empty basis`);
    }
  });

  it('finds no case asserting Server-Timing, which is why that row reads 0 / 0', () => {
    // The engine sends the header; the upstream suite never checks it. The row
    // stays in the table so "not measured" cannot be mistaken for "covered".
    const timing = probe('`Server-Timing` asserted on the response');
    const vary = probe('`Vary` asserted on the response');
    const all = [...byId.values()];
    assert.equal(all.filter(timing).length, 0);
    assert.ok(all.filter(vary).length > 0);
  });

  it('measures the embed depth and disambiguation features this wave changed', () => {
    // If one of these predicates stops matching, the row silently becomes
    // 0 / 0 and the table reports nothing where it used to report a rate.
    const all = [...byId.values()];
    for (const name of ['Embed nested two or more levels deep',
      'Embed nested three or more levels deep',
      'Disambiguating embed hint (`!fk`)',
      'Filter on an embedded resource',
      '`Prefer: handling=strict` / `handling=lenient`',
      '`Prefer: missing=default`',
      '`Prefer: max-affected`',
      '`OPTIONS`']) {
      assert.ok(all.filter(probe(name)).length > 0, `${name} matches no extracted case`);
    }
  });

  it('finds no case sending Prefer: tx=rollback, which is why that row reads 0 / 0', () => {
    // Guards the specific defect this module replaced. The upstream rollback
    // specs send tx=commit and rely on the harness rolling every request back,
    // which is the one thing DSQL cannot do.
    const rollback = probe('`Prefer: tx=rollback`');
    const commit = probe('`Prefer: tx=commit`');
    const all = [...byId.values()];
    assert.equal(all.filter(rollback).length, 0);
    assert.ok(all.filter(commit).length > 0);
  });
});
