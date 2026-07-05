const assert = require('assert');
const {
  numberOrNull,
  average,
  median,
  isNeutralizedFlag,
  captureSectorFlags,
  lapPaceEligible,
  representativePaceLaps,
  sectorPaceEligible,
  normalizeLap,
  pitCountFromLap,
  pitAffectedLap,
  rowShowsInPit,
  annotatePitPhases,
  baseLapExclusionReasons,
  completedLaps,
  lapsForCar,
  lapsForDriver,
  statsForLaps,
  driverStats,
  bestDriverByAverage,
  carsInClass,
  compareBestDriverToCurrentDriver,
  carStats,
  bestCarInClassByAverage,
  currentStintStats,
  compareCarToClassTargets,
  buildDashboardAnalysis
} = require('../src/shared/lapAnalytics');
const { lap, tenLapHistory, stintComparisonHistory } = require('./mockLapHistory');

assert.strictEqual(numberOrNull('123'), 123);
assert.strictEqual(numberOrNull(''), null);
assert.strictEqual(numberOrNull('--'), null);
assert.strictEqual(numberOrNull(undefined), null);
assert.strictEqual(average([]), null);
assert.strictEqual(average(['--', undefined, '']), null);
assert.strictEqual(median([]), null);
assert.strictEqual(median([3, 1, 2]), 2);
assert.strictEqual(median([4, 1, 3, 2]), 2.5);
assert.strictEqual(isNeutralizedFlag('Safety car'), true);
assert.strictEqual(isNeutralizedFlag('Full Course Yellow'), true);
assert.strictEqual(isNeutralizedFlag('FCY'), true);
assert.strictEqual(isNeutralizedFlag('Code 60'), true);
assert.strictEqual(isNeutralizedFlag('Red flag'), true);
assert.strictEqual(isNeutralizedFlag('Green flag'), false);

const redFlagLap = normalizeLap({
  carNumber: 33,
  lapNumber: 8,
  lapTimeMs: 500000,
  sessionFlag: 'Red flag',
  sector1Flag: 'Red flag'
});
assert.strictEqual(lapPaceEligible(redFlagLap), false);
assert.strictEqual(sectorPaceEligible(redFlagLap, 1), false);

const firstGreenSector = captureSectorFlags({ lastLap: '2:05.000', sector1: '40.000', sector1Flag: '', sector1Eligible: '' }, null, 'Green flag');
assert.strictEqual(firstGreenSector.sector1Flag, 'Green flag');
assert.strictEqual(firstGreenSector.sector1Eligible, 'true');
const sameSectorAfterFcy = captureSectorFlags({ lastLap: '2:05.000', sector1: '40.000', sector2: '45.000', sector1Flag: '', sector2Flag: '', sector1Eligible: '', sector2Eligible: '' }, firstGreenSector, 'Full Course Yellow');
assert.strictEqual(sameSectorAfterFcy.sector1Flag, 'Green flag');
assert.strictEqual(sameSectorAfterFcy.sector1Eligible, 'true');
assert.strictEqual(sameSectorAfterFcy.sector2Flag, 'Full Course Yellow');
assert.strictEqual(sameSectorAfterFcy.sector2Eligible, 'false');

