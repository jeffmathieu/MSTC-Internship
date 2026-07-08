const assert = require('assert');
const { lap } = require('./mockLapHistory');
const {
  driverInitials,
  stripStatus,
  buildTimingHighlights
} = require('../src/shared/timingHighlights');

assert.strictEqual(driverInitials('Nigel Moore'), 'NM');
assert.strictEqual(driverInitials('DE JONG Alain'), 'DJA');
assert.strictEqual(driverInitials(''), '');
assert.strictEqual(stripStatus({ lapPhase: 'inlap', sessionFlag: 'FCY' }), 'pit-in', 'pit status has visual priority');
assert.strictEqual(stripStatus({ lapPhase: 'outlap' }), 'pit-out');
assert.strictEqual(stripStatus({ sessionFlag: 'Safety car' }), 'neutralized');
assert.strictEqual(stripStatus({ sessionFlag: 'Green flag' }), 'normal');

const personalBestHistory = [
  lap({ carNumber: 13, className: 'C.CHA', driverName: 'Nigel Moore', lapNumber: 1, lapTimeMs: 125000, sector1Ms: 41000, sector2Ms: 47000, sector3Ms: 37000 }),
  lap({ carNumber: 13, className: 'C.CHA', driverName: 'Nigel Moore', lapNumber: 2, lapTimeMs: 123000, sector1Ms: 40000, sector2Ms: 46000, sector3Ms: 37000 }),
  lap({ carNumber: 13, className: 'C.CHA', driverName: 'Nigel Moore', lapNumber: 3, lapTimeMs: 120000, sector1Ms: 39000, sector2Ms: 45000, sector3Ms: 36000, sessionFlag: 'FCY' }),
  lap({ carNumber: 2, className: 'C.CHA', driverName: 'Fast Driver', lapNumber: 1, lapTimeMs: 122500, sector1Ms: 39500, sector2Ms: 47000, sector3Ms: 36000 })
];
const personal = buildTimingHighlights(personalBestHistory, '13');
assert.strictEqual(personal.bestLap.valueMs, 123000);
assert.strictEqual(personal.bestLap.classBestMs, 122500);
assert.strictEqual(personal.bestLap.isClassBest, false);
assert.strictEqual(personal.lapStrip[1].highlight, 'personal-best');
assert.strictEqual(personal.lapStrip[2].status, 'neutralized');
assert.strictEqual(personal.lapStrip[2].highlight, 'none', 'an FCY lap can never receive a best-lap color');
assert.strictEqual(personal.bestSectors.sector1.isClassBest, false);
assert.strictEqual(personal.bestSectors.sector2.isClassBest, true);
assert.strictEqual(personal.bestSectors.sector3.isClassBest, false);

const classBestHistory = personalBestHistory.map((entry) => ({ ...entry }));
classBestHistory.find((entry) => entry.carNumber === '2').lapTimeMs = 124000;
const classBest = buildTimingHighlights(classBestHistory, 13);
assert.strictEqual(classBest.bestLap.isClassBest, true);
assert.strictEqual(classBest.lapStrip[1].highlight, 'class-best');
assert.strictEqual(classBest.lapStrip[1].driverInitials, 'NM');

const empty = buildTimingHighlights([], '13');
assert.strictEqual(empty.bestLap.valueMs, null);
assert.strictEqual(empty.bestLap.isClassBest, false);
assert.deepStrictEqual(empty.lapStrip, []);

const driverChange = buildTimingHighlights([
  lap({ carNumber: 12, className: 'LMP3', driverName: 'Alessandro Bressan', lapNumber: 56, lapTimeMs: 126398, pitInfo: '2' }),
  lap({ carNumber: 12, className: 'LMP3', driverName: 'Gabriele Lancieri', lapNumber: 57, lapTimeMs: 242163, pitInfo: '3' })
], '12');
assert.strictEqual(driverChange.lapStrip[0].status, 'pit-in');
assert.strictEqual(driverChange.lapStrip[0].marker, 'P');
assert.strictEqual(driverChange.lapStrip[1].status, 'pit-out');
assert.strictEqual(driverChange.lapStrip[1].marker, '');

