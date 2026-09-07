const assert = require('assert');
const { fuelAction, updateFuelState, fuelSummary } = require('../src/shared/fuelModel');
const { drivingStintsForCar, buildDrivingStintState } = require('../src/shared/stintTracker');
const at = (s) => new Date(Date.UTC(2026, 8, 8) + s * 1000).toISOString();
const config = { enabled: true, capacityLitres: 100, litresPerLap: 2, reserveLitres: 10, litresPerSecond: 1,
  plannedPitInLaps: 5, targetStintLaps: 25 };
let fuel = fuelAction({}, { action: 'calibrate', litres: 60, sequence: 20, at: at(0) }, config);
fuel = updateFuelState(fuel, { sequence: 25, config });
assert.strictEqual(fuelSummary(fuel, config).estimatedLitres, 50);
assert.strictEqual(fuelSummary(fuel, config).lapsToReserve, 20);
assert.strictEqual(fuelSummary(fuel, config).plannedRefuelLitres, 20);
const stop = { id: 'fuel-1', closed: true, fuelObserved: true, fuelDurationMs: 30000, exitAt: at(300) };
fuel = updateFuelState(fuel, { sequence: 25, events: [stop], config });
assert.strictEqual(fuel.balanceLitres, 80);
fuel = updateFuelState(JSON.parse(JSON.stringify(fuel)), { sequence: 25, events: [stop], config });
assert.strictEqual(fuel.balanceLitres, 80, 'restarts cannot add a refuel twice');
fuel = fuelAction(fuel, { action: 'refuel', litres: 25, stopId: stop.id, at: at(310) }, config);
assert.strictEqual(fuel.balanceLitres, 75, 'actual litres replace the timer estimate, not add to it');
const unknown = updateFuelState(fuel, { sequence: 26, events: [{ ...stop, id: 'fuel-2', fuelDurationMs: null }], config });
assert.strictEqual(fuelSummary(unknown, config).estimatedLitres, null);
assert.strictEqual(fuelSummary(fuelAction(unknown, { action: 'refuel', litres: 10, stopId: 'fuel-2', at: at(400) }, config), config).estimatedLitres, 83);
assert.strictEqual(fuelSummary({}, config).estimatedLitres, null);
assert.strictEqual(fuelSummary(fuel, { ...config, enabled: false }).warning, '');
assert.strictEqual(fuelSummary(fuel, { ...config, enabled: false }).estimatedLitres, null);
assert.strictEqual(updateFuelState(fuel, { sequence: 26, config: { ...config, enabled: false } }).balanceLitres, null);
assert.match(fuelSummary({ balanceLitres: 12 }, config, { waitMs: 300000, averageLapMs: 120000 }).warning, /planned pit/);
assert.throws(() => fuelAction(fuel, { action: 'refuel', litres: 200 }, config));
assert.throws(() => fuelAction(fuel, { action: 'calibrate', litres: 40, stopActive: true }, config), /leaving the pits/);
assert.throws(() => fuelAction(fuel, { action: 'refuel', litres: 10, stopActive: true }, config), /leaving the pits/);
assert.throws(() => fuelAction(fuel, { action: 'refuel', litres: 10, stopExitAt: at(0) }, config), /calibrated level/);
assert.strictEqual(updateFuelState({ balanceLitres: 1, sequence: 1 }, { sequence: 2, config }).balanceLitres, null);
const lap = (n, s, driver = 'A', state = '') => ({ carNumber: '1', driverName: driver, lapNumber: n,
  lapTimeMs: n === 3 ? 60000 : 120000, lastLap: n === 3 ? '1:00.000' : '2:00.000', collectedAt: at(s), state });
const history = [lap(1, 120), lap(2, 240), lap(3, 300, 'A', 'P')];
const active = { id: 'stop', carNumber: '1', entryAt: at(300), exitAt: null, closed: false, driverBefore: 'A' };
let timed = buildDrivingStintState(history, ['1'], at(600), { pitEventsByCar: { '1': [active] }, liveRows: [{ carNumber: '1', driver: 'A', state: 'P', stint: '10:00' }] });
assert.strictEqual(timed.cars['1'].currentStint.stintTimeMs, 300000);
timed = buildDrivingStintState(history, ['1'], at(800), { pitEventsByCar: { '1': [active] }, previousState: timed,
  liveRows: [{ carNumber: '1', driver: 'A', state: 'P', stint: '13:20' }] });
assert.strictEqual(timed.cars['1'].currentStint.stintTimeMs, 300000, 'long pit pause cannot advance driving time');
assert.strictEqual(timed.cars['1'].currentStint.drivingTimePaused, true);
const handover = buildDrivingStintState(history, ['1'], at(800), {
  pitEventsByCar: { '1': [{ ...active, driverAfter: 'B' }] }, previousState: timed,
  liveRows: [{ carNumber: '1', driver: 'B', state: 'P', stint: '13:20' }]
});
assert.strictEqual(handover.cars['1'].currentStint.stintTimeMs, 0, 'new driver cannot accumulate time while still in the pits');
const closed = { ...active, exitAt: at(900), closed: true, driverAfter: 'A' };
const same = drivingStintsForCar([...history, lap(4, 1020)], '1', { generatedAt: at(1080), pitEvents: [closed] });
assert.strictEqual(same[0].stintTimeMs, 480000, 'fuel+pit union is subtracted exactly once');
assert.strictEqual(same[0].totalDriverTimeMs, 480000);
const changed = drivingStintsForCar([...history, lap(4, 1020, 'B')], '1', { generatedAt: at(1080), pitEvents: [{ ...closed, driverAfter: 'B' }] });
assert.deepStrictEqual(changed.map((s) => s.stintTimeMs), [300000, 180000]);
assert.deepStrictEqual(drivingStintsForCar(JSON.parse(JSON.stringify([...history, lap(4, 1020, 'B')])), '1',
  { generatedAt: at(1080), pitEvents: [{ ...closed, driverAfter: 'B' }] }).map((s) => s.stintTimeMs), [300000, 180000]);
assert.strictEqual(drivingStintsForCar(history, '1', { generatedAt: at(600) })[0].drivingTimeEstimated, true);
const returns = drivingStintsForCar([...history, lap(4, 1020, 'B'), lap(5, 1140, 'B'), lap(6, 1500, 'A')], '1', {
  generatedAt: at(1560), pitEvents: [{ ...closed, driverAfter: 'B' },
    { id: 'return', entryAt: at(1200), exitAt: at(1380), closed: true, driverBefore: 'B', driverAfter: 'A' }]
});
assert.deepStrictEqual(returns.map((s) => s.stintTimeMs), [300000, 300000, 180000]);
assert.strictEqual(returns[2].totalDriverTimeMs, 480000);
console.log('Fuel accounting and net driving-time tests passed.');
