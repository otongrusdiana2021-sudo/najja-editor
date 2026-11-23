// (v1.13.2) DESIGN.md §4: the --najja-* design tokens, defined for the editor (public/css/app.css) and Najja Desain
// (public/css/design.css) as aliases of the values each already uses. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const TOKENS = ['app-bg', 'panel-bg', 'panel-raised', 'canvas-bg', 'text-primary', 'text-secondary', 'border', 'accent', 'success', 'warning', 'danger'];
const css = (f) => fs.readFileSync(new URL(`../public/css/${f}`, import.meta.url), 'utf8');
const defined = (src) => new Map([...src.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));

for (const file of ['app.css', 'design.css']) {
  test(`${file}: every DESIGN.md token is defined, from a value the stylesheet already has`, () => {
    const vars = defined(css(file));
    for (const t of TOKENS) {
      const v = vars.get(`--najja-${t}`);
      assert.ok(v, `--najja-${t} defined in ${file}`);
      const ref = /^var\((--[a-z0-9-]+)\)$/.exec(v);
      if (ref) assert.ok(vars.has(ref[1]) && !ref[1].startsWith('--najja-'), `--najja-${t} → ${ref[1]} exists in ${file}`);
      else assert.match(v, /^#[0-9a-f]{6}$/i, `--najja-${t} is an alias or a plain colour`);
    }
  });
}

test('the tokens change nothing yet: no rule uses them (the look stays as it is)', () => {
  for (const file of ['app.css', 'design.css']) assert.doesNotMatch(css(file), /var\(--najja-/, file);
});
