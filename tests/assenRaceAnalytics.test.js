const assert = require('assert');
const path = require('path');
const {
  statsForLaps,
  driverStats,
  compareBestDriverToCurrentDriver,
  carStats,
  bestCarInClassByAverage,
  compareCarToClassTargets,
  buildDashboardAnalysis
} = require('../src/shared/lapAnalytics');
const { loadRaceData } = require('./race-assen-simulator/core');

const dataPath = path.join(__dirname, 'race-assen-simulator', 'assen-club-challenge-data.json');
const assenData = loadRaceData(dataPath);
const SECTOR_SPLITS = [0.34, 0.37, 0.29];

function closeTo(actual, expected, tolerance = 0.000001) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `Expected ${actual} to be within ${tolerance} of ${expected}`);
}

function driverForLap(car, lapNumber) {
  const names = car.driverNames && car.driverNames.length ? car.driverNames : ['Unknown'];
  const lapBlockSize = Math.ceil(car.lapTimeMs.length / names.length);
  return names[Math.min(names.length - 1, Math.floor((lapNumber - 1) / lapBlockSize))];
}

function assenLapHistory({ neutralizeCar33Lap48 = false } = {}) {
  return assenData.cars.flatMap((car) => car.lapTimeMs.map((lapTimeMs, index) => {
    const lapNumber = index + 1;
    const isNeutralizedExample = neutralizeCar33Lap48 && car.carNumber === '33' && lapNumber === 48;
    return {
      carNumber: car.carNumber,
      className: car.className,
      teamName: car.teamName,
      driverName: driverForLap(car, lapNumber),
      lapNumber,
      lapTimeMs,
      sector1Ms: Math.round(lapTimeMs * SECTOR_SPLITS[0]),
      sector2Ms: Math.round(lapTimeMs * SECTOR_SPLITS[1]),
      sector3Ms: Math.round(lapTimeMs * SECTOR_SPLITS[2]),
      lapFlag: isNeutralizedExample ? 'Full Course Yellow' : 'Green flag',
      sector1Flag: isNeutralizedExample ? 'Green flag' : 'Green flag',
      sector2Flag: isNeutralizedExample ? 'Full Course Yellow' : 'Green flag',
      sector3Flag: isNeutralizedExample ? 'Full Course Yellow' : 'Green flag',
      recordedAt: `2026-06-07T15:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`
    };
  }));
}

const history = assenLapHistory();
const neutralizedHistory = assenLapHistory({ neutralizeCar33Lap48: true });

const mstcStats = carStats(history, '33');
assert.strictEqual(mstcStats.carNumber, '33');
assert.strictEqual(mstcStats.teamName, 'MSTC');
assert.strictEqual(mstcStats.className, 'Club Challenge');
assert.strictEqual(mstcStats.lapCount, 83);
assert.strictEqual(mstcStats.paceLapCount, 82);
closeTo(mstcStats.averageLapMs, 131593.25609756098);
assert.strictEqual(mstcStats.bestLapMs, 119551);
assert.strictEqual(mstcStats.lastLapMs, 132155);
closeTo(mstcStats.averageSector1Ms, 44741.70731707317);
closeTo(mstcStats.averageSector2Ms, 48689.57317073171);
closeTo(mstcStats.averageSector3Ms, 38162.060975609755);
assert.strictEqual(mstcStats.bestSector1Ms, 40647);
assert.strictEqual(mstcStats.bestSector2Ms, 44234);
assert.strictEqual(mstcStats.bestSector3Ms, 34670);

const car38Stats = carStats(history, '38');
assert.strictEqual(car38Stats.lapCount, 84);
assert.strictEqual(car38Stats.paceLapCount, 83);
closeTo(car38Stats.averageLapMs, 128870.14457831325);
assert.strictEqual(car38Stats.bestLapMs, 121340);
assert.strictEqual(car38Stats.lastLapMs, 125330);

const car56Stats = carStats(history, '56');
assert.strictEqual(car56Stats.lapCount, 80);
assert.strictEqual(car56Stats.paceLapCount, 79);
closeTo(car56Stats.averageLapMs, 136414.54430379748);
assert.strictEqual(car56Stats.bestLapMs, 121411);

