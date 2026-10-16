// Engineer notes attached to detected pit stops (fuel/tyres done, tyre set,
// driver feedback, pit stop remarks). The notes of a stop stay editable until
// the next stop of the same car is detected; older stops become read-only.
(function initPitNotes(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.pitNotes = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function createPitNotesApi() {
  const LIMITS = { tyreSet: 80, driverNotes: 2000, pitNotes: 2000 };

  const text = (value, limit) => String(value ?? '').replace(/\r\n/g, '\n').trim().slice(0, limit);

  // Whitelists and trims what the renderer may store.
  function normalizeNotes(input = {}) {
    return {
      fuelAdded: input.fuelAdded === true,
      tyresChanged: input.tyresChanged === true,
      tyreSet: text(input.tyreSet, LIMITS.tyreSet),
      driverNotes: text(input.driverNotes, LIMITS.driverNotes),
      pitNotes: text(input.pitNotes, LIMITS.pitNotes)
    };
  }

  function stopSummary(event, saved) {
    return {
      eventId: event.id,
      stopNumber: event.stopNumber ?? null,
      detectedAt: event.entryAt || event.exitAt || null,
      exitAt: event.exitAt || null,
      closed: Boolean(event.closed),
      driverBefore: event.driverBefore || '',
      driverAfter: event.driverAfter || '',
      durationMs: Number.isFinite(Number(event.totalDurationMs ?? event.durationMs)) ? Number(event.totalDurationMs ?? event.durationMs) : null,
      notes: saved ? { ...normalizeNotes(saved), savedAt: saved.savedAt || null } : null
    };
  }

  // storedForCar: { [eventId]: notes }. The last event is the only editable one.
  function buildPitNotesView(events = [], storedForCar = {}) {
    const stops = events.map((event) => stopSummary(event, storedForCar?.[event.id]));
    const latest = stops.at(-1) || null;
    return {
      stopCount: stops.length,
      latest: latest && { ...latest, editable: true, needsAttention: !latest.notes },
      history: stops.slice(0, -1).reverse().map((stop) => ({ ...stop, editable: false }))
    };
  }

  // Returns { ok, notes, error } for a save request against the live events.
  function validateSave(events = [], eventId, input) {
    const latest = events.at(-1);
    if (!latest) return { ok: false, error: 'No pit stop has been detected yet.' };
    if (latest.id !== eventId) return { ok: false, error: 'A newer pit stop was detected; these notes are now read-only.' };
    return { ok: true, notes: normalizeNotes(input) };
  }

  // Notes are stored per pit event id; reports built from lap history alone only
  // know the stop number, so fall back to that.
  function notesForStop(stop, pitNotes = {}) {
    if (stop.id && pitNotes[stop.id]) return pitNotes[stop.id];
    return Object.values(pitNotes).find((notes) => notes.stopNumber != null && notes.stopNumber === stop.stopNumber) || null;
  }

  return { LIMITS, normalizeNotes, buildPitNotesView, validateSave, notesForStop };
});
