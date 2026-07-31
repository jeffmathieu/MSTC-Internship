// Pure session-completion rules. A checkered flag starts the final lap; the
// race is complete only after every car in the followed class is classified.
(function initSessionCompletion(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.sessionCompletion = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function createSessionCompletionApi() {
  function rowIsFinished(row = {}) {
    const status = [row.eta, row.state, row.status, row.pitStatus]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return /\b(?:finish|finished|finishd|classified)\b/.test(status);
  }

  function followedClassCompletion(rows = [], followedCarNumber = '') {
    const followed = rows.find((row) => String(row.carNumber) === String(followedCarNumber));
    if (!followed) return { complete: false, reason: 'followed-car-missing', classRows: [] };
    const className = String(followed.className || '').trim();
    const classRows = rows.filter((row) => (
      className ? String(row.className || '').trim() === className : true
    ) && String(row.carNumber || '').trim());
    if (!classRows.length) return { complete: false, reason: 'class-empty', classRows: [] };
    const unfinished = classRows.filter((row) => !rowIsFinished(row));
    return {
      complete: unfinished.length === 0,
      reason: unfinished.length ? 'cars-still-running' : 'all-class-cars-finished',
      className: className || 'Overall',
      classRows,
      unfinished
    };
  }

  return { rowIsFinished, followedClassCompletion };
});
