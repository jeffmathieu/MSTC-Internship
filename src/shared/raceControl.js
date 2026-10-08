function flagCategory(flag) {
  const text = String(flag || '').toLowerCase();
  if (/full\s*course\s*yellow|\bfcy\b|code\s*60/.test(text)) return 'fcy';
  if (/safety\s*car|\bsc\b/.test(text)) return 'safetyCar';
  if (/red/.test(text)) return 'redFlag';
  if (/finish|checkered|chequered/.test(text)) return 'finished';
  return 'green';
}

function nextRaceControlEvent(previous, session, observedAt) {
  const flag = session?.flag;
  if (!flag || !Number.isFinite(Date.parse(observedAt))) return null;
  const category = flagCategory(flag);
  if (previous?.category === category) return null;
  return { observedAt, flag, category };
}

function summarizeRaceControl(events = [], endAt = null) {
  const counts = { fcy: 0, safetyCar: 0, redFlag: 0 };
  const durationsMs = { fcy: 0, safetyCar: 0, redFlag: 0 };
  const timeline = [...events].filter((event) => Number.isFinite(Date.parse(event.observedAt)))
    .sort((a, b) => Date.parse(a.observedAt) - Date.parse(b.observedAt));
  let previous = null;
  timeline.forEach((event, index) => {
    const category = event.category || flagCategory(event.flag);
    if (category in counts && category !== previous) counts[category]++;
    const end = Date.parse(timeline[index + 1]?.observedAt || endAt);
    if (category in durationsMs && Number.isFinite(end)) durationsMs[category] += Math.max(0, end - Date.parse(event.observedAt));
    previous = category;
  });
  return { ...counts, durationsMs, source: 'observed-transitions' };
}

module.exports = { flagCategory, nextRaceControlEvent, summarizeRaceControl };
