// Minimal Haskell lexer, good enough for hspec test specs.
//
// Emits a flat token list with source positions. It understands the constructs
// that appear in PostgREST's test/spec/**/*.hs:
//   line comments (--), nested block comments ({- -}), pragmas,
//   string literals with Haskell escapes and string gaps, char literals,
//   quasi quotes ([json| ... |], [str| ... |], [aesonQQ| ... |]),
//   backtick infix operators (`shouldRespondWith`), symbolic operators,
//   numbers (including 1_000_000 separators), identifiers (including primes).
//
// Token shape:
//   { type, value, line, col, start, end, firstOfLine }
//   type: 'ident' | 'conid' | 'op' | 'punct' | 'string' | 'char' | 'number'
//         | 'quasi' | 'backtick'
//   'quasi' tokens carry { qq, raw }  (qq = quoter name, raw = literal body)
//   'string' tokens carry { raw, value } (value = escape-decoded)
//   'backtick' tokens carry value = the inner name, without backticks

const SYMBOL_CHARS = new Set('!#$%&*+./<=>?@\\^|-~:'.split(''));
const PUNCT_CHARS = new Set('()[]{},;`'.split(''));

const isDigit = (c) => c >= '0' && c <= '9';
const isLower = (c) => (c >= 'a' && c <= 'z') || c === '_';
const isUpper = (c) => c >= 'A' && c <= 'Z';
const isAlpha = (c) => isLower(c) || isUpper(c);
const isIdentChar = (c) => isAlpha(c) || isDigit(c) || c === "'";
const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';

const ESCAPES = {
  a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v',
  '\\': '\\', '"': '"', "'": "'",
};

const ASCII_ESCAPES = {
  NUL: '\0', SOH: '\x01', STX: '\x02', ETX: '\x03', EOT: '\x04', ENQ: '\x05',
  ACK: '\x06', BEL: '\x07', BS: '\b', HT: '\t', LF: '\n', VT: '\v', FF: '\f',
  CR: '\r', SO: '\x0e', SI: '\x0f', DLE: '\x10', DC1: '\x11', DC2: '\x12',
  DC3: '\x13', DC4: '\x14', NAK: '\x15', SYN: '\x16', ETB: '\x17', CAN: '\x18',
  EM: '\x19', SUB: '\x1a', ESC: '\x1b', FS: '\x1c', GS: '\x1d', RS: '\x1e',
  US: '\x1f', SP: ' ', DEL: '\x7f',
};
// Longest first so 'SOH' wins over 'SO'.
const ASCII_KEYS = Object.keys(ASCII_ESCAPES).sort((a, b) => b.length - a.length);

/**
 * Decode the body of a Haskell string literal (contents between the quotes).
 * Returns { value, ok }. ok=false when an escape could not be decoded.
 */
export function decodeHaskellString(raw) {
  let out = '';
  let ok = true;
  let i = 0;
  while (i < raw.length) {
    const c = raw[i];
    if (c !== '\\') { out += c; i += 1; continue; }
    i += 1;
    if (i >= raw.length) { ok = false; break; }
    const n = raw[i];
    // String gap: backslash, whitespace..., backslash
    if (isSpace(n)) {
      let j = i;
      while (j < raw.length && isSpace(raw[j])) j += 1;
      if (raw[j] === '\\') { i = j + 1; continue; }
      ok = false; i = j; continue;
    }
    if (n === '&') { i += 1; continue; }          // empty escape
    if (n in ESCAPES) { out += ESCAPES[n]; i += 1; continue; }
    if (n === 'x' || n === 'X') {
      let j = i + 1, hex = '';
      while (j < raw.length && /[0-9a-fA-F]/.test(raw[j])) { hex += raw[j]; j += 1; }
      if (hex) { out += String.fromCodePoint(parseInt(hex, 16)); i = j; continue; }
      ok = false; i += 1; continue;
    }
    if (n === 'o' || n === 'O') {
      let j = i + 1, oct = '';
      while (j < raw.length && /[0-7]/.test(raw[j])) { oct += raw[j]; j += 1; }
      if (oct) { out += String.fromCodePoint(parseInt(oct, 8)); i = j; continue; }
      ok = false; i += 1; continue;
    }
    if (isDigit(n)) {
      let j = i, dec = '';
      while (j < raw.length && isDigit(raw[j])) { dec += raw[j]; j += 1; }
      out += String.fromCodePoint(parseInt(dec, 10));
      i = j; continue;
    }
    if (n === '^' && i + 1 < raw.length) {
      const ctl = raw.charCodeAt(i + 1);
      out += String.fromCharCode(ctl - 64);
      i += 2; continue;
    }
    const key = ASCII_KEYS.find((k) => raw.startsWith(k, i));
    if (key) { out += ASCII_ESCAPES[key]; i += key.length; continue; }
    ok = false; i += 1;
  }
  return { value: out, ok };
}

