// Per-car driver overview: everything the drivers window shows, derived from
// stored laps plus the driving-stint state. Pure and dependency-light so the
// main process can include it in the analytics summary and tests can cover it.
(function initDriverOverview(root, factory) {
  const analytics = typeof module === 'object' && module.exports
    ? require('./lapAnalytics')
    : root?.lapAnalytics;
  const api = factory(analytics);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.driverOverview = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function createDriverOverviewApi(lapAnalytics) {
  const key = (name) => String(name || '').replace(/\s+/g, ' ').trim().toLocaleLowerCase();
  const num = (value) => (value === null || value === undefined || value === '' ? null : (Number.isFinite(Number(value)) ? Number(value) : null));
  const mean = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
  const stdev = (values) => {
    if (values.length < 2) return null;
    const m = mean(values);
    return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
  };
  const minOf = (values) => { const v = values.filter((x) => x !== null); return v.length ? Math.min(...v) : null; };
  const delta = (value, reference) => (value !== null && reference !== null ? value - reference : null);

  function buildDriverOverview({ laps = [], stintCar = null, carNumber = '', conditionFilter = 'combined', liveDriver = '' } = {}) {
    const stints = stintCar?.stints || [];
    const stats = lapAnalytics.driverStats(laps, carNumber, { conditionFilter });
    const names = [];
    [...stints.map((s) => s.driverName), ...stats.map((s) => s.driverName)].forEach((name) => {
      if (name && !names.some((known) => key(known) === key(name))) names.push(name);
    });
    const current = key(liveDriver) || (stints.length && !stints.at(-1).closed ? key(stints.at(-1).driverName) : '');

    const drivers = names.map((name) => {
      const own = stints.filter((s) => key(s.driverName) === key(name));
      const driverStats = stats.find((s) => key(s.driverName) === key(name)) || {};
      const paceTimes = lapAnalytics.representativePaceLaps(driverStats.laps || [], { conditionFilter })
        .map((lap) => num(lap.lapTimeMs)).filter((v) => v !== null);
      const drivingMs = num(stintCar?.totalTimeByDriver?.[name]) ?? own.reduce((sum, s) => sum + (num(s.stintTimeMs) || 0), 0);
      const longest = own.reduce((best, s) => (!best || (num(s.stintTimeMs) || 0) > (num(best.stintTimeMs) || 0) ? s : best), null);
      const last = own.at(-1) || null;
      return {
        driverName: name,
        isCurrent: key(name) === current,
        stintCount: own.length,
        drivingMs,
        lapCount: driverStats.lapCount || 0,
        paceLapCount: driverStats.paceLapCount || 0,
        bestLapMs: num(driverStats.bestLapMs),
        averageLapMs: num(driverStats.averageLapMs),
        consistencyMs: stdev(paceTimes),
        averageSectorMs: [1, 2, 3].map((n) => num(driverStats[`averageSector${n}Ms`])),
        bestSectorMs: [1, 2, 3].map((n) => num(driverStats[`bestSector${n}Ms`])),
        averageStintLaps: mean(own.map((s) => s.lapCount || 0)),
        longestStint: longest ? { number: longest.stintNumber, drivingMs: num(longest.stintTimeMs), lapCount: longest.lapCount } : null,
        lastStint: last ? { number: last.stintNumber, startLap: last.startLap, endLap: last.endLap, lapCount: last.lapCount, closed: Boolean(last.closed) } : null
      };
    });

    const totalDrivingMs = drivers.reduce((sum, d) => sum + d.drivingMs, 0);
    const bestAverage = minOf(drivers.map((d) => d.averageLapMs));
    const bestLap = minOf(drivers.map((d) => d.bestLapMs));
    const bestSector = [0, 1, 2].map((i) => minOf(drivers.map((d) => d.bestSectorMs[i])));
    drivers.forEach((d) => {
      d.sharePct = totalDrivingMs > 0 ? (d.drivingMs / totalDrivingMs) * 100 : null;
      d.deltaAverageMs = delta(d.averageLapMs, bestAverage);
      d.deltaBestMs = delta(d.bestLapMs, bestLap);
      d.deltaBestSectorMs = d.bestSectorMs.map((value, i) => delta(value, bestSector[i]));
      d.isFastestAverage = bestAverage !== null && d.averageLapMs === bestAverage;
      d.isFastestLap = bestLap !== null && d.bestLapMs === bestLap;
      d.bestSectorFlags = d.bestSectorMs.map((value, i) => value !== null && value === bestSector[i]);
    });

    const stintRows = stints.map((s) => ({
      number: s.stintNumber,
      driverName: s.driverName,
      startLap: s.startLap,
      endLap: s.endLap,
      lapCount: s.lapCount || 0,
      drivingMs: num(s.stintTimeMs),
      elapsedMs: num(s.elapsedTimeMs),
      pitExcludedMs: num(s.excludedPitTimeMs),
      averageLapMs: num(s.stats?.averageLapMs),
      bestLapMs: num(s.stats?.bestLapMs),
      closed: Boolean(s.closed),
      estimated: Boolean(s.drivingTimeEstimated)
    }));
    const longestStint = stintRows.reduce((best, s) => (!best || (s.drivingMs || 0) > (best.drivingMs || 0) ? s : best), null);
    const named = (driverName, ms) => (ms === null ? null : { driverName, ms });
    const pick = (field, value) => named(drivers.find((d) => d[field] === value)?.driverName, value);

    return {
      carNumber: String(carNumber),
      currentDriver: drivers.find((d) => d.isCurrent)?.driverName || '',
      conditionFilter,
      totals: {
        driverCount: drivers.length,
        stintCount: stintRows.length,
        lapCount: drivers.reduce((sum, d) => sum + d.lapCount, 0),
        drivingMs: totalDrivingMs,
        pitExcludedMs: stintRows.reduce((sum, s) => sum + (s.pitExcludedMs || 0), 0),
        fastestLap: pick('bestLapMs', bestLap),
        fastestAverage: pick('averageLapMs', bestAverage),
        bestSectors: bestSector.map((value, i) => named(drivers.find((d) => d.bestSectorMs[i] === value)?.driverName, value)),
        longestStint: longestStint && longestStint.drivingMs
          ? { driverName: longestStint.driverName, number: longestStint.number, drivingMs: longestStint.drivingMs } : null
      },
      drivers,
      stints: stintRows
    };
  }

  return { buildDriverOverview };
});