// Spa regression: FCY starts while the car is in S2, before S2 has a visible
// time. The pending S2 flag must survive both the later S2 time and a return to
// green before S3 is completed.
const spaS1Green = captureSectorFlags({ lastLap: '3:01.000', sector1: '55.000', sector2: '', sector3: '' }, null, 'Green flag');
const spaFcyDuringS2 = captureSectorFlags({ lastLap: '3:01.000', sector1: '55.000', sector2: '', sector3: '' }, spaS1Green, 'Full Course Yellow');
assert.strictEqual(spaFcyDuringS2.sector1Flag, 'Green flag');
assert.strictEqual(spaFcyDuringS2.sector2Flag, 'Full Course Yellow');
assert.strictEqual(spaFcyDuringS2.sector2Eligible, 'false');
const spaS2CompletedUnderFcy = captureSectorFlags({ lastLap: '3:01.000', sector1: '55.000', sector2: '1:40.000', sector3: '' }, spaFcyDuringS2, 'Full Course Yellow');
assert.strictEqual(spaS2CompletedUnderFcy.sector2Flag, 'Full Course Yellow');
assert.strictEqual(spaS2CompletedUnderFcy.sector3Flag, 'Full Course Yellow');
const spaGreenBeforeS3 = captureSectorFlags({ lastLap: '3:01.000', sector1: '55.000', sector2: '1:40.000', sector3: '' }, spaS2CompletedUnderFcy, 'Green flag');
assert.strictEqual(spaGreenBeforeS3.sector3Flag, 'Full Course Yellow');
const spaCompletedLapFlags = captureSectorFlags({ lastLap: '3:30.000', sector1: '55.000', sector2: '1:40.000', sector3: '55.000' }, spaGreenBeforeS3, 'Green flag');
assert.strictEqual(spaCompletedLapFlags.sector1Flag, 'Green flag');
assert.strictEqual(spaCompletedLapFlags.sector2Flag, 'Full Course Yellow');
assert.strictEqual(spaCompletedLapFlags.sector3Flag, 'Full Course Yellow');
const fcyDuringS1 = captureSectorFlags({ lastLap: '3:01.000', sector1: '', sector2: '', sector3: '' }, null, 'Full Course Yellow');
assert.strictEqual(fcyDuringS1.sector1Flag, 'Full Course Yellow');
assert.strictEqual(fcyDuringS1.sector1Eligible, 'false');
const greenThroughS2 = captureSectorFlags({ lastLap: '3:01.000', sector1: '55.000', sector2: '1:20.000', sector3: '' }, null, 'Green flag');
const redDuringS3 = captureSectorFlags({ lastLap: '3:01.000', sector1: '55.000', sector2: '1:20.000', sector3: '' }, greenThroughS2, 'Red flag');
assert.strictEqual(redDuringS3.sector1Flag, 'Green flag');
assert.strictEqual(redDuringS3.sector2Flag, 'Green flag');
assert.strictEqual(redDuringS3.sector3Flag, 'Red flag');
assert.strictEqual(redDuringS3.sector3Eligible, 'false');

const oldShapeLap = normalizeLap({
  carNumber: 7,
  className: 'GT',
  team: 'Old Shape Team',
  driver: 'Old Driver',
  lapNumber: '3',
  lastLapMs: 101234,
  sector1Ms: '31000',
  sector2Ms: '40000',
  sector3Ms: '30234'
});
assert.strictEqual(oldShapeLap.teamName, 'Old Shape Team');
assert.strictEqual(oldShapeLap.driverName, 'Old Driver');
assert.strictEqual(oldShapeLap.lapTimeMs, 101234);
assert.strictEqual(lapPaceEligible(oldShapeLap), true);

const recoveredRisSector3 = normalizeLap({
  sourceProvider: 'ris-timing',
  carNumber: 33,
  lapTimeMs: 182091,
  sector1Ms: 53272,
  sector2Ms: 81504,
  sector3Ms: ''
});
assert.strictEqual(recoveredRisSector3.sector3Ms, 47315);

const explicitFalseLap = normalizeLap({
  carNumber: null,
  className: null,
  teamName: null,
  driverName: null,
  lapTimeMs: '100000',
  lapNumber: '',
  flagState: 'Safety car',
  paceEligible: 'false',
  sector1Eligible: 'false',
  sector2Flag: 'Yellow flag',
  sector3Flag: 'Green flag'
});
assert.strictEqual(explicitFalseLap.carNumber, '');
assert.strictEqual(explicitFalseLap.className, '');
assert.strictEqual(explicitFalseLap.teamName, '');
assert.strictEqual(explicitFalseLap.driverName, '');
assert.strictEqual(explicitFalseLap.lapTimeMs, 100000);
assert.strictEqual(lapPaceEligible(explicitFalseLap), false);
assert.strictEqual(sectorPaceEligible(explicitFalseLap, 1), false);
assert.strictEqual(sectorPaceEligible(explicitFalseLap, 2), false);
assert.strictEqual(sectorPaceEligible(explicitFalseLap, 3), true);

const noisyHistory = [
  { carNumber: '', lapTimeMs: '100000', lapNumber: '1' },
  { carNumber: '33', lapTimeMs: '--', lapNumber: '2' },
  lap({ carNumber: 33, teamName: 'Our Team', driverName: 'Noise Driver', lapNumber: 3, lapTimeMs: 101000, sector1Ms: 31000, sector2Ms: 40000, sector3Ms: 30000 })
];
assert.strictEqual(completedLaps(noisyHistory).length, 1);

