const assert = require('assert');
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'graphs.html'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'graphs.css'), 'utf8');
const js = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'graphs.js'), 'utf8');

assert.strictEqual((html.match(/class="chart-panel"/g) || []).length, 4, 'graph window keeps exactly four switchable panels');
assert.strictEqual(/<header[\s>]/.test(html), false, 'graph metadata header no longer consumes viewport space');
assert.match(css, /grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\)/);
assert.match(css, /grid-template-rows:\s*repeat\(2, minmax\(0, 1fr\)\)/);
assert.match(css, /\.graphs-page\s*\{[\s\S]*height:\s*100vh;/);
assert.ok(js.includes('Race Analysis Graphs - Car #'), 'window title identifies the followed car');
assert.strictEqual(js.includes("getElementById('graphs-session')"), false, 'renderer no longer expects the removed graph header');
assert.ok(js.includes('point.label'), 'class-pace hover tooltip includes the stored race-lap label');
assert.strictEqual(js.includes('Δ to our car'), false, 'class-pace tooltip keeps the delta label compact');

console.log('Graph single-screen layout tests passed.');
