// Replays a recorded race as if the timing page only had a rotating GAP column
// ("time to the car directly ahead" or "-- N laps --", no DIFF/INT), runs the
// crossing timeline on it, and compares the reconstructed intervals with the
// real intervals the original page showed.
//
// Usage: node scripts/gap-only-replay.js [lap_history.jsonl]
const fs = require('fs');
const path = require('path');
const timeline = require('../src/shared/crossingTimeline');

// hideShare: share of visible interval times replaced by the lap count, to
// measure how well hidden intervals are rebuilt from LAST and the other links.
function replay(file, hideShare = 0) {
  const hidden = (car, lap) => hideShare > 0 && ((Number(car) * 7919 + Number(lap) * 104729) % 1000) / 1000 < hideShare;
  const records = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
    .filter((row) => row.carNumber && row.lastLap && Number.isFinite(Date.parse(row.collectedAt)));
  records.sort((a, b) => Date.parse(a.collectedAt) - Date.parse(b.collectedAt));
  const polls = [...new Set(records.map((row) => row.collectedAt))];
  const latest = new Map(); // car -> latest record
  let state = timeline.createTimeline();
  let pointer = 0;
  const checks = [];
  const truths = [];
  for (const poll of polls) {
    while (pointer < records.length && records[pointer].collectedAt === poll) {
      latest.set(String(records[pointer].carNumber), records[pointer]);
      pointer += 1;
    }
    const table = [...latest.values()].sort((a, b) => Number(a.position) - Number(b.position));
    // What the GAP-only page would show for every car on this poll.
    const rows = table.map((row, index) => {
      const ahead = index > 0 ? table[index - 1] : null;
      const sameLap = ahead && Number(ahead.lapNumber) === Number(row.lapNumber);
      return { carNumber: row.carNumber, position: row.position, lastLap: row.lastLap, gapSemantics: 'alternating-adjacent',
        gapRaw: sameLap && row.interval && !hidden(row.carNumber, row.lapNumber) ? row.interval : `-- ${row.lapNumber} laps --` };
    });
    // Ground truth: each car that crossed on this poll, its real interval and
    // the car directly ahead of it at that moment.
    table.forEach((row, index) => {
      if (row.collectedAt !== poll || index === 0) return;
      const trueMs = timeline.parseClockMs(row.interval);
      const ahead = table[index - 1];
      if (Number.isFinite(trueMs) && Number(ahead.lapNumber) === Number(row.lapNumber)) {
        truths.push({ car: String(row.carNumber), ahead: String(ahead.carNumber), lap: Number(row.lapNumber), trueMs,
          hidden: hidden(row.carNumber, row.lapNumber) });
      }
    });
    state = timeline.observePoll(state, rows, poll);
  }
  const resolved = timeline.resolve(state);
  // Compare every true interval with the reconstructed one.
  for (const truth of truths) {
    const ours = (resolved.crossings[truth.car] || []).find((item) => item.lap === truth.lap);
    const theirs = (resolved.crossings[truth.ahead] || []).find((item) => item.lap === truth.lap);
    if (!ours || !theirs) continue;
    const exact = ours.group === theirs.group;
    checks.push({ errorMs: Math.abs(ours.at - theirs.at - truth.trueMs), exact, truth,
      statedMs: exact ? 0 : ours.uncertaintyMs + theirs.uncertaintyMs });
  }
  return { checks, conflicts: resolved.conflicts, cars: Object.keys(resolved.crossings).length, crossings: records.length };
}

function summarize({ checks: all, conflicts, cars, crossings }, onlyHidden = false) {
  const checks = onlyHidden ? all.filter((check) => check.truth.hidden) : all;
  const errors = checks.map((check) => check.errorMs).sort((a, b) => a - b);
  const pct = (p) => errors.length ? errors[Math.min(errors.length - 1, Math.floor(errors.length * p))] : null;
  return { cars, crossings, compared: checks.length, linkedShare: checks.length ? checks.filter((c) => c.exact).length / checks.length : 0,
    withinStatedUncertainty: checks.length ? checks.filter((c) => c.errorMs <= c.statedMs + 500).length / checks.length : 0,
    medianErrorMs: pct(0.5), p90ErrorMs: pct(0.9), p99ErrorMs: pct(0.99), maxErrorMs: errors.at(-1) ?? null, conflicts };
}

if (require.main === module) {
  const file = path.resolve(process.argv[2] || path.join(__dirname, '..', 'tests', 'SPA', 'RACE', 'lap_history.jsonl'));
  for (const share of [0, 0.5, 0.9]) {
    const result = replay(file, share);
    console.log(`hide ${share * 100}% of times:`, JSON.stringify(summarize(result, share > 0)));
  }
}

module.exports = { replay, summarize };