const tenLaps = tenLapHistory();
const car33Laps = lapsForCar(tenLaps, 33);
assert.strictEqual(car33Laps.length, 10);
assert.strictEqual(average(car33Laps.map((lap) => lap.lapTimeMs)), 99500);

const tenLapStats = statsForLaps(car33Laps);
assert.strictEqual(tenLapStats.lapCount, 10);
assert.strictEqual(tenLapStats.paceLapCount, 10);
assert.strictEqual(tenLapStats.averageLapMs, 99500);
assert.strictEqual(tenLapStats.bestLapMs, 95000);
assert.strictEqual(tenLapStats.lastLapMs, 95000);
assert.strictEqual(tenLapStats.bestSector1Ms, 30000);
assert.strictEqual(tenLapStats.bestSector2Ms, 39100);
assert.strictEqual(tenLapStats.bestSector3Ms, 25000);

const emptyStats = statsForLaps([]);
assert.strictEqual(emptyStats.lapCount, 0);
assert.strictEqual(emptyStats.averageLapMs, null);
assert.strictEqual(emptyStats.bestLapMs, null);
assert.strictEqual(emptyStats.lastLapMs, null);
assert.strictEqual(emptyStats.bestSector1Ms, null);

const missingSectorStats = statsForLaps([
  { carNumber: '1', lapNumber: 1, lapTimeMs: 100000, sector1Ms: null, sector2Ms: 40000, sector3Ms: null }
]);
assert.strictEqual(missingSectorStats.averageLapMs, 100000);
assert.strictEqual(missingSectorStats.bestSector1Ms, null);
assert.strictEqual(missingSectorStats.bestSector2Ms, 40000);

// RIS can expose elapsed session time as the first LAST value when collection
// starts mid-session. It remains stored but must not distort pace statistics.
const spaStartupLaps = [
  lap({ carNumber: 33, driverName: 'JANSSENS Robbe', lapNumber: 1, lapTimeMs: 2105611 }),
  lap({ carNumber: 33, driverName: 'JANSSENS Robbe', lapNumber: 2, lapTimeMs: 183146 }),
  lap({ carNumber: 33, driverName: 'JANSSENS Robbe', lapNumber: 3, lapTimeMs: 173985 }),
  lap({ carNumber: 33, driverName: 'JANSSENS Robbe', lapNumber: 4, lapTimeMs: 173589 })
].map(normalizeLap);
const representativeSpaLaps = representativePaceLaps(spaStartupLaps);
assert.deepStrictEqual(representativeSpaLaps.map((entry) => entry.lapNumber), [2, 3, 4]);
const spaStartupStats = statsForLaps(spaStartupLaps);
assert.strictEqual(spaStartupStats.paceLapCount, 3);
assert.strictEqual(spaStartupStats.excludedOutlierLapCount, 1);
assert.strictEqual(spaStartupStats.averageLapMs, 176906.66666666666);
assert.strictEqual(spaStartupStats.lastLapMs, 173589);

// Do not classify ordinary variation or a one-minute weather shift as garbage.
const weatherTransition = [120000, 122000, 180000].map((lapTimeMs, index) => normalizeLap({
  carNumber: 7,
  lapNumber: index + 1,
  lapTimeMs
}));
assert.strictEqual(representativePaceLaps(weatherTransition).length, 3);
assert.strictEqual(representativePaceLaps(spaStartupLaps, { minimumSamples: 5 }).length, 4);

// A genuinely slow lap with a matching full sectorsum is evidence, not an
// outlier: rain, a spin, or traffic may explain it and it must remain included.
const confirmedSlowLap = normalizeLap({
  carNumber: 7,
  lapNumber: 4,
  lapTimeMs: 300000,
  sector1Ms: 100000,
  sector2Ms: 110000,
  sector3Ms: 90000
});
assert.strictEqual(representativePaceLaps([...weatherTransition, confirmedSlowLap]).includes(confirmedSlowLap), true);

