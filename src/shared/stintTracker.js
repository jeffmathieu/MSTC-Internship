// Driver-stint reconstruction from immutable completed-lap history.
//
// A stint changes only when the stored driver name changes. Pitstops with the
// same driver deliberately stay inside one stint because these reports are
// intended to explain one driver's complete run in the car.
(function initStintTracker(root, factory) {
  const analytics = typeof module === 'object' && module.exports
    ? require('./lapAnalytics')
    : root?.lapAnalytics;
  const api = factory(analytics);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.stintTracker = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function createStintTrackerApi(lapAnalytics) {
  function normalizeDriverName(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function driverKey(value) {
    return normalizeDriverName(value).toLocaleLowerCase();
  }

  function sumLapTimes(laps = []) {
    return laps.reduce((total, lap) => total + (Number.isFinite(Number(lap.lapTimeMs)) ? Number(lap.lapTimeMs) : 0), 0);
  }

  function compactStats(stats) {
    if (!stats) return null;
    const { laps, ...compact } = stats;
    return compact;
  }

  function completionTime(lap) {
    const value = lap?.recordedAt || lap?.collectedAt || '';
    return Number.isFinite(new Date(value).getTime()) ? value : null;
  }

  function estimatedStartTime(lap) {
    const completedAt = completionTime(lap);
    const lapTimeMs = Number(lap?.lapTimeMs);
    if (!completedAt || !Number.isFinite(lapTimeMs)) return completedAt;
    return new Date(new Date(completedAt).getTime() - lapTimeMs).toISOString();
  }

  // Provider STINT columns normally contain elapsed stint time (m:ss or
  // h:mm:ss), not an ordinal stint number.
  function parseStintDurationMs(value) {
    const parts = String(value ?? '').trim().split(':');
    if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) return null;
    const numbers = parts.map(Number);
    if (numbers.at(-1) >= 60 || (parts.length === 3 && numbers[1] >= 60)) return null;
    const seconds = parts.length === 2
      ? numbers[0] * 60 + numbers[1]
      : numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
    return seconds * 1000;
  }

  // If the provider resets its timer during a same-driver pitstop, preserve
  // the completed segment and continue accumulating instead of shortening the
  // driver's stint.
  function providerTimerProgress(laps = []) {
    let completedSegmentsMs = 0;
    let latestSegmentMs = null;
    laps.forEach((lap) => {
      const value = parseStintDurationMs(lap.stint);
      if (!Number.isFinite(value)) return;
      if (Number.isFinite(latestSegmentMs) && value + 30000 < latestSegmentMs) {
        completedSegmentsMs += latestSegmentMs;
      }
      latestSegmentMs = value;
    });
    return {
      completedSegmentsMs,
      latestSegmentMs,
      totalMs: Number.isFinite(latestSegmentMs) ? completedSegmentsMs + latestSegmentMs : null
    };
  }

  function currentStintTimeMs(group, options = {}) {
    // The collector can run before the official session starts. Freeze the
    // active timer in that state, including when a provider already exposes a
    // driver or a stale STINT value on the grid.
    if (options.timerRunning === false) {
      const previous = options.previousCurrentStint;
      return previous && driverKey(previous.driverName) === driverKey(group.driverName)
        ? Number(previous.stintTimeMs || 0)
        : 0;
    }
    const progress = providerTimerProgress(group.laps);
    const liveTimerMs = parseStintDurationMs(options.liveRow?.stint);
    if (Number.isFinite(liveTimerMs)) {
      const resetAfterLastLap = Number.isFinite(progress.latestSegmentMs) && liveTimerMs + 30000 < progress.latestSegmentMs;
      const confirmedMs = resetAfterLastLap
        ? (progress.totalMs || 0) + liveTimerMs
        : progress.completedSegmentsMs + liveTimerMs;
      const previous = options.previousCurrentStint;
      const previousAt = new Date(previous?.timerObservedAt || options.previousGeneratedAt || 0).getTime();
      const now = new Date(options.generatedAt || 0).getTime();
      const sameProviderReading = previous
        && driverKey(previous.driverName) === driverKey(group.driverName)
        && previous.providerTimerMs === liveTimerMs;
      if (sameProviderReading && Number.isFinite(previousAt) && Number.isFinite(now) && now >= previousAt) {
        return Math.max(confirmedMs, Number(previous.stintTimeMs || 0) + (now - previousAt));
      }
      return confirmedMs;
    }
    if (Number.isFinite(progress.totalMs)) {
      const lastCompletedAt = new Date(completionTime(group.laps.at(-1)) || 0).getTime();
      const now = new Date(options.generatedAt || 0).getTime();
      return progress.totalMs + (Number.isFinite(now) && Number.isFinite(lastCompletedAt) ? Math.max(0, now - lastCompletedAt) : 0);
    }
    if (!group.laps.length) {
      // Before the first completed lap, the official session start is the best
      // available anchor for the first driver's stint. Once lap history is
      // available, the timestamp-based branch below replaces this estimate.
      const sessionStartedAt = options.sessionStartedAt
        ? new Date(options.sessionStartedAt).getTime()
        : NaN;
      const now = new Date(options.generatedAt || 0).getTime();
      if (options.isFirstStint && Number.isFinite(sessionStartedAt)
        && Number.isFinite(now) && now >= sessionStartedAt) {
        return now - sessionStartedAt;
      }
      const previous = options.previousCurrentStint;
      const previousAt = new Date(previous?.timerObservedAt || options.previousGeneratedAt || 0).getTime();
      if (previous && driverKey(previous.driverName) === driverKey(group.driverName)
        && Number.isFinite(previousAt) && Number.isFinite(now) && now >= previousAt) {
        return Number(previous.stintTimeMs || 0) + (now - previousAt);
      }
      return 0;
    }
    const start = new Date(estimatedStartTime(group.laps[0]) || 0).getTime();
    const now = new Date(options.generatedAt || 0).getTime();
    return Number.isFinite(start) && Number.isFinite(now) && now >= start
      ? now - start
      : sumLapTimes(group.laps);
  }

  // Missing names are filled from the previous known driver. Leading missing
  // names use the first later known name, avoiding a fake "Unknown" stint when
  // a timing provider starts publishing the driver after the first lap.
  function resolveMissingDriverNames(laps = []) {
    let nextKnown = '';
    const nextKnownByIndex = new Array(laps.length);
    for (let index = laps.length - 1; index >= 0; index -= 1) {
      const name = normalizeDriverName(laps[index]?.driverName || laps[index]?.driver);
      if (name) nextKnown = name;
      nextKnownByIndex[index] = nextKnown;
    }
    let previousKnown = '';
    return laps.map((lap, index) => {
      const explicit = normalizeDriverName(lap.driverName || lap.driver);
      const driverName = explicit || previousKnown || nextKnownByIndex[index] || 'Unknown';
      if (driverName !== 'Unknown') previousKnown = driverName;
      return { ...lap, driverName, driver: driverName };
    });
  }

  function stintsForCar(history = [], carNumber = '', options = {}) {
    const laps = resolveMissingDriverNames(lapAnalytics.lapsForCar(history, carNumber));
    const groups = [];
    laps.forEach((lap) => {
      let current = groups.at(-1);
      if (!current || driverKey(current.driverName) !== driverKey(lap.driverName)) {
        current = {
          carNumber: String(carNumber),
          driverName: lap.driverName,
          laps: []
        };
        groups.push(current);
      }
      current.laps.push(lap);
    });
    const liveDriverName = normalizeDriverName(options.liveRow?.driver || options.liveRow?.driverName);
    if (liveDriverName && (!groups.length || driverKey(groups.at(-1).driverName) !== driverKey(liveDriverName))) {
      groups.push({ carNumber: String(carNumber), driverName: liveDriverName, laps: [] });
    }

    const driverStintCounts = new Map();
    const normalizedStints = groups.map((group, index) => {
      const next = groups[index + 1];
      const firstLap = group.laps[0];
      const lastLap = group.laps.at(-1);
      const closed = index < groups.length - 1 || Boolean(options.closeFinalAt);
      const key = driverKey(group.driverName);
      const driverStintNumber = (driverStintCounts.get(key) || 0) + 1;
      driverStintCounts.set(key, driverStintNumber);
      const providerProgress = providerTimerProgress(group.laps);
      const isLatest = index === groups.length - 1;
      const stintTimeMs = isLatest
        ? currentStintTimeMs(group, { ...options, isFirstStint: index === 0 })
        : providerProgress.totalMs ?? sumLapTimes(group.laps);
      return {
        ...group,
        stintNumber: index + 1,
        driverStintNumber,
        detectionSource: 'driver-change',
        timerSource: options.timerRunning === false && isLatest
          ? 'session-not-started'
          : Number.isFinite(parseStintDurationMs(options.liveRow?.stint)) && isLatest
          ? 'live-provider-stint-timer'
          : Number.isFinite(providerProgress.totalMs) ? 'stored-provider-stint-timer' : 'timestamps',
        providerTimerMs: isLatest
          ? parseStintDurationMs(options.liveRow?.stint) ?? providerProgress.latestSegmentMs
          : providerProgress.latestSegmentMs,
        timerObservedAt: isLatest ? options.generatedAt || null : completionTime(lastLap),
        startLap: firstLap?.displayLapNumber ?? firstLap?.lapNumber ?? null,
        endLap: lastLap?.displayLapNumber ?? lastLap?.lapNumber ?? null,
        lapNumberSource: firstLap?.lapNumberSource || 'provider',
        startedAt: isLatest && Number.isFinite(stintTimeMs) && options.generatedAt
          ? new Date(new Date(options.generatedAt).getTime() - stintTimeMs).toISOString()
          : estimatedStartTime(firstLap),
        lastLapCompletedAt: completionTime(lastLap),
        closedAt: closed ? (estimatedStartTime(next?.laps?.[0]) || options.closeFinalAt || completionTime(lastLap)) : null,
        closed,
        lapCount: group.laps.length,
        stintTimeMs,
        stats: compactStats(lapAnalytics.statsForLaps(group.laps))
      };
    });

    const totalTimeByDriver = new Map();
    normalizedStints.forEach((stint) => {
      const key = driverKey(stint.driverName);
      // Closed stint totals must be reconstructable from immutable history.
      // Provider STINT timers differ between feeds and may include unrelated
      // elapsed time, so only the active stint uses its live/provider timer.
      const contributionMs = stint.closed ? sumLapTimes(stint.laps) : stint.stintTimeMs;
      totalTimeByDriver.set(key, (totalTimeByDriver.get(key) || 0) + contributionMs);
    });
    return normalizedStints.map((stint) => ({
      ...stint,
      totalDriverTimeMs: totalTimeByDriver.get(driverKey(stint.driverName)) || 0
    }));
  }

  function compactStint(stint) {
    if (!stint) return null;
    const { laps, ...compact } = stint;
    return compact;
  }

  function buildStintState(history = [], carNumbers = [], generatedAt = new Date().toISOString(), options = {}) {
    const cars = {};
    [...new Set((carNumbers || []).map((car) => String(car || '').trim()).filter(Boolean))].forEach((carNumber) => {
      const liveRow = (options.liveRows || []).find((row) => String(row.carNumber) === carNumber);
      const previousCarState = options.previousState?.cars?.[carNumber] || null;
      const fullStints = (options.drivingTimeOnly ? drivingStintsForCar : stintsForCar)(history, carNumber, {
        ...options,
        liveRow,
        generatedAt,
        previousCurrentStint: previousCarState?.currentStint || null,
        previousGeneratedAt: options.previousState?.generatedAt || null
      });
      const stints = fullStints.map(compactStint);
      const currentStint = stints.at(-1) || null;
      const totalTimeByDriver = {};
      fullStints.forEach((stint) => {
        totalTimeByDriver[stint.driverName] = stint.totalDriverTimeMs;
      });
      cars[carNumber] = {
        carNumber,
        detectionSource: 'driver-change',
        stintCount: stints.length,
        closedStintCount: stints.filter((stint) => stint.closed).length,
        currentStint,
        totalTimeByDriver,
        stints
      };
    });
    return { schemaVersion: 1, generatedAt, cars };
  }

  function drivingStintsForCar(history = [], carNumber = '', options = {}) {
    const stints = stintsForCar(history, carNumber, options);
    const events = options.pitEvents || options.pitEventsByCar?.[String(carNumber)] || [];
    const now = Date.parse(options.closeFinalAt || options.generatedAt || '')
      || Date.parse(completionTime(stints.at(-1)?.laps?.at(-1)) || '');
    const intervals = events.filter((event) => event.entryAt).map((event) => ({
      start: Date.parse(event.entryAt), end: Date.parse(event.exitAt || '') || now,
      approximate: Boolean(event.partial), stopNumber: event.stopNumber
    }));
    // Old lap-only archives have no exact pit exit timestamps. Exclude the
    // observed service window conservatively and label the result estimated.
    let pending = null;
    for (const lap of lapAnalytics.lapsForCar(history, carNumber)) {
      const at = Date.parse(completionTime(lap) || '');
      if (lapAnalytics.rowShowsInPit(lap) && !pending) pending = { start: at, stopNumber: lapAnalytics.pitCountFromLap(lap) };
      if (pending && !lapAnalytics.rowShowsInPit(lap)) {
        if (!events.some((event) => event.stopNumber === pending.stopNumber ||
          (Date.parse(event.entryAt) <= at && Date.parse(event.exitAt || '') >= pending.start))) {
          intervals.push({ ...pending, end: at, approximate: true });
        }
        pending = null;
      }
    }
    if (pending && !events.some((event) => event.stopNumber === pending.stopNumber)) intervals.push({ ...pending, end: now, approximate: true });
    const bounds = stints.map((stint, i) => {
      const previous = options.previousCurrentStint;
      let start = Date.parse(estimatedStartTime(stint.laps[0]) || '')
        || (previous && driverKey(previous.driverName) === driverKey(stint.driverName) ? Date.parse(previous.startedAt) : NaN)
        || (i === 0 ? Date.parse(options.sessionStartedAt || '') : NaN) || now;
      let end = i + 1 < stints.length ? Date.parse(estimatedStartTime(stints[i + 1].laps[0]) || '') || now : now;
      // Match transitions by time too: returning drivers can change repeatedly.
      const incoming = events.filter((e) => driverKey(e.driverAfter) === driverKey(stint.driverName)
        && e.exitAt && Date.parse(e.exitAt) <= Date.parse(completionTime(stint.laps[0]) || options.generatedAt)
        && (i === 0 || driverKey(e.driverBefore) === driverKey(stints[i - 1].driverName)))
        .sort((a, b) => Date.parse(b.exitAt) - Date.parse(a.exitAt))[0];
      if (incoming && i > 0) start = Date.parse(incoming.exitAt);
      const outgoing = events.find((e) => Date.parse(e.entryAt) >= start
        && driverKey(e.driverBefore) === driverKey(stint.driverName)
        && ((e.driverAfter && i + 1 < stints.length && driverKey(e.driverAfter) === driverKey(stints[i + 1].driverName))
          || (!e.closed && i + 1 < stints.length)));
      if (outgoing) end = Date.parse(outgoing.entryAt);
      if (!stint.laps.length && i > 0) {
        const active = events.find((e) => !e.closed);
        if (active) start = Date.parse(active.entryAt);
      }
      return { start, end: Math.max(start, end) };
    });
    const net = stints.map((stint, i) => {
      const { start, end } = bounds[i];
      const clipped = intervals.map((p) => ({ ...p, start: Math.max(start, p.start), end: Math.min(end, p.end) }))
        .filter((p) => Number.isFinite(p.start) && p.end > p.start).sort((a, b) => a.start - b.start);
      let excluded = 0, coveredUntil = start;
      for (const p of clipped) { excluded += Math.max(0, p.end - Math.max(p.start, coveredUntil)); coveredUntil = Math.max(coveredUntil, p.end); }
      const gross = Number.isFinite(end - start) ? end - start : sumLapTimes(stint.laps);
      const active = events.some((e) => !e.closed && Date.parse(e.entryAt) <= end);
      return { ...stint, startedAt: Number.isFinite(start) ? new Date(start).toISOString() : null,
        closedAt: stint.closed && Number.isFinite(end) ? new Date(end).toISOString() : null,
        elapsedTimeMs: gross, excludedPitTimeMs: excluded,
        stintTimeMs: options.timerRunning === false ? 0 : Math.max(0, gross - excluded),
        drivingTimeEstimated: clipped.some((p) => p.approximate) || !events.length,
        drivingTimePaused: i === stints.length - 1 && (active || lapAnalytics.rowShowsInPit(options.liveRow)),
        timerSource: options.timerRunning === false ? 'session-not-started' : 'net-driving-time' };
    });
    const totals = new Map();
    net.forEach((s) => totals.set(driverKey(s.driverName), (totals.get(driverKey(s.driverName)) || 0) + s.stintTimeMs));
    return net.map((s) => ({ ...s, totalDriverTimeMs: totals.get(driverKey(s.driverName)) }));
  }

  function buildDrivingStintState(history, carNumbers, generatedAt, options = {}) {
    return buildStintState(history, carNumbers, generatedAt, { ...options, drivingTimeOnly: true });
  }

  return {
    drivingStintsForCar,
    buildDrivingStintState,
    normalizeDriverName,
    driverKey,
    sumLapTimes,
    parseStintDurationMs,
    providerTimerProgress,
    currentStintTimeMs,
    resolveMissingDriverNames,
    stintsForCar,
    compactStint,
    buildStintState
  };
});
