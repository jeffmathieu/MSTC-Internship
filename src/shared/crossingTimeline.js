// Line-crossing timeline for timing pages without a reliable interval column:
// a GAP that rotates between a time and "-- N laps --", a GAP to the leader
// (no DIFF/INT), or RIS (INT shows "1L" across laps).
//
// Idea: LAST is exact, so within an uninterrupted run of observed crossings a
// car's crossing times are fixed relative to each other:
//   t(k) = base + (sum of LAST up to k).
// Every observed crossing happened between two polls, which bounds the base to
// a small window. Every time the gap cell shows a real time, it gives the exact
// difference between two cars' crossings (the car directly ahead, or the
// leader on a GAP-to-leader page), which links their bases exactly.
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
  // LAST and the lap count may update a poll apart (RIS): one crossing.
  const MERGE_MS = 30000;
  // Deciding what a lone GAP column means: GAP to the leader never goes down
  // along the order of cars on the same lap; a time to the car ahead often does.
  const MIN_GAP_VOTES = 12;

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

  // What one timing row says about its car:
  //  linkMs: the time shown to the reference car - DIFF/INT (car directly
  //          ahead), or, on a page whose only gap column is GAP, that cell:
  //          to the car directly ahead or to the leader (gapMode). On RIS,
  //          GAP (to the first car on the same lap) next to INT is never used.
  //  linkTo: 'ahead' or 'leader'.
  //  laps:   completed laps - the LAPS column, or on a rotating GAP page the
  //          "-- N laps --" cell.
  function readRow(row, gapMode, pageHasInterval = true) {
    const rotating = row.gapSemantics === 'alternating-adjacent';
    const intervalText = String(row.diff || row.interval || '').trim();
    const gapOnly = rotating || !pageHasInterval;
    const linkText = gapOnly ? String(row.gapRaw ?? row.gap ?? '').trim() : intervalText;
    const linkCell = readGapCell(linkText);
    const lapValue = row.lapNumber === '' || row.lapNumber == null ? NaN : Number(row.lapNumber);
    const providerLaps = !rotating && row.lapNumberSource !== 'observed-sequence' && Number.isFinite(lapValue) ? lapValue : null;
    const laps = providerLaps ?? (rotating && linkCell.kind === 'laps' ? linkCell.laps : null);
    const linkTo = gapOnly ? (gapMode || (rotating ? 'ahead' : 'leader')) : 'ahead';
    return { linkMs: linkCell.kind === 'time' ? linkCell.ms : null, linkTo, laps, changeText: `${linkText}|${laps ?? ''}` };
  }

  // GRR pages without DIFF leave it empty on every row; RIS always fills INT
  // (at least "--"), and its GAP is to the first car on the same lap.
  function pageShowsInterval(ordered) {
    return ordered.some((row) => String(row.diff || row.interval || '').trim() !== '');
  }

  // Votes on what a lone GAP column means, from cars next to each other that
  // both show a time.
  function voteGapMode(votes, ordered) {
    const next = { up: votes?.up || 0, down: votes?.down || 0 };
    let previous = null;
    ordered.forEach((row) => {
      const cell = readGapCell(row.gapRaw ?? row.gap);
      if (cell.kind !== 'time') { previous = null; return; }
      if (previous !== null) {
        if (cell.ms >= previous) next.up += 1;
        else next.down += 1;
      }
      previous = cell.ms;
    });
    return next;
  }

  function gapModeFrom(votes) {
    const total = (votes?.up || 0) + (votes?.down || 0);
    if (total < MIN_GAP_VOTES) return null;
    const share = votes.up / total;
    return share >= 0.9 ? 'leader' : share <= 0.75 ? 'ahead' : null;
  }

  function createTimeline() {
    return { pollAt: null, segmentSeq: 0, cars: {} };
  }

  // Places a crossing in its car's run once its lap time is known: continues the
  // run when the lap time fits between the poll windows, otherwise starts a new run.
  function placeCrossing(state, crossing, lapMs, carKey, next) {
    const previous = state.crossings[state.crossings.indexOf(crossing) - 1];
    let continuous = previous && Number.isFinite(lapMs) && Number.isFinite(previous.cum) && previous.segment === state.segment
      // The previous crossing was in [previous.prev, previous.at] and this one in
      // [crossing.prev, crossing.at], so this lap must fit between those bounds.
      && lapMs <= crossing.at - previous.prev + SLACK_MS
      && lapMs >= crossing.prev - previous.at - SLACK_MS;
    const cum = continuous ? previous.cum + lapMs : 0;
    // The run's base must stay consistent with every crossing in it. A LAST that
    // does not add up (pit-lane timing, a glitch) starts a new run instead of
    // shifting the whole run.
    if (continuous) {
      const lo = Math.max(state.window.lo, crossing.prev - cum);
      const hi = Math.min(state.window.hi, crossing.at - cum);
      if (lo > hi + BREAK_TOLERANCE_MS) continuous = false;
      else state.window = lo <= hi ? { lo, hi } : { lo: (lo + hi) / 2, hi: (lo + hi) / 2 };
    }
    if (!continuous) {
      next.segmentSeq += 1;
      state.segment = `${carKey}#${next.segmentSeq}`;
      state.window = { lo: crossing.prev, hi: crossing.at };
    }
    crossing.segment = state.segment;
    crossing.lapMs = Number.isFinite(lapMs) ? lapMs : null;
    crossing.cum = continuous ? cum : 0;
    crossing.pending = false;
  }

  // rows: one poll of the timing table (any order); each row needs carNumber,
  // position, lastLap (text) and the gap/interval/laps columns it has.
  function observePoll(timeline = createTimeline(), rows = [], pollAtIso) {
    const pollAt = Date.parse(pollAtIso);
    if (!Number.isFinite(pollAt)) return timeline;
    const previousPoll = timeline.pollAt;
    const ordered = [...rows].filter((row) => key(row.carNumber))
      .sort((a, b) => (Number(a.position) || Infinity) - (Number(b.position) || Infinity));
    const pageHasInterval = pageShowsInterval(ordered);
    const gapVotes = pageHasInterval ? (timeline.gapVotes || { up: 0, down: 0 }) : voteGapMode(timeline.gapVotes, ordered);
    const gapMode = gapModeFrom(gapVotes);
    const next = { ...timeline, pollAt, cars: { ...timeline.cars }, gapVotes, gapMode };
    ordered.forEach((row, index) => {
      const car = key(row.carNumber);
      const lastText = String(row.lastLap ?? '').trim();
      const info = readRow(row, gapMode, pageHasInterval);
      const before = next.cars[car];
      const state = before
        ? { ...before, crossings: before.crossings.map((item) => ({ ...item })) }
        : { crossings: [], lastText, linkText: info.changeText, segment: null, window: null, lastCount: info.laps };
      const ready = before && Number.isFinite(previousPoll);
      // A crossing shows up as a new LAST and/or a higher lap count. Some pages
      // (RIS) update the two a poll apart: within MERGE_MS they are one crossing.
      const lastChanged = ready && lastText !== before.lastText;
      const countUp = ready && Number.isFinite(info.laps) && Number.isFinite(before.lastCount) && info.laps > before.lastCount;
      const latest = state.crossings.at(-1);
      const mergeable = latest && pollAt - latest.at <= MERGE_MS
        && ((lastChanged && !latest.byLast && latest.byCount) || (countUp && !latest.byCount && latest.byLast));
      if (lastChanged || countUp) {
        if (mergeable) {
          if (lastChanged) { latest.byLast = true; placeCrossing(state, latest, parseClockMs(lastText), car, next); }
          if (countUp) { latest.byCount = true; latest.lap = info.laps; }
        } else {
          // A crossing still waiting for its LAST keeps the LAST it has.
          if (latest?.pending) placeCrossing(state, latest, parseClockMs(before.lastText), car, next);
          const crossing = {
            segment: state.segment, prev: previousPoll, at: pollAt, lapMs: null, cum: null,
            lap: countUp ? info.laps : Number.isFinite(state.lastCount) ? state.lastCount + 1 : null,
            aheadCar: null, gapMs: null, byLast: lastChanged, byCount: countUp, pending: !lastChanged
          };
          state.crossings.push(crossing);
          if (lastChanged) placeCrossing(state, crossing, parseClockMs(lastText), car, next);
          if (state.crossings.length > KEEP_CROSSINGS) state.crossings.shift();
        }
      } else if (latest?.pending && pollAt - latest.at > MERGE_MS) {
        // The lap count went up but LAST stayed the same: an identical lap time.
        placeCrossing(state, latest, parseClockMs(lastText), car, next);
      }
      const current = state.crossings.at(-1);
      // The gap/interval cell is rewritten when the car crosses the line (or a
      // poll later): it ties this crossing to the reference car's crossing.
      const linkFresh = current && (lastChanged || countUp
        || (!Number.isFinite(current.gapMs) && info.changeText !== before?.linkText && pollAt - current.at <= MERGE_MS));
      if (linkFresh && Number.isFinite(info.linkMs) && index > 0) {
        current.aheadCar = key((info.linkTo === 'leader' ? ordered[0] : ordered[index - 1]).carNumber);
        current.gapMs = info.linkMs;
      }
      if (current && Number.isFinite(info.laps) && (!Number.isFinite(current.lap) || info.laps >= current.lap)) current.lap = info.laps;
      if (Number.isFinite(info.laps)) state.lastCount = info.laps;
      else if (current && Number.isFinite(current.lap)) state.lastCount = current.lap;
      state.lastText = lastText;
      state.linkText = info.changeText;
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
    // Crossings still waiting for their LAST are not placed yet.
    const cars = Object.fromEntries(Object.entries(timeline?.cars || {}).map(([car, state]) =>
      [car, { ...state, crossings: state.crossings.filter((crossing) => !crossing.pending && Number.isFinite(crossing.cum)) }]));
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
