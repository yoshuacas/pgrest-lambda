// pg-types.mjs — node-postgres type parsers for numeric wire fidelity
//
// PostgREST builds its response body inside PostgreSQL (`json_agg`), so an
// int8/bigint column arrives at the client as a JSON *number*:
//
//   GET /items?select=id  ->  [{"id":1}]        (PostgREST)
//
// node-postgres, by contrast, hands int8 and numeric back as JavaScript
// strings, which `JSON.stringify` then quotes:
//
//   GET /items?select=id  ->  [{"id":"1"}]      (default node-postgres)
//
// These parsers close that gap. The conversion is deliberately lossless: a
// value is only turned into a JS number when the number renders back to the
// exact same digits Postgres sent. That keeps
//
//   * int8 beyond 2^53   (9007199254740993 does not round-trip)
//   * numeric with a scale that JS drops ("0.50" -> 0.5)
//
// as strings rather than silently corrupting them. PostgREST would emit those
// as raw JSON numbers; emitting the exact digits as a string is the closest
// thing to that which JSON.stringify can express without losing information.

import pg from 'pg';

// pg_type.oid values. Kept as literals on purpose — they are stable parts of
// the PostgreSQL wire protocol, not something to introspect at runtime.
const OID_INT8 = 20;
const OID_NUMERIC = 1700;
const OID_INT8_ARRAY = 1016;
const OID_NUMERIC_ARRAY = 1231;

/**
 * Convert a Postgres numeric literal to a JS number when the conversion is
 * exactly reversible, otherwise return the original text.
 *
 * @param {string|null} text
 * @returns {number|string|null}
 */
export function parseExactNumber(text) {
  if (text == null) return text;
  const n = Number(text);
  if (!Number.isFinite(n)) return text;
  return String(n) === canonicalDecimal(text) ? n : text;
}

/**
 * Drop the digits a decimal literal carries only to state its scale, so
 * `String(Number(x))` can be compared against it.
 *
 * PostgreSQL prints a `numeric` at its declared scale: `sum(price)` over
 * `numeric(19,6)` comes back as `"8800.000000"`, and `avg` as
 * `"1100.0000000000000000"`. Those trailing zeros carry no value — the number
 * is exactly 8800 — but they made the strict `String(n) === text` test fail, so
 * every aggregate over a scaled numeric was emitted as a JSON string while
 * upstream emits a JSON number (AggregateFunctionsSpec:39, :42, :45, ...).
 *
 * Only insignificant zeros after the point are removed, which is why the
 * comparison stays lossless: `"9007199254740993"` and `"1.234567890123456789"`
 * are untouched and still fail the test, so they remain strings.
 */
function canonicalDecimal(text) {
  if (typeof text !== 'string' || !text.includes('.')) return text;
  // Exponent notation has its own canonical form; leave it to the strict test.
  if (/[eE]/.test(text)) return text;
  return text.replace(/\.?0+$/, '') || '0';
}

let installed = false;

/**
 * Install the int8/numeric parsers on the shared `pg` type registry.
 * Idempotent: the registry is global to the process, so repeated calls
 * (one per handler construction) must not stack parsers.
 */
export function installPgTypeParsers() {
  if (installed) return;
  installed = true;

  pg.types.setTypeParser(OID_INT8, parseExactNumber);
  pg.types.setTypeParser(OID_NUMERIC, parseExactNumber);

  for (const oid of [OID_INT8_ARRAY, OID_NUMERIC_ARRAY]) {
    // Reuse pg's own array tokenizer and only re-map the elements, so array
    // literal quoting/escaping stays pg's problem.
    const parseArray = pg.types.getTypeParser(oid, 'text');
    pg.types.setTypeParser(oid, (text) => {
      const arr = parseArray(text);
      return Array.isArray(arr) ? arr.map(parseExactNumber) : arr;
    });
  }
}
