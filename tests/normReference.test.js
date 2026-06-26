const assert = require('assert');
const {
  parseDashboardTimeToMs,
  displayDeltaSeconds,
  normState,
  deltaToReference,
  lapReferenceStatus,
  sectorReferenceStatus,
  idealReferenceStatus
} = require('../src/shared/normReference');

// Time entry accepts both full lap notation and quick sector notation.
assert.strictEqual(parseDashboardTimeToMs('2:04.500'), 124500);
assert.strictEqual(parseDashboardTimeToMs('124.500'), 124500);
assert.strictEqual(parseDashboardTimeToMs('41.2'), 41200);
assert.strictEqual(parseDashboardTimeToMs('1:02:03.456'), 3723456);
assert.strictEqual(parseDashboardTimeToMs('41,250'), 41250);
assert.strictEqual(parseDashboardTimeToMs(''), null);
assert.strictEqual(parseDashboardTimeToMs('abc'), null);
assert.strictEqual(parseDashboardTimeToMs('-1.000'), null);
assert.strictEqual(parseDashboardTimeToMs('1:02:03:04'), null);

// Delta formatting stays compact for dashboard boxes.
assert.strictEqual(displayDeltaSeconds(679), '+0.679s');
assert.strictEqual(displayDeltaSeconds(-3500), '-3.500s');
assert.strictEqual(displayDeltaSeconds(0), '0.000s');
assert.strictEqual(displayDeltaSeconds(null), '—');

// Thresholds: at or below 0.500s above reference is red, up to 2.000s is orange,
// and anything above that is green.
assert.strictEqual(normState(-1), 'bad');
assert.strictEqual(normState(0), 'bad');
assert.strictEqual(normState(500), 'bad');
assert.strictEqual(normState(501), 'warn');
assert.strictEqual(normState(2000), 'warn');
assert.strictEqual(normState(2001), 'good');
assert.strictEqual(normState(null), 'neutral');

// Prediction/reference lap scenarios.
let status = lapReferenceStatus(124321, 124500);
assert.strictEqual(status.deltaMs, -179);
assert.strictEqual(status.deltaLabel, '-0.179s');
assert.strictEqual(status.state, 'bad');

status = lapReferenceStatus(125600, 124500);
assert.strictEqual(status.deltaMs, 1100);
assert.strictEqual(status.state, 'warn');

status = lapReferenceStatus(127000, 124500);
assert.strictEqual(status.deltaMs, 2500);
assert.strictEqual(status.state, 'good');

status = lapReferenceStatus(null, 124500);
assert.strictEqual(status.deltaMs, null);
assert.strictEqual(status.state, 'neutral');

// Sector reference scenarios. The most dangerous delta between last and best
// decides the color, because either one can show we are too close/too fast.
let sector = sectorReferenceStatus(41000, 41250, 41000);
assert.strictEqual(sector.label, 'Last 0.000s · Best +0.250s');
assert.strictEqual(sector.tightestDeltaMs, 0);
assert.strictEqual(sector.state, 'bad');

sector = sectorReferenceStatus(43050, 42800, 41000);
assert.strictEqual(sector.label, 'Last +2.050s · Best +1.800s');
assert.strictEqual(sector.tightestDeltaMs, 1800);
assert.strictEqual(sector.state, 'warn');

sector = sectorReferenceStatus(44500, 43250, 41000);
assert.strictEqual(sector.label, 'Last +3.500s · Best +2.250s');
assert.strictEqual(sector.tightestDeltaMs, 2250);
assert.strictEqual(sector.state, 'good');

sector = sectorReferenceStatus(41000, 40500, 41000);
assert.strictEqual(sector.label, 'Last 0.000s · Best -0.500s');
assert.strictEqual(sector.tightestDeltaMs, -500);
assert.strictEqual(sector.state, 'bad');

sector = sectorReferenceStatus(41000, 40500, null);
assert.strictEqual(sector.label, 'Last — · Best —');
assert.strictEqual(sector.state, 'neutral');

// Ideal time must use the car's best sector values. The helper only receives
// those best sectors, so a current-driver sector cannot accidentally sneak in.
let ideal = idealReferenceStatus(41000, 46000, 36000, 124500);
assert.strictEqual(ideal.idealMs, 123000);
assert.strictEqual(ideal.deltaMs, -1500);
assert.strictEqual(ideal.state, 'bad');

ideal = idealReferenceStatus(42000, 47000, 38000, 124500);
assert.strictEqual(ideal.idealMs, 127000);
assert.strictEqual(ideal.deltaMs, 2500);
assert.strictEqual(ideal.state, 'good');

ideal = idealReferenceStatus(42000, null, 38000, 124500);
assert.strictEqual(ideal.idealMs, null);
assert.strictEqual(ideal.deltaMs, null);
assert.strictEqual(ideal.state, 'neutral');

assert.strictEqual(deltaToReference(126000, 124500), 1500);
assert.strictEqual(deltaToReference('', 124500), null);

console.log('Norm reference tests passed.');
