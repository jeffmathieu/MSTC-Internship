const assert = require('assert');
const {
  PITSTOP_CIRCUITS,
  pitstopCircuitById,
  normalizePitstopCircuitId
} = require('../src/shared/pitstopCircuits');
const { pitLossForSession } = require('../src/shared/pitstopPlanner');

assert.deepStrictEqual(
  PITSTOP_CIRCUITS.map((circuit) => circuit.id),
  ['spa-full', 'spa-f1', 'spa-endurance', 'zolder', 'assen']
);
assert.strictEqual(pitstopCircuitById('zolder').label, 'Zolder');
assert.strictEqual(pitstopCircuitById('unknown'), null);
assert.strictEqual(normalizePitstopCircuitId('spa-f1'), 'spa-f1');
assert.strictEqual(normalizePitstopCircuitId('unknown'), 'zolder');
assert.strictEqual(normalizePitstopCircuitId('unknown', 'assen'), 'assen');
assert.strictEqual(normalizePitstopCircuitId('unknown', 'also-unknown'), 'spa-full');
assert.ok(PITSTOP_CIRCUITS.every((circuit) =>
  circuit.regularTrackDistanceMeters > 0 && circuit.fcySpeedKph > 0
));
assert.ok(Object.isFrozen(PITSTOP_CIRCUITS));
assert.ok(PITSTOP_CIRCUITS.every(Object.isFrozen));
assert.strictEqual(new Set(PITSTOP_CIRCUITS.map((circuit) => circuit.id)).size, PITSTOP_CIRCUITS.length);
assert.strictEqual(new Set(PITSTOP_CIRCUITS.map((circuit) => circuit.label)).size, PITSTOP_CIRCUITS.length);

// These expected values deliberately use the real configured distances. At
// 60 km/h every metre takes 60 ms; the net loss is that travel time subtracted
// from the complete 75-second pit-in to pit-out duration.
const expectedFcyCalculations = {
  'spa-full': { distanceMeters: 1150, regularTrackTravelMs: 69000, pitLossMs: 6000 },
  'spa-f1': { distanceMeters: 650, regularTrackTravelMs: 39000, pitLossMs: 36000 },
  'spa-endurance': { distanceMeters: 500, regularTrackTravelMs: 30000, pitLossMs: 45000 },
  zolder: { distanceMeters: 950, regularTrackTravelMs: 57000, pitLossMs: 18000 },
  assen: { distanceMeters: 900, regularTrackTravelMs: 54000, pitLossMs: 21000 }
};

PITSTOP_CIRCUITS.forEach((circuit) => {
  const expected = expectedFcyCalculations[circuit.id];
  assert.strictEqual(circuit.regularTrackDistanceMeters, expected.distanceMeters);
  const result = pitLossForSession({
    session: { flag: 'FCY' },
    fcyGapState: { ready: true },
    rules: {
      circuitId: circuit.id,
      regularTrackDistanceMeters: circuit.regularTrackDistanceMeters,
      fcySpeedKph: circuit.fcySpeedKph,
      pitStopDurationMs: 75000
    }
  });
  assert.strictEqual(result.status, 'ready');
  assert.strictEqual(result.regularTrackTravelMs, expected.regularTrackTravelMs);
  assert.strictEqual(result.pitLossMs, expected.pitLossMs);
});

console.log('Pitstop circuit profile tests passed.');
