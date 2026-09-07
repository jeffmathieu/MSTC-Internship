const { parseTimeToMs } = require('./pitstopPlanner');

function servicePhase(row = {}) {
  const status = String(row.state || row.movement || '').trim();
  const eta = String(row.eta || '').trim();
  if (/^f$/i.test(status) || /^fuel(?:ling|ing)?$/i.test(status)) return 'fuel';
  if (/^(p|in|pit|in pit|in-pit)$/i.test(status)) return 'pit';
  if (/^(run|running|out|outlap|out lap)$/i.test(status)) return 'track';
  if (/\bfuel(?:ling|ing)?\b/i.test(eta)) return 'fuel';
  if (/\bin\s*pit\b/i.test(eta)) return 'pit';
  if (/^(run|running|out|outlap|out lap)$/i.test(status) || /\bout\s*lap\b/i.test(eta)
    || /^\d+:\d/.test(eta)) return 'track';
  return 'unknown';
}

function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  return Number.isFinite(Number(value)) ? Number(value) : null;
}

function driverChange(before, after) {
  if (!before || !after) return null;
  return before.trim().toLocaleLowerCase() !== after.trim().toLocaleLowerCase();
}

// Each entry is one revision of an event. The caller appends changed revisions
// to JSONL, allowing crash recovery and later provider-duration corrections.
function updatePitEvents(previous = {}, row = {}, at, options = {}) {
  const now = Date.parse(at);
  if (!Number.isFinite(now)) return { state: previous, changedEvents: [] };
  const phase = servicePhase(row);
  const driver = String(row.driverName || row.driver || '').trim();
  const pitMatch = String(row.pitInfo || row.pit || '').match(/\d+/);
  const count = pitMatch ? Number(pitMatch[0]) : null;
  const providerDuration = parseTimeToMs(row.lastPit);
  const increased = count !== null && previous.count != null && count > previous.count;
  let events = previous.events || [];
  let active = previous.active ? { ...previous.active } : null;
  const observationGap = Boolean(options.resumeGap) || (previous.observedAt
    && now - Date.parse(previous.observedAt) > (options.maximumObservationGapMs ?? Infinity));
  if (active && observationGap) {
    active.partial = true;
    active.fuelDurationMs = null;
    active.pitDurationMs = null;
  }
  const changedEvents = [];
  const persist = (event) => {
    const saved = { ...event, revisionAt: at, driverChanged: driverChange(event.driverBefore, event.driverAfter) };
    const index = events.findIndex((item) => item.id === saved.id);
    events = index < 0 ? [...events, saved] : events.map((item, i) => i === index ? saved : item);
    changedEvents.push(saved);
    return saved;
  };
  if (active && observationGap) active = persist(active);
  if (!active && (phase === 'fuel' || phase === 'pit')) {
    active = {
      id: `${row.carNumber}|${at}`, carNumber: String(row.carNumber),
      stopNumber: increased ? count : null, entryAt: at, exitAt: null,
      lapNumber: numberOrNull(row.lapNumber) ?? options.historySequence ?? null,
      lapNumberSource: numberOrNull(row.lapNumber) !== null ? row.lapNumberSource || 'provider' : 'observed-sequence',
      driverBefore: previous.driver || driver, driverAfter: '',
      fuelDurationMs: 0, pitDurationMs: 0, totalDurationMs: null, durationMs: null,
      targetDurationMs: numberOrNull(options.targetDurationMs),
      durationSource: 'observed', fuelObserved: phase === 'fuel',
      providerBeforeMs: previous.providerDuration ?? null,
      partial: !previous.observedAt || Boolean(observationGap),
      phase, phaseStartedAt: at, closed: false
    };
    active = persist(active);
  }
  if (active) {
    if (increased) active.stopNumber = count;
    if (phase !== 'unknown' && phase !== active.phase) {
      const elapsed = Math.max(0, now - Date.parse(active.phaseStartedAt));
      const key = active.phase === 'fuel' ? 'fuelDurationMs' : 'pitDurationMs';
      if (active[key] != null) active[key] += elapsed;
      active.phase = phase;
      active.phaseStartedAt = at;
      active.fuelObserved ||= phase === 'fuel';
      if (phase === 'track') {
        active.closed = true;
        active.exitAt = at;
        active.driverAfter = driver;
        active.positionAfter = row.position;
        active.classPositionAfter = row.classPosition;
        if (active.partial) { active.fuelDurationMs = null; active.pitDurationMs = null; }
        active.totalDurationMs = active.partial ? null : active.fuelDurationMs + active.pitDurationMs;
        active.durationMs = Number.isFinite(providerDuration) && providerDuration !== active.providerBeforeMs
          ? providerDuration : active.partial ? null : active.pitDurationMs;
        active.durationSource = Number.isFinite(providerDuration) && providerDuration !== active.providerBeforeMs
          ? 'provider' : active.partial ? 'unavailable' : 'observed';
      }
      active = persist(active);
      if (active.closed) active = null;
    } else if (increased) active = persist(active);
  }
  // Counter-only feeds and provider values which arrive after pit exit.
  if (!active && (increased || (Number.isFinite(providerDuration) && providerDuration !== previous.providerDuration))) {
    let latest = events.at(-1);
    if (latest && latest.closed && (latest.stopNumber == null || latest.stopNumber === count)) {
      const patch = { ...latest, stopNumber: increased ? count : latest.stopNumber };
      if (Number.isFinite(providerDuration) && providerDuration !== latest.providerBeforeMs) {
        Object.assign(patch, { durationMs: providerDuration, durationSource: 'provider' });
      }
      persist(patch);
    } else if (increased) {
      persist({ id: `${row.carNumber}|counter-${count}|${at}`, carNumber: String(row.carNumber), stopNumber: count,
        entryAt: null, exitAt: at, closed: true, partial: true,
        lapNumber: numberOrNull(row.lapNumber) ?? options.historySequence ?? null,
        lapNumberSource: numberOrNull(row.lapNumber) !== null ? row.lapNumberSource || 'provider' : 'observed-sequence',
        durationMs: providerDuration !== previous.providerDuration ? providerDuration : null,
        durationSource: Number.isFinite(providerDuration) && providerDuration !== previous.providerDuration ? 'provider' : 'unavailable',
        providerBeforeMs: previous.providerDuration ?? null,
        fuelDurationMs: null, pitDurationMs: null, totalDurationMs: null,
        driverBefore: previous.driver || '', driverAfter: driver,
        targetDurationMs: numberOrNull(options.targetDurationMs), positionAfter: row.position, classPositionAfter: row.classPosition });
    }
  }
  return { state: { events, active, count: count ?? previous.count ?? null, driver: driver || previous.driver || '',
    providerDuration, observedAt: at }, changedEvents };
}

function serviceTimers(state = {}, at) {
  const stop = state.active || state.events?.at(-1);
  if (!stop) return null;
  const elapsed = state.active ? Math.max(0, Date.parse(at) - Date.parse(stop.phaseStartedAt)) : 0;
  return {
    active: Boolean(state.active), phase: state.active?.phase || 'complete', partial: Boolean(stop.partial),
    fuelDurationMs: stop.fuelDurationMs == null ? null : stop.fuelDurationMs + (state.active?.phase === 'fuel' ? elapsed : 0),
    pitDurationMs: stop.pitDurationMs == null ? null : stop.pitDurationMs + (state.active?.phase === 'pit' ? elapsed : 0),
    totalDurationMs: state.active && !stop.partial ? Date.parse(at) - Date.parse(stop.entryAt) : stop.totalDurationMs,
    observedAt: at
  };
}

module.exports = { servicePhase, updatePitEvents, serviceTimers, numberOrNull, driverChange };
