const { lap } = require('../mockLapHistory');
const { stintsForCar } = require('../../src/shared/stintTracker');
const { buildCanonicalReportPayload } = require('../../src/main/stintReports');

const OUR_CAR = '33';
const CLASS_NAME = 'C.CHA';

function conditionForLap(lapNumber) {
  // The requested ranges overlap on lap 7. This fixture treats lap 7 as wet
  // and starts the first dry block at lap 8 so every lap has one condition.
  if (lapNumber >= 1 && lapNumber <= 7) return 'wet';
  if (lapNumber >= 8 && lapNumber <= 12) return 'dry';
  if (lapNumber >= 13 && lapNumber <= 17) return 'wet';
  if (lapNumber >= 18 && lapNumber <= 20) return 'dry';
  if (lapNumber >= 21 && lapNumber <= 24) return 'wet';
  if (lapNumber >= 25 && lapNumber <= 28) return 'transition';
  return 'dry';
}

function sectorTimesFor(condition, lapNumber, offsetMs = 0) {
  const wobble = (lapNumber % 5) * 120 + offsetMs;
  if (condition === 'wet') {
    const sector1Ms = 46500 + wobble;
    const sector2Ms = 51500 + Math.round(wobble / 2);
    const sector3Ms = 39200 + Math.round(wobble / 3);
    return { sector1Ms, sector2Ms, sector3Ms };
  }
  if (condition === 'transition') {
    const sector1Ms = 44500 + wobble;
    const sector2Ms = 49200 + Math.round(wobble / 2);
    const sector3Ms = 37600 + Math.round(wobble / 3);
    return { sector1Ms, sector2Ms, sector3Ms };
  }
  const sector1Ms = 42100 + wobble;
  const sector2Ms = 46600 + Math.round(wobble / 2);
  const sector3Ms = 36400 + Math.round(wobble / 3);
  return { sector1Ms, sector2Ms, sector3Ms };
}

function exampleLap({ carNumber, teamName, driverName, lapNumber, offsetMs = 0, className = CLASS_NAME }) {
  const lapCondition = conditionForLap(lapNumber);
  const sectors = sectorTimesFor(lapCondition, lapNumber, offsetMs);
  return lap({
    carNumber,
    className,
    teamName,
    driverName,
    lapNumber,
    lapTimeMs: sectors.sector1Ms + sectors.sector2Ms + sectors.sector3Ms,
    ...sectors,
    lapCondition,
    trackCondition: lapCondition,
    sector1Condition: lapCondition,
    sector2Condition: lapCondition,
    sector3Condition: lapCondition,
    conditionPhaseId: `${lapCondition}-example`
  });
}

function buildConditionExampleHistory() {
  const rows = [];
  for (let lapNumber = 1; lapNumber <= 30; lapNumber += 1) {
    rows.push(exampleLap({
      carNumber: OUR_CAR,
      teamName: 'MSTC',
      driverName: 'Condition Tester',
      lapNumber
    }));
    rows.push(exampleLap({
      carNumber: '38',
      teamName: 'BMW Team Van Der Horst',
      driverName: 'Class Rival',
      lapNumber,
      offsetMs: 900
    }));
    rows.push(exampleLap({
      carNumber: '56',
      teamName: 'Offenga Racing',
      driverName: 'Class Benchmark',
      lapNumber,
      offsetMs: -650
    }));
  }
  for (let lapNumber = 1; lapNumber <= 12; lapNumber += 1) {
    rows.push(exampleLap({
      carNumber: OUR_CAR,
      teamName: 'MSTC',
      driverName: 'Previous Team Driver',
      lapNumber: 100 + lapNumber,
      offsetMs: 1400
    }));
  }
  return rows;
}

function buildConditionExampleStint() {
  const history = buildConditionExampleHistory();
  const stints = stintsForCar(history, OUR_CAR, { closeFinalAt: '2026-06-23T13:30:00.000Z' });
  return {
    history,
    stint: stints.find((item) => item.driverName === 'Condition Tester'),
    stints,
    session: {
      sessionName: 'Condition example race',
      circuit: 'Synthetic condition test'
    },
    referenceTimes: {
      lapMs: 125000,
      sector1Ms: 42000,
      sector2Ms: 46500,
      sector3Ms: 36500
    }
  };
}

function buildConditionExamplePayload() {
  const { history, stint, session, referenceTimes } = buildConditionExampleStint();
  return buildCanonicalReportPayload({
    stints: [stint],
    session,
    history,
    carNumber: OUR_CAR,
    referenceTimes
  });
}

module.exports = {
  OUR_CAR,
  CLASS_NAME,
  conditionForLap,
  sectorTimesFor,
  buildConditionExampleHistory,
  buildConditionExampleStint,
  buildConditionExamplePayload
};
