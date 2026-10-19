const assert = require('assert');
const timeline = require('../src/shared/crossingTimeline');
const { updateGapMemory } = require('../src/shared/gapMemory');
const { adaptTimingFeed } = require('../src/shared/timingFeed');

// A small simulated race on a timing page with only a rotating GAP column:
// the gap cell shows the time to the car directly ahead when both are on the
// same lap, otherwise the car's own completed laps ("-- 12 laps --").
function simulate({ cars, durationMs, pollMs = 5000, start = Date.parse('2026-10-19T12:00:00.000Z') }) {
  const crossings = Object.fromEntries(cars.map((car) => {
    const times = [];
    let t = car.startOffsetMs;
    car.lapTimes.forEach((lapMs) => { t += lapMs; times.push(t); });
    return [car.car, times];
  }));
  const fmt = (ms) => {
    const minutes = Math.floor(ms / 60000);
    const rest = ((ms % 60000) / 1000).toFixed(3).padStart(6, '0');
    return minutes ? `${minutes}:${rest}` : String(Number(rest).toFixed(3));
  };
  const polls = [];
  for (let at = pollMs; at <= durationMs; at += pollMs) {
    const state = cars.map((car) => {
      const done = crossings[car.car].filter((t) => t <= at);
      return { car, laps: done.length, lastCross: done.at(-1) ?? -Infinity, lastLapMs: done.length ? car.lapTimes[done.length - 1] : null };
    }).sort((a, b) => b.laps - a.laps || a.lastCross - b.lastCross);
    const rows = state.map((item, index) => {
      const ahead = state[index - 1];
      const sameLap = ahead && ahead.laps === item.laps && item.laps > 0;
      const gapMs = sameLap ? crossings[item.car.car][item.laps - 1] - crossings[ahead.car.car][item.laps - 1] : null;
      return { carNumber: item.car.car, className: item.car.className || 'GT', position: index + 1, classPosition: index + 1,
        lastLap: item.lastLapMs ? fmt(item.lastLapMs) : '', gap: sameLap ? fmt(gapMs) : `-- ${item.laps} laps --` };
    });
    polls.push({ at: new Date(start + at).toISOString(), rows, crossings });
  }
  return { polls, crossings };
}

const laps = (n, base, jitter = 0) => Array.from({ length: n }, (_, i) => base + ((i * 7919) % 5) * jitter);
const race = simulate({
  durationMs: 40 * 60 * 1000,
  cars: [
    { car: '4', startOffsetMs: 0, lapTimes: laps(30, 100000, 300) },          // our car
    { car: '7', startOffsetMs: 10000, lapTimes: laps(30, 100000, 300) },      // 10 s behind, same pace
    { car: '9', startOffsetMs: 4000, lapTimes: laps(30, 106000, 200) },       // slower: gets lapped
    { car: '2', startOffsetMs: -6000, lapTimes: laps(30, 99500, 250) }        // ahead
  ]
});

let state = timeline.createTimeline();
let memory = {};
let feed = {};
let sawFalseLap = false;
race.polls.forEach((poll) => {
  // Same path as the app: the feed adapter recognises the rotating GAP column.
  const adapted = adaptTimingFeed(feed, ['POS', 'NR', 'DRIVER', 'CLASS', 'GAP', 'LAST'], poll.rows);
  feed = adapted.state;
  state = timeline.observePoll(state, adapted.rows, poll.at);
  memory = updateGapMemory(memory, { rows: adapted.rows, followedCars: ['4'], collectedAt: poll.at });
  const behind = memory.viewsByCar['4'].behind;
  // Right after we cross the line, car 7 is shown as "-- N laps --": it must
  // still be 10 s behind, never "+1 lap".
  if (behind?.rivalCarNumber === '7' && behind.lapGap > 0) sawFalseLap = true;
});
assert.strictEqual(sawFalseLap, false, 'the car 10 s behind is never shown as a lap down');

const resolved = timeline.resolve(state);
const truth = (car, other) => {
  const ours = race.crossings[car], theirs = race.crossings[other];
  const lap = Math.min(ours.filter((t) => t <= 40 * 60 * 1000).length, theirs.filter((t) => t <= 40 * 60 * 1000).length);
  return theirs[lap - 1] - ours[lap - 1];
};
const behind7 = timeline.gapBetween(resolved, '4', '7');
assert.strictEqual(behind7.gapMs, truth('4', '7'), 'gap to the car behind is exact');
assert.strictEqual(behind7.lapsDown, 0);
assert.strictEqual(behind7.exact, true, 'linked through the times shown in the gap cell');

const ahead2 = timeline.gapBetween(resolved, '4', '2');
assert.strictEqual(ahead2.gapMs, truth('4', '2'), 'the car ahead has a negative gap');
assert.ok(ahead2.gapMs < 0);

