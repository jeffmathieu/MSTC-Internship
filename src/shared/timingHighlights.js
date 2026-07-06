// Precomputes the visual timing states used by the dashboard.
//
// The renderer only consumes labels and state names from this module. Keeping
// comparisons here means the lap strip and metric cards can be moved or
// redesigned without duplicating class-best calculations in UI code.
(function initTimingHighlights(root, factory) {
  const analytics = typeof module === 'object' && module.exports
    ? require('./lapAnalytics')
    : root?.lapAnalytics;
  const api = factory(analytics);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.timingHighlights = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function createTimingHighlightsApi(lapAnalytics) {
  function finiteMs(value) {
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function minimum(values = []) {
    const finite = values.map(finiteMs).filter((value) => value !== null);
    return finite.length ? Math.min(...finite) : null;
  }

  // Uses at most three initials so long provider names such as "DE JONG Alain"
  // remain readable in the narrow lap strip.
  function driverInitials(name) {
    const words = String(name || '').trim().split(/\s+/).filter(Boolean);
    return words.slice(0, 3).map((word) => word[0].toUpperCase()).join('');
  }

  function stripStatus(lap) {
    if (lap.lapPhase === 'inlap') return 'pit-in';
    if (lap.lapPhase === 'outlap') return 'pit-out';
    const flags = [lap.sessionFlag, lap.lapFlag, lap.sector1Flag, lap.sector2Flag, lap.sector3Flag];
    return flags.some((flag) => lapAnalytics.isNeutralizedFlag(flag)) ? 'neutralized' : 'normal';
  }

  function classBestState(value, classBestValue) {
    const own = finiteMs(value);
    const best = finiteMs(classBestValue);
    return {
      valueMs: own,
      classBestMs: best,
      isClassBest: own !== null && best !== null && own === best
    };
  }

  function buildTimingHighlights(history = [], carNumber = '') {
    const followedCar = String(carNumber || '');
    const laps = lapAnalytics.lapsForCar(history, followedCar);
    const ourStats = lapAnalytics.carStats(history, followedCar);
    const classCars = ourStats.className ? lapAnalytics.carsInClass(history, ourStats.className) : [];
    const classBestLapMs = minimum(classCars.map((car) => car.bestLapMs));
    const classBestSector1Ms = minimum(classCars.map((car) => car.bestSector1Ms));
    const classBestSector2Ms = minimum(classCars.map((car) => car.bestSector2Ms));
    const classBestSector3Ms = minimum(classCars.map((car) => car.bestSector3Ms));
    const representativeLaps = new Set(lapAnalytics.representativePaceLaps(laps));
    const bestLap = classBestState(ourStats.bestLapMs, classBestLapMs);

    return {
      carNumber: followedCar,
      className: ourStats.className || '',
      bestLap,
      bestSectors: {
        sector1: classBestState(ourStats.bestSector1Ms, classBestSector1Ms),
        sector2: classBestState(ourStats.bestSector2Ms, classBestSector2Ms),
        sector3: classBestState(ourStats.bestSector3Ms, classBestSector3Ms)
      },
      lapStrip: laps.map((lap) => {
        const status = stripStatus(lap);
        const isPersonalBest = status === 'normal'
          && representativeLaps.has(lap)
          && finiteMs(lap.lapTimeMs) !== null
          && finiteMs(lap.lapTimeMs) === bestLap.valueMs;
        return {
          lapNumber: lap.lapNumber,
          lapTimeMs: finiteMs(lap.lapTimeMs),
          driverName: lap.driverName || '',
          driverInitials: driverInitials(lap.driverName),
          status,
          highlight: isPersonalBest ? (bestLap.isClassBest ? 'class-best' : 'personal-best') : 'none',
          marker: status === 'pit-in' ? 'P' : '',
          tooltip: `${lap.driverName || 'Unknown driver'} · ${lap.sessionFlag || lap.lapFlag || status}`
        };
      })
    };
  }

  return {
    finiteMs,
    minimum,
    driverInitials,
    stripStatus,
    classBestState,
    buildTimingHighlights
  };
});
