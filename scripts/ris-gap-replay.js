// Replays a recorded RIS race (LAPS, GAP and INT columns) through the real gap
// model, once with and once without the line-crossing timeline, and compares
// the gaps to the class rivals ahead/behind with the exact gaps at the line.
//
// Usage: node scripts/ris-gap-replay.js [lap_history.jsonl] [followed cars, comma separated]
const fs = require('fs');
const path = require('path');
const timeline = require('../src/shared/crossingTimeline');
const { updateGapMemory } = require('../src/shared/gapMemory');
const { adaptTimingFeed } = require('../src/shared/timingFeed');

const HEADERS = ['P', 'STATE', 'CLASS', 'PIC', '#', 'TEAM INFO', 'LAPS', 'GAP', 'INT', 'LAST'];

function loadPolls(file) {
  const records = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(JSON.parse)
    .filter((row) => row.carNumber && row.lastLap && Number.isFinite(Date.parse(row.collectedAt)));
  records.sort((a, b) => Date.parse(a.collectedAt) - Date.parse(b.collectedAt));
  const latest = new Map();
  const polls = [];
  let pointer = 0;
  for (const at of [...new Set(records.map((row) => row.collectedAt))]) {
    while (pointer < records.length && records[pointer].collectedAt === at) {
      latest.set(String(records[pointer].carNumber), records[pointer]);
      pointer += 1;
    }
    const rows = [...latest.values()].sort((a, b) => Number(a.position) - Number(b.position)).map((row) => ({
      carNumber: String(row.carNumber), position: row.position, className: row.className, classPosition: row.classPosition,
      state: row.state, lastLap: row.lastLap, lapNumber: row.lapNumber, gap: row.gap, interval: row.interval, diff: row.diff
    }));
    polls.push({ at, rows });
  }
  return polls;
}

function run(polls, followedCars, disableTimeline) {
  let feed = {};
  let memory = {};
  const views = [];
  for (const poll of polls) {
    const adapted = adaptTimingFeed(feed, HEADERS, poll.rows);
    feed = adapted.state;
    memory = updateGapMemory(memory, { rows: adapted.rows, followedCars, collectedAt: poll.at, disableTimeline });
    views.push({ at: poll.at, rows: adapted.rows, viewsByCar: memory.viewsByCar });
  }
  return views;
}

function evaluate(file, followedCars) {
  const polls = loadPolls(file);
  // Reference: exact crossing times of every car from the complete race.
  let reference = timeline.createTimeline();
  polls.forEach((poll) => { reference = timeline.observePoll(reference, poll.rows, poll.at); });
  const exact = timeline.resolve(reference);
  const truthAt = (car, other, atIso) => {
    const at = Date.parse(atIso);
    const ours = (exact.crossings[car] || []).filter((item) => item.at <= at);
    const theirs = (exact.crossings[other] || []).filter((item) => item.at <= at);
    const lap = Math.min(ours.at(-1)?.lap ?? -1, theirs.at(-1)?.lap ?? -1);
    const a = ours.find((item) => item.lap === lap), b = theirs.find((item) => item.lap === lap);
    return a && b && a.group === b.group ? Math.abs(b.at - a.at) : null;
  };
  const results = {};
  for (const [label, disable] of [['old', true], ['new', false]]) {
    const views = run(polls, followedCars, disable);
    let asked = 0, known = 0, compared = 0;
    const errors = [];
    views.forEach(({ at, viewsByCar }) => followedCars.forEach((car) => ['ahead', 'behind'].forEach((relation) => {
      const item = viewsByCar[car]?.[relation];
      if (!item?.rivalCarNumber) return;
      asked += 1;
      if (!Number.isFinite(item.gapMs)) return;
      known += 1;
      const truth = truthAt(car, item.rivalCarNumber, at);
      if (Number.isFinite(truth)) { compared += 1; errors.push(Math.abs(item.gapMs - truth)); }
    })));
    errors.sort((a, b) => a - b);
    const pct = (p) => errors.length ? errors[Math.min(errors.length - 1, Math.floor(errors.length * p))] : null;
    results[label] = { gapKnownShare: asked ? +(known / asked).toFixed(3) : 0, compared,
      medianErrorMs: pct(0.5), p90ErrorMs: pct(0.9), p99ErrorMs: pct(0.99), maxErrorMs: errors.at(-1) ?? null };
  }
  return results;
}

if (require.main === module) {
  const file = path.resolve(process.argv[2] || path.join(__dirname, '..', 'tests', 'SPA', 'RACE', 'lap_history.jsonl'));
  const followed = (process.argv[3] || '2,98,4,84').split(',').map((car) => car.trim()).filter(Boolean);
  console.log(JSON.stringify(evaluate(file, followed), null, 2));
}

module.exports = { evaluate };
