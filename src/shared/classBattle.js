// Same-class battle/catch analysis.
//
// This UMD-style module is shared by Node tests and the renderer. It keeps the
// race logic out of app.js: callers pass live rows, stored lap history, and the
// followed car number; this module returns data that any dashboard view can
// render.
(function initClassBattle(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.classBattle = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function createClassBattleApi() {
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function average(values) {
  const usable = values.map(numberOrNull).filter((value) => value !== null);
  if (!usable.length) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

function parseTimeToMs(value) {
  const raw = String(value || '').trim().replace(',', '.');
  if (!raw || /^(—|-|--|\?|in pit|out lap)$/i.test(raw)) return null;
  const parts = raw.split(':');
  let seconds = null;
  if (parts.length === 1) {
    const n = Number(parts[0]);
    if (Number.isFinite(n)) seconds = n;
  } else if (parts.length === 2) {
    const m = Number(parts[0]);
    const s = Number(parts[1]);
    if (Number.isFinite(m) && Number.isFinite(s)) seconds = m * 60 + s;
  } else if (parts.length === 3) {
    const first = Number(parts[0]);
    const middle = Number(parts[1]);
    const last = parts[2];
    if (Number.isFinite(first) && Number.isFinite(middle)) {
      if (!last.includes('.') && first < 10 && middle < 60) {
        const milli = Number(String(last).padEnd(3, '0').slice(0, 3));
        if (Number.isFinite(milli)) seconds = first * 60 + middle + milli / 1000;
      } else {
        const sec = Number(last);
        if (Number.isFinite(sec)) seconds = first * 3600 + middle * 60 + sec;
      }
    }
  }
  return seconds === null ? null : Math.round(seconds * 1000);
}

function parseGapToMs(value) {
  const text = String(value || '').trim();
  if (!text || text === '--' || text === '?' || /lap/i.test(text)) return null;
  return parseTimeToMs(text.replace(/^\+/, ''));
}

function formatSeconds(ms) {
  return Number.isFinite(ms) ? `${(ms / 1000).toFixed(3)}s` : '—';
}

function rowSortNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 999999;
}

function classSortedRows(rows, className) {
  return (rows || [])
    .filter((row) => row.className === className)
    .sort((a, b) => (rowSortNumber(a.classPosition) - rowSortNumber(b.classPosition)) || (rowSortNumber(a.position) - rowSortNumber(b.position)));
}

function overallSortedRows(rows) {
  return [...(rows || [])].sort((a, b) => rowSortNumber(a.position) - rowSortNumber(b.position));
}

function previousOverallRow(rows, row) {
  const ordered = overallSortedRows(rows);
  const index = ordered.findIndex((candidate) => String(candidate.carNumber) === String(row.carNumber));
  return index > 0 ? ordered[index - 1] : null;
}

function classGapToPrevious(rows, classRows, row) {
  const classIndex = classRows.findIndex((candidate) => String(candidate.carNumber) === String(row.carNumber));
  if (classIndex <= 0) return { ms: 0, label: 'class leader', reliable: true };

  const previousClassRow = classRows[classIndex - 1];
  const previousOverall = previousOverallRow(rows, row);
  if (!previousOverall || String(previousOverall.carNumber) !== String(previousClassRow.carNumber)) {
    return { ms: null, label: 'class gap unknown', reliable: false };
  }

  const gapMs = parseGapToMs(row.diff) ?? parseGapToMs(row.interval) ?? parseGapToMs(row.gap);
  if (!Number.isFinite(gapMs)) return { ms: null, label: row.diff || row.interval || row.gap || 'class gap unknown', reliable: false };
  return { ms: gapMs, label: formatSeconds(gapMs), reliable: true };
}

function relativeClassGap(rows, classRows, fromRow, toRow) {
  const fromIndex = classRows.findIndex((row) => String(row.carNumber) === String(fromRow.carNumber));
  const toIndex = classRows.findIndex((row) => String(row.carNumber) === String(toRow.carNumber));
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return null;

  const start = Math.min(fromIndex, toIndex) + 1;
  const end = Math.max(fromIndex, toIndex);
  let totalMs = 0;
  for (let i = start; i <= end; i += 1) {
    const gap = classGapToPrevious(rows, classRows, classRows[i]);
    if (!gap.reliable || !Number.isFinite(gap.ms)) return null;
    totalMs += gap.ms;
  }
  return totalMs;
}

function historyLapForAnalysis(entry) {
  const lastLapMs = numberOrNull(entry.lastLapMs ?? entry.lapTimeMs);
  return {
    ...entry,
    carNumber: String(entry.carNumber ?? ''),
    driver: entry.driver ?? entry.driverName ?? '',
    lastLapMs,
    lapNumber: numberOrNull(entry.lapNumber),
    recordedAt: entry.recordedAt || entry.collectedAt || ''
  };
}

function historySortTime(entry) {
  const ms = new Date(entry.recordedAt || 0).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function lapsForCar(history, carNumber) {
  return (history || [])
    .map(historyLapForAnalysis)
    .filter((entry) => entry.carNumber === String(carNumber) && Number.isFinite(entry.lastLapMs))
    .sort((a, b) => {
      const lapDelta = (a.lapNumber ?? 0) - (b.lapNumber ?? 0);
      if (lapDelta) return lapDelta;
      return historySortTime(a) - historySortTime(b);
    });
}

function recentAverageForCar(history, carNumber, lapWindow = 5) {
  const laps = lapsForCar(history, carNumber).slice(-lapWindow);
  return average(laps.map((entry) => entry.lastLapMs));
}

function buildBattleItem({ rows, classRows, followed, row, history, lapWindow }) {
  const ourAvg = recentAverageForCar(history, followed.carNumber, lapWindow) ?? numberOrNull(followed.lastLapMs);
  const theirAvg = recentAverageForCar(history, row.carNumber, lapWindow) ?? numberOrNull(row.lastLapMs);
  const relation = rowSortNumber(row.classPosition) < rowSortNumber(followed.classPosition) ? 'ahead' : 'behind';
  const relativeGap = relativeClassGap(rows, classRows, followed, row);
  let deltaPerLap = null;
  let lapsToCatch = null;
  let minutesToCatch = null;
  let estimate = 'class gap unknown';

  if (Number.isFinite(ourAvg) && Number.isFinite(theirAvg)) {
    if (relation === 'ahead') {
      deltaPerLap = theirAvg - ourAvg;
      if (Number.isFinite(relativeGap) && relativeGap > 0 && deltaPerLap > 0) {
        lapsToCatch = relativeGap / deltaPerLap;
        minutesToCatch = (lapsToCatch * ourAvg) / 60000;
        estimate = `we catch #${row.carNumber}`;
      } else if (deltaPerLap > 0) estimate = `gaining on #${row.carNumber}`;
      else estimate = 'we are not catching';
    } else {
      deltaPerLap = ourAvg - theirAvg;
      if (Number.isFinite(relativeGap) && relativeGap > 0 && deltaPerLap > 0) {
        lapsToCatch = relativeGap / deltaPerLap;
        minutesToCatch = (lapsToCatch * ourAvg) / 60000;
        estimate = `#${row.carNumber} catches us`;
      } else if (deltaPerLap > 0) estimate = `#${row.carNumber} gaining`;
      else estimate = 'they are not catching';
    }
  }

  const deltaLabel = Number.isFinite(deltaPerLap) ? `${formatSeconds(Math.abs(deltaPerLap))}/lap` : '';
  const catchInfo = [
    estimate,
    deltaLabel,
    Number.isFinite(lapsToCatch) ? `${lapsToCatch.toFixed(1)} laps` : '',
    Number.isFinite(minutesToCatch) ? `${minutesToCatch.toFixed(1)} min` : ''
  ].filter(Boolean).join(' · ');

  return {
    key: `${followed.carNumber}|${row.carNumber}`,
    relation,
    row,
    relativeGap,
    ourAvg,
    theirAvg,
    deltaPerLap,
    lapsToCatch,
    minutesToCatch,
    estimate,
    catchInfo
  };
}

function buildClassBattleSummary(rows, history, followedCarNumber, options = {}) {
  const followed = (rows || []).find((row) => String(row.carNumber) === String(followedCarNumber));
  if (!followed || !followed.className) {
    return { followed: null, className: '', classRows: [], items: [] };
  }

  const lapWindow = options.lapWindow || 5;
  const classRows = classSortedRows(rows, followed.className);
  const items = classRows.map((row) => {
    const classGap = classGapToPrevious(rows, classRows, row);
    const battle = String(row.carNumber) === String(followed.carNumber)
      ? null
      : buildBattleItem({ rows, classRows, followed, row, history, lapWindow });
    return { row, classGap, battle };
  });

  return { followed, className: followed.className, classRows, items };
}

return {
  numberOrNull,
  average,
  parseTimeToMs,
  parseGapToMs,
  formatSeconds,
  rowSortNumber,
  classSortedRows,
  overallSortedRows,
  previousOverallRow,
  classGapToPrevious,
  relativeClassGap,
  lapsForCar,
  recentAverageForCar,
  buildBattleItem,
  buildClassBattleSummary
};
});
