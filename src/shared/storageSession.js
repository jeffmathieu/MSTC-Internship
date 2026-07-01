// Helpers for resuming one manually selected race-session folder.
// Keeping file parsing outside Electron's main process makes crash recovery
// testable without opening application windows.
function resolveSessionFolder(configuredFolder, fallbackFolder) {
  return String(configuredFolder || '').trim() || String(fallbackFolder || '').trim();
}

function loadSessionHistory({ fs, jsonlPath, identityForLap, limit = 20000 }) {
  if (!fs.existsSync(jsonlPath)) return { entries: [], knownKeys: new Set() };
  const allEntries = fs.readFileSync(jsonlPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const entries = allEntries.slice(-Math.max(0, limit));
  const knownKeys = new Set(entries
    .filter((entry) => entry?.carNumber && entry?.lastLap)
    .map(identityForLap));
  return { entries, knownKeys };
}

function loadStoredJson(fs, filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

module.exports = { resolveSessionFolder, loadSessionHistory, loadStoredJson };
