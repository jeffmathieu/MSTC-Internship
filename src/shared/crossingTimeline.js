// Line-crossing timeline for timing pages whose only gap column rotates
// between "time to the car directly ahead" and "-- N laps --" (no DIFF/INT).
//
// Idea: LAST is exact, so within an uninterrupted run of observed crossings a
// car's crossing times are fixed relative to each other:
//   t(k) = base + (sum of LAST up to k).
// Every observed crossing happened between two polls, which bounds the base to
// a small window. Every time the gap cell shows a real time, it gives the exact
// difference between two cars' crossings, which links their bases exactly.
// With those links, the gap between any two cars is the difference of their
// crossings on the same lap - exact when linked, otherwise within the poll
// window - and "laps down" follows from the same timelines instead of from the
// lap counts the page only shows now and then.
(function initCrossingTimeline(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.crossingTimeline = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function createCrossingTimelineApi() {
  const KEEP_CROSSINGS = 80;
  const LINK_TOLERANCE_MS = 400;
  const SLACK_MS = 3000;
  const BREAK_TOLERANCE_MS = 6000;

  const key = (value) => String(value ?? '').trim();

  function parseClockMs(value) {
    const text = String(value ?? '').trim().replace(',', '.');
    if (!/^\+?\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(text)) return null;
    const parts = text.replace('+', '').split(':').map(Number);
    if (parts.some((part) => !Number.isFinite(part))) return null;
    const seconds = parts.reduce((total, part) => total * 60 + part, 0);
    return Math.round(seconds * 1000);
  }

  // The gap cell: { kind: 'laps', laps } | { kind: 'time', ms } | { kind: 'none' }.
  function readGapCell(value) {
    const text = String(value ?? '').trim();
    const laps = text.match(/^-*\s*(\d+)\s*laps?\s*-*$/i);
    if (laps) return { kind: 'laps', laps: Number(laps[1]) };
    const ms = parseClockMs(text);
    return Number.isFinite(ms) ? { kind: 'time', ms } : { kind: 'none' };
  }

  function createTimeline() {
    return { pollAt: null, segmentSeq: 0, cars: {} };
  }

  // rows: one poll of the timing table (any order); each row needs carNumber,
  // position, lastLap (text), gap cell text (gapRaw or gap).
  function observePoll(timeline = createTimeline(), rows = [], pollAtIso) {
    const pollAt = Date.parse(pollAtIso);
    if (!Number.isFinite(pollAt)) return timeline;
    const previousPoll = timeline.pollAt;
    const next = { ...timeline, pollAt, cars: { ...timeline.cars } };
    const ordered = [...rows].filter((row) => key(row.carNumber))
      .sort((a, b) => (Number(a.position) || Infinity) - (Number(b.position) || Infinity));
    ordered.forEach((row, index) => {
      const car = key(row.carNumber);
      const gapText = String(row.gapRaw ?? row.gap ?? '').trim();
      const lastText = String(row.lastLap ?? '').trim();
      const cell = readGapCell(gapText);
      const before = next.cars[car];
      const state = before ? { ...before, crossings: before.crossings.slice() } : { crossings: [], lastText, gapText, segment: null, window: null };
      const changed = before && Number.isFinite(previousPoll) && (lastText !== before.lastText || gapText !== before.gapText);
      // Normally LAST changes on every crossing. Two laps with exactly the same
      // time are still caught when the car's own lap count goes up.
      const countUp = cell.kind === 'laps' && Number.isFinite(before?.lastCount) && cell.laps === before.lastCount + 1;
      if (changed && (lastText !== before.lastText || countUp)) {
        const lapMs = parseClockMs(lastText);
        const latest = state.crossings.at(-1);
        // A new run starts when the previous crossing is missing or when the
        // elapsed time cannot be explained by this lap (missed crossing, restart).
        // The previous crossing was in [latest.prev, latest.at] and this one in
        // [previousPoll, pollAt], so this lap must fit between those bounds.
        let continuous = latest && Number.isFinite(lapMs) && latest.segment === state.segment
          && lapMs <= pollAt - latest.prev + SLACK_MS
          && lapMs >= previousPoll - latest.at - SLACK_MS;
        const cum = continuous ? latest.cum + lapMs : 0;
        // The run's base must stay consistent with every crossing in it. A LAST
        // that does not add up (pit-lane timing, a glitch) starts a new run
        // instead of shifting the whole run.
        if (continuous) {
          const lo = Math.max(state.window.lo, previousPoll - cum);
          const hi = Math.min(state.window.hi, pollAt - cum);
          if (lo > hi + BREAK_TOLERANCE_MS) continuous = false;
          else state.window = lo <= hi ? { lo, hi } : { lo: (lo + hi) / 2, hi: (lo + hi) / 2 };
        }
        if (!continuous) {
          next.segmentSeq += 1;
          state.segment = `${car}#${next.segmentSeq}`;
          state.window = { lo: previousPoll, hi: pollAt };
        }
        state.crossings.push({
          segment: state.segment,
          prev: previousPoll,
          at: pollAt,
          lapMs: Number.isFinite(lapMs) ? lapMs : null,
          cum: continuous ? cum : 0,
          lap: null,
          aheadCar: null,
          gapMs: null
        });
        if (state.crossings.length > KEEP_CROSSINGS) state.crossings.shift();
        // Completed laps go up with every recorded crossing.
        if (Number.isFinite(state.lastCount)) state.lastCount += 1;
      }
      const latest = state.crossings.at(-1);
      if (latest && latest.at === pollAt) {
        // The cell is rewritten when the car crosses the line.
        if (cell.kind === 'time' && index > 0) { latest.aheadCar = key(ordered[index - 1].carNumber); latest.gapMs = cell.ms; }
      }
      if (cell.kind === 'laps' && latest) latest.lap = cell.laps;
      state.lastText = lastText;
      state.gapText = gapText;
      if (cell.kind === 'laps') state.lastCount = cell.laps;
      next.cars[car] = state;
    });
    return next;
  }

  // Weighted union-find over run bases: diff[node] = base(node) - base(parent).
  function makeLinks() {
    const parent = new Map();
    const diff = new Map();
    const find = (node) => {
      if (!parent.has(node)) { parent.set(node, node); diff.set(node, 0); }
      let current = node;
      let offset = 0;
      const path = [];
      while (parent.get(current) !== current) { path.push(current); offset += diff.get(current); current = parent.get(current); }
      // Path compression with accumulated offsets.
      let remaining = offset;
      path.forEach((item) => { const own = diff.get(item); parent.set(item, current); diff.set(item, remaining); remaining -= own; });
      return { root: current, offset };
    };
    // Records base(b) - base(a) = delta. Returns false on a contradiction.
    const union = (a, b, delta) => {
      const ra = find(a), rb = find(b);
      if (ra.root === rb.root) return Math.abs((rb.offset - ra.offset) - delta) <= LINK_TOLERANCE_MS;
      parent.set(rb.root, ra.root);
      diff.set(rb.root, delta + ra.offset - rb.offset);
      return true;
    };
    return { find, union };
  }

  // Resolves every kept crossing to an estimated absolute time and lap number.
  function resolve(timeline) {
    const cars = timeline?.cars || {};
    const links = makeLinks();
    const windows = new Map();
    Object.values(cars).forEach((state) => state.crossings.forEach((crossing) => {
      links.find(crossing.segment);
      const lo = crossing.prev - crossing.cum, hi = crossing.at - crossing.cum;
      let current = windows.get(crossing.segment);
      if (!current) { current = { lo: -Infinity, hi: Infinity, centers: [] }; windows.set(crossing.segment, current); }
      current.lo = Math.max(current.lo, lo);
      current.hi = Math.min(current.hi, hi);
      current.centers.push((lo + hi) / 2);
    }));
    // One rough base per run (cached: sorting for a median is not free).
    const segmentBase = new Map();
    windows.forEach((window, segment) => segmentBase.set(segment,
      window.lo <= window.hi ? (window.lo + window.hi) / 2 : median(window.centers)));
    const roughTime = (crossing) => segmentBase.get(crossing.segment) + crossing.cum;
    // Exact links from the time shown in the gap cell.
    let conflicts = 0;
    Object.values(cars).forEach((state) => state.crossings.forEach((crossing) => {
      if (!crossing.aheadCar || !Number.isFinite(crossing.gapMs) || !cars[crossing.aheadCar]) return;
      const expected = roughTime(crossing) - crossing.gapMs;
      const match = nearest(cars[crossing.aheadCar].crossings, (item) => Math.abs(roughTime(item) - expected));
      if (!match || Math.abs(roughTime(match) - expected) > SLACK_MS * 2) return;
      // base(b) + cum_b - (base(a) + cum_a) = gap
      if (!links.union(match.segment, crossing.segment, crossing.gapMs - crossing.cum + match.cum)) conflicts += 1;
    }));
    // One base per linked group: intersect every member's window.
    const groups = new Map();
    windows.forEach((window, segment) => {
      const { root, offset } = links.find(segment);
      let group = groups.get(root);
      if (!group) { group = { lo: -Infinity, hi: Infinity, centers: [] }; groups.set(root, group); }
      group.lo = Math.max(group.lo, window.lo - offset);
      group.hi = Math.min(group.hi, window.hi - offset);
      window.centers.forEach((center) => group.centers.push(center - offset));
    });
    groups.forEach((group) => {
      group.consistent = group.lo <= group.hi;
      group.base = group.consistent ? (group.lo + group.hi) / 2 : median(group.centers);
    });
    const resolved = {};
    Object.entries(cars).forEach(([car, state]) => {
      resolved[car] = state.crossings.map((crossing) => {
        const { root, offset } = links.find(crossing.segment);
        const group = groups.get(root);
        const consistent = group.consistent;
        const base = group.base;
        return { segment: crossing.segment, group: root, at: base + offset + crossing.cum,
          uncertaintyMs: consistent ? (group.hi - group.lo) / 2 : SLACK_MS, lap: crossing.lap, lapMs: crossing.lapMs };
      });
    });
    assignLapNumbers(resolved, cars);
    return { crossings: resolved, conflicts };
  }

  // Lap numbers: shown counts anchor a run; runs without a count borrow the lap
  // of the crossing they are linked to (same lap as the car directly ahead).
  function assignLapNumbers(resolved, cars) {
    const anchor = (list) => {
      let changed = false;
      const bySegment = new Map();
      list.forEach((item, index) => { if (!bySegment.has(item.segment)) bySegment.set(item.segment, []); bySegment.get(item.segment).push(index); });
      bySegment.forEach((indexes) => {
        const known = indexes.find((index) => Number.isFinite(list[index].lap));
        if (known === undefined) return;
        const position = indexes.indexOf(known);
        indexes.forEach((index, i) => {
          const lap = list[known].lap + (i - position);
          if (list[index].lap !== lap) { list[index].lap = lap; changed = true; }
        });
      });
      return changed;
    };
    Object.values(resolved).forEach(anchor);
    for (let pass = 0; pass < 6; pass += 1) {
      let changed = false;
      Object.entries(cars).forEach(([car, state]) => {
        state.crossings.forEach((crossing, index) => {
          const own = resolved[car][index];
          if (Number.isFinite(own.lap) || !crossing.aheadCar || !resolved[crossing.aheadCar]) return;
          const target = own.at - crossing.gapMs;
          const match = nearest(resolved[crossing.aheadCar], (item) => Math.abs(item.at - target));
          if (match && Number.isFinite(match.lap) && Math.abs(match.at - target) <= SLACK_MS) { own.lap = match.lap; changed = true; }
        });
        if (anchor(resolved[car])) changed = true;
      });
      if (!changed) break;
    }
  }

  function nearest(list, distance) {
    let best = null, bestDistance = Infinity;
    (list || []).forEach((item) => { const d = distance(item); if (d < bestDistance) { best = item; bestDistance = d; } });
    return best;
  }

  function median(values) {
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
  }

  // Gap of car `other` relative to `car` at the line: positive = behind.
  // { gapMs, lapsDown, exact, uncertaintyMs } or null when unknown.
  function gapBetween(resolvedTimeline, car, other) {
    const ours = resolvedTimeline?.crossings?.[key(car)] || [];
    const theirs = resolvedTimeline?.crossings?.[key(other)] || [];
    const ourLatest = ours.filter((item) => Number.isFinite(item.lap)).at(-1);
    const theirLatest = theirs.filter((item) => Number.isFinite(item.lap)).at(-1);
    if (!ourLatest || !theirLatest) return null;
    const lap = Math.min(ourLatest.lap, theirLatest.lap);
    const a = ours.find((item) => item.lap === lap);
    const b = theirs.find((item) => item.lap === lap);
    if (!a || !b) return null;
    const gapMs = b.at - a.at;
    const exact = a.group === b.group;
    // Laps down: crossings the leading car made before the other reached this lap.
    const leader = gapMs >= 0 ? ours : theirs;
    const trailingAt = gapMs >= 0 ? b.at : a.at;
    const lapsDown = leader.filter((item) => item.lap > lap && item.at <= trailingAt).length;
    return { gapMs: Math.round(gapMs), lapsDown, lap, exact,
      uncertaintyMs: exact ? 0 : Math.round(a.uncertaintyMs + b.uncertaintyMs) };
  }

  return { createTimeline, observePoll, resolve, gapBetween, readGapCell, parseClockMs };
});