const lapped = timeline.gapBetween(resolved, '4', '9');
assert.strictEqual(lapped.gapMs, truth('4', '9'), 'more than a lap behind still has an exact time');
assert.ok(lapped.lapsDown >= 1, 'and the laps down are counted from our crossings');

const view = memory.viewsByCar['4'];
assert.strictEqual(memory.sourceMode, 'line-crossing-timeline');
assert.strictEqual(view.behind.rivalCarNumber, '7');
assert.strictEqual(view.behind.gapMs, truth('4', '7'));
assert.strictEqual(view.behind.estimated, false);
const coordinate = view.classCoordinates.find((item) => item.carNumber === '9');
assert.strictEqual(coordinate.gapToUsMs, truth('4', '9'));
assert.ok(coordinate.lapGap >= 1);

// RIS layout: LAPS, GAP (to the first car on the same lap) and INT (to the car
// directly ahead). LAST and LAPS may update a poll apart; that is one crossing.
{
  const at = (s) => new Date(Date.parse('2026-10-19T14:00:00.000Z') + s * 1000).toISOString();
  let ris = timeline.createTimeline();
  const poll = (s, rows) => { ris = timeline.observePoll(ris, rows, at(s)); };
  const row = (car, position, laps, last, gap, int) => ({ carNumber: car, position, lapNumber: laps, lastLap: last, gap, interval: int, diff: int });
  // Car A leads; B is 7.5 s behind; C is a lap down but 20 s behind B on track.
  poll(0, [row('A', 1, 10, '1:40.000', '--', '--'), row('B', 2, 10, '1:40.500', '7.500', '7.500'), row('C', 3, 9, '1:41.000', '1L', '1L')]);
  // A crosses at ~t=3: its lap counter arrives first, LAST a poll later.
  poll(5, [row('A', 1, 11, '1:40.000', '--', '--'), row('B', 2, 10, '1:40.500', '7.500', '7.500'), row('C', 3, 9, '1:41.000', '1L', '1L')]);
  poll(10, [row('A', 1, 11, '1:39.800', '--', '--'), row('B', 2, 10, '1:40.500', '7.500', '7.500'), row('C', 3, 9, '1:41.000', '1L', '1L')]);
  // B crosses ~7.7 s after A: LAST first, the lap counter a poll later.
  poll(15, [row('A', 1, 11, '1:39.800', '--', '--'), row('B', 2, 10, '1:40.200', '7.700', '7.700'), row('C', 3, 9, '1:41.000', '1L', '1L')]);
  poll(20, [row('A', 1, 11, '1:39.800', '--', '--'), row('B', 2, 11, '1:40.200', '7.700', '7.700'), row('C', 3, 9, '1:41.000', '1L', '1L')]);
  assert.strictEqual(ris.cars.A.crossings.length, 1, 'counter and LAST a poll apart are one crossing');
  assert.strictEqual(ris.cars.B.crossings.length, 1);
  assert.strictEqual(ris.cars.A.crossings[0].lap, 11);
  assert.strictEqual(ris.cars.B.crossings[0].lap, 11);
  const resolvedRis = timeline.resolve(ris);
  const ab = timeline.gapBetween(resolvedRis, 'A', 'B');
  assert.strictEqual(ab.gapMs, 7700, 'INT links the two crossings exactly');
  assert.strictEqual(ab.exact, true);
  // GAP to the first car on the same lap is never read as "time to the car ahead".
  const gapOnly = timeline.observePoll(timeline.observePoll(timeline.createTimeline(),
    [{ carNumber: 'X', position: 1, lapNumber: 5, lastLap: '1:40.000', gap: '--' }, { carNumber: 'Y', position: 2, lapNumber: 5, lastLap: '1:40.000', gap: '3.000' }], at(0)),
  [{ carNumber: 'X', position: 1, lapNumber: 6, lastLap: '1:40.100', gap: '--' }, { carNumber: 'Y', position: 2, lapNumber: 6, lastLap: '1:40.200', gap: '3.100' }], at(5));
  assert.strictEqual(gapOnly.cars.Y.crossings[0].gapMs, null, 'a GAP column without INT/DIFF is no link');
}

// Parsing the gap cell
assert.deepStrictEqual(timeline.readGapCell('-- 113 laps --'), { kind: 'laps', laps: 113 });
assert.deepStrictEqual(timeline.readGapCell('1:22.126'), { kind: 'time', ms: 82126 });
assert.deepStrictEqual(timeline.readGapCell('38,281'), { kind: 'time', ms: 38281 });
assert.deepStrictEqual(timeline.readGapCell(''), { kind: 'none' });

console.log('Crossing timeline tests passed.');