export function lex(src) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const n = src.length;

  const col = () => i - lineStart + 1;
  const advanceNewlines = (from, to) => {
    for (let k = from; k < to; k += 1) {
      if (src[k] === '\n') { line += 1; lineStart = k + 1; }
    }
  };
  const push = (tok) => {
    tokens.push(tok);
  };

  while (i < n) {
    const c = src[i];

    if (c === '\n') { line += 1; i += 1; lineStart = i; continue; }
    if (isSpace(c)) { i += 1; continue; }

    // Block comment / pragma
    if (c === '{' && src[i + 1] === '-') {
      let depth = 1;
      let j = i + 2;
      while (j < n && depth > 0) {
        if (src[j] === '{' && src[j + 1] === '-') { depth += 1; j += 2; }
        else if (src[j] === '-' && src[j + 1] === '}') { depth -= 1; j += 2; }
        else j += 1;
      }
      advanceNewlines(i, j);
      i = j;
      continue;
    }

    // Line comment: two or more dashes not followed by a symbol char
    if (c === '-' && src[i + 1] === '-') {
      let j = i;
      while (j < n && src[j] === '-') j += 1;
      if (j - i >= 2 && !(j < n && SYMBOL_CHARS.has(src[j]))) {
        while (j < n && src[j] !== '\n') j += 1;
        i = j;
        continue;
      }
      // else: falls through to operator handling
    }

    const startLine = line;
    const startCol = col();
    const start = i;

    // Quasi quote: [name| ... |]
    if (c === '[') {
      const m = /^\[([a-zA-Z][a-zA-Z0-9_']*)\|/.exec(src.slice(i, i + 40));
      if (m) {
        const bodyStart = i + m[0].length;
        const close = src.indexOf('|]', bodyStart);
        const end = close === -1 ? n : close + 2;
        const raw = src.slice(bodyStart, close === -1 ? n : close);
        advanceNewlines(i, end);
        push({
          type: 'quasi', value: m[1], qq: m[1], raw,
          line: startLine, col: startCol, start, end,
        });
        i = end;
        continue;
      }
    }

    // String literal
    if (c === '"') {
      let j = i + 1;
      let raw = '';
      while (j < n) {
        if (src[j] === '\\') { raw += src[j] + (src[j + 1] ?? ''); j += 2; continue; }
        if (src[j] === '"') break;
        raw += src[j];
        j += 1;
      }
      const end = Math.min(j + 1, n);
      advanceNewlines(i, end);
      const dec = decodeHaskellString(raw);
      push({
        type: 'string', value: dec.value, raw, decodeOk: dec.ok,
        line: startLine, col: startCol, start, end,
      });
      i = end;
      continue;
    }

    // Char literal: '"'  'a'  '\n'  '\''
    if (c === "'") {
      const m = /^'(\\[^']*|[^'\\])'/.exec(src.slice(i, i + 12));
      if (m) {
        const end = i + m[0].length;
        push({ type: 'char', value: decodeHaskellString(m[1]).value, line: startLine, col: startCol, start, end });
        i = end;
        continue;
      }
    }

    // Backtick infix operator
    if (c === '`') {
      const m = /^`([A-Za-z_][A-Za-z0-9_'.]*)`/.exec(src.slice(i, i + 80));
      if (m) {
        const end = i + m[0].length;
        push({ type: 'backtick', value: m[1], line: startLine, col: startCol, start, end });
        i = end;
        continue;
      }
    }

    // Identifier / constructor (with qualified module prefixes: JSON.encode)
    if (isAlpha(c)) {
      let j = i;
      while (j < n && isIdentChar(src[j])) j += 1;
      // qualified name
      while (src[j] === '.' && j + 1 < n && isAlpha(src[j + 1]) && isUpper(src[i])) {
        j += 1;
        while (j < n && isIdentChar(src[j])) j += 1;
      }
      const value = src.slice(i, j);
      const lastSeg = value.split('.').pop();
      push({
        type: isUpper(lastSeg[0]) ? 'conid' : 'ident',
        value, line: startLine, col: startCol, start, end: j,
      });
      i = j;
      continue;
    }

    // Number
    if (isDigit(c)) {
      let j = i;
      while (j < n && (isDigit(src[j]) || src[j] === '_')) j += 1;
      if (src[j] === '.' && isDigit(src[j + 1])) {
        j += 1;
        while (j < n && (isDigit(src[j]) || src[j] === '_')) j += 1;
      }
      if ((src[j] === 'e' || src[j] === 'E') && (isDigit(src[j + 1]) || ((src[j + 1] === '-' || src[j + 1] === '+') && isDigit(src[j + 2])))) {
        j += 2;
        while (j < n && isDigit(src[j])) j += 1;
      }
      const text = src.slice(i, j).replace(/_/g, '');
      push({ type: 'number', value: text, num: Number(text), line: startLine, col: startCol, start, end: j });
      i = j;
      continue;
    }

    // Punctuation
    if (PUNCT_CHARS.has(c)) {
      push({ type: 'punct', value: c, line: startLine, col: startCol, start, end: i + 1 });
      i += 1;
      continue;
    }

    // Symbolic operator
    if (SYMBOL_CHARS.has(c)) {
      let j = i;
      while (j < n && SYMBOL_CHARS.has(src[j])) j += 1;
      push({ type: 'op', value: src.slice(i, j), line: startLine, col: startCol, start, end: j });
      i = j;
      continue;
    }

    // Anything else: emit as an opaque op so the parser can bail out on it.
    push({ type: 'op', value: c, line: startLine, col: startCol, start, end: i + 1 });
    i += 1;
  }

  // firstOfLine flags
  let prevLine = 0;
  for (const t of tokens) {
    t.firstOfLine = t.line !== prevLine;
    prevLine = t.line;
  }
  return tokens;
}
