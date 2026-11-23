// (v1.13.2, P0-6a/b) Tool arguments checked against the tool's inputSchema: on the server before they reach the
// editor tab (mcp/protocol.js, server.js), and in the editor for commands pasted in the AI · MCP panel
// (bridge.runLocal). No DOM here. The v1 contract only grows (docs/MCP_COMPATIBILITY_REPORT.md), so this never
// refuses a call that worked before:
//   refused  — a value whose type can not be what the schema says, even after the conversions the editor already
//              made (an object for a number; "abc" for a number, which became NaN and was saved into the project).
//   converted — what the editor converted anyway, done here once: "1.5" → 1.5, "true" → true, 12 → "12".
//   noted    — what the editor handles itself (it may default, clamp or ignore): a missing required field, a value
//              outside an enum or a range, an unknown field. The call goes on; a note in the result tells the AI.
// null means "not given" for the editor: it is passed on untouched.

const kind = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
const show = (v) => { const s = JSON.stringify(v); return s && s.length > 40 ? `${s.slice(0, 37)}...` : s; };

/**
 * Check `args` against `schema`. Returns { args (converted copy), errors: [{ field, message }], notes: [string] }.
 */
export function checkArgs(schema, args) {
  const errors = [];
  const notes = [];
  const value = check(schema || {}, args ?? {}, '', errors, notes);
  return { args: value, errors, notes };
}

function check(s, v, at, errors, notes) {
  const field = at || 'arguments';
  if (v === null || v === undefined) return v;
  const want = s.type;
  if (want === 'object') {
    if (kind(v) !== 'object') { errors.push({ field, message: `expected an object, got ${kind(v)} ${show(v)}` }); return v; }
    const out = {};
    const props = s.properties || {};
    for (const [k, x] of Object.entries(v)) {
      const sub = at ? `${at}.${k}` : k;
      if (props[k]) out[k] = check(props[k], x, sub, errors, notes);
      else {
        out[k] = x;
        if (s.additionalProperties === false) notes.push(`"${sub}" is not a parameter of this tool and was ignored`);
      }
    }
    for (const r of s.required || []) if (v[r] === undefined || v[r] === null) notes.push(`"${at ? `${at}.${r}` : r}" is required`);
    return out;
  }
  if (want === 'array') {
    if (kind(v) !== 'array') { errors.push({ field, message: `expected an array, got ${kind(v)} ${show(v)}` }); return v; }
    if (s.minItems != null && v.length < s.minItems) notes.push(`"${field}" should have at least ${s.minItems} items`);
    if (s.maxItems != null && v.length > s.maxItems) notes.push(`"${field}" should have at most ${s.maxItems} items`);
    return s.items ? v.map((x, i) => check(s.items, x, `${field}[${i}]`, errors, notes)) : v;
  }
  if (want === 'number' || want === 'integer') {
    let n = v;
    if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) n = Number(v);
    if (typeof n !== 'number' || !Number.isFinite(n)) { errors.push({ field, message: `expected a number, got ${kind(v)} ${show(v)}` }); return v; }
    if (want === 'integer' && !Number.isInteger(n)) notes.push(`"${field}" should be a whole number (got ${n})`);
    if (s.minimum != null && n < s.minimum) notes.push(`"${field}" should be at least ${s.minimum} (got ${n})`);
    if (s.maximum != null && n > s.maximum) notes.push(`"${field}" should be at most ${s.maximum} (got ${n})`);
    if (s.enum && !s.enum.includes(n)) notes.push(`"${field}" should be one of ${s.enum.join(', ')} (got ${n})`);
    return n;
  }
  if (want === 'boolean') {
    if (v === 'true' || v === 'false') return v === 'true';
    if (typeof v !== 'boolean') { errors.push({ field, message: `expected true or false, got ${kind(v)} ${show(v)}` }); return v; }
    return v;
  }
  if (want === 'string') {
    let t = v;
    if (typeof v === 'number' || typeof v === 'boolean') t = String(v);
    if (typeof t !== 'string') { errors.push({ field, message: `expected text, got ${kind(v)} ${show(v)}` }); return v; }
    if (s.enum && !s.enum.includes(t)) notes.push(`"${field}" is not one of the listed values (got ${show(t)})`);
    return t;
  }
  return v; // (no type, or one this checker does not know: passed on as it was)
}

/** "Invalid arguments for add_text: x: expected a number, got string "abc"" */
export function errorText(tool, errors) {
  return `Invalid arguments for ${tool}: ${errors.map((e) => `${e.field}: ${e.message}`).join('; ')}. Nothing was changed.`;
}
