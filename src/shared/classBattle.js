// Same-class battle/catch analysis.
//
// This UMD-style module is shared by Node tests and the renderer. It keeps the
// race logic out of app.js: callers pass live rows, stored lap history, and the
// followed car number; this module returns data that any dashboard view can
// render.
(function initClassBattle(root, factory) {
  const analytics = typeof module === 'object' && module.exports
    ? require('./lapAnalytics')
    : root?.lapAnalytics;
  const api = factory(analytics);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.classBattle = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function createClassBattleApi(lapAnalytics) {
// Shared numeric helper for live rows and stored history. Empty values should
// stay unknown instead of becoming 0-second gaps or lap times.
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

// Computes a mean for recent pace windows while ignoring missing values.
function average(values) {
  const usable = values.map(numberOrNull).filter((value) => value !== null);
  if (!usable.length) return null;
  return usable.reduce((sum, value) => sum + value, 0) / usable.length;
}

// Parses provider lap/gap strings into milliseconds. This intentionally mirrors
// parser.js enough for class-battle math without importing browser/main code.
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

// Parses only time gaps. Lap gaps such as "1L" are rejected because they cannot
// be added as seconds between same-lap cars.
function parseGapToMs(value) {
  const text = String(value || '').trim();
  if (!text || text === '--' || text === '?' || parseLapGap(text) !== null) return null;
  return parseTimeToMs(text.replace(/^\+/, ''));
}

// Recognizes lap intervals from any provider. RIS commonly uses "5L", while
// GetRaceResults may use "-- 5 laps --". Keeping this generic is a deliberate
// failsafe: no provider is allowed to turn a lap count into fake seconds.
function parseLapGap(value) {
  const match = String(value || '').trim().match(/(?:^|\s|-)(\d+)\s*(?:l|laps?)(?:\s|$|-)/i);
  return match ? Number(match[1]) : null;
}

// RIS can expose only GAP, where every value is cumulative to the overall
// leader. In that layout GAP must be subtracted, never added row by row.
function usesCumulativeGap(rows) {
  const ordered = overallSortedRows(rows);
  const hasAdjacentIntervals = ordered.slice(1).some((row) =>
    parseGapToMs(row.diff) !== null || parseGapToMs(row.interval) !== null ||
    parseLapGap(row.diff) !== null || parseLapGap(row.interval) !== null);
  return !hasAdjacentIntervals && ordered.slice(1).some((row) =>
    parseGapToMs(row.gap) !== null || parseLapGap(row.gap) !== null);
}

// Converts one cumulative GAP-to-leader value to milliseconds. Numeric GAP is
// exact. A lap deficit is necessarily approximate and uses a representative
// lap time; completed-lap counters win over provider text when available.
function cumulativeGapToLeaderMs(rows, row, averageLapMs = null) {
  const ordered = overallSortedRows(rows);
  const index = ordered.findIndex((candidate) => String(candidate.carNumber) === String(row?.carNumber));
  if (index < 0) return null;
  if (index === 0) return 0;
  const numericGap = parseGapToMs(row?.gap);
  if (Number.isFinite(numericGap)) return numericGap;
  if (!Number.isFinite(averageLapMs) || averageLapMs <= 0) return null;
  const leaderLap = numberOrNull(ordered[0]?.lapNumber);
  const rowLap = numberOrNull(row?.lapNumber);
  const lapDeficit = leaderLap !== null && rowLap !== null
    ? Math.max(0, leaderLap - rowLap)
    : parseLapGap(row?.gap);
  return Number.isFinite(lapDeficit) ? lapDeficit * averageLapMs : null;
}

// Formats gap deltas for compact class-table cells.
function formatSeconds(ms) {
  return Number.isFinite(ms) ? `${(ms / 1000).toFixed(3)}s` : '—';
}

function formatSignedSeconds(ms) {
  if (!Number.isFinite(ms)) return '—';
  return `${ms >= 0 ? '+' : '-'}${(Math.abs(ms) / 1000).toFixed(3)}s`;
}

// Converts row ordering values into sortable numbers, pushing unknown values to
// the bottom instead of letting NaN break sort order.
function rowSortNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 999999;
}

// Returns live rows for one class sorted by class position, then overall
// position. This defines the visible class battle order.
function classSortedRows(rows, className) {
  return (rows || [])
    .filter((row) => row.className === className)
    .sort((a, b) => (rowSortNumber(a.classPosition) - rowSortNumber(b.classPosition)) || (rowSortNumber(a.position) - rowSortNumber(b.position)));
}

// Sorts live rows by overall race position for checking whether adjacent class
// cars are also adjacent on the timing page.
function overallSortedRows(rows) {
  return [...(rows || [])].sort((a, b) => rowSortNumber(a.position) - rowSortNumber(b.position));
}

// Finds the previous car in the overall table. This is needed because DIFF/INT
// columns are only reliable for class gap when the previous overall car is also
// the previous class car.
function previousOverallRow(rows, row) {
  const ordered = overallSortedRows(rows);
  const index = ordered.findIndex((candidate) => String(candidate.carNumber) === String(row.carNumber));
  return index > 0 ? ordered[index - 1] : null;
}

// Returns the class gap to the previous class car. If another-class traffic sits
// between the two cars, we mark the gap unreliable instead of using the wrong
// overall interval.
function classGapToPrevious(rows, classRows, row) {
  const classIndex = classRows.findIndex((candidate) => String(candidate.carNumber) === String(row.carNumber));
  if (classIndex <= 0) return { ms: 0, label: 'class leader', reliable: true };

  const previousClassRow = classRows[classIndex - 1];
  const lapGap = lapGapBetween(rows, previousClassRow, row);
  if (Number.isFinite(lapGap) && lapGap > 0) {
    return { ms: null, lapGap, label: `${lapGap}L`, reliable: false };
  }
  const previousOverall = previousOverallRow(rows, row);
  if (!previousOverall || String(previousOverall.carNumber) !== String(previousClassRow.carNumber)) {
    return { ms: null, label: 'class gap unknown', reliable: false };
  }

  const gapMs = parseGapToMs(row.diff) ?? parseGapToMs(row.interval) ?? parseGapToMs(row.gap);
  if (!Number.isFinite(gapMs)) return { ms: null, label: row.diff || row.interval || row.gap || 'class gap unknown', reliable: false };
  return { ms: gapMs, label: formatSeconds(gapMs), reliable: true };
}

// Adds reliable adjacent class gaps between two class rows. Returns null when
// any required intermediate gap is unknown or contaminated by other-class cars.
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

// Adds the provider's DIFF/INT chain through the complete overall table. This
// remains correct when other classes sit between two class rivals because each
// row contributes its interval to the immediately preceding overall car.
function overallRelativeGap(rows, fromRow, toRow, averageLapMs = null) {
  const ordered = overallSortedRows(rows);
  const fromIndex = ordered.findIndex((row) => String(row.carNumber) === String(fromRow?.carNumber));
  const toIndex = ordered.findIndex((row) => String(row.carNumber) === String(toRow?.carNumber));
  if (fromIndex < 0 || toIndex < 0 || fromIndex === toIndex) return null;
  if (usesCumulativeGap(rows)) {
    const fromGap = cumulativeGapToLeaderMs(rows, fromRow, averageLapMs);
    const toGap = cumulativeGapToLeaderMs(rows, toRow, averageLapMs);
    return Number.isFinite(fromGap) && Number.isFinite(toGap) ? Math.abs(toGap - fromGap) : null;
  }
  const fromLap = numberOrNull(fromRow?.lapNumber);
  const toLap = numberOrNull(toRow?.lapNumber);
  if (fromLap !== null && toLap !== null && fromLap !== toLap) return null;
  let totalMs = 0;
  for (let index = Math.min(fromIndex, toIndex) + 1; index <= Math.max(fromIndex, toIndex); index += 1) {
    const row = ordered[index];
    const intervalMs = parseGapToMs(row.diff) ?? parseGapToMs(row.interval) ?? parseGapToMs(row.gap);
    if (!Number.isFinite(intervalMs)) return null;
    totalMs += intervalMs;
  }
  return totalMs;
}

// Returns an absolute lap difference. Completed-lap counters are authoritative;
// provider text is only a fallback when both counters are unavailable and the
// cars are adjacent in the overall timing table.
function lapGapBetween(rows, fromRow, toRow) {
  const fromLap = numberOrNull(fromRow?.lapNumber);
  const toLap = numberOrNull(toRow?.lapNumber);
  if (fromLap !== null && toLap !== null && fromLap !== toLap) return Math.abs(fromLap - toLap);

  const ordered = overallSortedRows(rows);
  const fromIndex = ordered.findIndex((row) => String(row.carNumber) === String(fromRow?.carNumber));
  const toIndex = ordered.findIndex((row) => String(row.carNumber) === String(toRow?.carNumber));
  if (fromIndex < 0 || toIndex < 0 || Math.abs(fromIndex - toIndex) !== 1) return null;
  const lowerRow = ordered[Math.max(fromIndex, toIndex)];
  return parseLapGap(lowerRow.diff) ?? parseLapGap(lowerRow.interval) ?? parseLapGap(lowerRow.gap);
}

// Normalizes stored history rows to the small shape needed by catch estimates.
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

// Returns sorted completed laps for one car, used for recent-average pace.
function lapsForCar(history, carNumber) {
  return lapAnalytics.lapsForCar(history, carNumber).map(historyLapForAnalysis);
}

// Averages the last N valid laps for one car. This makes catch estimates react
// to current pace instead of full-race averages.
function recentAverageForCar(history, carNumber, lapWindow = 10) {
  const laps = lapAnalytics.representativePaceLaps(lapAnalytics.lapsForCar(history, carNumber))
    .slice(-lapWindow)
    .map(historyLapForAnalysis);
  return average(laps.map((entry) => entry.lastLapMs));
}

// Builds one catch/being-caught estimate versus a class rival. The output keeps
// raw numbers and a display string so future UI can choose either.
function buildBattleItem({ rows, classRows, followed, row, history, lapWindow }) {
  const ourAvg = recentAverageForCar(history, followed.carNumber, lapWindow) ?? parseTimeToMs(followed.lastLap);
  const theirAvg = recentAverageForCar(history, row.carNumber, lapWindow) ?? parseTimeToMs(row.lastLap);
  const relation = rowSortNumber(row.classPosition) < rowSortNumber(followed.classPosition) ? 'ahead' : 'behind';
  const representativeLapMs = Number.isFinite(ourAvg) && Number.isFinite(theirAvg)
    ? (ourAvg + theirAvg) / 2
    : ourAvg ?? theirAvg;
  const relativeGap = overallRelativeGap(rows, followed, row, representativeLapMs);
  const lapGap = lapGapBetween(rows, followed, row);
  const ourLastLapMs = parseTimeToMs(followed.lastLap) ?? numberOrNull(followed.lastLapMs);
  const theirLastLapMs = parseTimeToMs(row.lastLap) ?? numberOrNull(row.lastLapMs);
  const lastLapDeltaMs = Number.isFinite(ourLastLapMs) && Number.isFinite(theirLastLapMs) ? theirLastLapMs - ourLastLapMs : null;
  let deltaPerLap = null;
  let lapsToCatch = null;
  let minutesToCatch = null;
  let estimate = 'class gap unknown';
  let estimatedGapMs = null;
  let gapIsEstimate = usesCumulativeGap(rows) && (parseLapGap(followed.gap) !== null || parseLapGap(row.gap) !== null || (numberOrNull(followed.lapNumber) !== numberOrNull(row.lapNumber)));

  if (Number.isFinite(ourAvg) && Number.isFinite(theirAvg)) {
    // For an ahead rival, its pace estimates the time represented by its lead.
    // For a behind rival, our pace estimates the distance represented by our
    // lead. This is intentionally approximate because lap counters contain no
    // information about either car's position within its current lap.
    if (Number.isFinite(lapGap) && lapGap > 0) {
      estimatedGapMs = lapGap * (relation === 'ahead' ? theirAvg : ourAvg);
      gapIsEstimate = true;
    }
    const catchGapMs = Number.isFinite(relativeGap) ? relativeGap : estimatedGapMs;
    if (relation === 'ahead') {
      deltaPerLap = theirAvg - ourAvg;
      if (Number.isFinite(catchGapMs) && catchGapMs > 0 && deltaPerLap > 0) {
        lapsToCatch = catchGapMs / deltaPerLap;
        minutesToCatch = (lapsToCatch * ourAvg) / 60000;
        estimate = `we catch #${row.carNumber}`;
      } else if (deltaPerLap > 0) estimate = `gaining on #${row.carNumber}`;
      else estimate = 'we are not catching';
    } else {
      deltaPerLap = ourAvg - theirAvg;
      if (Number.isFinite(catchGapMs) && catchGapMs > 0 && deltaPerLap > 0) {
        lapsToCatch = catchGapMs / deltaPerLap;
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
    Number.isFinite(lapsToCatch) ? `${gapIsEstimate ? 'est. ' : ''}${lapsToCatch.toFixed(1)} laps` : '',
    Number.isFinite(minutesToCatch) ? `${gapIsEstimate ? 'est. ' : ''}${minutesToCatch.toFixed(1)} min` : ''
  ].filter(Boolean).join(' · ');
  const trendState = !Number.isFinite(deltaPerLap) || deltaPerLap === 0
    ? 'neutral'
    : relation === 'ahead'
      ? (deltaPerLap > 0 ? 'good' : 'bad')
      : (deltaPerLap > 0 ? 'bad' : 'good');

  return {
    key: `${followed.carNumber}|${row.carNumber}`,
    relation,
    row,
    relativeGap,
    lapGap,
    estimatedGapMs,
    gapIsEstimate,
    gapLabel: Number.isFinite(lapGap) && lapGap > 0
      ? `${lapGap}L`
      : Number.isFinite(relativeGap) ? formatSeconds(relativeGap) : 'gap unknown',
    lastLapDeltaMs,
    lastLapDeltaLabel: formatSignedSeconds(lastLapDeltaMs),
    ourAvg,
    theirAvg,
    deltaPerLap,
    lapsToCatch,
    minutesToCatch,
    estimate,
    catchInfo,
    trendState
  };
}

// Top-level class-battle API for the renderer. It returns the followed car,
// class rows, reliable class gaps, and catch estimates without requiring the UI
// to do any race math.
function buildClassBattleSummary(rows, history, followedCarNumber, options = {}) {
  const followed = (rows || []).find((row) => String(row.carNumber) === String(followedCarNumber));
  if (!followed || !followed.className) {
    return { followed: null, className: '', classRows: [], items: [] };
  }

  const lapWindow = options.lapWindow || 10;
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

// Returns only the class cars immediately ahead of and behind us. This compact
// object is persisted in analytics_summary.json and can be rendered by any UI
// without repeating gap or catch calculations.
function buildAdjacentClassBattles(rows, history, followedCarNumber, options = {}) {
  const summary = buildClassBattleSummary(rows, history, followedCarNumber, options);
  if (!summary.followed) return { available: false, ahead: null, behind: null, lapWindow: options.lapWindow || 10 };
  const ourIndex = summary.classRows.findIndex((row) => String(row.carNumber) === String(followedCarNumber));
  const itemFor = (row) => summary.items.find((item) => String(item.row.carNumber) === String(row?.carNumber))?.battle || null;
  return {
    available: true,
    className: summary.className,
    followedCarNumber: String(followedCarNumber),
    lapWindow: options.lapWindow || 10,
    ahead: itemFor(ourIndex > 0 ? summary.classRows[ourIndex - 1] : null),
    behind: itemFor(ourIndex >= 0 && ourIndex < summary.classRows.length - 1 ? summary.classRows[ourIndex + 1] : null)
  };
}

return {
  numberOrNull,
  average,
  parseTimeToMs,
  parseLapGap,
  parseGapToMs,
  usesCumulativeGap,
  cumulativeGapToLeaderMs,
  formatSeconds,
  formatSignedSeconds,
  rowSortNumber,
  classSortedRows,
  overallSortedRows,
  previousOverallRow,
  classGapToPrevious,
  relativeClassGap,
  overallRelativeGap,
  lapGapBetween,
  lapsForCar,
  recentAverageForCar,
  buildBattleItem,
  buildClassBattleSummary,
  buildAdjacentClassBattles
};
});
