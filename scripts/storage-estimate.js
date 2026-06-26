#!/usr/bin/env node

// Quick storage estimator for race lap-history data.
//
// Edit the CONFIG values below and run:
//   node scripts/storage-estimate.js
//
// This estimates append-only lap history storage, overwritten live snapshot
// files, and the derived analytics summary. Multiple followed-car screens can
// share one site poll: the app reads the full timing table once, then each
// screen can filter the same rows for a different followed car.

const CONFIG = {
  raceHours: 24,
  pollIntervalSeconds: 5,
  averageLapSeconds: 125,

  // storedCars is how many cars from the timing table are written to disk.
  // followedCars is how many dashboards/cars you actively focus on. The current
  // app stores all parsed timing rows, so disk usage mainly follows storedCars.
  storedCars: 45,
  followedCars: 1,

  // Approximate bytes per completed lap in each append-only format. These are
  // intentionally conservative and easy to tune after checking real files.
  csvBytesPerLap: 360,
  jsonlBytesPerLap: 1100,
  latestJsonBytesPerCar: 1200,
  parserDebugBytesPerCar: 450,
  sessionMetadataBytes: 600,
  analyticsSummaryBaseBytes: 2500,
  analyticsSummaryBytesPerCar: 850,
  analyticsSummaryBytesPerDriver: 700,
  lapPredictionBytes: 3500,
  averageDriversPerCar: 4,

  // Optional overhead for headers/newlines/session variation.
  overheadBytesPerFile: 2048
};

function lapsPerCar({ raceHours, averageLapSeconds }) {
  return Math.floor((raceHours * 60 * 60) / averageLapSeconds);
}

// Poll count estimates how often latest/debug files are overwritten. It does
// not multiply append-only lap history because completed laps are only stored
// once per car/lap.
function pollCount({ raceHours, pollIntervalSeconds }) {
  return Math.ceil((raceHours * 60 * 60) / pollIntervalSeconds);
}

// Estimates append-only storage for completed lap history.
function bytesForScenario(carCount, lapsEach, config = CONFIG) {
  const lapRecords = carCount * lapsEach;
  const csvBytes = config.overheadBytesPerFile + lapRecords * config.csvBytesPerLap;
  const jsonlBytes = config.overheadBytesPerFile + lapRecords * config.jsonlBytesPerLap;
  return {
    carCount,
    lapRecords,
    csvBytes,
    jsonlBytes,
    totalBytes: csvBytes + jsonlBytes
  };
}

// Estimates files that are overwritten during the race. These do not grow with
// poll count, but they do matter for total session folder size.
function latestSnapshotBytes(carCount, config = CONFIG) {
  const latestCsvBytes = config.overheadBytesPerFile + carCount * config.csvBytesPerLap;
  const latestJsonBytes = config.overheadBytesPerFile + carCount * config.latestJsonBytesPerCar;
  const parserDebugBytes = config.overheadBytesPerFile + carCount * config.parserDebugBytesPerCar;
  const sessionMetadataBytes = config.sessionMetadataBytes;
  const analyticsSummaryBytes = analyticsSummarySizeBytes(carCount, config);
  const lapPredictionBytes = config.lapPredictionBytes;
  return {
    latestCsvBytes,
    latestJsonBytes,
    parserDebugBytes,
    sessionMetadataBytes,
    analyticsSummaryBytes,
    lapPredictionBytes,
    totalBytes: latestCsvBytes + latestJsonBytes + parserDebugBytes + sessionMetadataBytes + analyticsSummaryBytes + lapPredictionBytes
  };
}

// Estimates analytics_summary.json size. It stores aggregates for cars/drivers,
// not every individual lap again.
function analyticsSummarySizeBytes(carCount, config = CONFIG) {
  const driverCount = Math.ceil(carCount * config.averageDriversPerCar);
  return config.analyticsSummaryBaseBytes
    + carCount * config.analyticsSummaryBytesPerCar
    + driverCount * config.analyticsSummaryBytesPerDriver;
}

// Breaks analytics estimate into parts so CONFIG can be tuned from real files.
function analyticsSummaryBreakdown(carCount, config = CONFIG) {
  const driverCount = Math.ceil(carCount * config.averageDriversPerCar);
  const baseBytes = config.analyticsSummaryBaseBytes;
  const carStatsBytes = carCount * config.analyticsSummaryBytesPerCar;
  const driverStatsBytes = driverCount * config.analyticsSummaryBytesPerDriver;
  return {
    carCount,
    driverCount,
    baseBytes,
    carStatsBytes,
    driverStatsBytes,
    totalBytes: baseBytes + carStatsBytes + driverStatsBytes
  };
}

