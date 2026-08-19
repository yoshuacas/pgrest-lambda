// response.mjs — Format responses with PostgREST headers
//
// Wire behaviour mirrors upstream PostgREST's `PostgREST.Response` and
// `PostgREST.MediaType`:
//
//   * Content-Type carries the negotiated media type plus `charset=utf-8`
//     (`toContentType`/`toMime`).
//   * A response with no body carries no Content-Type at all — upstream only
//     appends `contentTypeHeaders` on the branches that also carry bytes, so a
//     204 or a `return=minimal` mutation has none.
//   * `application/vnd.pgrst.object+json` is the singular media type; asking
//     for it and getting anything but exactly one row is PGRST116.
//   * `nulls=stripped` on the array/object media types drops null members
//     recursively (upstream `json_strip_nulls`).

import { PostgRESTError } from './errors.mjs';
import { CORS_HEADERS } from '../shared/cors.mjs';

const CHARSET = '; charset=utf-8';

export const MEDIA_JSON = 'json';
export const MEDIA_SINGULAR = 'singular';
export const MEDIA_CSV = 'csv';
export const MEDIA_OPENAPI = 'openapi';
export const MEDIA_OTHER = 'other';

/**
 * Split one media type into `{ main, sub, params }`, lowercasing the type and
 * the parameter names (RFC 7231 §3.1.1.1); parameter values keep their case.
 *
 * @param {string} raw
 */
export function decodeMediaType(raw) {
  const parts = String(raw).split(';');
  const [main = '', sub = ''] = parts[0].trim().toLowerCase().split('/');
  const params = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf('=');
    if (eq === -1) continue;
    const name = p.slice(0, eq).trim().toLowerCase();
    const value = p.slice(eq + 1).trim().replace(/^"|"$/g, '');
    params[name] = value;
  }
  return { main, sub, params };
}

function classify({ main, sub, params }) {
  const stripNulls = params.nulls === 'stripped';
  if (main === '*' && sub === '*') return { kind: MEDIA_JSON, stripNulls: false };
  if (main === 'application') {
    if (sub === 'json') return { kind: MEDIA_JSON, stripNulls: false };
    if (sub === 'openapi+json') return { kind: MEDIA_OPENAPI, stripNulls: false };
    if (sub === 'vnd.pgrst.object' || sub === 'vnd.pgrst.object+json') {
      return { kind: MEDIA_SINGULAR, stripNulls };
    }
    if (sub === 'vnd.pgrst.array' || sub === 'vnd.pgrst.array+json') {
      return { kind: MEDIA_JSON, stripNulls };
    }
  }
  if (main === 'text' && sub === 'csv') return { kind: MEDIA_CSV, stripNulls: false };
  return null;
}

// The media types upstream knows by name (`MediaType.decodeMediaType`). Their
// Content-Type carries `; charset=utf-8`; everything else — `MTOther`, and
// `application/octet-stream` — is sent bare (`MediaType.toContentType`).
const CHARSET_MIMES = new Set([
  'application/json',
  'application/geo+json',
  'application/openapi+json',
  'application/x-www-form-urlencoded',
  'application/vnd.pgrst.array+json',
  'application/vnd.pgrst.object+json',
  'text/csv',
  'text/plain',
  'text/xml',
]);

/**
 * The Content-Type bytes for one mime string, adding `; charset=utf-8` only for
 * the media types upstream has a constructor for.
 *
 * @param {string} mime
 */
export function mimeContentType(mime) {
  const bare = String(mime).split(';')[0].trim().toLowerCase();
  return CHARSET_MIMES.has(bare) ? `${mime}${CHARSET}` : String(mime);
}

/**
 * The exact Content-Type bytes for a negotiated media type.
 *
 * @param {{kind: string, stripNulls: boolean, mime?: string,
 *          contentType?: string}} media
 */
export function mediaContentType(media) {
  const strip = media.stripNulls ? ';nulls=stripped' : '';
  switch (media.kind) {
    case MEDIA_SINGULAR:
      return `application/vnd.pgrst.object+json${strip}${CHARSET}`;
    case MEDIA_CSV:
      return `text/csv${CHARSET}`;
    case MEDIA_OPENAPI:
      return `application/openapi+json${CHARSET}`;
    case MEDIA_OTHER:
      return media.contentType || media.mime || `application/json${CHARSET}`;
    default:
      return media.stripNulls
        ? `application/vnd.pgrst.array+json;nulls=stripped${CHARSET}`
        : `application/json${CHARSET}`;
  }
}

