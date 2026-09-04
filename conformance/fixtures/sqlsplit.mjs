// sqlsplit.mjs — SQL lexing helpers shared by the fixture transformer.
//
// Everything here is text-level: enough structure to split statements, walk
// parenthesised lists and recognise keywords without pulling in a parser
// dependency. It understands the quoting rules the PostgREST fixtures use:
// line/block comments, single-quoted literals (with '' and E'\' escapes),
// double-quoted identifiers (with "" escapes) and dollar-quoted bodies.

/**
 * Scan `src` from `i` and return the index just past the construct that starts
 * at `i`, or -1 when nothing special starts there.
 */
function skipQuoted(src, i) {
  const c = src[i];

  if (c === '-' && src[i + 1] === '-') {
    const nl = src.indexOf('\n', i);
    return nl === -1 ? src.length : nl;
  }

  if (c === '/' && src[i + 1] === '*') {
    let depth = 1;
    let j = i + 2;
    while (j < src.length && depth > 0) {
      if (src[j] === '/' && src[j + 1] === '*') { depth++; j += 2; }
      else if (src[j] === '*' && src[j + 1] === '/') { depth--; j += 2; }
      else j++;
    }
    return j;
  }

  if (c === "'") {
    // Backslash only escapes inside E'...'. standard_conforming_strings is on
    // for the fixtures, so '\' is a one-character literal, not an open quote.
    const isEString = i > 0 && /[Ee]/.test(src[i - 1])
      && !(i > 1 && /[A-Za-z0-9_$]/.test(src[i - 2]));
    let j = i + 1;
    while (j < src.length) {
      if (isEString && src[j] === '\\') { j += 2; continue; }
      if (src[j] === "'") {
        if (src[j + 1] === "'") { j += 2; continue; }
        return j + 1;
      }
      j++;
    }
    return src.length;
  }

  if (c === '"') {
    let j = i + 1;
    while (j < src.length) {
      if (src[j] === '"') {
        if (src[j + 1] === '"') { j += 2; continue; }
        return j + 1;
      }
      j++;
    }
    return src.length;
  }

  if (c === '$') {
    // A dollar-quote tag cannot follow an identifier character: `do$llar$s` is
    // one identifier, not a quoted body. The upstream fixtures rely on this.
    if (i > 0 && /[A-Za-z0-9_$-￿]/.test(src[i - 1])) return -1;
    const m = /^\$[A-Za-z_-￿][A-Za-z_0-9-￿]*\$|^\$\$/.exec(src.slice(i));
    if (!m) return -1;
    const tag = m[0];
    const end = src.indexOf(tag, i + tag.length);
    return end === -1 ? src.length : end + tag.length;
  }

  return -1;
}

/**
 * Split a SQL script into statements. psql meta-commands (lines starting with
 * a backslash) are returned with kind 'meta' so the caller can drop them
 * knowingly rather than silently.
 *
 * @returns {{text:string, line:number, kind:'sql'|'meta'}[]}
 */
export function splitStatements(src) {
  const out = [];
  let start = 0;
  let i = 0;
  let line = 1;
  let stmtLine = 1;
  let sawContent = false;

  const push = (endExclusive) => {
    const text = src.slice(start, endExclusive);
    if (text.trim()) out.push({ text: text.trim(), line: stmtLine, kind: 'sql' });
    start = endExclusive;
    sawContent = false;
  };

  while (i < src.length) {
    const c = src[i];

    if (c === '\n') { line++; i++; continue; }

    if (!sawContent && c === '\\' && (i === 0 || src[i - 1] === '\n')) {
      const nl = src.indexOf('\n', i);
      const end = nl === -1 ? src.length : nl;
      const text = src.slice(i, end).trim();
      // flush anything pending before the meta command
      if (src.slice(start, i).trim()) push(i);
      if (text) out.push({ text, line, kind: 'meta' });
      start = end;
      i = end;
      continue;
    }

    const skipped = skipQuoted(src, i);
    if (skipped !== -1) {
      for (let k = i; k < skipped; k++) if (src[k] === '\n') line++;
      if (!/^[-/]/.test(c)) sawContent = true;
      i = skipped;
      continue;
    }

    if (c === ';') {
      push(i + 1);
      i++;
      stmtLine = line;
      continue;
    }

    if (!/\s/.test(c)) {
      if (!sawContent) stmtLine = line;
      sawContent = true;
    }
    i++;
  }

  push(src.length);
  return out;
}

