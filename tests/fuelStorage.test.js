const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mainHarness } = require('./helpers/mainHarness');

module.exports = (async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mstc-fuel-storage-'));
  const app = mainHarness(folder);
  let settings = app.normalizeSettings({ storageFolder: folder, followedCar: '1', followedCars: ['1'], sessionMode: 'race' });
  app.setSettings(settings);
  app.setState({ storageSessionFolder: folder });
  try {
    settings = await app.updateFuelSettingsAndState({ carNumber: '1',
      config: { enabled: true, capacityLitres: 100, litresPerLap: 2, litresPerSecond: 1, reserveLitres: 10 },
      action: 'calibrate', litres: 60 });
    app.setSettings(settings);
    assert.strictEqual(settings.fuelByCar['1'].capacityLitres, 100);
    assert.strictEqual(app.fuel.get('1').balanceLitres, 60);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(folder, 'fuel_state.json')))['1'].balanceLitres, 60);
    app.loadExistingHistory(settings);
    assert.strictEqual(app.fuel.get('1').balanceLitres, 60, 'fuel calibration survives an archive reload');
    await assert.rejects(app.updateFuelSettingsAndState({ carNumber: '2', action: 'calibrate', litres: 40 }), /followed car/);
    await assert.rejects(app.updateFuelSettingsAndState({ carNumber: '1', config: { reserveLitres: -1 } }), /non-negative/);
    await assert.rejects(app.updateFuelSettingsAndState({ carNumber: '1', config: { capacityLitres: 100, reserveLitres: 120 } }), /Reserve/);
    app.services.set('1', { active: { id: 'active' }, events: [] });
    await assert.rejects(app.updateFuelSettingsAndState({ carNumber: '1', action: 'calibrate', litres: 40 }), /leaving the pits/);
    app.services.clear();
    settings = await app.updateFuelSettingsAndState({ carNumber: '1', config: { ...settings.fuelByCar['1'], enabled: false } });
    app.setSettings(settings);
    settings = await app.updateFuelSettingsAndState({ carNumber: '1', config: { ...settings.fuelByCar['1'], enabled: true } });
    app.setSettings(settings);
    assert.strictEqual(settings.fuelByCar['1'].capacityLitres, 100, 'toggle retains configuration');
    assert.strictEqual(app.fuel.get('1').balanceLitres, null, 're-enabling requires calibration, not a stale tank level');
  } finally {
    await app.flush();
    fs.rmSync(folder, { recursive: true, force: true });
  }
  console.log('Fuel settings, calibration, persistence and input validation tests passed.');
})();
