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

// Temporal types. node-postgres turns these into JavaScript `Date`, which
// JSON.stringify then renders as UTC with millisecond precision — so
// `timestamp '2015-12-08 04:22:57.472738'` reaches the client as
// "2015-12-08T04:22:57.472Z": four digits of microsecond precision thrown
// away and a UTC marker invented for a type that has no time zone.
// PostgREST never converts: the value goes through PostgreSQL's own
// datum-to-json path, so the client sees "2015-12-08T04:22:57.472738"
// (QuerySpec:891, EmbedDisambiguationSpec:190, :232, QuerySpec:1700).
const OID_DATE = 1082;
const OID_TIMESTAMP = 1114;
const OID_TIMESTAMPTZ = 1184;
const OID_DATE_ARRAY = 1182;
const OID_TIMESTAMP_ARRAY = 1115;
const OID_TIMESTAMPTZ_ARRAY = 1185;

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

/**
 * Render a `date`/`timestamp`/`timestamptz` the way PostgreSQL's own
 * datum-to-json conversion does, given the type's text output.
 *
 * PostgreSQL's `JsonEncodeDateTime` (src/backend/utils/adt/json.c) prints the
 * value with `USE_XSD_DATES`, which differs from the default `ISO, MDY` text
 * output in exactly two ways:
 *
 *   date        2019-12-02                    (identical)
 *   timestamp   2015-12-08 04:22:57.472738 -> 2015-12-08T04:22:57.472738
 *   timestamptz 2018-01-02 00:00:00+00     -> 2018-01-02T00:00:00+00:00
 *
 * i.e. the date/time separator becomes `T` and a numeric zone offset is
 * padded to `±HH:MM`. Verified against PostgreSQL 16: `to_json` of those three
 * values returns exactly the right-hand column.
 *
 * Anything that is not a plain timestamp — `infinity`, `-infinity`, a `BC`
 * era suffix — is returned untouched, because PostgreSQL prints those as their
 * text form too and guessing a rewrite would be worse than passing them
 * through.
 *
 * @param {string|null} text raw text from the wire
 * @returns {string|null}
 */
export function formatPgTimestamp(text) {
  if (typeof text !== 'string' || text === '') return text;
  // infinity / -infinity, and any era-qualified value.
  if (!/^\d/.test(text) || text.endsWith(' BC') || text.endsWith(' AD')) {
    return text;
  }
  const m = /^(\d{4,}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(.*)$/.exec(text);
  if (!m) return text; // bare date, or a shape we do not recognise
  const [, day, time, zoneRaw] = m;
  return `${day}T${time}${normalizeZoneOffset(zoneRaw)}`;
}

/**
 * Pad a Postgres zone offset to the `±HH:MM` form `to_json` emits. Postgres
 * prints the shortest form (`+00`, `-07`, `-05:30`, `+00:53:28` for a few
 * pre-1900 LMT zones); XSD dates always carry at least hours and minutes.
 */
function normalizeZoneOffset(zone) {
  if (!zone) return '';
  const m = /^([+-])(\d{2})(?::(\d{2}))?(?::(\d{2}))?$/.exec(zone);
  if (!m) return zone;
  const [, sign, hh, mm, ss] = m;
  return `${sign}${hh}:${mm || '00'}${ss ? `:${ss}` : ''}`;
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

// Temporal parsers are NOT installed globally. `pg.types` is process-wide, and
// the auth layer (better-auth) runs its own pool through the same registry and
// expects `Date` objects for its `createdAt`/`expiresAt` columns. Handing it
// strings would break session expiry comparisons in a library this project does
// not control. So the REST engine passes its own registry to its own pools:
// `types` on a `pg` Pool/Client overrides the global one for that connection
// only (`Client` reads `options.types` and every result parses through it).
const REST_TEXT_PARSERS = new Map([
  [OID_DATE, (text) => text],
  [OID_TIMESTAMP, formatPgTimestamp],
  [OID_TIMESTAMPTZ, formatPgTimestamp],
]);

// pg's array tokenizer applies its own Date-producing element parser, and
// recovering text from a `Date` it already produced has lost the
// sub-millisecond digits. So arrays of temporal values are tokenized from the
// raw literal here instead. Splitting a Postgres array literal means honouring
// quotes and backslash escapes; that is what this does. A shape it does not
// recognise (a nested array) returns null and falls back to pg.
function splitArrayLiteral(text) {
  if (typeof text !== 'string' || !text.startsWith('{') || !text.endsWith('}')) {
    return null;
  }
  const body = text.slice(1, -1);
  if (body === '') return [];
  const out = [];
  let cur = '';
  let quoted = false;
  let sawQuote = false;
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === '\\' && i + 1 < body.length) { cur += body[i + 1]; i += 1; continue; }
    if (ch === '"') { quoted = !quoted; sawQuote = true; continue; }
    if (ch === ',' && !quoted) {
      out.push(cur === 'NULL' && !sawQuote ? null : cur);
      cur = '';
      sawQuote = false;
      continue;
    }
    cur += ch;
  }
  out.push(cur === 'NULL' && !sawQuote ? null : cur);
  return out;
}

for (const [arrayOid, elementParser] of [
  [OID_DATE_ARRAY, (t) => t],
  [OID_TIMESTAMP_ARRAY, formatPgTimestamp],
  [OID_TIMESTAMPTZ_ARRAY, formatPgTimestamp],
]) {
  REST_TEXT_PARSERS.set(arrayOid, (text) => {
    const parts = splitArrayLiteral(text);
    if (parts) return parts.map((v) => (v == null ? v : elementParser(v)));
    // A shape splitArrayLiteral does not handle (a nested array). Resolved
    // here rather than at module load: `pg.types` must not be touched while
    // this module is being imported, or a test that mocks `pg` with just a
    // Pool cannot import anything that reaches here.
    return pg.types.getTypeParser(arrayOid, 'text')(text);
  });
}

/**
 * The type registry the REST engine's own pools use: everything the global
 * registry does, plus temporal types rendered as PostgreSQL's json conversion
 * renders them. Pass as `types` when constructing a Pool.
 */
export const restPoolTypes = {
  getTypeParser(oid, format = 'text') {
    if (format === 'text' || format === undefined) {
      const parser = REST_TEXT_PARSERS.get(oid);
      if (parser) return parser;
    }
    return pg.types.getTypeParser(oid, format);
  },
};