const neutralizedHistory = [
  lap({ carNumber: 33, teamName: 'Our Team', driverName: 'Driver A', lapNumber: 1, lapTimeMs: 100000, sector1Ms: 30000, sector2Ms: 40000, sector3Ms: 30000, sessionFlag: 'Green flag' }),
  lap({ carNumber: 33, teamName: 'Our Team', driverName: 'Driver A', lapNumber: 2, lapTimeMs: 160000, sector1Ms: 29000, sector2Ms: 70000, sector3Ms: 61000, sessionFlag: 'Safety car' }),
  lap({ carNumber: 33, teamName: 'Our Team', driverName: 'Driver A', lapNumber: 3, lapTimeMs: 120000, sector1Ms: 28000, sector2Ms: 62000, sector3Ms: 30000, lapFlag: 'Full Course Yellow', sector1Flag: 'Green flag', sector2Flag: 'Full Course Yellow', sector3Flag: 'Full Course Yellow' }),
  lap({ carNumber: 33, teamName: 'Our Team', driverName: 'Driver A', lapNumber: 4, lapTimeMs: 99000, sector1Ms: 31000, sector2Ms: 39000, sector3Ms: 29000, paceEligible: true, sector1Eligible: true, sector2Eligible: true, sector3Eligible: true })
];
const normalizedNeutralized = completedLaps(neutralizedHistory);
assert.strictEqual(lapPaceEligible(normalizedNeutralized[0]), true);
assert.strictEqual(lapPaceEligible(normalizedNeutralized[1]), false);
assert.strictEqual(lapPaceEligible(normalizedNeutralized[2]), false);
assert.strictEqual(sectorPaceEligible(normalizedNeutralized[2], 1), true);
assert.strictEqual(sectorPaceEligible(normalizedNeutralized[2], 2), false);
assert.strictEqual(sectorPaceEligible(normalizedNeutralized[2], 3), false);

const oneNeutralizedSector = normalizeLap({
  carNumber: 33,
  lapTimeMs: 100000,
  paceEligible: true,
  sessionFlag: 'Green flag',
  sector1Flag: 'Green flag',
  sector2Flag: 'Safety car',
  sector3Flag: 'Green flag'
});
assert.strictEqual(lapPaceEligible(oneNeutralizedSector), false, 'one SC/FCY sector excludes the complete lap');
assert.strictEqual(sectorPaceEligible(oneNeutralizedSector, 1), true, 'green sectors remain valid individually');
assert.strictEqual(sectorPaceEligible(oneNeutralizedSector, 2), false);

const pitSequence = [
  normalizeLap({ carNumber: 33, lapNumber: 1, lapTimeMs: 100000, pitInfo: '0' }),
  normalizeLap({ carNumber: 33, lapNumber: 2, lapTimeMs: 150000, pitInfo: 'P1' }),
  normalizeLap({ carNumber: 33, lapNumber: 3, lapTimeMs: 120000, pitInfo: 'P1' }),
  normalizeLap({ carNumber: 33, lapNumber: 4, lapTimeMs: 101000, pitInfo: 'P1' })
];
const annotatedPitSequence = annotatePitPhases(pitSequence);
assert.strictEqual(pitCountFromLap(annotatedPitSequence[1]), 1);
assert.strictEqual(annotatedPitSequence[1].lapPhase, 'inlap');
assert.strictEqual(annotatedPitSequence[2].lapPhase, 'outlap');
assert.strictEqual(pitAffectedLap(annotatedPitSequence[2]), true);
assert.strictEqual(lapPaceEligible(annotatedPitSequence[1]), false);
assert.strictEqual(lapPaceEligible(annotatedPitSequence[2]), false);
assert.strictEqual(lapPaceEligible(annotatedPitSequence[3]), true);
assert.strictEqual(sectorPaceEligible(annotatedPitSequence[2], 1), false, 'outlap sectors do not affect sector averages');

const spaPitSequence = annotatePitPhases([
  normalizeLap({ carNumber: 33, lapNumber: 22, lapTimeMs: 180000, pitInfo: '--', state: 'RUN' }),
  normalizeLap({ carNumber: 33, lapNumber: 23, lapTimeMs: 181000, pitInfo: '--', state: 'IN' }),
  normalizeLap({ carNumber: 33, lapNumber: 24, lapTimeMs: 420000, pitInfo: '1', state: 'RUN' }),
  normalizeLap({ carNumber: 33, lapNumber: 25, lapTimeMs: 182000, pitInfo: '1', state: 'RUN' })
]);
assert.strictEqual(rowShowsInPit(spaPitSequence[1]), true);
assert.strictEqual(spaPitSequence[1].lapPhase, 'inlap');
assert.strictEqual(spaPitSequence[2].lapPhase, 'outlap');
assert.strictEqual(spaPitSequence[3].lapPhase, '');
assert.deepStrictEqual(baseLapExclusionReasons(spaPitSequence[1]), ['pit-in']);

