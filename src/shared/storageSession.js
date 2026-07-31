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

// Old session folders can be reopened while the setup screen currently points
// at another car or mode. Final reports must follow the folder metadata, not
// those unrelated current selections. Very old metadata did not store a mode,
// so an explicit "Race" session name is the narrow backwards-compatible
// fallback; practice and qualifying names remain untouched.
function resolveFinalReportSettings(settings = {}, metadata = {}, history = []) {
  const availableCars = new Set((history || [])
    .map((lap) => String(lap?.carNumber || '').trim())
    .filter(Boolean));
  const metadataCars = Array.isArray(metadata.followedCars) ? metadata.followedCars : [];
  const configuredCars = Array.isArray(settings.followedCars) ? settings.followedCars : [];
  const candidates = [metadata.followedCar, ...metadataCars, settings.followedCar, ...configuredCars]
    .map((car) => String(car || '').trim())
    .filter(Boolean);
  let followedCars = [...new Set(candidates)].filter((car) => !availableCars.size || availableCars.has(car)).slice(0, 3);
  if (!followedCars.length && availableCars.size === 1) followedCars = [...availableCars];

  const storedMode = String(metadata.sessionMode || '').trim().toLowerCase();
  const configuredMode = String(settings.sessionMode || 'race').trim().toLowerCase();
  const sessionName = String(metadata.sessionName || '').trim();
  const sessionMode = ['race', 'practice', 'qualifying'].includes(storedMode)
    ? storedMode
    : /(^|\W)race(\W|$)/i.test(sessionName) ? 'race' : configuredMode;

  return {
    ...settings,
    followedCar: followedCars[0] || String(settings.followedCar || '').trim(),
    followedCars: followedCars.length ? followedCars : configuredCars,
    sessionMode
  };
}

module.exports = { resolveSessionFolder, loadSessionHistory, loadStoredJson, resolveFinalReportSettings };
