const { canonicalHeader } = require('./parser');

// Stateful, schema-scoped adapter for feeds which rotate completed laps and
// intervals through GAP. Raw cells remain in row.raw for diagnostics.
function adaptTimingFeed(previous = {}, headers = [], rows = []) {
  const fields = headers.map(canonicalHeader);
  const signature = fields.join('|');
  const state = previous.signature === signature ? previous : { signature, lapsByCar: {} };
  const candidate = fields.includes('gap') && !fields.includes('lapNumber')
    && !fields.includes('interval') && !fields.includes('diff');
  if (!candidate) return { state: { signature, lapsByCar: {} }, rows };
  const ordered = [...rows].sort((a, b) => a.position - b.position);
  const countValue = (row) => {
    const match = String(row.gap || '').trim().match(/^(?:--\s*)?(\d+)\s*(?:laps?|l)?(?:\s*--)?$/i);
    return match ? Number(match[1]) : null;
  };
  const counts = ordered.map(countValue);
  const wrappedCount = (row) => /^--\s*\d+\s+laps?\s*--$/i.test(String(row.gap || '').trim());
  const wrappedFollowers = ordered.slice(1).some(wrappedCount);
  const populated = counts.filter((count) => count !== null);
  // A leader's positive count plus a mostly descending field distinguishes
  // absolute laps from leader deficits. Never infer this from one car alone.
  const countPhase = ordered.length >= 2 && counts[0] > 0
    && populated.length >= Math.ceil(ordered.length * 0.7)
    && populated.every((count, index) => index === 0 || count <= populated[index - 1]);
  const timePhase = ordered.slice(1).some((row) => /[.:,]/.test(String(row.gap || '')))
    && (!(counts[0] > 0) || wrappedFollowers || state.sawCounts);
  const sawCounts = Boolean(state.sawCounts || countPhase || wrappedFollowers);
  const sawTimes = Boolean(state.sawTimes || timePhase);
  const alternating = sawCounts && sawTimes;
  const lapsByCar = { ...state.lapsByCar };
  ordered.forEach((row, index) => {
    const count = counts[index];
    if ((countPhase || wrappedCount(row)) && count !== null
      && count >= (lapsByCar[row.carNumber] ?? 0)) lapsByCar[row.carNumber] = count;
  });
  const nextRows = rows.map((row) => {
    const rawGap = row.gap || '';
    // Cells rotate independently; one table can contain both kinds at once.
    const isCount = wrappedCount(row) || (countPhase && countValue(row) !== null);
    const ambiguous = isCount || (!alternating && /^\d+$/.test(String(rawGap).trim()));
    return {
      ...row,
      gapRaw: rawGap,
      gap: ambiguous ? '' : rawGap,
      // Once rotation is proven, intervals are explicitly adjacent, even if
      // every cell is blank during the count phase.
      gapSemantics: alternating ? 'alternating-adjacent' : ambiguous ? 'unavailable' : '',
      gapRole: isCount ? 'completed-laps' : ambiguous ? 'ambiguous' : 'time-gap',
      interval: alternating && !ambiguous ? rawGap : row.interval,
      lapNumber: alternating ? lapsByCar[row.carNumber] ?? null : row.lapNumber,
      lapNumberSource: alternating ? 'alternating-gap' : '',
      lapNumberFresh: alternating && isCount
    };
  });
  return { state: { signature, sawCounts, sawTimes, alternating, lapsByCar }, rows: nextRows };
}

module.exports = { adaptTimingFeed };
