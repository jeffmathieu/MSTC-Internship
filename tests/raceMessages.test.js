const assert = require('assert');
const { mentionsCar, updateMessageLog, restoreMessageLog } = require('../src/shared/raceMessages');

// Car-number detection
['Car #4 - drive through penalty', 'car 4: track limits warning', 'No. 4 black and white flag', 'Nr 4 investigated after the race',
  '#4 stop and go', '4 - drive through penalty', 'Number 04 - unsafe release', 'N° 4 avertissement']
  .forEach((text) => assert.ok(mentionsCar(text, '4'), `"${text}" mentions car 4`));
['Car #44 - drive through penalty', 'Car 14 warning', 'Lap 4: track limits car 12', 'Penalty 4:00 for car 7', 'Pit lane closed for 40 minutes', 'Car #4']
  .slice(0, 5).forEach((text) => assert.ok(!mentionsCar(text, '4'), `"${text}" does not mention car 4`));
assert.ok(mentionsCar('Car #4', '4'));
assert.ok(!mentionsCar('Car #4 penalty', ''), 'no car, no match');
assert.ok(!mentionsCar('Car #4 penalty', 'abc'));

// Log: new messages, repeats and reappearances
const t = (minute) => `2026-10-19T12:${String(minute).padStart(2, '0')}:00.000Z`;
let state = updateMessageLog([], ['Car #4 - drive through penalty', 'Pit lane open'], t(0), ['4', '12']);
assert.strictEqual(state.added.length, 2);
assert.deepStrictEqual(state.added[0].cars, ['4'], 'the message is linked to followed car 4');
assert.deepStrictEqual(state.added[1].cars, []);
state = updateMessageLog(state.log, ['Car #4 - drive through penalty'], t(1), ['4', '12']);
assert.strictEqual(state.added.length, 0, 'a message that stays on screen is not new');
assert.strictEqual(state.log[0].lastSeenAt, t(1));
state = updateMessageLog(state.log, ['  Pit   lane open '], t(5), ['4']);
assert.strictEqual(state.added.length, 0, 'whitespace differences are the same message');
state = updateMessageLog(state.log, ['Pit lane open'], t(30), ['4']);
assert.strictEqual(state.added.length, 1, 'the same text much later is logged again');
assert.strictEqual(state.log.length, 3);

// Restore from journal revisions (latest revision per id)
const restored = restoreMessageLog([...state.log, { ...state.log[0], lastSeenAt: t(2) }, { junk: true }]);
assert.strictEqual(restored.length, 3);
assert.strictEqual(restored[0].lastSeenAt, t(2));

console.log('Race message tests passed.');
