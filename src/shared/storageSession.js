// Helpers for resuming one manually selected race-session folder.
// Keeping file parsing outside Electron's main process makes crash recovery
// testable without opening application windows.
function resolveSessionFolder(configuredFolder, fallbackFolder) {
  return String(configuredFolder || '').trim() || String(fallbackFolder || '').trim();
}

// Recover fields the old parser missed, without modifying the source archive.
// A wrapped absolute count is unambiguous evidence for this rotating schema.
function recoverStoredTiming(entries) {
  const schema = (row) => Object.keys(row.raw || {}).join('|');
  const wrappedCount = (value) => String(value || '').match(/^--\s*(\d+)\s+laps?\s*--$/i);
  const rotating = new Set(entries.filter((row) => wrappedCount(row.gap)
    && !row.lapNumber && !row.diff && !row.interval).map(schema));
  return entries.map((row) => {
    const raw = row.raw || {};
    const recovered = { ...row };
    if (!row.lastPit && raw['PIT TIME']) recovered.lastPit = raw['PIT TIME'];
    if (!row.state && /^[FP]$/i.test(raw.column_1 || '')) recovered.state = raw.column_1;
    if (!row.gapRole && rotating.has(schema(row))) {
      const count = wrappedCount(row.gap);
      Object.assign(recovered, { gapRaw: row.gap, gap: count ? '' : row.gap,
        gapRole: count ? 'completed-laps' : 'time-gap', gapSemantics: 'alternating-adjacent',
        interval: count ? '' : row.gap, diff: count ? '' : row.gap,
        observedProviderLapNumber: count?.[1] || '', lapNumberSource: 'observed-sequence' });
    }
    return recovered;
  });
}

function loadSessionHistory({ fs, jsonlPath, identityForLap, limit = Infinity }) {
  if (!fs.existsSync(jsonlPath)) return { entries: [], knownKeys: new Set() };
  const allEntries = fs.readFileSync(jsonlPath, 'utf8')
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const entries = recoverStoredTiming(limit === Infinity ? allEntries : limit > 0 ? allEntries.slice(-limit) : []);
  const knownKeys = new Set(allEntries
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

module.exports = { resolveSessionFolder, loadSessionHistory, loadStoredJson, resolveFinalReportSettings, recoverStoredTiming };
