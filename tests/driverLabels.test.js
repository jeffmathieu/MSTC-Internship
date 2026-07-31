const assert = require('assert');
const { baseDriverCode, uniqueDriverCodes } = require('../src/shared/driverLabels');

assert.strictEqual(baseDriverCode('Robbe Janssens'), 'JAN');
assert.strictEqual(baseDriverCode('Nigel Moore'), 'MOO');
assert.strictEqual(baseDriverCode('DE JONG Alain'), 'JON', 'the second provider name part is used as requested');
assert.strictEqual(baseDriverCode(''), '—');

assert.deepStrictEqual(uniqueDriverCodes(['Robbe Janssens', 'Nigel Moore']), {
  'Robbe Janssens': 'JAN',
  'Nigel Moore': 'MOO'
});
assert.deepStrictEqual(uniqueDriverCodes(['Robbe Janssens', 'Jeroen Jans']), {
  'Robbe Janssens': 'RJA',
  'Jeroen Jans': 'JJA'
});
assert.deepStrictEqual(uniqueDriverCodes(['Robbe Janssens', 'Ruben Jans']), {
  'Robbe Janssens': 'ROJA',
  'Ruben Jans': 'RUJA'
}, 'additional first-name letters resolve a second collision');
assert.deepStrictEqual(uniqueDriverCodes(['Robbe Janssens', 'Robbe Janssens']), {
  'Robbe Janssens': 'JAN'
}, 'duplicate history rows do not create false driver collisions');

console.log('Driver label tests passed.');