/**
 * Pick the response media type from an Accept header. Entries are tried in the
 * order they were sent (q-values are parsed only well enough to sort by them);
 * the first one this engine can produce wins. An Accept naming nothing we can
 * produce falls back to JSON but is reported as `MEDIA_OTHER` so the caller can
 * decide whether to refuse it.
 *
 * @param {string} accept
 */
export function negotiateMedia(accept) {
  const fallback = { kind: MEDIA_JSON, stripNulls: false };
  const raw = (accept || '').trim();
  if (!raw) return fallback;

  const entries = raw.split(',')
    .map((e) => e.trim())
    .filter(Boolean)
    .map((e, i) => {
      const decoded = decodeMediaType(e);
      const q = Number(decoded.params.q);
      return {
        decoded,
        order: i,
        q: Number.isFinite(q) ? q : 1,
      };
    })
    .sort((a, b) => (b.q - a.q) || (a.order - b.order));

  for (const entry of entries) {
    const hit = classify(entry.decoded);
    if (hit) return hit;
  }

  const first = entries[0];
  return {
    kind: MEDIA_OTHER,
    stripNulls: false,
    mime: first ? `${first.decoded.main}/${first.decoded.sub}` : undefined,
  };
}

/**
 * Split an Accept header into its entries, trimmed, in the order sent.
 *
 * @param {string} accept
 */
export function acceptEntries(accept) {
  return String(accept || '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
}

/**
 * Upstream's `MediaTypeError` (Error.hs:181): 406 PGRST107, message listing
 * every media type the client asked for.
 *
 * @param {string} accept
 */
export function mediaUnavailable(accept) {
  return new PostgRESTError(
    406,
    'PGRST107',
    'None of these media types are available: '
      + acceptEntries(accept).join(', '),
    null,
    null,
  );
}

/**
 * Can this engine produce the negotiated media type? Upstream negotiates
 * against the media handlers in the schema cache; the ones every relation gets
 * are the wildcard, `application/json`, `text/csv` and `application/geo+json`
 * (`SchemaCache.initialMediaHandlers`), plus the vendored `vnd.pgrst.*` types,
 * which cannot be overridden. This engine has no geojson aggregate — that needs
 * PostGIS — so geo+json is not producible here either.
 *
 * @param {{kind: string}} media
 */
export function mediaProducible(media) {
  return media?.kind !== MEDIA_OTHER;
}

/**
 * A domain whose name is a media type — `create domain "text/plain" as text` —
 * declares the media type a function returning it produces (upstream
 * `SchemaCache.mediaHandlers`). The wildcard domain is the catch-all: it
 * resolves to `application/octet-stream`.
 *
 * @param {string} typeName  the return type's `pg_type.typname`
 * @returns {string|null} the media type this type declares, or null
 */
export function mediaTypeDomain(typeName) {
  const name = String(typeName || '');
  if (name === '*/*') return 'application/octet-stream';
  return /^[A-Za-z0-9.-]+\/[A-Za-z0-9.+-]+$/.test(name)
    ? name.toLowerCase()
    : null;
}

/**
 * The media type to serve a scalar with, when its Postgres type is a media type
 * domain and the client asked for that type. A wildcard domain matches any
 * Accept; any other domain matches only its own name. A wildcard Accept does
 * not match a
 * named domain — upstream falls back to the built-in JSON handler there
 * (`Plan/Negotiate.hs lookupHandler` looks up `(RelId, MTAny)`, which only the
 * wildcard domain registers).
 *
 * @param {string} accept
 * @param {string} typeName  the routine's return `typname`
 * @returns {{kind: string, stripNulls: boolean, contentType: string}|null}
 */
export function rawMediaFor(accept, typeName) {
  const domain = mediaTypeDomain(typeName);
  if (!domain) return null;
  const raw = { kind: MEDIA_OTHER, stripNulls: false, raw: true,
    contentType: mimeContentType(domain) };
  if (domain === 'application/octet-stream' && typeName === '*/*') return raw;
  const asked = acceptEntries(accept)
    .map((e) => `${decodeMediaType(e).main}/${decodeMediaType(e).sub}`);
  return asked.includes(domain) ? raw : null;
}

/**
 * Drop null members recursively, matching Postgres `json_strip_nulls`:
 * object keys whose value is null go away, array elements do not.
 */
export function stripNulls(value) {
  if (Array.isArray(value)) return value.map(stripNulls);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (v === null) continue;
      out[k] = stripNulls(v);
    }
    return out;
  }
  return value;
}

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'object'
    ? JSON.stringify(value)
    : String(value);
  return /[",\n\r]/.test(text) || text === ''
    ? `"${text.replaceAll('"', '""')}"`
    : text;
}

