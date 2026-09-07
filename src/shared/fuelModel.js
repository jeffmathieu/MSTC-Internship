// Engineering estimate only: completed-lap consumption plus recorded refuels.
// No tank level is inferred from a timer without a configured flow rate.
const num = (v) => v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v);
function normalizeFuelConfig(input = {}) {
  const positive = (v) => num(v) > 0 ? num(v) : null;
  return { enabled: input.enabled === true, capacityLitres: positive(input.capacityLitres), litresPerLap: positive(input.litresPerLap),
    litresPerSecond: positive(input.litresPerSecond), reserveLitres: Math.max(0, num(input.reserveLitres) ?? 0),
    targetStintLaps: positive(input.targetStintLaps), plannedPitInLaps: Math.max(0, num(input.plannedPitInLaps) ?? 0) };
}
function updateFuelState(previous = {}, { sequence = 0, events = [], config = {} } = {}) {
  const rules = normalizeFuelConfig(config);
  if (!rules.enabled) return { ...previous, balanceLitres: null, sequence, fills: {} };
  let balance = num(previous.balanceLitres);
  const delta = Math.max(0, sequence - (previous.sequence ?? sequence));
  if (balance !== null && delta) balance = rules.litresPerLap ? balance - delta * rules.litresPerLap : null;
  // A negative tank is a failed estimate, not fuel debt carried into the next fill.
  if (balance !== null && balance < 0) balance = null;
  const fills = { ...(previous.fills || {}) };
  for (const event of events.filter((e) => e.closed && (!previous.calibratedAt || Date.parse(e.exitAt || e.revisionAt) > Date.parse(previous.calibratedAt)))) {
    if (fills[event.id]) continue;
    if (event.fuelDurationMs === 0) continue;
    if (!event.fuelObserved && event.fuelDurationMs == null) {
      fills[event.id] = { litres: null, source: 'unknown' }; continue;
    }
    const litres = rules.litresPerSecond && num(event.fuelDurationMs) !== null
      ? event.fuelDurationMs / 1000 * rules.litresPerSecond : null;
    const accepted = litres === null ? null : balance !== null && rules.capacityLitres
      ? Math.max(0, Math.min(litres, rules.capacityLitres - balance)) : litres;
    fills[event.id] = { litres: accepted, source: accepted === null ? 'unknown' : 'timer-estimate' };
    if (balance !== null && accepted !== null) balance += accepted;
  }
  return { ...previous, balanceLitres: balance, sequence, fills };
}
function fuelAction(previous, { action, litres, at, sequence, stopId, stopActive, stopExitAt }, config = {}) {
  const rules = normalizeFuelConfig(config);
  if (!rules.enabled) throw new Error('Enable fuel estimates first.');
  const amount = num(litres);
  if (amount === null || amount < 0 || (rules.capacityLitres && amount > rules.capacityLitres)) throw new Error('Enter valid litres within tank capacity.');
  if (action === 'calibrate') {
    if (stopActive) throw new Error('Calibrate after leaving the pits so the current fuel stop is not counted twice.');
    return { balanceLitres: amount, sequence, calibratedAt: at, fills: {}, lastAction: { action, litres: amount, at } };
  }
  if (action !== 'refuel') throw new Error('Unknown fuel action.');
  if (stopActive) throw new Error('Confirm total litres after leaving the pits.');
  if (stopExitAt && previous.calibratedAt && Date.parse(stopExitAt) <= Date.parse(previous.calibratedAt)) {
    throw new Error('That stop is already included in the calibrated level. Calibrate again to correct it.');
  }
  const key = stopId || `manual-${at}`;
  const old = previous.fills?.[key];
  let balance = num(previous.balanceLitres);
  if (balance !== null) balance += amount - (num(old?.litres) ?? 0);
  if (balance !== null && rules.capacityLitres && balance > rules.capacityLitres) throw new Error('Refuel exceeds tank capacity; check or calibrate the current level.');
  return { ...previous, balanceLitres: balance, fills: { ...previous.fills, [key]: { litres: amount, source: 'manual' } },
    lastAction: { action, litres: amount, stopId: key, at } };
}
function fuelSummary(state = {}, config = {}, { averageLapMs, waitMs } = {}) {
  const rules = normalizeFuelConfig(config);
  if (!rules.enabled) return { ...rules, estimatedLitres: null, lapsToReserve: null, plannedRefuelLitres: null,
    plannedFuelTimeMs: null, warning: '', estimated: true };
  const unknownFills = Object.values(state.fills || {}).filter((fill) => fill.litres == null).length;
  const rawLevel = unknownFills ? null : num(state.balanceLitres);
  const level = rawLevel === null ? null : Math.max(0, rawLevel);
  const laps = level !== null && rules.litresPerLap ? Math.max(0, (level - rules.reserveLitres) / rules.litresPerLap) : null;
  const arrival = level !== null && rules.litresPerLap ? level - rules.plannedPitInLaps * rules.litresPerLap : null;
  const desired = rules.targetStintLaps && rules.litresPerLap ? rules.targetStintLaps * rules.litresPerLap + rules.reserveLitres : null;
  const needed = desired !== null && arrival !== null ? Math.max(0, desired - Math.max(0, arrival)) : null;
  const space = arrival !== null && rules.capacityLitres ? Math.max(0, rules.capacityLitres - Math.max(0, arrival)) : null;
  const add = needed === null ? null : space === null ? needed : Math.min(needed, space);
  let warning = '';
  if (rawLevel === null) warning = unknownFills ? 'Confirm litres for the last fuel stop, or calibrate tank level.' : 'Calibrate tank level to enable the estimate.';
  else if (!rules.litresPerLap) warning = 'Set consumption in litres/lap.';
  else if (level <= rules.reserveLitres) warning = 'FUEL: reserve reached — pit required.';
  else if (arrival < rules.reserveLitres) warning = 'FUEL: planned pit lap is beyond the estimated reserve.';
  else if (num(waitMs) > 0 && num(averageLapMs) > 0 && laps * averageLapMs < waitMs) warning = 'FUEL: estimated range cannot reach the next allowed pit window.';
  else if (desired !== null && rules.capacityLitres && desired > rules.capacityLitres) warning = 'FUEL: target stint exceeds tank capacity; shorten the stint.';
  return { ...rules, estimatedLitres: level, lapsToReserve: laps, plannedRefuelLitres: add,
    plannedFuelTimeMs: add !== null && rules.litresPerSecond ? add / rules.litresPerSecond * 1000 : null,
    unknownFills, warning, estimated: true, sequence: state.sequence, calibratedAt: state.calibratedAt || null };
}
module.exports = { normalizeFuelConfig, updateFuelState, fuelAction, fuelSummary };
