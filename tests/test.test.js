const assert = require('assert');

// Lightweight smoke tests for the custom test runner. Replace or extend this
// file with renderer/main-process unit tests as the app grows.
assert.strictEqual(1 + 1, 2);
assert.strictEqual('Hello'.toUpperCase(), 'HELLO');
assert.deepStrictEqual([1, 2, 3], [1, 2, 3]);
assert.deepStrictEqual({ a: 1, b: 2 }, { a: 1, b: 2 });

console.log('App tests passed.');
