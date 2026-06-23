const assert = require('assert');
const {
  config,
  completeSectorLaps,
  predictCurrentLap,
  predictionProfileForRow,
  predictionReadiness
} = require('../src/shared/normPrediction');

function lap(carNumber, driver, lapNumber, sector1Ms, sector2Ms, sector3Ms) {
  return {
    carNumber,
    driver,
    lapNumber,
    recordedAt: `2026-06-22T12:${String(lapNumber).padStart(2, '0')}:00.000Z`,
    sector1Ms,
    sector2Ms,
    sector3Ms,
    lastLapMs: sector1Ms + sector2Ms + sector3Ms
  };
}

const history = [
  lap(33, 'Alice', 1, 32000, 39000, 30000),
  lap(33, 'Alice', 2, 32100, 39100, 30100),
  lap(33, 'Alice', 3, 31900, 38900, 29900),
  lap(33, 'Bob', 4, 34000, 42000, 33000),
  lap(33, 'Bob', 5, 34100, 42100, 33100),
  lap(33, 'Bob', 6, 33900, 41900, 32900)
];

const twoLapHistory = [
  lap(77, 'Dana', 1, 33000, 40000, 31000),
  lap(77, 'Dana', 2, 33100, 40100, 31100)
];

const incompleteHistory = [
  lap(88, 'Eve', 1, 33000, 40000, 31000),
  { carNumber: 88, driver: 'Eve', lapNumber: 2, lastLapMs: 104000, sector1Ms: 33000, sector2Ms: 40000 },
  { carNumber: 88, driverName: 'Eve', lapNumber: 3, lapTimeMs: 104200, sector1Ms: 33100, sector2Ms: 40100, sector3Ms: 31000 }
];

assert.strictEqual(config.minDriverLaps, 2);
assert.strictEqual(config.sectorSumToleranceMs, 5000);
assert.deepStrictEqual(completeSectorLaps(null, 33), []);
assert.strictEqual(completeSectorLaps(incompleteHistory, 88, 'Eve').length, 2);
assert.strictEqual(completeSectorLaps(incompleteHistory, 88, 'Other').length, 0);

const mismatchedSectorHistory = [
  { carNumber: 66, driver: 'Mismatch', lapNumber: 1, lastLapMs: 126000, sector1Ms: 30000, sector2Ms: 35000, sector3Ms: 30000 },
  { carNumber: 66, driver: 'Mismatch', lapNumber: 2, lastLapMs: 127000, sector1Ms: 31000, sector2Ms: 35000, sector3Ms: 30000 }
];
assert.strictEqual(completeSectorLaps(mismatchedSectorHistory, 66, 'Mismatch').length, 0);
assert.strictEqual(predictionProfileForRow({ carNumber: 66, driver: 'Mismatch' }, mismatchedSectorHistory), null);

const noCarReadiness = predictionReadiness(null, history);
assert.strictEqual(noCarReadiness.reason, 'no-car');
assert.strictEqual(noCarReadiness.ready, false);
assert.strictEqual(predictionProfileForRow(null, history), null);

// Contract: prediction should not start until enough completed sector laps exist
// for either the current driver or the car fallback.
assert.strictEqual(
  predictCurrentLap({ carNumber: 44, driver: 'New Driver', sector1Ms: 32000 }, history),
  null
);

// Contract: driver-specific data is preferred when available. The exact math may
// change later, but the model source and sample size should still make that clear.
const aliceProfile = predictionProfileForRow({ carNumber: 33, driver: 'Alice' }, history);
assert.ok(aliceProfile);
assert.strictEqual(aliceProfile.source, 'driver Alice');
assert.strictEqual(aliceProfile.sampleSize, 3);

const stricterAliceProfile = predictionProfileForRow(
  { carNumber: 33, driver: 'Alice' },
  history,
  { recentLaps: 12, minDriverLaps: 4, minCarLaps: 2 }
);
assert.ok(stricterAliceProfile);
assert.strictEqual(stricterAliceProfile.source, 'car average');

