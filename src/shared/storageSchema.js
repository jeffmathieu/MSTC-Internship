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
  'bestLapMs'
];

function normalizeStorageField(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeMsField(value) {
  const ms = parseLapTimeToMs(value);
  return ms === null || ms === undefined ? '' : String(ms);
}

function csvEscape(value) {
  const s = normalizeStorageField(value);
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function toCsvRows(rows, columns = NORMALIZED_ROW_COLUMNS) {
  return [
    columns.join(','),
    ...rows.map((row) => columns.map((column) => csvEscape(row[column])).join(','))
  ].join('\n');
}

function detectSourceProvider(context = {}) {
  if (context.sourceProvider) return context.sourceProvider;
  const url = String(context.timingUrl || '').toLowerCase();
  if (url.includes('getraceresults')) return 'getraceresults';
  if (url.includes('ris-timing') || url.includes('ristiming') || url.includes('ris timing')) return 'ris-timing';
  return 'unknown';
}

function valueAt(row, ...keys) {
  for (const key of keys) {
    if (row && row[key] !== null && row[key] !== undefined && row[key] !== '') return row[key];
  }
  return '';
}

function normalizedSessionName(context = {}) {
  const session = context.session || {};
  return normalizeStorageField(session.sessionName || session.statusText || session.pageTitle || context.sessionName || '');
}

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

  // Ensure all storage columns exist as strings, even when a provider does not
  // expose that field. The raw object remains available in JSON/JSONL only.
  NORMALIZED_ROW_COLUMNS.forEach((column) => {
    normalized[column] = normalizeStorageField(normalized[column]);
  });
  return normalized;
}

function lapRecordFromNormalizedRow(row) {
  return {
    ...row,
    lapTimeMs: normalizeMsField(row.lastLap),
    sector1Ms: normalizeMsField(row.sector1),
    sector2Ms: normalizeMsField(row.sector2),
    sector3Ms: normalizeMsField(row.sector3),
    bestLapMs: normalizeMsField(row.bestLap)
  };
}

function lapIdentity(row) {
  const base = [row.sourceProvider, row.timingUrl, row.sessionName, row.carNumber];
  if (row.lapNumber) return [...base, row.lapNumber, row.lastLap].join('|');
  return [...base, row.collectedAt, row.lastLap].join('|');
}

module.exports = {
  NORMALIZED_ROW_COLUMNS,
  LAP_HISTORY_COLUMNS,
  normalizeStorageField,
  normalizeForStorage,
  lapRecordFromNormalizedRow,
  lapIdentity,
  toCsvRows,
  detectSourceProvider
};
