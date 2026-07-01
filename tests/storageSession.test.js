const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lapIdentity } = require('../src/shared/storageSchema');
const { resolveSessionFolder, loadSessionHistory, loadStoredJson } = require('../src/shared/storageSession');

assert.strictEqual(resolveSessionFolder('/race/zolder', '/fallback'), '/race/zolder');
assert.strictEqual(resolveSessionFolder('', '/fallback'), '/fallback');
assert.strictEqual(resolveSessionFolder('   ', '/fallback'), '/fallback');

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mstc-session-resume-'));
const jsonlPath = path.join(folder, 'lap_history.jsonl');
const laps = [
  { sourceProvider: 'ris-timing', timingUrl: 'https://example.test', sessionName: 'Race', carNumber: '33', driverName: 'D1', lapNumber: '1', lastLap: '2:00.000' },
  { sourceProvider: 'ris-timing', timingUrl: 'https://example.test', sessionName: 'Race', carNumber: '33', driverName: 'D1', lapNumber: '2', lastLap: '1:59.000' },
  { sourceProvider: 'ris-timing', timingUrl: 'https://example.test', sessionName: 'Race', carNumber: '', driverName: 'D1', lapNumber: '3', lastLap: '1:58.000' }
];

try {
  assert.deepStrictEqual(loadSessionHistory({ fs, jsonlPath, identityForLap: lapIdentity }).entries, []);
  fs.writeFileSync(jsonlPath, `${laps.map(JSON.stringify).join('\n')}\n`);
  const restored = loadSessionHistory({ fs, jsonlPath, identityForLap: lapIdentity });
  assert.deepStrictEqual(restored.entries, laps);
  assert.strictEqual(restored.knownKeys.size, 2, 'only valid stored laps rebuild duplicate keys');
  assert.ok(restored.knownKeys.has(lapIdentity(laps[0])));
  assert.deepStrictEqual(
    loadSessionHistory({ fs, jsonlPath, identityForLap: lapIdentity, limit: 1 }).entries,
    [laps[2]],
    'history limit keeps the newest stored entries'
  );
  const pitPlanPath = path.join(folder, 'pitstop_plan_car-33.json');
  assert.strictEqual(loadStoredJson(fs, pitPlanPath), null);
  const savedPitState = { completedPitStops: 1, validCompletedPitStops: 1, lastPitElapsedMs: 3600000 };
  fs.writeFileSync(pitPlanPath, JSON.stringify({ pitState: savedPitState }));
  assert.deepStrictEqual(loadStoredJson(fs, pitPlanPath).pitState, savedPitState);
  fs.writeFileSync(jsonlPath, '{invalid json}\n');
  assert.throws(() => loadSessionHistory({ fs, jsonlPath, identityForLap: lapIdentity }), SyntaxError);
  fs.writeFileSync(pitPlanPath, '{invalid json}');
  assert.throws(() => loadStoredJson(fs, pitPlanPath), SyntaxError);
} finally {
  fs.rmSync(folder, { recursive: true, force: true });
}

console.log('Storage session resume tests passed.');
