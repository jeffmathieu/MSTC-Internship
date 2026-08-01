// Pure session-completion rules. A checkered flag starts the final lap; the
// race is complete only after every car in the followed class is classified.
(function initSessionCompletion(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.sessionCompletion = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function createSessionCompletionApi() {
  const DEFAULT_FINISH_BUFFER_RATIO = 0.25;
  const DEFAULT_FINISH_LAP_MS = 180000;

  function rowIsFinished(row = {}) {
    const status = [row.eta, row.state, row.status, row.pitStatus]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return /\b(?:finish|finished|finishd|classified)\b/.test(status);
  }

  function followedClassCompletion(rows = [], followedCarNumber = '') {
    const followed = rows.find((row) => String(row.carNumber) === String(followedCarNumber));
    if (!followed) return { complete: false, reason: 'followed-car-missing', classRows: [] };
    const className = String(followed.className || '').trim();
    const classRows = rows.filter((row) => (
      className ? String(row.className || '').trim() === className : true
    ) && String(row.carNumber || '').trim());
    if (!classRows.length) return { complete: false, reason: 'class-empty', classRows: [] };
    const unfinished = classRows.filter((row) => !rowIsFinished(row));
    return {
      complete: unfinished.length === 0,
      reason: unfinished.length ? 'cars-still-running' : 'all-class-cars-finished',
      className: className || 'Overall',
      classRows,
      unfinished
    };
  }

  function finishSignalPresent(session = {}, rows = []) {
    if ((rows || []).some(rowIsFinished)) return true;
    const status = [
      session.flag,
      session.currentFlag,
      session.sessionFlag,
      session.status,
      session.sessionStatus,
      session.raceStatus,
      session.message
    ].filter(Boolean).join(' ').toLowerCase();
    return /\b(?:finish|finished|finishd|checkered|chequered)\b/.test(status);
  }

  function timestampMs(value) {
    if (value instanceof Date) return value.getTime();
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    const parsed = Date.parse(String(value || ''));
    return Number.isFinite(parsed) ? parsed : Date.now();
  }

  function positiveMs(value) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : null;
  }

  // Starts once when the first finish signal appears, then remains latched.
  // The primary followed car supplies the lap-time estimate even when extra
  // dashboard windows follow other cars.
  function updateFinishCountdown(previous = {}, input = {}) {
    previous = previous && typeof previous === 'object' ? previous : {};
    input = input && typeof input === 'object' ? input : {};
    const nowMs = timestampMs(input.nowMs);
    const existingDeadline = positiveMs(previous.deadlineAtMs);
    if (previous.active && existingDeadline) {
      return {
        ...previous,
        active: true,
        expired: nowMs >= existingDeadline,
        remainingMs: Math.max(0, existingDeadline - nowMs),
        lastUpdatedAtMs: nowMs
      };
    }

    const requestedBuffer = Number(input.bufferRatio);
    const bufferRatio = Number.isFinite(requestedBuffer) && requestedBuffer >= 0
      ? requestedBuffer
      : DEFAULT_FINISH_BUFFER_RATIO;
    if (!finishSignalPresent(input.session, input.rows)) {
      return {
        active: false,
        expired: false,
        observedAtMs: null,
        deadlineAtMs: null,
        remainingMs: null,
        baseLapMs: null,
        bufferRatio,
        lastUpdatedAtMs: nowMs
      };
    }

    const baseLapMs = positiveMs(input.primaryAverageLapMs)
      || positiveMs(input.primaryLastLapMs)
      || DEFAULT_FINISH_LAP_MS;
    const durationMs = Math.round(baseLapMs * (1 + bufferRatio));
    return {
      active: true,
      expired: false,
      observedAtMs: nowMs,
      deadlineAtMs: nowMs + durationMs,
      remainingMs: durationMs,
      baseLapMs,
      bufferRatio,
      lastUpdatedAtMs: nowMs
    };
  }

  return {
    DEFAULT_FINISH_BUFFER_RATIO,
    DEFAULT_FINISH_LAP_MS,
    rowIsFinished,
    followedClassCompletion,
    finishSignalPresent,
    updateFinishCountdown
  };
});
