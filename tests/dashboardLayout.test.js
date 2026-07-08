const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');

assert.ok(html.includes('class="sector-panel"'), 'sector timings have their own center panel');
assert.ok(html.includes('class="timing-stack board-box"'), 'best, ideal, reference and prediction share the right stack');
assert.ok(html.includes('class="comparison-placeholder board-box"'), 'comparison space remains reserved and empty');
assert.strictEqual(html.includes('id="last-time-card"'), false, 'the duplicate last-time card is removed');
assert.strictEqual(html.includes('class="compare-stack"'), false, 'old comparison cards are absent');
assert.match(html, /id="track-condition"[\s\S]*?<option value="dry"[^>]*>☀<\/option>/, 'track condition uses compact weather symbols');
const analysisSelect = html.match(/<select id="analysis-condition"[\s\S]*?<\/select>/)?.[0] || '';
assert.match(analysisSelect, /<option value="combined"[^>]*title="Overall"[^>]*>Σ<\/option>/, 'analysis condition defaults to compact overall view');
assert.match(analysisSelect, /<option value="dry"[^>]*>☀<\/option>/, 'analysis condition keeps dry view');
assert.match(analysisSelect, /<option value="wet"[^>]*>☂<\/option>/, 'analysis condition keeps wet view');
assert.strictEqual(analysisSelect.includes('value="current"'), false, 'analysis condition no longer exposes current view');
assert.strictEqual(analysisSelect.includes('value="transition"'), false, 'analysis condition no longer exposes transition view');

const timingOrder = ['best-time-card', 'ideal-time', 'reference-lap-card', 'predicted-lap-card']
  .map((id) => html.indexOf(`id="${id}"`));
assert.ok(timingOrder.every((index) => index >= 0));
assert.deepStrictEqual([...timingOrder].sort((a, b) => a - b), timingOrder, 'timing rows follow the requested vertical order');

assert.match(css, /grid-template-columns:\s*180px minmax\(0, 1fr\) minmax\(320px, \.30fr\)/);
assert.match(css, /select:focus,[\s\S]*select:focus-visible\s*\{[\s\S]*outline:\s*none;[\s\S]*border-color:\s*var\(--line\);/, 'select dropdowns do not keep the browser focus highlight');
assert.match(css, /\.pit-window\s*\{\s*grid-column:\s*1 \/ -1;\s*grid-row:\s*4;/);
assert.match(css, /\.debug-panel\s*\{\s*display:\s*none;/);

console.log('Dashboard single-screen layout tests passed.');
