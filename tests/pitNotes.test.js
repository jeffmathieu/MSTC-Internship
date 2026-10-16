const assert = require('assert');
const { normalizeNotes, buildPitNotesView, validateSave, LIMITS } = require('../src/shared/pitNotes');

const stop = (id, stopNumber, extra = {}) => ({ id, carNumber: '4', stopNumber, entryAt: `2026-10-16T14:0${stopNumber}:00.000Z`,
  exitAt: `2026-10-16T14:0${stopNumber}:50.000Z`, closed: true, driverBefore: 'A', driverAfter: 'B', totalDurationMs: 50000, ...extra });

assert.deepStrictEqual(normalizeNotes({ fuelAdded: 'yes', tyresChanged: true, tyreSet: '  Set 3 ', extra: 'x' }),
  { fuelAdded: false, tyresChanged: true, tyreSet: 'Set 3', driverNotes: '', pitNotes: '' }, 'only known fields, strict booleans, trimmed text');
assert.strictEqual(normalizeNotes({ driverNotes: 'x'.repeat(5000) }).driverNotes.length, LIMITS.driverNotes);

const noStops = buildPitNotesView([], {});
assert.strictEqual(noStops.latest, null);
assert.strictEqual(noStops.stopCount, 0);

const events = [stop('4|a', 1), stop('4|b', 2)];
const fresh = buildPitNotesView(events, {});
assert.strictEqual(fresh.latest.eventId, '4|b');
assert.strictEqual(fresh.latest.needsAttention, true, 'a newly detected stop asks for notes');
assert.strictEqual(fresh.history.length, 1);
assert.strictEqual(fresh.history[0].editable, false);

const saved = buildPitNotesView(events, { '4|b': { tyresChanged: true, savedAt: '2026-10-16T14:10:00.000Z' }, '4|a': { fuelAdded: true } });
assert.strictEqual(saved.latest.needsAttention, false, 'saved notes clear the attention cue');
assert.strictEqual(saved.latest.notes.tyresChanged, true);
assert.strictEqual(saved.history[0].notes.fuelAdded, true, 'older stops keep their notes');

assert.strictEqual(validateSave(events, '4|b', { tyreSet: 'S4' }).ok, true);
assert.strictEqual(validateSave(events, '4|b', { tyreSet: 'S4' }).notes.tyreSet, 'S4');
assert.strictEqual(validateSave(events, '4|a', {}).ok, false, 'an older stop can no longer be edited');
assert.strictEqual(validateSave([], '4|a', {}).ok, false);

console.log('Pit notes tests passed.');