/** Remove comments from a statement, preserving string/identifier literals. */
export function stripComments(sql) {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if ((c === '-' && sql[i + 1] === '-') || (c === '/' && sql[i + 1] === '*')) {
      const end = skipQuoted(sql, i);
      out += ' ';
      i = end;
      continue;
    }
    const skipped = skipQuoted(sql, i);
    if (skipped !== -1) { out += sql.slice(i, skipped); i = skipped; continue; }
    out += c;
    i++;
  }
  return out;
}

/** Comment-free, whitespace-collapsed, lowercased form used for matching. */
export function norm(sql) {
  return stripComments(sql).replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Index of the `)` matching the `(` at `openIdx`, or -1.
 */
export function matchParen(sql, openIdx) {
  let depth = 0;
  let i = openIdx;
  while (i < sql.length) {
    const skipped = skipQuoted(sql, i);
    if (skipped !== -1) { i = skipped; continue; }
    if (sql[i] === '(') depth++;
    else if (sql[i] === ')') { depth--; if (depth === 0) return i; }
    i++;
  }
  return -1;
}

/** Index of the first top-level (depth 0, unquoted) occurrence of `ch`. */
export function findTopLevel(sql, ch, from = 0) {
  let depth = 0;
  let i = from;
  while (i < sql.length) {
    const skipped = skipQuoted(sql, i);
    if (skipped !== -1) { i = skipped; continue; }
    const c = sql[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (depth === 0 && c === ch) return i;
    i++;
  }
  return -1;
}

/** Split on top-level commas. */
export function splitCommas(body) {
  const parts = [];
  let depth = 0;
  let start = 0;
  let i = 0;
  while (i < body.length) {
    const skipped = skipQuoted(body, i);
    if (skipped !== -1) { i = skipped; continue; }
    const c = body[i];
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === ',' && depth === 0) { parts.push(body.slice(start, i)); start = i + 1; }
    i++;
  }
  parts.push(body.slice(start));
  return parts;
}

const WORD_RE = /^[A-Za-z_-￿][A-Za-z_0-9$-￿]*/;

/**
 * Tokenize a fragment into words / quoted identifiers / literals / punctuation.
 * @returns {{v:string, kind:'word'|'ident'|'string'|'punct'|'number'|'dollar'|'comment', start:number, end:number}[]}
 */
export function tokenize(sql) {
  const out = [];
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (/\s/.test(c)) { i++; continue; }

    if ((c === '-' && sql[i + 1] === '-') || (c === '/' && sql[i + 1] === '*')) {
      const end = skipQuoted(sql, i);
      out.push({ v: sql.slice(i, end), kind: 'comment', start: i, end });
      i = end;
      continue;
    }
    if (c === "'") {
      const end = skipQuoted(sql, i);
      out.push({ v: sql.slice(i, end), kind: 'string', start: i, end });
      i = end;
      continue;
    }
    if (c === '"') {
      const end = skipQuoted(sql, i);
      out.push({ v: sql.slice(i, end), kind: 'ident', start: i, end });
      i = end;
      continue;
    }
    if (c === '$') {
      const end = skipQuoted(sql, i);
      if (end !== -1) {
        out.push({ v: sql.slice(i, end), kind: 'dollar', start: i, end });
        i = end;
        continue;
      }
    }
    const w = WORD_RE.exec(sql.slice(i));
    if (w) {
      out.push({ v: w[0], kind: 'word', start: i, end: i + w[0].length });
      i += w[0].length;
      continue;
    }
    const n = /^[0-9][0-9.eE+-]*/.exec(sql.slice(i));
    if (n && /^[0-9]/.test(c)) {
      out.push({ v: n[0], kind: 'number', start: i, end: i + n[0].length });
      i += n[0].length;
      continue;
    }
    out.push({ v: c, kind: 'punct', start: i, end: i + 1 });
    i++;
  }
  return out;
}

/** Lowercase an identifier token: unquote `"Foo"` to Foo, downcase bare words. */
export function identValue(tok) {
  if (!tok) return '';
  if (tok.kind === 'ident') return tok.v.slice(1, -1).replace(/""/g, '"');
  return tok.v.toLowerCase();
}

/**
 * Parse a possibly schema-qualified object name starting at token index `i`.
 * @returns {{schema:string|null, name:string, next:number, raw:string}}
 */
export function parseQualifiedName(toks, i) {
  const first = toks[i];
  if (!first) return { schema: null, name: '', next: i, raw: '' };
  let schema = null;
  let name = identValue(first);
  let raw = first.v;
  let next = i + 1;
  if (toks[next] && toks[next].v === '.' && toks[next + 1]) {
    schema = name;
    name = identValue(toks[next + 2 - 1]);
    raw = `${raw}.${toks[next + 1].v}`;
    next = next + 2;
  }
  return { schema, name, next, raw };
}