const auditableStats = statsForLaps(spaPitSequence);
assert.strictEqual(auditableStats.selection.lap.includedCount, 2);
assert.strictEqual(auditableStats.selection.lap.excludedCount, 2);
assert.strictEqual(auditableStats.selection.lap.excludedByReason['pit-in'], 1);
assert.strictEqual(auditableStats.selection.lap.excludedByReason['pit-out'], 1);
assert.deepStrictEqual(auditableStats.selection.lap.excludedLaps.map((lapEntry) => lapEntry.lapNumber), [23, 24]);

const neutralizedStats = statsForLaps(normalizedNeutralized);
assert.strictEqual(neutralizedStats.lapCount, 4);
assert.strictEqual(neutralizedStats.paceLapCount, 2);
assert.strictEqual(neutralizedStats.averageLapMs, 99500);
assert.strictEqual(neutralizedStats.bestLapMs, 99000);
assert.strictEqual(neutralizedStats.lastLapMs, 99000);
assert.strictEqual(neutralizedStats.bestSector1Ms, 28000);
assert.strictEqual(neutralizedStats.bestSector2Ms, 39000);
assert.strictEqual(neutralizedStats.bestSector3Ms, 29000);
assert.strictEqual(neutralizedStats.averageSector1Ms, 29666.666666666668);
assert.strictEqual(neutralizedStats.averageSector2Ms, 39500);
assert.strictEqual(neutralizedStats.averageSector3Ms, 29500);

const stintHistory = stintComparisonHistory();
const ourDriverStats = driverStats(stintHistory, 33);
assert.deepStrictEqual(ourDriverStats.map((stats) => stats.driverName), ['Driver 1', 'Driver 2', 'Driver 3']);
assert.strictEqual(ourDriverStats.find((stats) => stats.driverName === 'Driver 1').lapCount, 20);
assert.strictEqual(ourDriverStats.find((stats) => stats.driverName === 'Driver 2').lapCount, 20);
assert.strictEqual(ourDriverStats.find((stats) => stats.driverName === 'Driver 3').lapCount, 10);
assert.strictEqual(lapsForDriver(stintHistory, 33, 'Driver 2').length, 20);

const bestDriver = bestDriverByAverage(stintHistory, 33);
assert.strictEqual(bestDriver.driverName, 'Driver 1');
assert.strictEqual(bestDriver.averageLapMs, 100095);
assert.strictEqual(bestDriver.bestLapMs, 100000);

const driverComparison = compareBestDriverToCurrentDriver(stintHistory, 33, 'Driver 3');
assert.strictEqual(driverComparison.bestDriver.driverName, 'Driver 1');
assert.strictEqual(driverComparison.currentDriver.driverName, 'Driver 3');
assert.strictEqual(driverComparison.currentDriver.lastLapMs, 102090);
assert.strictEqual(driverComparison.currentDriver.bestLapMs, 102000);
assert.strictEqual(driverComparison.currentDriver.averageLapMs, 102045);
assert.strictEqual(driverComparison.deltas.bestDriverBestLapToCurrentLastLapMs, 2090);
assert.strictEqual(driverComparison.deltas.bestDriverBestLapToCurrentBestLapMs, 2000);
assert.strictEqual(driverComparison.deltas.bestDriverAverageToCurrentAverageMs, 1950);

const missingDriverComparison = compareBestDriverToCurrentDriver(stintHistory, 33, 'Driver 404');
assert.strictEqual(missingDriverComparison, null);

const noHistoryDriverComparison = compareBestDriverToCurrentDriver([], 33, 'Driver 1');
assert.strictEqual(noHistoryDriverComparison, null);

const fasterCurrentHistory = [
  lap({ carNumber: 44, teamName: 'Fast Current', driverName: 'Reference', lapNumber: 1, lapTimeMs: 100000, sector1Ms: 30000, sector2Ms: 40000, sector3Ms: 30000 }),
  lap({ carNumber: 44, teamName: 'Fast Current', driverName: 'Reference', lapNumber: 2, lapTimeMs: 100200, sector1Ms: 30100, sector2Ms: 40100, sector3Ms: 30000 }),
  lap({ carNumber: 44, teamName: 'Fast Current', driverName: 'Current', lapNumber: 3, lapTimeMs: 99000, sector1Ms: 29500, sector2Ms: 39500, sector3Ms: 30000 }),
  lap({ carNumber: 44, teamName: 'Fast Current', driverName: 'Current', lapNumber: 4, lapTimeMs: 99200, sector1Ms: 29600, sector2Ms: 39600, sector3Ms: 30000 })
];
const fasterComparison = compareBestDriverToCurrentDriver(fasterCurrentHistory, 44, 'Current');
assert.strictEqual(fasterComparison.bestDriver.driverName, 'Current');
assert.strictEqual(fasterComparison.deltas.bestDriverAverageToCurrentAverageMs, 0);