const bestClassCar = bestCarInClassByAverage(history, 'Club Challenge');
assert.strictEqual(bestClassCar.carNumber, '38');
closeTo(bestClassCar.averageLapMs, 128870.14457831325);

const mstcDriverStats = driverStats(history, '33');
assert.deepStrictEqual(mstcDriverStats.map((stats) => stats.driverName), ['De Jong', 'Janssens']);
assert.strictEqual(mstcDriverStats[0].lapCount, 42);
assert.strictEqual(mstcDriverStats[1].lapCount, 41);
assert.strictEqual(mstcDriverStats[0].paceLapCount, 41);
assert.strictEqual(mstcDriverStats[1].paceLapCount, 41);
closeTo(mstcDriverStats[0].averageLapMs, 123789.75609756098);
closeTo(mstcDriverStats[1].averageLapMs, 139396.75609756098);
assert.strictEqual(mstcDriverStats[0].bestLapMs, 119551);
assert.strictEqual(mstcDriverStats[1].bestLapMs, 120311);

const driverComparison = compareBestDriverToCurrentDriver(history, '33', 'Janssens');
assert.strictEqual(driverComparison.bestDriver.driverName, 'De Jong');
assert.strictEqual(driverComparison.currentDriver.driverName, 'Janssens');
assert.strictEqual(driverComparison.deltas.bestDriverBestLapToCurrentLastLapMs, 12604);
assert.strictEqual(driverComparison.deltas.bestDriverBestLapToCurrentBestLapMs, 760);
closeTo(driverComparison.deltas.bestDriverAverageToCurrentAverageMs, 15607);

const classComparison = compareCarToClassTargets(history, '33', '56');
assert.strictEqual(classComparison.bestClassCar.carNumber, '38');
assert.strictEqual(classComparison.selectedCar.carNumber, '56');
assert.strictEqual(classComparison.ourCurrentStint.driverName, 'Janssens');
closeTo(classComparison.deltas.currentStintAverageToBestClassCarAverageMs, 10526.61151924773);
closeTo(classComparison.deltas.currentStintAverageToSelectedCarAverageMs, 2982.211793763505);

const dashboardAnalysis = buildDashboardAnalysis(history, { ourCarNumber: '33', selectedCarNumber: '56' });
assert.strictEqual(dashboardAnalysis.currentDriverName, 'Janssens');
assert.strictEqual(dashboardAnalysis.driverComparison.bestDriver.driverName, 'De Jong');
assert.strictEqual(dashboardAnalysis.classComparison.bestClassCar.carNumber, '38');

const neutralizedMstcStats = carStats(neutralizedHistory, '33');
assert.strictEqual(neutralizedMstcStats.lapCount, 83);
assert.strictEqual(neutralizedMstcStats.paceLapCount, 81);
closeTo(neutralizedMstcStats.averageLapMs, 129393.61728395062);
assert.strictEqual(neutralizedMstcStats.bestLapMs, 119551);
assert.strictEqual(neutralizedMstcStats.lastLapMs, 132155);

// Lap 48 is marked FCY for the full lap but sector 1 is still explicitly green.
// That means the lap must be excluded from lap averages while sector 1 remains
// eligible for sector averages.
closeTo(neutralizedMstcStats.averageSector1Ms, 44741.70731707317);
assert.ok(neutralizedMstcStats.averageSector2Ms < mstcStats.averageSector2Ms);
assert.ok(neutralizedMstcStats.averageSector3Ms < mstcStats.averageSector3Ms);

const neutralizedCurrentStint = statsForLaps(neutralizedMstcStats.laps.filter((lap) => lap.driverName === 'Janssens'));
assert.strictEqual(neutralizedCurrentStint.lapCount, 41);
assert.strictEqual(neutralizedCurrentStint.paceLapCount, 40);
closeTo(neutralizedCurrentStint.averageLapMs, 135137.575);

const neutralizedClassComparison = compareCarToClassTargets(neutralizedHistory, '33', '56');
closeTo(neutralizedClassComparison.deltas.currentStintAverageToBestClassCarAverageMs, 6267.43042168676);
closeTo(neutralizedClassComparison.deltas.currentStintAverageToSelectedCarAverageMs, -1276.9693037974648);

console.log('Assen race analytics tests passed.');
