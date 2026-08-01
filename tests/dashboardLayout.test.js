const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');

assert.ok(html.includes('class="sector-panel"'), 'sector timings have their own center panel');
assert.ok(html.includes('class="right-rail"'), 'timing and gap cards share an independent right column');
assert.ok(html.includes('class="timing-stack board-box"'), 'last, best, ideal, reference and prediction share the right stack');
assert.ok(html.includes('class="comparison-placeholder board-box"'), 'comparison space remains reserved and empty');
assert.ok(html.includes('id="last-time-card"'), 'last lap receives a prominent timing card');
assert.strictEqual(html.includes('class="compare-stack"'), false, 'old comparison cards are absent');
assert.match(html, /class="condition-control"[\s\S]*?<span>mode<\/span>[\s\S]*id="track-condition"[\s\S]*?<option value="dry"[^>]*>dry<\/option>[\s\S]*?<option value="wet"[^>]*>wet<\/option>[\s\S]*?<option value="transition"[^>]*>inter<\/option>/, 'track condition uses compact mode words');
const analysisSelect = html.match(/<select id="analysis-condition"[\s\S]*?<\/select>/)?.[0] || '';
assert.match(html, /class="condition-control"[\s\S]*?<span>view<\/span>[\s\S]*id="analysis-condition"/, 'analysis condition has a compact view label');
assert.match(analysisSelect, /<option value="combined"[^>]*title="Full view"[^>]*>full<\/option>/, 'analysis condition defaults to full view');
assert.match(analysisSelect, /<option value="dry"[^>]*>dry<\/option>/, 'analysis condition keeps dry view');
assert.match(analysisSelect, /<option value="wet"[^>]*>wet<\/option>/, 'analysis condition keeps wet view');
assert.strictEqual(analysisSelect.includes('value="current"'), false, 'analysis condition no longer exposes current view');
assert.strictEqual(analysisSelect.includes('value="transition"'), false, 'analysis condition no longer exposes transition view');

const timingOrder = ['last-time-card', 'best-time-card', 'ideal-time', 'reference-lap-card', 'predicted-lap-card']
  .map((id) => html.indexOf(`id="${id}"`));
assert.ok(timingOrder.every((index) => index >= 0));
assert.deepStrictEqual([...timingOrder].sort((a, b) => a - b), timingOrder, 'timing rows follow the requested vertical order');

assert.match(css, /grid-template-columns:\s*180px minmax\(0, 1fr\) minmax\(320px, \.30fr\)/);
assert.match(css, /grid-template-rows:\s*auto minmax\(0, \.88fr\) minmax\(210px, 1\.05fr\) auto/, 'sector and comparison rows retain their original proportions');
assert.match(css, /\.right-rail\s*\{[\s\S]*?grid-column:\s*3;[\s\S]*?grid-row:\s*2 \/ 4;[\s\S]*?grid-template-rows:\s*minmax\(0, 1fr\) auto;/, 'right rail spans the content height and gives remaining space to timing');
assert.match(css, /\.comparison-average-heading\s*\{[\s\S]*?height:\s*30px;/, 'all average columns reserve the same header height as the XIC input');
assert.match(css, /\.comparison-average-chip\.total\s*\{[\s\S]*?margin-bottom:\s*8px;/, 'car total average is separated from individual driver averages');
assert.match(css, /\.comparison-sector-cell\s*\{[\s\S]*?font-size:\s*15px;/, 'sector values use the same font size as lap comparison values');
assert.match(css, /\.comparison-sector-label\s*\{[\s\S]*?font-size:\s*11px;/, 'sector headings use the same font size as lap comparison headings');
assert.ok(css.includes('.comparison-car-label.is-our-car'), 'our car number receives a distinct comparison-tab color');
assert.match(css, /\.comparison-tab\.comparison-tab-scrollable\s*\{[\s\S]*?overflow-y:\s*auto;/, 'large classes can scroll inside comparison tabs');
assert.match(css, /select:focus,[\s\S]*select:focus-visible\s*\{[\s\S]*outline:\s*none;[\s\S]*border-color:\s*var\(--line\);/, 'select dropdowns do not keep the browser focus highlight');
assert.match(css, /--lap-strip-wet-lap-number-color:/, 'wet laps have their own editable lap-number color');
assert.match(css, /\.lap-strip-row\.condition-wet \.lap-number\s*\{\s*color:\s*var\(--lap-strip-wet-lap-number-color\);/, 'wet lap numbers are visually marked without recoloring the full row');
assert.match(css, /\.pit-window\s*\{\s*grid-column:\s*1 \/ -1;\s*grid-row:\s*4;/);
assert.match(css, /\.debug-panel\s*\{\s*display:\s*none;/);

console.log('Dashboard single-screen layout tests passed.');
