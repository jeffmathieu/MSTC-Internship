const assert = require('assert');
const {
  lapsPerCar,
  pollCount,
  bytesForScenario,
  latestSnapshotBytes,
  analyticsSummarySizeBytes,
  analyticsSummaryBreakdown,
  gapHistorySizeBytes,
  formatBytes,
  main
} = require('../scripts/storage-estimate');

const config = {
  raceHours: 2,
  pollIntervalSeconds: 7,
  averageLapSeconds: 91,
  csvBytesPerLap: 10,
  jsonlBytesPerLap: 30,
  latestJsonBytesPerCar: 50,
  parserDebugBytesPerCar: 20,
  sessionMetadataBytes: 100,
  analyticsSummaryBaseBytes: 200,
  analyticsSummaryBytesPerCar: 40,
  analyticsSummaryBytesPerDriver: 25,
  lapPredictionBytes: 60,
  pitPlanBytes: 70,
  gapStateBaseBytes: 80,
  gapStateBytesPerStoredCar: 10,
  gapViewBytesPerFollowedCar: 20,
  gapSampleBytes: 7,
  gapSamplesPerFollowedLap: 2,
  followedCars: 2,
  averageDriversPerCar: 2.5,
  overheadBytesPerFile: 5
};

assert.strictEqual(lapsPerCar(config), 79);
assert.strictEqual(pollCount(config), 1029);

const history = bytesForScenario(3, 4, config);
assert.strictEqual(history.carCount, 3);
assert.strictEqual(history.lapRecords, 12);
assert.strictEqual(history.csvBytes, 125);
assert.strictEqual(history.jsonlBytes, 365);
assert.strictEqual(history.totalBytes, 490);

const analyticsBreakdown = analyticsSummaryBreakdown(3, config);
assert.strictEqual(analyticsBreakdown.carCount, 3);
assert.strictEqual(analyticsBreakdown.driverCount, 8);
assert.strictEqual(analyticsBreakdown.baseBytes, 200);
assert.strictEqual(analyticsBreakdown.carStatsBytes, 120);
assert.strictEqual(analyticsBreakdown.driverStatsBytes, 200);
assert.strictEqual(analyticsBreakdown.totalBytes, 520);
assert.strictEqual(analyticsSummarySizeBytes(3, config), 520);

const latest = latestSnapshotBytes(3, config);
assert.strictEqual(latest.latestCsvBytes, 35);
assert.strictEqual(latest.latestJsonBytes, 155);
assert.strictEqual(latest.parserDebugBytes, 65);
assert.strictEqual(latest.sessionMetadataBytes, 100);
assert.strictEqual(latest.analyticsSummaryBytes, 520);
assert.strictEqual(latest.lapPredictionBytes, 120);
assert.strictEqual(latest.pitPlanBytes, 140);
assert.strictEqual(latest.gapStateBytes, 150);
assert.strictEqual(latest.totalBytes, 1285);
assert.deepStrictEqual(gapHistorySizeBytes(4, config), { sampleCount: 16, totalBytes: 117 });

assert.strictEqual(formatBytes(999), '999.0 B');
assert.strictEqual(formatBytes(1024), '1.00 KB');
assert.strictEqual(formatBytes(1024 * 1024), '1.00 MB');
assert.strictEqual(formatBytes(12 * 1024 * 1024), '12.0 MB');

const captured = [];
const originalLog = console.log;
console.log = (line = '') => captured.push(String(line));
try {
  main({ ...config, storedCars: 3, followedCars: 1 });
} finally {
  console.log = originalLog;
}
assert.ok(captured.includes('Storage estimate'));
assert.ok(captured.some((line) => line.includes('Stored cars:         3')));
assert.ok(captured.some((line) => line.includes('Followed cars:       1')));
assert.ok(captured.some((line) => line.includes('All stored cars')));
assert.ok(captured.some((line) => line.includes('Needed averages/stats')));
assert.ok(captured.some((line) => line.includes('Total estimated stored data:')));

console.log('Storage estimate tests passed.');