// Contract: two complete sector laps are enough to start predicting. This keeps
// the dashboard useful early in a session while still avoiding one-lap noise.
const twoLapPrediction = predictCurrentLap({ carNumber: 77, driver: 'Dana', sector1Ms: 32900 }, twoLapHistory);
assert.ok(twoLapPrediction);
assert.strictEqual(twoLapPrediction.profile.source, 'driver Dana');
assert.strictEqual(twoLapPrediction.profile.sampleSize, 2);
assert.strictEqual(twoLapPrediction.stage, 'S1');

// Contract: a driver without enough own laps can still use the followed car's
// completed sector history as a fallback.
const carProfile = predictionProfileForRow({ carNumber: 33, driver: 'Charlie' }, history);
assert.ok(carProfile);
assert.strictEqual(carProfile.source, 'car average');
assert.strictEqual(carProfile.sampleSize, history.length);

const limitedProfile = predictionProfileForRow(
  { carNumber: 33, driver: 'Charlie' },
  history,
  { recentLaps: 2, minDriverLaps: 2, minCarLaps: 2 }
);
assert.strictEqual(limitedProfile.sampleSize, 2);

// Contract: after S1 and S2, predictions expose the stage and produce a finite
// predicted time that is ahead of the elapsed sectors.
const afterS1 = predictCurrentLap({ carNumber: 33, driver: 'Alice', sector1Ms: 31000 }, history);
assert.ok(afterS1);
assert.strictEqual(afterS1.stage, 'S1');
assert.ok(Number.isFinite(afterS1.predictedMs));
assert.ok(afterS1.predictedMs > afterS1.elapsedMs);

const afterS2 = predictCurrentLap({ carNumber: 33, driver: 'Alice', sector1Ms: 31000, sector2Ms: 38000 }, history);
assert.ok(afterS2);
assert.strictEqual(afterS2.stage, 'S2');
assert.ok(Number.isFinite(afterS2.predictedMs));
assert.ok(afterS2.predictedMs > afterS2.elapsedMs);

// Contract: once all three sectors are present, the prediction equals the current
// completed sector total regardless of the future prediction model.
const afterS3 = predictCurrentLap({ carNumber: 33, driver: 'Alice', sector1Ms: 31000, sector2Ms: 38000, sector3Ms: 29000 }, history);
assert.ok(afterS3);
assert.strictEqual(afterS3.stage, 'S3');
assert.strictEqual(afterS3.predictedMs, 98000);

const noHistoryReadiness = predictionReadiness({ carNumber: 44, driver: 'New Driver', sector1Ms: 32000 }, history);
assert.strictEqual(noHistoryReadiness.reason, 'not-enough-history');
assert.strictEqual(noHistoryReadiness.driverLapCount, 0);
assert.strictEqual(noHistoryReadiness.carLapCount, 0);

const waitingForS1Readiness = predictionReadiness({ carNumber: 33, driver: 'Alice' }, history);
assert.strictEqual(waitingForS1Readiness.reason, 'waiting-for-s1');
assert.strictEqual(waitingForS1Readiness.ready, false);
assert.strictEqual(waitingForS1Readiness.hasS1, false);

const readyWithOnlyS1 = predictionReadiness({ carNumber: 33, driver: 'Alice', sector1Ms: 31000 }, history);
assert.strictEqual(readyWithOnlyS1.reason, 'ready');
assert.strictEqual(readyWithOnlyS1.ready, true);
assert.strictEqual(readyWithOnlyS1.hasS1, true);
assert.strictEqual(readyWithOnlyS1.hasS2, false);

assert.strictEqual(predictCurrentLap({ carNumber: 33, driver: 'Alice' }, history), null);

// Contract: callers can compare predictedMs with the configured norm time to
// decide whether the warning screen should go red. This avoids baking the exact
// dashboard color rules into the prediction module tests.
const normMs = 100000;
assert.ok(afterS3.predictedMs < normMs);

console.log('Prediction tests passed.');
