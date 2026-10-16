// Periodic safety copy of the irreplaceable session files (the lap journal,
// pit/race-control journals, notes and small state files). Derived snapshots
// such as analytics_summary.json are rebuilt from those and are skipped, so a
// backup stays small and cheap even late in a 24-hour race.
const fs = require('fs');
const path = require('path');

const BACKUP_FOLDER = 'backups';
const BACKUP_INTERVAL_MS = 30 * 60 * 1000;
const BACKUP_NAME = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;
const BACKED_UP_FILE = /^(?:[a-z_]+\.jsonl|lap_history\.csv|session_metadata\.json|pit_event_state\.json|pit_notes\.json|gap_state\.json|timing_feed_state\.json|stint_state\.json|fuel_state\.json|track_condition_state\.json)$/;

function backupName(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;
}

// Keeps the newest `keepRecent` backups plus every `thinEvery`-th older one, so
// a long race keeps a sparse history without growing without bound.
function backupsToDelete(names, keepRecent, thinEvery) {
  const sorted = [...names].sort();
  const older = sorted.slice(0, Math.max(0, sorted.length - keepRecent));
  return older.filter((_, index) => index % thinEvery !== 0);
}

async function createSessionBackup({ sessionFolder, now = new Date(), keepRecent = 12, thinEvery = 6 }) {
  const dataFolder = path.join(sessionFolder, 'data');
  let files = [];
  try { files = (await fs.promises.readdir(dataFolder)).filter((name) => BACKED_UP_FILE.test(name)); } catch { return null; }
  if (!files.includes('lap_history.jsonl')) return null;

  const root = path.join(sessionFolder, BACKUP_FOLDER);
  const name = backupName(now);
  const partial = path.join(root, `${name}.partial`);
  const target = path.join(root, name);
  await fs.promises.rm(partial, { recursive: true, force: true });
  await fs.promises.mkdir(partial, { recursive: true });
  for (const file of files) await fs.promises.copyFile(path.join(dataFolder, file), path.join(partial, file));
  await fs.promises.rm(target, { recursive: true, force: true });
  await fs.promises.rename(partial, target);

  const existing = (await fs.promises.readdir(root)).filter((entry) => BACKUP_NAME.test(entry));
  for (const old of backupsToDelete(existing, keepRecent, thinEvery)) {
    await fs.promises.rm(path.join(root, old), { recursive: true, force: true });
  }
  return { folder: target, fileCount: files.length, createdAt: now.toISOString() };
}

module.exports = { BACKUP_FOLDER, BACKUP_INTERVAL_MS, backupName, backupsToDelete, createSessionBackup };