const ourCar = carStats(stintHistory, 33);
assert.strictEqual(ourCar.lapCount, 50);
assert.strictEqual(ourCar.className, 'LMP3');

assert.strictEqual(carStats(stintHistory, 999).lapCount, 0);
assert.strictEqual(carStats(stintHistory, 999).averageLapMs, null);
assert.strictEqual(carsInClass(stintHistory, 'LMP3').length, 3);
assert.deepStrictEqual(carsInClass(stintHistory, 'NOPE'), []);
assert.strictEqual(bestCarInClassByAverage(stintHistory, 'NOPE'), null);

const bestClassCar = bestCarInClassByAverage(stintHistory, 'LMP3');
assert.strictEqual(bestClassCar.carNumber, '2');
assert.strictEqual(bestClassCar.averageLapMs, 99095);

const currentStint = currentStintStats(stintHistory, 33, 'Driver 3');
assert.strictEqual(currentStint.driverName, 'Driver 3');
assert.strictEqual(currentStint.lapCount, 10);
assert.strictEqual(currentStint.averageLapMs, 102045);

const missingStint = currentStintStats(stintHistory, 33, 'Driver 404');
assert.strictEqual(missingStint.driverName, 'Driver 404');
assert.strictEqual(missingStint.lapCount, 0);
assert.strictEqual(missingStint.averageLapMs, null);

const classComparison = compareCarToClassTargets(stintHistory, 33, 9);
assert.strictEqual(classComparison.bestClassCar.carNumber, '2');
assert.strictEqual(classComparison.selectedCar.carNumber, '9');
assert.strictEqual(classComparison.ourCurrentStint.driverName, 'Driver 3');
assert.strictEqual(classComparison.deltas.currentStintAverageToBestClassCarAverageMs, 2950);
assert.strictEqual(classComparison.deltas.currentStintAverageToSelectedCarAverageMs, 1450);

const noSelectedComparison = compareCarToClassTargets(stintHistory, 33);
assert.strictEqual(noSelectedComparison.selectedCar, null);
assert.strictEqual(noSelectedComparison.deltas.currentStintAverageToSelectedCarAverageMs, null);

const missingSelectedComparison = compareCarToClassTargets(stintHistory, 33, 999);
assert.strictEqual(missingSelectedComparison.selectedCar.carNumber, '999');
assert.strictEqual(missingSelectedComparison.selectedCar.lapCount, 0);
assert.strictEqual(missingSelectedComparison.deltas.currentStintAverageToSelectedCarAverageMs, null);

const unknownOurCarComparison = compareCarToClassTargets(stintHistory, 999, 9);
assert.strictEqual(unknownOurCarComparison.bestClassCar, null);
assert.strictEqual(unknownOurCarComparison.deltas.currentStintAverageToBestClassCarAverageMs, null);

const dashboardAnalysis = buildDashboardAnalysis(stintHistory, { ourCarNumber: 33, selectedCarNumber: 9 });
assert.strictEqual(dashboardAnalysis.currentDriverName, 'Driver 3');
assert.strictEqual(dashboardAnalysis.driverComparison.deltas.bestDriverAverageToCurrentAverageMs, 1950);
assert.strictEqual(dashboardAnalysis.classComparison.deltas.currentStintAverageToSelectedCarAverageMs, 1450);
const liveDriverOverrideAnalysis = buildDashboardAnalysis(stintHistory, {
  ourCarNumber: 33,
  selectedCarNumber: 9,
  currentDriverName: 'Driver 1'
});
assert.strictEqual(liveDriverOverrideAnalysis.currentDriverName, 'Driver 1');
assert.strictEqual(liveDriverOverrideAnalysis.driverComparison.currentDriver.driverName, 'Driver 1');
assert.strictEqual(liveDriverOverrideAnalysis.classComparison.ourCurrentStint.driverName, 'Driver 1');
assert.strictEqual(buildDashboardAnalysis(stintHistory), null);

console.log('Lap analytics tests passed.');
