// Detects whether the timed part of a session has really started.
//
// Starting the collector is deliberately not treated as starting the race:
// teams often open the dashboard while cars are still on the grid. The state
// latches once an official clock moves or completed-lap history proves that
// the session is underway, so temporary disconnects cannot stop the timer.
(function initSessionTiming(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.sessionTiming = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function createSessionTimingApi() {
  function parseClockMs(value) {
    const clock = String(value ?? '').split('/')[0].trim();
    if (!clock) return null;
    const parts = clock.split(':');
    if (parts.length < 2 || parts.length > 3 || parts.some((part) => !/^\d+$/.test(part))) return null;
    const numbers = parts.map(Number);
    if (numbers.at(-1) >= 60 || (parts.length === 3 && numbers[1] >= 60)) return null;
    const seconds = parts.length === 2
      ? numbers[0] * 60 + numbers[1]
      : numbers[0] * 3600 + numbers[1] * 60 + numbers[2];
    return seconds * 1000;
  }

  function observedTime(value) {
    const timestamp = new Date(value || 0).getTime();
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function completedLapEvidence(history = []) {
    return history.find((lap) => Number(lap?.lapNumber) > 0 && Number(lap?.lapTimeMs) > 0) || null;
  }

  function lapStartAt(lap, fallback) {
    const completedAt = observedTime(lap?.recordedAt || lap?.collectedAt);
    const lapTimeMs = Number(lap?.lapTimeMs);
    if (!Number.isFinite(completedAt) || !Number.isFinite(lapTimeMs) || lapTimeMs <= 0) return fallback;
    return new Date(completedAt - lapTimeMs).toISOString();
  }

  function updateSessionTiming(previous = null, session = {}, history = [], observedAt = new Date().toISOString()) {
    const observedAtMs = observedTime(observedAt);
    const safeObservedAt = Number.isFinite(observedAtMs) ? new Date(observedAtMs).toISOString() : new Date().toISOString();
    const elapsedMs = parseClockMs(session.elapsed);
    const remainingMs = parseClockMs(session.timeToGo);
    const base = {
      started: false,
      startedAt: null,
      observedAt: safeObservedAt,
      elapsedMs,
      remainingMs,
      reason: 'waiting-for-official-session-start'
    };

    // Session start is irreversible for the active collection. A provider may
    // hide or reset its clocks after finish or during a reconnect.
    if (previous?.started) {
      return {
        ...base,
        started: true,
        startedAt: previous.startedAt || safeObservedAt,
        reason: previous.reason || 'previously-started'
      };
    }

    if (Number.isFinite(elapsedMs) && elapsedMs > 0) {
      return {
        ...base,
        started: true,
        startedAt: new Date(new Date(safeObservedAt).getTime() - elapsedMs).toISOString(),
        reason: 'official-elapsed-clock'
      };
    }

    const completedLap = completedLapEvidence(history);
    if (completedLap) {
      return {
        ...base,
        started: true,
        startedAt: lapStartAt(completedLap, safeObservedAt),
        reason: 'completed-lap'
      };
    }

    if (Number.isFinite(previous?.remainingMs)
      && Number.isFinite(remainingMs)
      && remainingMs < previous.remainingMs) {
      return {
        ...base,
        started: true,
        startedAt: previous.observedAt || safeObservedAt,
        reason: 'official-remaining-clock'
      };
    }

    const finishText = `${session.statusText || ''} ${session.flag || ''}`;
    if (/finish|checkered|chequered/i.test(finishText)) {
      return {
        ...base,
        started: true,
        startedAt: safeObservedAt,
        reason: 'finished-session'
      };
    }

    return base;
  }

  return {
    parseClockMs,
    completedLapEvidence,
    updateSessionTiming
  };
});
