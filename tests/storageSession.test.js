const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { lapIdentity } = require('../src/shared/storageSchema');
const { resolveSessionFolder, loadSessionHistory, loadStoredJson, resolveFinalReportSettings,
  readJsonLines, appendJsonLines, atomicWriteFile, resolveSessionEndAt } = require('../src/shared/storageSession');

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

  const historicalRaceSettings = resolveFinalReportSettings(
    { followedCar: '2', followedCars: ['2'], sessionMode: 'qualifying' },
    { followedCar: '33', followedCars: ['33'], sessionName: 'Ligier Js Cup - Race' },
    laps
  );
  assert.strictEqual(historicalRaceSettings.followedCar, '33', 'old folder metadata selects the originally followed car');
  assert.deepStrictEqual(historicalRaceSettings.followedCars, ['33']);
  assert.strictEqual(historicalRaceSettings.sessionMode, 'race', 'legacy race metadata still enables the race overview');

  const explicitPracticeSettings = resolveFinalReportSettings(
    { followedCar: '2', followedCars: ['2'], sessionMode: 'race' },
    { followedCar: '33', sessionName: 'Friday Race Simulation', sessionMode: 'practice' },
    laps
  );
  assert.strictEqual(explicitPracticeSettings.sessionMode, 'practice', 'new explicit metadata wins over words in the session title');

  const onlyHistoricalCar = resolveFinalReportSettings(
    { followedCar: '999', followedCars: ['999'], sessionMode: 'race' },
    {},
    laps
  );
  assert.deepStrictEqual(onlyHistoricalCar.followedCars, ['33'], 'a single historical car is a safe metadata fallback');

  fs.writeFileSync(jsonlPath, `${JSON.stringify(laps[0])}\n{invalid json}\n${JSON.stringify(laps[1])}\n{"carNumber":`);
  const recovered = loadSessionHistory({ fs, jsonlPath, identityForLap: lapIdentity });
  assert.deepStrictEqual(recovered.entries, laps.slice(0, 2), 'bad interior and truncated tail records do not discard valid laps');
  assert.strictEqual(recovered.knownKeys.size, 2);
  assert.deepStrictEqual(recovered.invalidLines.map((line) => line.lineNumber), [2, 4]);
  appendJsonLines(fs, jsonlPath, [laps[2]]);
  assert.deepStrictEqual(readJsonLines(fs, jsonlPath).entries, laps, 'the next append is separated from the incomplete tail');
  const original = fs.readFileSync(jsonlPath, 'utf8');
  const failingFs = { ...fs, renameSync() { throw new Error('Injected rename failure'); } };
  assert.throws(() => atomicWriteFile(failingFs, jsonlPath, 'replacement'), /Injected rename failure/);
  assert.strictEqual(fs.readFileSync(jsonlPath, 'utf8'), original, 'a failed replacement preserves the original archive');
  assert.ok(!fs.readdirSync(folder).some((file) => file.endsWith('.tmp')), 'failed replacement cleans up its temporary file');
  atomicWriteFile(fs, jsonlPath, `${JSON.stringify(laps[0])}\n`);
  assert.deepStrictEqual(readJsonLines(fs, jsonlPath).entries, [laps[0]]);

  const end = '2026-09-08T12:06:00.000Z';
  assert.strictEqual(resolveSessionEndAt({ lastUpdatedAt: end }, [{ collectedAt: '2026-09-08T12:04:00Z' }]), end);
  assert.strictEqual(resolveSessionEndAt({ finishedAt: end }, [], '2026-10-08T12:00:00Z'), end,
    'regenerating a finalized archive keeps the stored endpoint');
  assert.strictEqual(resolveSessionEndAt({}, [{ collectedAt: end }]), end, 'old archives fall back to the last lap observation');
  assert.strictEqual(resolveSessionEndAt({}, []), null, 'an empty archive has no invented endpoint');
  fs.writeFileSync(pitPlanPath, '{invalid json}');
  assert.throws(() => loadStoredJson(fs, pitPlanPath), SyntaxError);
} finally {
  fs.rmSync(folder, { recursive: true, force: true });
}

console.log('Storage session resume tests passed.');
