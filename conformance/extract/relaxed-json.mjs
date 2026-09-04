// Parser for the JSON dialect accepted by aeson-qq, which is what the
// [json| ... |] and [aesonQQ| ... |] quasi quoters in the PostgREST specs use.
//
// Differences from strict JSON that actually occur in the specs:
//   - object keys may be bare identifiers:  [json| [{ id: 1 }] |]
//   - arbitrary whitespace / newlines
//   - Haskell splices #{expr} (rejected: not statically representable)
//
// Returns { ok: true, value } or { ok: false, error }.

const IDENT_START = /[A-Za-z_$]/;
const IDENT_CHAR = /[A-Za-z0-9_$'-]/;

export function parseRelaxedJson(text) {
  if (text.includes('#{')) {
    return { ok: false, error: 'json quasi quote contains a Haskell splice #{...}' };
  }
  const s = text;
  let i = 0;

  const fail = (msg) => { throw new SyntaxError(`${msg} at offset ${i}`); };

  const ws = () => {
    for (;;) {
      while (i < s.length && /\s/.test(s[i])) i += 1;
      if (s[i] === '-' && s[i + 1] === '-') { // aeson-qq tolerates nothing here, but be safe
        break;
      }
      break;
    }
  };

  const parseValue = () => {
    ws();
    if (i >= s.length) fail('unexpected end of input');
    const c = s[i];
    if (c === '{') return parseObject();
    if (c === '[') return parseArray();
    if (c === '"') return parseString();
    if (c === '-' || (c >= '0' && c <= '9')) return parseNumber();
    if (s.startsWith('true', i)) { i += 4; return true; }
    if (s.startsWith('false', i)) { i += 5; return false; }
    if (s.startsWith('null', i)) { i += 4; return null; }
    return fail(`unexpected character ${JSON.stringify(c)}`);
  };

  const parseObject = () => {
    i += 1; // {
    const obj = {};
    ws();
    if (s[i] === '}') { i += 1; return obj; }
    for (;;) {
      ws();
      let key;
      if (s[i] === '"') key = parseString();
      else if (IDENT_START.test(s[i] ?? '')) {
        const start = i;
        while (i < s.length && IDENT_CHAR.test(s[i])) i += 1;
        key = s.slice(start, i);
      } else return fail('expected object key');
      ws();
      if (s[i] !== ':') return fail('expected ":" after object key');
      i += 1;
      obj[key] = parseValue();
      ws();
      if (s[i] === ',') { i += 1; continue; }
      if (s[i] === '}') { i += 1; return obj; }
      return fail('expected "," or "}" in object');
    }
  };

  const parseArray = () => {
    i += 1; // [
    const arr = [];
    ws();
    if (s[i] === ']') { i += 1; return arr; }
    for (;;) {
      arr.push(parseValue());
      ws();
      if (s[i] === ',') { i += 1; continue; }
      if (s[i] === ']') { i += 1; return arr; }
      return fail('expected "," or "]" in array');
    }
  };

  const parseString = () => {
    i += 1; // opening quote
    let out = '';
    while (i < s.length && s[i] !== '"') {
      if (s[i] === '\\') {
        const e = s[i + 1];
        i += 2;
        switch (e) {
          case 'n': out += '\n'; break;
          case 't': out += '\t'; break;
          case 'r': out += '\r'; break;
          case 'b': out += '\b'; break;
          case 'f': out += '\f'; break;
          case '/': out += '/'; break;
          case '"': out += '"'; break;
          case '\\': out += '\\'; break;
          case 'u': {
            const hex = s.slice(i, i + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) return fail('bad \\u escape');
            out += String.fromCharCode(parseInt(hex, 16));
            i += 4;
            break;
          }
          default: return fail(`bad string escape \\${e}`);
        }
        continue;
      }
      out += s[i];
      i += 1;
    }
    if (s[i] !== '"') return fail('unterminated string');
    i += 1;
    return out;
  };

  const parseNumber = () => {
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(s.slice(i));
    if (!m) return fail('bad number');
    i += m[0].length;
    return Number(m[0]);
  };

  try {
    const v = parseValue();
    ws();
    if (i < s.length) fail('trailing content');
    return { ok: true, value: v };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * Decode a Text.Heredoc [str| ... |] body.
 *
 * Heredoc keeps the first line verbatim; every subsequent line has its leading
 * whitespace and a single '|' stripped. The closing '|]' sits on its own
 * (whitespace-only) continuation line, which means the previous line ended with
 * a newline.
 */
export function decodeHeredoc(raw) {
  const lines = raw.split('\n');
  if (lines.length === 1) return lines[0];
  const stripPipe = (l) => l.replace(/^[ \t]*\|/, '');
  const body = [lines[0], ...lines.slice(1, -1).map(stripPipe)];
  const tail = lines[lines.length - 1];
  if (/^[ \t]*$/.test(tail)) return `${body.join('\n')}\n`;
  return `${body.join('\n')}\n${stripPipe(tail)}`;
}
