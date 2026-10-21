const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { backupsToDelete, backupName, createSessionBackup } = require('../src/main/sessionBackup');

module.exports = (async () => {
  assert.strictEqual(backupName(new Date(2026, 9, 16, 14, 5, 9)), '2026-10-16_14-05-09');

  // 20 backups, keep the newest 4 plus every 5th older one.
  const names = Array.from({ length: 20 }, (_, i) => `2026-10-16_${String(i).padStart(2, '0')}-00-00`);
  const removed = backupsToDelete(names, 4, 5);
  assert.ok(!removed.includes(names[19]) && !removed.includes(names[16]), 'the newest backups are always kept');
  assert.ok(!removed.includes(names[0]) && !removed.includes(names[5]), 'older backups are thinned, not dropped completely');
  assert.strictEqual(removed.length, 12);

  const session = fs.mkdtempSync(path.join(os.tmpdir(), 'mstc-backup-'));
  try {
    assert.strictEqual(await createSessionBackup({ sessionFolder: session }), null, 'no data folder, nothing to back up');
    const data = path.join(session, 'data');
    fs.mkdirSync(data);
    fs.writeFileSync(path.join(data, 'lap_history.jsonl'), '{"carNumber":"1"}\n');
    fs.writeFileSync(path.join(data, 'lap_history.csv'), 'a,b\n');
    fs.writeFileSync(path.join(data, 'pit_notes.json'), '{}');
    fs.writeFileSync(path.join(data, 'analytics_summary.json'), '{}');
    fs.writeFileSync(path.join(data, 'latest_live_rows.json'), '[]');

    const first = await createSessionBackup({ sessionFolder: session, now: new Date(2026, 9, 16, 14, 0, 0), keepRecent: 2, thinEvery: 100 });
    assert.deepStrictEqual(fs.readdirSync(first.folder).sort(), ['lap_history.csv', 'lap_history.jsonl', 'pit_notes.json'],
      'only irreplaceable files are copied; derived snapshots are skipped');
    assert.strictEqual(fs.readFileSync(path.join(first.folder, 'lap_history.jsonl'), 'utf8'), '{"carNumber":"1"}\n');

    await createSessionBackup({ sessionFolder: session, now: new Date(2026, 9, 16, 14, 30, 0), keepRecent: 2, thinEvery: 100 });
    await createSessionBackup({ sessionFolder: session, now: new Date(2026, 9, 16, 15, 0, 0), keepRecent: 2, thinEvery: 100 });
    await createSessionBackup({ sessionFolder: session, now: new Date(2026, 9, 16, 15, 30, 0), keepRecent: 2, thinEvery: 100 });
    const kept = fs.readdirSync(path.join(session, 'backups')).sort();
    assert.deepStrictEqual(kept, ['2026-10-16_14-00-00', '2026-10-16_15-00-00', '2026-10-16_15-30-00'],
      'oldest thinned-out backup is pruned (the first is kept as the thinning anchor)');
    assert.ok(!kept.some((name) => name.endsWith('.partial')), 'no unfinished backup is left behind');
  } finally {
    fs.rmSync(session, { recursive: true, force: true });
  }
  console.log('Session backup tests passed.');
})();
