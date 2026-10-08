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

// A power loss can leave one incomplete record. Recover other records and
// return diagnostics rather than making the entire session unreadable.
function readJsonLines(fs, filePath) {
  const entries = [], invalidLines = [];
  if (!fs.existsSync(filePath)) return { entries, invalidLines };
  fs.readFileSync(filePath, 'utf8').split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    try {
      const value = JSON.parse(line);
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected a JSON object');
      entries.push(value);
    } catch (error) {
      invalidLines.push({ lineNumber: index + 1, line, error: error.message });
    }
  });
  return { entries, invalidLines };
}

// Keep an incomplete trailing record separate from subsequent appends. Reading
// one byte avoids scanning a 24-hour journal on every lap.
function appendJsonLines(fs, filePath, entries) {
  if (!entries.length) return;
  const fd = fs.openSync(filePath, 'a+');
  try {
    const size = fs.fstatSync(fd).size;
    const tail = Buffer.alloc(1);
    if (size) fs.readSync(fd, tail, 0, 1, size - 1);
    fs.writeFileSync(fd, `${size && tail[0] !== 10 ? '\n' : ''}${entries.map(JSON.stringify).join('\n')}\n`);
  } finally { fs.closeSync(fd); }
}

// Never truncate the canonical archive in place. The replacement is complete
// and flushed before rename, and a failed write leaves the original untouched.
function atomicWriteFile(fs, filePath, contents) {
  const temporaryPath = `${filePath}.${process.pid}.${require('crypto').randomBytes(6).toString('hex')}.tmp`;
  let fd;
  try {
    fd = fs.openSync(temporaryPath, 'wx');
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temporaryPath, filePath);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
  }
}

function loadSessionHistory({ fs, jsonlPath, identityForLap, limit = Infinity }) {
  const { entries: allEntries, invalidLines } = readJsonLines(fs, jsonlPath);
  const entries = recoverStoredTiming(limit === Infinity ? allEntries : limit > 0 ? allEntries.slice(-limit) : []);
  const knownKeys = new Set(allEntries
    .filter((entry) => entry?.carNumber && entry?.lastLap)
    .map(identityForLap));
  return { entries, knownKeys, invalidLines };
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

// Report generation time is unrelated to when the car stopped driving. Prefer
// an already saved endpoint, otherwise the last confirmed source observation.
function resolveSessionEndAt(metadata = {}, history = [], lastObservedAt = null, pitEvents = []) {
  if (Number.isFinite(Date.parse(metadata.finishedAt))) return new Date(metadata.finishedAt).toISOString();
  const observations = [metadata.lastUpdatedAt, lastObservedAt,
    ...history.map((lap) => lap.recordedAt || lap.collectedAt),
    ...pitEvents.flatMap((event) => [event.entryAt, event.exitAt])]
    .map((value) => Date.parse(value)).filter(Number.isFinite);
  return observations.length ? new Date(observations.reduce((latest, at) => Math.max(latest, at))).toISOString() : null;
}

module.exports = { resolveSessionFolder, loadSessionHistory, loadStoredJson, resolveFinalReportSettings,
  recoverStoredTiming, readJsonLines, appendJsonLines, atomicWriteFile, resolveSessionEndAt };