/**
 * Render rows as CSV the way upstream's `asCsvF` does: one header line taken
 * from the first row's keys, then one line per row, no trailing newline.
 */
export function toCsv(rows) {
  const list = Array.isArray(rows) ? rows : [rows];
  if (list.length === 0) return '\n';
  const keys = Object.keys(list[0] || {});
  const header = keys.join(',');
  const body = list
    .map((row) => keys.map((k) => csvCell(row?.[k])).join(','))
    .join('\n');
  return `${header}\n${body}`;
}

function singularize(body) {
  const rows = Array.isArray(body) ? body : [body];
  if (rows.length !== 1) {
    throw new PostgRESTError(
      406,
      'PGRST116',
      'Cannot coerce the result to a single JSON object',
      `The result contains ${rows.length} rows`,
      null,
    );
  }
  return rows[0];
}

/**
 * Build a successful API Gateway proxy result.
 *
 * @param {number} statusCode
 * @param {*} body                     rows, spec object, or null for no body
 * @param {Object} [options]
 * @param {string} [options.contentRange]
 * @param {string} [options.preferenceApplied]
 * @param {boolean} [options.singleObject]  force singular coercion
 * @param {Object} [options.media]          from negotiateMedia()
 * @param {boolean} [options.headersOnly]   HEAD: keep headers, drop the body
 * @param {string} [options.serializedBody] pre-rendered bytes; use when the
 *        body is a bare JSON value (a scalar function result) and `null` has
 *        to be sent as the four bytes `null` rather than as "no body"
 * @param {Object} [options.corsHeaders]
 * @param {Object} [options.extraHeaders]
 */
export function success(statusCode, body, options = {}) {
  const {
    contentRange, singleObject, corsHeaders, preferenceApplied,
    headersOnly, extraHeaders, serializedBody,
  } = options;
  const media = options.media
    || { kind: singleObject ? MEDIA_SINGULAR : MEDIA_JSON, stripNulls: false };
  const cors = corsHeaders || CORS_HEADERS;

  const headers = { ...cors, ...(extraHeaders || null) };
  if (contentRange != null) headers['Content-Range'] = contentRange;
  if (preferenceApplied) headers['Preference-Applied'] = preferenceApplied;

  if (serializedBody != null) {
    headers['Content-Type'] = mediaContentType(media);
    return {
      statusCode,
      headers,
      body: headersOnly ? '' : serializedBody,
    };
  }

  // No body means no Content-Type: upstream only emits one on the branches
  // that actually serialize rows, and a 204 with a Content-Type makes clients
  // (and the PostgREST test suite) expect bytes that are not coming. The CORS
  // block no longer carries a default one, so nothing has to be removed here;
  // the delete only guards against a caller passing one in `extraHeaders`.
  if (body == null) {
    delete headers['Content-Type'];
    return { statusCode, headers, body: '' };
  }

  const wantSingular = singleObject || media.kind === MEDIA_SINGULAR;
  let value = wantSingular ? singularize(body) : body;
  if (media.stripNulls) value = stripNulls(value);

  headers['Content-Type'] = mediaContentType(media);

  if (headersOnly) {
    return { statusCode, headers, body: '' };
  }

  return {
    statusCode,
    headers,
    body: media.kind === MEDIA_CSV ? toCsv(value) : JSON.stringify(value),
  };
}

export function error(err, corsHeaders, extraHeaders) {
  const cors = corsHeaders || CORS_HEADERS;
  const base = {
    ...cors,
    ...(extraHeaders || null),
    'Content-Type': `application/json${CHARSET}`,
  };

  if (err instanceof PostgRESTError) {
    return {
      statusCode: err.statusCode,
      headers: base,
      body: JSON.stringify(err.toJSON()),
    };
  }

  return {
    statusCode: 500,
    headers: base,
    body: JSON.stringify({
      code: 'PGRST000',
      message: err.message || 'Internal server error',
      details: null,
      hint: null,
    }),
  };
}
