const { parseLapTimeToMs } = require('./parser');

// Provider adapters/parsers may have different raw column names, but before
// writing anything to disk they must produce this storage schema. Future timing
// providers only need to map their parsed row into these fields.
const NORMALIZED_ROW_COLUMNS = [
  'collectedAt',
  'sourceProvider',
  'timingUrl',
  'sessionName',
  'position',
  'state',
  'carNumber',
  'className',
  'classPosition',
  'teamName',
  'driverName',
  'carModel',
  'laps',
  'lapNumber',
  'gap',
  'diff',
  'interval',
  'lastLap',
  'bestLap',
  'sector1',
  'sector2',
  'sector3',
  'pitInfo',
  'lastPit',
  'eta',
  'stint'
];

const LAP_HISTORY_COLUMNS = [
  ...NORMALIZED_ROW_COLUMNS,
  'lapTimeMs',
  'sector1Ms',
  'sector2Ms',
  'sector3Ms',
  'bestLapMs',
  'sessionFlag',
  'lapFlag',
  'sector1Flag',
  'sector2Flag',
  'sector3Flag',
  'paceEligible',
  'sector1Eligible',
  'sector2Eligible',
  'sector3Eligible'
];

// Converts any stored/exported field to the string form used in CSV and JSONL.
// Empty string is the canonical "missing" value in storage files.
function normalizeStorageField(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

// Parses a timing string and stores milliseconds as a string. CSV consumers then
// see one consistent numeric representation independent of provider formatting.
function normalizeMsField(value) {
  const ms = parseLapTimeToMs(value);
  return ms === null || ms === undefined ? '' : String(ms);
}

// Escapes one CSV cell. Keep this tiny and dependency-free because export code
// uses it frequently during live polling.
function csvEscape(value) {
  const s = normalizeStorageField(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

// Serializes rows to CSV with a stable column order. Pass LAP_HISTORY_COLUMNS
// when writing completed-lap history.
function toCsvRows(rows, columns = NORMALIZED_ROW_COLUMNS) {
  return [
    columns.join(','),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(','))
  ].join('\n');
}

// Labels data with the timing provider. Add new providers here when the parser
// gains support for another timing website.
function detectSourceProvider(context = {}) {
  if (context.sourceProvider) return context.sourceProvider;
  const url = String(context.timingUrl || '').toLowerCase();
  if (url.includes('getraceresults')) return 'getraceresults';
  if (url.includes('ris-timing') || url.includes('ristiming') || url.includes('ris timing')) return 'ris-timing';
  return 'unknown';
}

// Reads the first non-empty value from a row. This lets provider adapters use
// aliases such as team/teamName without duplicating mapping code.
function valueAt(row, ...keys) {
  for (const key of keys) {
    if (row && row[key] !== null && row[key] !== undefined && row[key] !== '') return row[key];
  }
  return '';
}

// Picks the best available session label for storage metadata.
function normalizedSessionName(context = {}) {
  const session = context.session || {};
  return normalizeStorageField(session.sessionName || session.statusText || session.pageTitle || context.sessionName || '');
}

// Converts one parsed live row into the provider-independent latest-row schema.
// All exported latest_live_rows files should pass through this function first.
function normalizeForStorage(row, context = {}) {
  const raw = row?.raw && typeof row.raw === 'object' ? row.raw : {};
  const normalized = {
    collectedAt: normalizeStorageField(context.collectedAt),
    sourceProvider: detectSourceProvider(context),
    timingUrl: normalizeStorageField(context.timingUrl),
    sessionName: normalizedSessionName(context),
    position: normalizeStorageField(valueAt(row, 'position')),
    state: normalizeStorageField(valueAt(row, 'state', 'movement')),
    carNumber: normalizeStorageField(valueAt(row, 'carNumber', 'carNumberRaw')),
    className: normalizeStorageField(valueAt(row, 'className')),
    classPosition: normalizeStorageField(valueAt(row, 'classPosition')),
    teamName: normalizeStorageField(valueAt(row, 'teamName', 'team')),
    driverName: normalizeStorageField(valueAt(row, 'driverName', 'driver')),
    carModel: normalizeStorageField(valueAt(row, 'carModel', 'car')),
    laps: normalizeStorageField(valueAt(row, 'laps')),
    lapNumber: normalizeStorageField(valueAt(row, 'lapNumber')),
    gap: normalizeStorageField(valueAt(row, 'gap')),
    diff: normalizeStorageField(valueAt(row, 'diff', 'interval')),
    interval: normalizeStorageField(valueAt(row, 'interval', 'diff')),
    lastLap: normalizeStorageField(valueAt(row, 'lastLap')),
    bestLap: normalizeStorageField(valueAt(row, 'bestLap')),
    sector1: normalizeStorageField(valueAt(row, 'sector1')),
    sector2: normalizeStorageField(valueAt(row, 'sector2')),
    sector3: normalizeStorageField(valueAt(row, 'sector3')),
    pitInfo: normalizeStorageField(valueAt(row, 'pitInfo', 'pit')),
    lastPit: normalizeStorageField(valueAt(row, 'lastPit')),
    eta: normalizeStorageField(valueAt(row, 'eta')),
    stint: normalizeStorageField(valueAt(row, 'stint')),
    raw
  };
  normalized.sessionFlag = normalizeStorageField(valueAt(row, 'sessionFlag') || context.session?.flag || context.sessionFlag);
  normalized.lapFlag = normalizeStorageField(valueAt(row, 'lapFlag') || normalized.sessionFlag);
  normalized.sector1Flag = normalizeStorageField(valueAt(row, 'sector1Flag'));
  normalized.sector2Flag = normalizeStorageField(valueAt(row, 'sector2Flag'));
  normalized.sector3Flag = normalizeStorageField(valueAt(row, 'sector3Flag'));
  normalized.paceEligible = normalizeStorageField(valueAt(row, 'paceEligible'));
  normalized.sector1Eligible = normalizeStorageField(valueAt(row, 'sector1Eligible'));
  normalized.sector2Eligible = normalizeStorageField(valueAt(row, 'sector2Eligible'));
  normalized.sector3Eligible = normalizeStorageField(valueAt(row, 'sector3Eligible'));

  // Ensure all storage columns exist as strings, even when a provider does not
  // expose that field. The raw object remains available in JSON/JSONL only.
  NORMALIZED_ROW_COLUMNS.forEach((column) => {
    normalized[column] = normalizeStorageField(normalized[column]);
  });
  return normalized;
}

// Converts a normalized live row into a completed lap record. The app stores lap
// time strings and parsed millisecond values so humans and calculations can use
// the same file.
function lapRecordFromNormalizedRow(row) {
  return {
    ...row,
    lapTimeMs: normalizeMsField(row.lastLap),
    sector1Ms: normalizeMsField(row.sector1),
    sector2Ms: normalizeMsField(row.sector2),
    sector3Ms: normalizeMsField(row.sector3),
    bestLapMs: normalizeMsField(row.bestLap),
    sessionFlag: normalizeStorageField(row.sessionFlag),
    lapFlag: normalizeStorageField(row.lapFlag || row.sessionFlag),
    sector1Flag: normalizeStorageField(row.sector1Flag),
    sector2Flag: normalizeStorageField(row.sector2Flag),
    sector3Flag: normalizeStorageField(row.sector3Flag),
    paceEligible: normalizeStorageField(row.paceEligible),
    sector1Eligible: normalizeStorageField(row.sector1Eligible),
    sector2Eligible: normalizeStorageField(row.sector2Eligible),
    sector3Eligible: normalizeStorageField(row.sector3Eligible)
  };
}

// Verifies whether the sectors visible in the current live row belong to its
// newly completed LAST lap. RIS publishes S3 and LAST together; their exact sum
// is stronger evidence than provider-specific timing assumptions.
function currentSectorsMatchCompletedLap(row, toleranceMs = 2000) {
  const lapMs = parseLapTimeToMs(row?.lastLap);
  const sectors = [row?.sector1, row?.sector2, row?.sector3].map(parseLapTimeToMs);
  if (!Number.isFinite(lapMs) || sectors.some((value) => !Number.isFinite(value))) return false;
  return Math.abs(sectors.reduce((sum, value) => sum + value, 0) - lapMs) <= toleranceMs;
}

function withoutCurrentSectors(row) {
  return {
    ...row,
    sector1: '',
    sector2: '',
    sector3: '',
    sector1Flag: '',
    sector2Flag: '',
    sector3Flag: '',
    sector1Eligible: '',
    sector2Eligible: '',
    sector3Eligible: ''
  };
}

// Selects sector evidence for a completed lap. Current-row sectors are used
// only when they reconcile with LAST; otherwise the previous snapshot remains
// the conservative source used by GetRaceResults-style feeds.
function completedLapRowFromLiveRow(row, previousRow) {
  const evidence = currentSectorsMatchCompletedLap(row) ? row : previousRow;
  if (!evidence) return withoutCurrentSectors(row);
  return {
    ...row,
    driverName: previousRow?.driverName || row.driverName,
    sector1: evidence.sector1 || '',
    sector2: evidence.sector2 || '',
    sector3: evidence.sector3 || '',
    sector1Flag: evidence.sector1Flag || '',
    sector2Flag: evidence.sector2Flag || '',
    sector3Flag: evidence.sector3Flag || '',
    sector1Eligible: evidence.sector1Eligible || '',
    sector2Eligible: evidence.sector2Eligible || '',
    sector3Eligible: evidence.sector3Eligible || ''
  };
}

// Builds a duplicate-detection key for completed laps. Lap number is preferred;
// when missing, driver + last lap is the fallback because some providers do not
// expose lap numbers reliably.
function lapIdentity(row) {
  const base = [row.sourceProvider, row.timingUrl, row.sessionName, row.carNumber];
  if (row.lapNumber) return [...base, row.lapNumber, row.lastLap].join('|');
  return [...base, row.driverName || row.driver || '', row.lastLap].join('|');
}

module.exports = {
  NORMALIZED_ROW_COLUMNS,
  LAP_HISTORY_COLUMNS,
  normalizeStorageField,
  normalizeForStorage,
  lapRecordFromNormalizedRow,
  currentSectorsMatchCompletedLap,
  completedLapRowFromLiveRow,
  lapIdentity,
  toCsvRows,
  detectSourceProvider
};
