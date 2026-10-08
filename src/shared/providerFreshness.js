// The browser can successfully read a cached table after the provider has
// disconnected. Track source progress separately from successful DOM reads.
function nextProviderFreshness(previous = {}, { session = {}, rows = [], status = 'collecting',
  observedAt = new Date().toISOString(), pollIntervalMs = 5000 } = {}) {
  const now = Date.parse(observedAt);
  const connectionText = String(session.statusText || '').toLowerCase();
  const disconnected = /not connected|reconnect|connecting to/.test(connectionText);
  const waiting = /no active heat|waiting for.*data/.test(connectionText);
  const clocks = [session.elapsed, session.timeToGo, session.pageUpdated].map((value) => String(value || ''));
  const timing = rows.map((row) => [row.carNumber, row.lapNumber, row.lastLap,
    row.sector1, row.sector2, row.sector3, row.state, row.pitInfo, row.driverName || row.driver]);
  const timingSignature = JSON.stringify(timing);
  const signature = JSON.stringify([clocks, session.flag || '', timing]);
  const unavailable = disconnected || waiting || status !== 'collecting' || !rows.length;
  if (unavailable) return { ...previous, usable: false, status: disconnected ? 'disconnected' : waiting ? 'waiting' : status,
    message: session.statusText || 'No usable timing data.', observedAt, needsProgress: true };

  const changed = previous.signature !== signature;
  const lastProgressAt = changed ? observedAt : previous.lastProgressAt || observedAt;
  const timingChanged = previous.timingSignature !== timingSignature;
  const lastTimingProgressAt = timingChanged ? observedAt : previous.lastTimingProgressAt || observedAt;
  // Official clocks/heartbeats normally update every few seconds. Without one,
  // allow two representative laps, with a three-minute minimum. A static grid
  // or red-flag table without any heartbeat cannot prove a lost connection.
  const hasClock = clocks.some(Boolean);
  const lapTimes = rows.map((row) => Number(row.lastLapMs || row.lapTimeMs)).filter((value) => value > 0).sort((a, b) => a - b);
  const paused = /red|finish|checkered|chequered/i.test(session.flag || '');
  const running = rows.some((row) => Number(row.lapNumber) > 0 || row.lastLap);
  const timingTimeoutMs = Math.max(180000, (lapTimes[Math.floor(lapTimes.length / 2)] || 0) * 2);
  const timeoutMs = hasClock ? Math.max(30000, pollIntervalMs * 6) : timingTimeoutMs;
  const stale = (!changed && previous.needsProgress === true)
    || ((hasClock || (running && !paused)) && now - Date.parse(lastProgressAt) >= timeoutMs)
    // Some pages animate their clock locally while the timing feed is frozen.
    || (running && !paused && now - Date.parse(lastTimingProgressAt) >= timingTimeoutMs);
  return { signature, timingSignature, lastProgressAt, lastTimingProgressAt, observedAt, timeoutMs, timingTimeoutMs, needsProgress: stale,
    usable: !stale, status: stale ? 'stale' : 'collecting',
    message: stale ? 'Provider timing has stopped updating; displaying the last confirmed data.' : '',
    progressObserved: changed && Boolean(previous.signature) };
}

module.exports = { nextProviderFreshness };
