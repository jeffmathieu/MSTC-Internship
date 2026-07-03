const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { verifyReleaseAssets } = require('./verify-release-assets');

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mstc-release-assets-'));
const manifest = path.join(folder, 'latest.yml');
const installer = 'MSTC-Race-Engineer-Dashboard-Setup-1.1.2-x64.exe';
fs.writeFileSync(path.join(folder, installer), 'test installer');
fs.writeFileSync(manifest, `version: 1.1.2\nfiles:\n  - url: ${installer}\n`);
assert.deepStrictEqual(verifyReleaseAssets(manifest), [installer]);

fs.unlinkSync(path.join(folder, installer));
assert.throws(() => verifyReleaseAssets(manifest), /missing release assets/);
assert.throws(() => verifyReleaseAssets(path.join(folder, 'missing.yml')), /manifest not found/);

console.log('Release asset tests passed.');
