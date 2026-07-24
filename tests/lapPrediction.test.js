const assert = require('assert');
const {
  recentDriverSectorValues,
  recentDriverSectorAverages,
  buildLapPrediction
} = require('../src/shared/lapPrediction');
const { lap } = require('./mockLapHistory');

function liveRow({ carNumber = 33, driver = 'Driver A', sector1 = '', sector2 = '', sector3 = '', ...extra } = {}) {
  return {
    carNumber: String(carNumber),
    driver,
    sector1,
    sector2,
    sector3,
    ...extra
  };
}

function driverLap(driverName, lapNumber, sectors, extra = {}) {
  const [sector1Ms, sector2Ms, sector3Ms] = sectors;
  return lap({
    carNumber: 33,
    teamName: 'Prediction Team',
    driverName,
    lapNumber,
    lapTimeMs: sector1Ms + sector2Ms + sector3Ms,
    sector1Ms,
    sector2Ms,
    sector3Ms,
    ...extra
  });
}

let prediction;

prediction = buildLapPrediction({ history: [], rows: [], carNumber: 33 });
assert.strictEqual(prediction.available, false);
assert.strictEqual(prediction.reason, 'No live row for followed car');

prediction = buildLapPrediction({ history: [], rows: [{ carNumber: '', driver: 'Nobody', sector1: '30.000' }], carNumber: '' });
assert.strictEqual(prediction.available, false);
assert.strictEqual(prediction.carNumber, '');

prediction = buildLapPrediction({ history: [], rows: [liveRow({ driver: '', sector1: '30.000' })], carNumber: 33 });
assert.strictEqual(prediction.available, false);
assert.strictEqual(prediction.reason, 'No current driver yet');

// No same-driver history means the first lap cannot be predicted yet. The live
// sector is real, but there is no trustworthy S2/S3 average to complete it.
prediction = buildLapPrediction({
  history: [],
  rows: [liveRow({ driver: 'New Driver', sector1: '30.000' })],
  carNumber: 33
});
assert.strictEqual(prediction.available, false);
assert.match(prediction.reason, /Need sector 2 history/);

const fallbackDriverHistory = [driverLap('History Driver', 2, [30000, 40000, 30000])];
prediction = buildLapPrediction({
  history: fallbackDriverHistory,
  rows: [{ carNumber: '33', driverName: '', sector1Ms: 29500, sector1: '', sector2: '', sector3: '' }],
  carNumber: 33,
  currentDriver: 'History Driver',
  options: { sampleSize: 1.9 }
});
assert.strictEqual(prediction.available, true);
assert.strictEqual(prediction.driverName, 'History Driver');
assert.strictEqual(prediction.predictedLapMs, 99500);
assert.strictEqual(prediction.sampleSize, 1);

const missingS3History = [driverLap('Missing S3', 2, [30000, 40000, 30000], { sector3Ms: '', sector3: '' })];
prediction = buildLapPrediction({
  history: missingS3History,
  rows: [liveRow({ driver: 'Missing S3', sector1: '30.000', sector2: '40.000' })],
  carNumber: 33,
  options: { sampleSize: 0 }
});
assert.strictEqual(prediction.available, false);
assert.match(prediction.reason, /Need sector 3 history/);

// New-driver case: after one completed lap, lap two can be predicted from S1
// plus that driver's single S2/S3 sample. More laps improve the average.
const newDriverHistory = [
  driverLap('New Driver', 2, [30000, 40000, 30000]),
  driverLap('New Driver', 3, [31000, 41000, 31000]),
  driverLap('New Driver', 4, [32000, 42000, 32000]),
  driverLap('New Driver', 5, [33000, 43000, 33000]),
  driverLap('New Driver', 6, [34000, 44000, 34000])
];
prediction = buildLapPrediction({
  history: newDriverHistory.slice(0, 1),
  rows: [liveRow({ driver: 'New Driver', sector1: '29.500' })],
  carNumber: 33
});
assert.strictEqual(prediction.available, true);
assert.strictEqual(prediction.predictedLapMs, 99500);
assert.strictEqual(prediction.sectors.map((sector) => sector.source).join(','), 'live,average,average');
assert.strictEqual(prediction.sectors[1].sampleCount, 1);

prediction = buildLapPrediction({
  history: newDriverHistory.slice(0, 5),
  rows: [liveRow({ driver: 'New Driver', sector1: '29.500', sector2: '39.500' })],
  carNumber: 33
});
assert.strictEqual(prediction.available, true);
assert.strictEqual(prediction.predictedLapMs, 101000);
assert.strictEqual(prediction.completedSectorCount, 2);
assert.strictEqual(prediction.sectors[2].sampleCount, 5);

// Once S3 is present, predictedLapMs must stay equal to the S1/S2 prediction.
// S3 is only used to show actual-vs-predicted delta until the next lap starts.
prediction = buildLapPrediction({
  history: newDriverHistory.slice(0, 5),
  rows: [liveRow({ driver: 'New Driver', sector1: '29.500', sector2: '39.500', sector3: '33.000' })],
  carNumber: 33
});
assert.strictEqual(prediction.available, true);
assert.strictEqual(prediction.predictedLapMs, 101000);
assert.strictEqual(prediction.actualLapMs, 102000);
assert.strictEqual(prediction.predictionDeltaMs, 1000);
assert.strictEqual(prediction.completedSectorCount, 2);
assert.strictEqual(prediction.label, 'After S2');

