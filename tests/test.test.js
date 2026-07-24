const assert = require('assert');
const packageJson = require('../package.json');

// Lightweight smoke tests for the custom test runner. Replace or extend this
// file with renderer/main-process unit tests as the app grows.
assert.strictEqual(1 + 1, 2);
assert.strictEqual('Hello'.toUpperCase(), 'HELLO');
assert.deepStrictEqual([1, 2, 3], [1, 2, 3]);
assert.deepStrictEqual({ a: 1, b: 2 }, { a: 1, b: 2 });
assert.strictEqual(packageJson.build.win.artifactName, 'MSTC-Dashboard-Setup-${version}-${arch}.${ext}');
assert.ok(!packageJson.build.win.artifactName.includes(' '), 'Windows asset name must remain identical in latest.yml and GitHub Releases');
assert.ok(!packageJson.build.mac.artifactName.includes(' '), 'macOS asset name must remain identical in latest-mac.yml and GitHub Releases');

console.log('App tests passed.');
