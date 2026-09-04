// view-sources.mjs — map a view's output columns back to base columns
//
// A view's rewrite rule (pg_rewrite.ev_action) is a pg_node_tree. Each
// TARGETENTRY in the top-level query's targetList records:
//
//   :resno       the view's own attnum for that output column
//   :resorigtbl  the oid of the relation the column ultimately came from
//                (0 when the column is an expression, not a plain column)
//   :resorigcol  the attnum of that source column
//
// PostgREST reads the same three fields (SchemaCache.hs,
// `allViewsKeyDependencies`) by rewriting the node tree into JSON inside
// SQL. Doing the parse in JavaScript keeps the SQL trivial and portable:
// only `ev_action::text` is needed.
//
// Nothing here touches user input — the input is catalog text.

function skipQuoted(s, i) {
  // s[i] === '"'
  i += 1;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '\\') { i += 2; continue; }
    if (ch === '"') return i + 1;
    i += 1;
  }
  return i;
}

// Skip a balanced `{...}` node or `(...)` list starting at s[i].
function skipGroup(s, i) {
  let depth = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') { i = skipQuoted(s, i); continue; }
    if (ch === '\\') { i += 2; continue; }
    if (ch === '{' || ch === '(') {
      depth += 1;
    } else if (ch === '}' || ch === ')') {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
    i += 1;
  }
  return i;
}

const WS = /\s/;

// Read one `{NODETAG :key value ...}` node starting at s[start].
// Returns the scalar fields declared directly on that node (nested
// nodes and lists are recorded as ranges in `groups`, not descended
// into), plus the index just past the closing brace.
function readNode(s, start) {
  const fields = Object.create(null);
  const groups = Object.create(null);
  let i = start + 1;

  while (i < s.length) {
    const ch = s[i];
    if (ch === '"') { i = skipQuoted(s, i); continue; }
    if (ch === '\\') { i += 2; continue; }
    if (ch === '{' || ch === '(') { i = skipGroup(s, i); continue; }
    if (ch === '}') return { fields, groups, end: i + 1 };
    if (ch === ':') {
      let j = i + 1;
      while (j < s.length && !WS.test(s[j]) && s[j] !== '}') j += 1;
      const key = s.slice(i + 1, j);
      let k = j;
      while (k < s.length && WS.test(s[k])) k += 1;
      if (k >= s.length) return { fields, groups, end: k };
      const vc = s[k];
      if (vc === '{' || vc === '(') {
        const end = skipGroup(s, k);
        groups[key] = [k, end];
        i = end;
      } else if (vc === '"') {
        const end = skipQuoted(s, k);
        fields[key] = s.slice(k + 1, end - 1);
        i = end;
      } else {
        let end = k;
        while (end < s.length && !WS.test(s[end])
               && s[end] !== '}' && s[end] !== ')') {
          end += 1;
        }
        fields[key] = s.slice(k, end);
        i = end;
      }
      continue;
    }
    i += 1;
  }
  return { fields, groups, end: i };
}

// Every top-level `{...}` node inside the list s[start..end).
function listNodes(s, start, end) {
  const out = [];
  let i = start + 1;
  while (i < end) {
    if (s[i] === '{') {
      const node = readNode(s, i);
      out.push(node);
      i = node.end;
      continue;
    }
    i += 1;
  }
  return out;
}

function toInt(val) {
  if (val === undefined || val === null) return null;
  const n = Number.parseInt(val, 10);
  return Number.isNaN(n) ? null : n;
}

/**
 * Parse one `ev_action` text into the view's column provenance.
 *
 * @param {string} evAction
 * @returns {Array<{attnum: number, srcOid: number, srcAttnum: number}>}
 */
export function parseViewTargetList(evAction) {
  if (typeof evAction !== 'string') return [];
  const first = evAction.indexOf('{');
  if (first === -1) return [];

  const query = readNode(evAction, first);
  const range = query.groups.targetList;
  if (!range) return [];

  const entries = [];
  for (const node of listNodes(evAction, range[0], range[1])) {
    const f = node.fields;
    if (f.resjunk === 'true') continue;
    const attnum = toInt(f.resno);
    const srcOid = toInt(f.resorigtbl);
    const srcAttnum = toInt(f.resorigcol);
    if (!attnum || !srcOid || !srcAttnum) continue;
    if (srcAttnum < 1) continue;
    entries.push({ attnum, srcOid, srcAttnum });
  }
  return entries;
}

/**
 * @param {Array<{view_oid: any, view_definition: string}>} rows
 * @returns {Map<number, Array<{attnum, srcOid, srcAttnum}>>}
 */
export function parseViewTargetLists(rows) {
  const byView = new Map();
  for (const row of rows || []) {
    const oid = toInt(row.view_oid);
    if (oid === null) continue;
    const entries = parseViewTargetList(row.view_definition);
    if (entries.length === 0) continue;
    byView.set(oid, entries);
  }
  return byView;
}

const MAX_VIEW_CHAIN = 12;

/**
 * Resolve every view column down to the base relation it came from,
 * following views built on views.
 *
 * @param {Map<number, Array<{attnum, srcOid, srcAttnum}>>} byView
 * @returns {Map<number, Array<{attnum, srcOid, srcAttnum}>>}
 *   Same shape, but srcOid is never itself a mapped view.
 */
export function resolveViewColumnSources(byView) {
  const resolved = new Map();
  for (const [viewOid, entries] of byView) {
    const out = [];
    for (const entry of entries) {
      let { srcOid, srcAttnum } = entry;
      const seen = new Set([viewOid]);
      for (let hop = 0; hop < MAX_VIEW_CHAIN; hop += 1) {
        if (!byView.has(srcOid) || seen.has(srcOid)) break;
        seen.add(srcOid);
        const next = byView.get(srcOid)
          .find(e => e.attnum === srcAttnum);
        if (!next) break;
        srcOid = next.srcOid;
        srcAttnum = next.srcAttnum;
      }
      if (byView.has(srcOid)) continue; // unresolvable chain
      out.push({ attnum: entry.attnum, srcOid, srcAttnum });
    }
    resolved.set(viewOid, out);
  }
  return resolved;
}