// Driver switch case 1: another driver's data must not be reused for a new
// driver. This avoids a confident-looking but wrong prediction after a change.
prediction = buildLapPrediction({
  history: [driverLap('Old Driver', 2, [30000, 40000, 30000])],
  rows: [liveRow({ driver: 'Fresh Driver', sector1: '31.000' })],
  carNumber: 33
});
assert.strictEqual(prediction.available, false);
assert.match(prediction.reason, /Fresh Driver/);

// Driver switch case 2: when the incoming driver has an earlier stint, that
// driver's own stored sectors are immediately usable.
prediction = buildLapPrediction({
  history: [
    driverLap('Returning Driver', 2, [29000, 39000, 29000]),
    driverLap('Other Driver', 3, [35000, 45000, 35000]),
    driverLap('Returning Driver', 4, [31000, 41000, 31000])
  ],
  rows: [liveRow({ driver: 'Returning Driver', sector1: '30.000' })],
  carNumber: 33
});
assert.strictEqual(prediction.available, true);
assert.strictEqual(prediction.predictedLapMs, 100000);

// Weather convergence case: the model still calculates correctly with old dry
// data, then moves toward the wet pace as recent wet laps replace dry samples in
// the last-10-sector window.
const dryHistory = Array.from({ length: 10 }, (_, index) => driverLap('Weather Driver', index + 2, [30000, 40000, 30000]));
prediction = buildLapPrediction({
  history: dryHistory,
  rows: [liveRow({ driver: 'Weather Driver', sector1: '35.000' })],
  carNumber: 33
});
assert.strictEqual(prediction.predictedLapMs, 105000);

const mixedWeatherHistory = [
  ...dryHistory,
  ...Array.from({ length: 5 }, (_, index) => driverLap('Weather Driver', 12 + index, [35000, 50000, 40000]))
];
prediction = buildLapPrediction({
  history: mixedWeatherHistory,
  rows: [liveRow({ driver: 'Weather Driver', sector1: '35.000' })],
  carNumber: 33
});
assert.strictEqual(prediction.predictedLapMs, 115000);

const wetHistory = [
  ...dryHistory,
  ...Array.from({ length: 10 }, (_, index) => driverLap('Weather Driver', 12 + index, [35000, 50000, 40000]))
];
prediction = buildLapPrediction({
  history: wetHistory,
  rows: [liveRow({ driver: 'Weather Driver', sector1: '35.000' })],
  carNumber: 33
});
assert.strictEqual(prediction.predictedLapMs, 125000);
assert.deepStrictEqual(recentDriverSectorValues(wetHistory, 33, 'Weather Driver', 2, 10), Array(10).fill(50000));

// Neutralized sectors are stored but excluded. Sector 1 from the FCY lap remains
// valid because it has an explicit green sector flag; S2/S3 do not.
const neutralizedHistory = [
  driverLap('Flag Driver', 2, [30000, 40000, 30000]),
  driverLap('Flag Driver', 3, [28000, 80000, 70000], {
    lapFlag: 'Full Course Yellow',
    sector1Flag: 'Green flag',
    sector2Flag: 'Full Course Yellow',
    sector3Flag: 'Full Course Yellow'
  })
];
const averages = recentDriverSectorAverages(neutralizedHistory, 33, 'Flag Driver');
assert.deepStrictEqual(averages.sectors.map((sector) => sector.values), [[30000, 28000], [40000], [30000]]);
prediction = buildLapPrediction({
  history: neutralizedHistory,
  rows: [liveRow({ driver: 'Flag Driver', sector1: '29.000' })],
  carNumber: 33
});
assert.strictEqual(prediction.predictedLapMs, 99000);

// Current live sectors marked FCY/yellow are not used as the "already driven"
// part of the lap; the UI should keep waiting for a valid sector 1.
prediction = buildLapPrediction({
  history: [driverLap('Flag Driver', 2, [30000, 40000, 30000])],
  rows: [liveRow({ driver: 'Flag Driver', sector1: '29.000', sector1Flag: 'Yellow flag' })],
  carNumber: 33
});
assert.strictEqual(prediction.available, false);
assert.strictEqual(prediction.reason, 'Waiting for sector 1');

for (const explicitInvalid of [false, 'false', 0, '0']) {
  prediction = buildLapPrediction({
    history: [driverLap('Explicit Flag Driver', 2, [30000, 40000, 30000])],
    rows: [liveRow({ driver: 'Explicit Flag Driver', sector1: '29.000', sector1Eligible: explicitInvalid })],
    carNumber: 33
  });
  assert.strictEqual(prediction.reason, 'Waiting for sector 1');
}

prediction = buildLapPrediction({
  history: [driverLap('Session Flag Driver', 2, [30000, 40000, 30000])],
  rows: [liveRow({ driver: 'Session Flag Driver', sector1: '29.000', sessionFlag: 'Code 60' })],
  carNumber: 33
});
assert.strictEqual(prediction.reason, 'Waiting for sector 1');

prediction = buildLapPrediction({
  history: [driverLap('Red Flag Driver', 2, [30000, 40000, 30000])],
  rows: [liveRow({ driver: 'Red Flag Driver', sector1: '29.000', sector1Flag: 'Red flag' })],
  carNumber: 33
});
assert.strictEqual(prediction.reason, 'Waiting for sector 1');

console.log('Lap prediction tests passed.');