const providerLapResetHistory = [
  lap({ carNumber: 12, className: 'LMP3', driverName: 'Gabriele Lancieri', lapNumber: 86, lapTimeMs: 126548, collectedAt: '2026-07-08T12:00:00.000Z' }),
  lap({ carNumber: 12, className: 'LMP3', driverName: 'Gabriele Lancieri', lapNumber: 87, lapTimeMs: 126413, collectedAt: '2026-07-08T12:02:00.000Z' }),
  lap({ carNumber: 12, className: 'LMP3', driverName: 'Yuki Harata', lapNumber: 4, lapTimeMs: 130407, collectedAt: '2026-07-08T12:06:00.000Z' }),
  lap({ carNumber: 12, className: 'LMP3', driverName: 'Yuki Harata', lapNumber: 5, lapTimeMs: 130619, collectedAt: '2026-07-08T12:08:00.000Z' })
];
const providerLapReset = buildTimingHighlights(providerLapResetHistory, '12');
assert.deepStrictEqual(
  providerLapReset.lapStrip.map((entry) => entry.lapNumber),
  [86, 87, 4, 5],
  'lap strip follows storage time, not a provider lap counter that reset after a driver change'
);
assert.strictEqual(providerLapReset.lapStrip.at(-1).driverInitials, 'YH');

const conditionHistory = [
  lap({
    carNumber: 12,
    className: 'LMP3',
    driverName: 'Dry Driver',
    lapNumber: 1,
    lapTimeMs: 122659,
    sector1Ms: 42124,
    sector2Ms: 43907,
    sector3Ms: 36373,
    lapCondition: 'dry',
    sector1Condition: 'dry',
    sector2Condition: 'dry',
    sector3Condition: 'dry'
  }),
  lap({
    carNumber: 12,
    className: 'LMP3',
    driverName: 'Wet Driver',
    lapNumber: 2,
    lapTimeMs: 132000,
    sector1Ms: 46000,
    sector2Ms: 48000,
    sector3Ms: 38000,
    lapCondition: 'wet',
    sector1Condition: 'wet',
    sector2Condition: 'wet',
    sector3Condition: 'wet'
  }),
  lap({
    carNumber: 9,
    className: 'LMP3',
    driverName: 'Dry Rival',
    lapNumber: 1,
    lapTimeMs: 121000,
    sector1Ms: 41000,
    sector2Ms: 43000,
    sector3Ms: 36000,
    lapCondition: 'dry',
    sector1Condition: 'dry',
    sector2Condition: 'dry',
    sector3Condition: 'dry'
  }),
  lap({
    carNumber: 9,
    className: 'LMP3',
    driverName: 'Wet Rival',
    lapNumber: 2,
    lapTimeMs: 131000,
    sector1Ms: 45500,
    sector2Ms: 47500,
    sector3Ms: 37500,
    lapCondition: 'wet',
    sector1Condition: 'wet',
    sector2Condition: 'wet',
    sector3Condition: 'wet'
  })
];
const dryHighlights = buildTimingHighlights(conditionHistory, '12', { conditionFilter: 'dry' });
assert.strictEqual(dryHighlights.bestLap.valueMs, 122659);
assert.strictEqual(dryHighlights.bestLap.classBestMs, 121000);
assert.strictEqual(dryHighlights.bestLap.isClassBest, false);
assert.strictEqual(dryHighlights.bestSectors.sector1.valueMs, 42124);
assert.strictEqual(dryHighlights.bestSectors.sector1.classBestMs, 41000);

const wetHighlights = buildTimingHighlights(conditionHistory, '12', { conditionFilter: 'wet' });
assert.strictEqual(wetHighlights.conditionFilter, 'wet');
assert.strictEqual(wetHighlights.bestLap.valueMs, 132000, 'wet view uses the wet best lap, not the dry best lap');
assert.strictEqual(wetHighlights.bestLap.classBestMs, 131000, 'wet class-best comparison only uses wet class samples');
assert.strictEqual(wetHighlights.bestLap.isClassBest, false);
assert.strictEqual(wetHighlights.bestSectors.sector1.valueMs, 46000);
assert.strictEqual(wetHighlights.bestSectors.sector1.classBestMs, 45500);
assert.strictEqual(wetHighlights.lapStrip[1].lapCondition, 'wet');

const noWetOwnSamples = buildTimingHighlights([
  conditionHistory[0],
  conditionHistory[3]
], '12', { conditionFilter: 'wet' });
assert.strictEqual(noWetOwnSamples.bestLap.valueMs, null, 'wet view shows no best lap when our car has no wet lap');
assert.strictEqual(noWetOwnSamples.bestLap.isClassBest, false, 'a missing wet best lap must not render as class-best purple');
assert.strictEqual(noWetOwnSamples.bestSectors.sector1.valueMs, null, 'wet view shows no best sector when our car has no wet sector');
assert.strictEqual(noWetOwnSamples.bestSectors.sector1.isClassBest, false, 'a missing wet best sector must not render as class-best purple');

console.log('Timing highlight tests passed.');