// Human-readable byte formatting for command output.
function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 || unit === 0 ? 1 : 2)} ${units[unit]}`;
}

// Prints one append-only history scenario line.
function printScenario(label, result) {
  console.log(`${label.padEnd(24)} cars=${String(result.carCount).padStart(2)} laps=${String(result.lapRecords).padStart(6)} CSV=${formatBytes(result.csvBytes).padStart(9)} JSONL=${formatBytes(result.jsonlBytes).padStart(9)} total=${formatBytes(result.totalBytes).padStart(9)}`);
}

// Prints one overwritten/latest-files scenario line.
function printLatestScenario(label, carCount, config) {
  const result = latestSnapshotBytes(carCount, config);
  console.log(`${label.padEnd(24)} cars=${String(carCount).padStart(2)} latestCSV=${formatBytes(result.latestCsvBytes).padStart(9)} latestJSON=${formatBytes(result.latestJsonBytes).padStart(9)} debug=${formatBytes(result.parserDebugBytes).padStart(9)} analytics=${formatBytes(result.analyticsSummaryBytes).padStart(9)} prediction=${formatBytes(result.lapPredictionBytes).padStart(9)} total=${formatBytes(result.totalBytes).padStart(9)}`);
}

// Prints analytics-summary details so driver-count assumptions are visible.
function printAnalyticsBreakdown(label, carCount, config) {
  const result = analyticsSummaryBreakdown(carCount, config);
  console.log(`${label.padEnd(24)} cars=${String(result.carCount).padStart(2)} drivers=${String(result.driverCount).padStart(3)} base=${formatBytes(result.baseBytes).padStart(8)} carStats=${formatBytes(result.carStatsBytes).padStart(9)} driverStats=${formatBytes(result.driverStatsBytes).padStart(9)} total=${formatBytes(result.totalBytes).padStart(9)}`);
}

// CLI entry point. Tests call this with injected config; normal users edit
// CONFIG and run the script directly.
function main(config = CONFIG) {
  const lapsEach = lapsPerCar(config);
  const polls = pollCount(config);
  const history = bytesForScenario(config.storedCars, lapsEach, config);
  const overwritten = latestSnapshotBytes(config.storedCars, config);
  const totalStoredBytes = history.totalBytes + overwritten.totalBytes;

  console.log('Storage estimate');
  console.log('----------------');
  console.log(`Race duration:       ${config.raceHours}h`);
  console.log(`Poll interval:       ${config.pollIntervalSeconds}s`);
  console.log(`Estimated polls:     ${polls}`);
  console.log(`Average lap time:    ${config.averageLapSeconds}s`);
  console.log(`Stored cars:         ${config.storedCars}`);
  console.log(`Followed cars:       ${config.followedCars}`);
  console.log(`Estimated laps/car:  ${lapsEach}`);
  console.log(`Bytes/lap CSV:       ${config.csvBytesPerLap}`);
  console.log(`Bytes/lap JSONL:     ${config.jsonlBytesPerLap}`);
  console.log(`Drivers/car estimate:${config.averageDriversPerCar}`);
  console.log('');

  console.log('Append-only lap history');
  console.log('-----------------------');
  printScenario('All stored cars', history);
  console.log('');

  console.log('Current overwritten files');
  console.log('-------------------------');
  printLatestScenario('All stored cars', config.storedCars, config);
  console.log('');

  console.log('Analytics summary detail');
  console.log('------------------------');
  printAnalyticsBreakdown('Needed averages/stats', config.storedCars, config);
  console.log('');
  console.log('Note: latest/debug/prediction files are overwritten every poll. analytics_summary.json is overwritten when new laps are stored. It contains averages/stats for stored cars and drivers, but not every individual lap again.');
  console.log('');
  console.log(`Total estimated stored data: ${formatBytes(totalStoredBytes)} (${totalStoredBytes.toLocaleString()} bytes)`);
}

if (require.main === module) main();

module.exports = {
  CONFIG,
  lapsPerCar,
  pollCount,
  bytesForScenario,
  latestSnapshotBytes,
  analyticsSummarySizeBytes,
  analyticsSummaryBreakdown,
  formatBytes,
  main
};
