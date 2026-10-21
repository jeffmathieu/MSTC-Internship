// Steward / race-control messages shown on the timing page (penalties,
// warnings, notes). Each distinct message is logged once with the time it was
// first and last seen, and with the followed cars it mentions.
(function initRaceMessages(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.raceMessages = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function createRaceMessagesApi() {
  const SAME_MESSAGE_WINDOW_MS = 10 * 60 * 1000;
  const MAX_LOG = 300;

  const clean = (value) => String(value ?? '').replace(/\s+/g, ' ').trim();

  // "#4", "Car 4", "car #4", "No. 4", "Nr 4", "N° 4", "Number 4" or a message
  // that starts with the number ("4 - drive through"). A bare 4 inside a time
  // or lap count does not count.
  function mentionsCar(text, carNumber) {
    const car = String(carNumber ?? '').trim();
    if (!/^\d+$/.test(car)) return false;
    const number = `0*${Number(car)}(?!\\d)`;
    const prefixed = new RegExp(`(?:#\\s*|\\b(?:car|no|nr|num(?:ber|mer|ero|éro)?|n°|wagen|voiture|auto|startnummer)\\.?\\s*#?\\s*)${number}`, 'i');
    const leading = new RegExp(`^\\s*${number}\\s*[-–:|]`);
    const value = clean(text);
    return prefixed.test(value) || leading.test(value);
  }

  // log: previous entries (oldest first). Returns { log, added } where added are
  // the entries that appeared on this poll.
  function updateMessageLog(log = [], visibleMessages = [], observedAt = new Date().toISOString(), followedCars = []) {
    const now = Date.parse(observedAt);
    const next = log.slice();
    const added = [];
    const changed = [];
    [...new Set(visibleMessages.map(clean).filter(Boolean))].forEach((text) => {
      const index = next.findLastIndex((entry) => entry.text === text
        && Number.isFinite(now) && now - Date.parse(entry.lastSeenAt) <= SAME_MESSAGE_WINDOW_MS);
      if (index >= 0) {
        next[index] = { ...next[index], lastSeenAt: observedAt };
        changed.push(next[index]);
        return;
      }
      const entry = {
        id: `${observedAt}|${text}`,
        text,
        firstSeenAt: observedAt,
        lastSeenAt: observedAt,
        cars: followedCars.map(String).filter((car) => mentionsCar(text, car))
      };
      next.push(entry);
      added.push(entry);
    });
    return { log: next.slice(-MAX_LOG), added, changed };
  }

  // Reads a JSONL journal of entry revisions back into the latest revision per id.
  function restoreMessageLog(revisions = []) {
    const byId = new Map();
    revisions.forEach((entry) => { if (entry?.id && entry.text) byId.set(entry.id, entry); });
    return [...byId.values()].sort((a, b) => Date.parse(a.firstSeenAt) - Date.parse(b.firstSeenAt)).slice(-MAX_LOG);
  }

  return { mentionsCar, updateMessageLog, restoreMessageLog };
});
