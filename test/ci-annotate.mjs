// (P0-6b) CI: turn failing tests in the `npm test` output into GitHub annotations (::error), so the test names and
// their errors can be read in the run summary and through the public API, without opening the logs.
// Usage (in .github/workflows/ci.yml, only after a failure): node test/ci-annotate.mjs test-output.txt
// Reads the TAP output Node prints when stdout is not a terminal, and the spec output (✖ lines) as a fallback.
import fs from 'node:fs';

const MAX = 10; // GitHub shows at most 10 error annotations per step
const esc = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
const escProp = (s) => esc(s).replace(/:/g, '%3A').replace(/,/g, '%2C');

/** [{ name, location, error }] from TAP or spec output. File-level "not ok" (a whole test file) is skipped when its tests are listed. */
export function failuresOf(text) {
  const lines = text.split('\n');
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^(\s*)not ok \d+ - (.+?)(?: # .*)?$/.exec(lines[i]);
    if (!m) continue;
    const indent = m[1].length;
    const f = { name: m[2].trim(), location: '', error: '', indent };
    // the YAML block that follows: "  ---" … "  ..."
    let j = i + 1;
    if (lines[j]?.trim() === '---') {
      for (j += 1; j < lines.length && lines[j].trim() !== '...'; j++) {
        const l = lines[j].trim();
        if (l.startsWith('location:')) f.location = l.slice(9).trim().replace(/^'|'$/g, '');
        else if (l.startsWith('error:')) {
          const rest = l.slice(6).trim();
          const body = [];
          if (rest && rest !== '|-' && rest !== '|' && rest !== '>-') body.push(rest.replace(/^'|'$/g, ''));
          const base = lines[j].search(/\S/);
          for (let k = j + 1; k < lines.length && (lines[k].search(/\S/) > base || lines[k].trim() === ''); k++) body.push(lines[k].trim());
          f.error = body.join('\n').trim().slice(0, 1500);
        }
      }
    }
    out.push(f);
  }
  if (out.length) {
    // keep the innermost failures: a failing file is reported through its failing tests
    const deepest = out.filter((f) => !out.some((g) => g.indent > f.indent && g.location && f.location && g.location.startsWith(f.location.split(':')[0])));
    return deepest.length ? deepest : out;
  }
  // spec reporter: "✖ name (1.2ms)" followed by indented error lines
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*✖ (.+?)(?: \([\d.]+m?s\))?$/.exec(lines[i]);
    if (!m || /failing tests:/.test(m[1])) continue;
    const body = [];
    for (let k = i + 1; k < lines.length && /^\s{2,}\S/.test(lines[k]) && !/^\s*[✔✖]/.test(lines[k]); k++) body.push(lines[k].trim());
    if (!out.some((f) => f.name === m[1])) out.push({ name: m[1], location: '', error: body.join('\n').slice(0, 1500) });
  }
  return out;
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split('/').pop())) {
  const file = process.argv[2];
  const text = file && fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const failures = failuresOf(text);
  if (!failures.length) console.log('::error title=npm test failed::No failing test found in the output (the run may have crashed before the tests). See the log.');
  for (const f of failures.slice(0, MAX)) {
    const where = f.location ? ` (${f.location.replace(/^.*\/(test\/)/, '$1')})` : '';
    console.log(`::error title=${escProp(`Test failed: ${f.name}`.slice(0, 200))}::${esc(`${f.name}${where}\n${f.error || 'no error message'}`)}`);
  }
  if (failures.length > MAX) console.log(`::error title=More failures::${failures.length - MAX} more failing tests; see the log.`);
}
