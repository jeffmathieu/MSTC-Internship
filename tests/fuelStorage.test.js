const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { mainHarness } = require('./helpers/mainHarness');

module.exports = (async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mstc-fuel-disabled-'));
  const collector = mainHarness(folder);
  const settings = collector.normalizeSettings({ storageFolder: folder, followedCar: '1', followedCars: ['1'], sessionMode: 'race',
    fuelByCar: { '1': { enabled: true, capacityLitres: 100, litresPerLap: 2 } } });
  collector.setSettings(settings);
  collector.setState({ storageSessionFolder: folder });
  try {
    await assert.rejects(collector.updateFuelSettingsAndState({ action: 'calibrate', litres: 60 }), /temporarily disabled/);
    const collectedAt = '2026-09-08T12:00:00Z';
    const rows = [{ carNumber: '1', driver: 'A', state: 'F', pit: '0' }];
    collector.updateServiceEvents(settings, rows, { collectedAt });
    collector.rebuildCollectorDerivedState(settings, { collectedAt, session: { elapsed: '00:10:00' } }, rows);
    await collector.flush();
    assert.strictEqual(collector.getState().pitstopPlansByCar['1'].fuel, null, 'old enabled settings cannot reactivate estimates');
    assert.strictEqual(collector.services.get('1').active.phase, 'fuel', 'observed fuel service time remains enabled');
    assert.strictEqual(fs.existsSync(path.join(folder, 'fuel_state.json')), false, 'parked estimation does not update tank balances');
    assert.strictEqual(settings.fuelByCar['1'].capacityLitres, 100, 'saved configuration is retained for later');
  } finally { await collector.flush(); fs.rmSync(folder, { recursive: true, force: true }); }
  console.log('Disabled fuel estimation and retained service timer tests passed.');
})();
