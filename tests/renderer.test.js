const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach((name) => this.values.add(name)); }
  remove(...names) { names.forEach((name) => this.values.delete(name)); }
  contains(name) { return this.values.has(name); }
  toggle(name, force) {
    if (force === true) this.add(name);
    else if (force === false) this.remove(name);
    else if (this.contains(name)) this.remove(name);
    else this.add(name);
  }
}

class FakeElement {
  constructor(id = '', tagName = 'div') {
    this.id = id;
    this.tagName = tagName.toUpperCase();
    this.textContent = '';
    this.innerHTML = '';
    this.value = '';
    this.children = [];
    this.dataset = {};
    this.classList = new FakeClassList();
    this.listeners = {};
    this.parentElement = null;
    this.offsetWidth = 100;
    this.style = {};
  }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  addEventListener(event, callback) {
    this.listeners[event] = callback;
  }
  async trigger(event) {
    if (this.listeners[event]) await this.listeners[event]({ target: this });
  }
  closest(selector) {
    if (selector !== '.metric-box') return null;
    let node = this;
    while (node) {
      if (node.classList.contains('metric-box')) return node;
      node = node.parentElement;
    }
    return null;
  }
}

function createFakeDocument() {
  const elements = new Map();
  const html = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'index.html'), 'utf8');
  [...html.matchAll(/id="([^"]+)"/g)].forEach((match) => {
    elements.set(match[1], new FakeElement(match[1]));
  });

  function byId(id) {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  }

  ['last-time-card', 'best-time-card', 'best-sector1-card', 'best-sector2-card', 'best-sector3-card',
    'delta-best-last-card', 'delta-best-best-card', 'delta-average-drivers-card', 'delta-bic-card', 'delta-xic-card'
  ].forEach((id) => byId(id).classList.add('metric-box'));

  const metricChildren = {
    'last-time': 'last-time-card',
    'best-time': 'best-time-card',
    'best-sector-1': 'best-sector1-card',
    'best-sector-2': 'best-sector2-card',
    'best-sector-3': 'best-sector3-card',
    'delta-best-last': 'delta-best-last-card',
    'delta-best-best': 'delta-best-best-card',
    'delta-average-drivers': 'delta-average-drivers-card',
    'delta-bic': 'delta-bic-card',
    'delta-xic': 'delta-xic-card'
  };
  Object.entries(metricChildren).forEach(([childId, parentId]) => {
    byId(childId).parentElement = byId(parentId);
  });

  const tableBodies = new Map([
    ['#cars-table tbody', new FakeElement('cars-table-body', 'tbody')],
    ['#driver-table tbody', new FakeElement('driver-table-body', 'tbody')],
    ['#history-table tbody', new FakeElement('history-table-body', 'tbody')],
    ['#class-table tbody', null]
  ]);

  return {
    elements,
    getElementById: byId,
    createElement: (tagName) => new FakeElement('', tagName),
    querySelector: (selector) => tableBodies.has(selector) ? tableBodies.get(selector) : null,
    querySelectorAll: () => []
  };
}

const settings = {
  timingUrl: 'https://example.com/live',
  followedCar: '13',
  comparisonCar: '56',
  storageFolder: '/tmp/race-data',
  pollIntervalMs: 5000,
  setupComplete: true
};

const initialState = {
  status: 'collecting',
  lastSuccessAt: '2026-06-25T10:00:00.000Z',
  session: { sessionName: 'Test Race', timeToGo: '55:54' },
  headers: [],
  diagnostics: {},
  errors: [],
  lapHistory: [],
  rows: [
    { position: 1, carNumber: 13, team: 'Our Team', car: 'Car', driver: 'Nigel Moore', className: 'LMP3', classPosition: 1, gap: '', diff: '', lastLap: '2:05.000', bestLap: '2:03.500', lapNumber: 12, sector1: '41.000', sector2: '46.000', sector3: '', pit: '1' },
    { position: 2, carNumber: 2, team: 'Best Class', car: 'Car', driver: 'Fast Driver', className: 'LMP3', classPosition: 2, gap: '5.000', diff: '5.000', lastLap: '2:04.000', bestLap: '2:02.000', lapNumber: 12, sector1: '', sector2: '', sector3: '', pit: '0' },
    { position: 3, carNumber: 56, team: 'Chosen Class', car: 'Car', driver: 'X Driver', className: 'LMP3', classPosition: 3, gap: '10.000', diff: '5.000', lastLap: '2:10.000', bestLap: '2:06.554', lapNumber: 12, sector1: '', sector2: '', sector3: '', pit: '0' }
  ],
  analyticsSummary: {
    cars: [{ carNumber: '13', bestSector1Ms: null, bestSector2Ms: '', bestSector3Ms: undefined }],
    driversByCar: {},
    dashboardAnalysis: null
  }
};

const updatedState = {
  ...initialState,
  pitstopPlan: {
    label: 'Pit window open',
    status: 'open',
    canPitNow: true,
    waitMs: 0,
    completedPitStops: 1,
    remainingRequiredStops: 1,
    mustPitSoonMs: 1800000,
    clock: { elapsedMs: 3600000, remainingMs: 3600000, progress: 0.5 },
    rules: { requiredPitStops: 2, pitStopDurationMs: 75000 },
    projection: {
      available: true,
      projectedClassPosition: 2,
      carAhead: { carNumber: '2', projectedGapToUsMs: -5000 },
      carBehind: { carNumber: '56', projectedGapToUsMs: 10000 }
    }
  },
  analyticsSummary: {
    cars: [{ carNumber: '13', bestSector1Ms: 41000, bestSector2Ms: 46000, bestSector3Ms: 36000 }],
    driversByCar: {
      2: [{ driverName: 'Fast Driver', averageLapMs: 123500 }],
      56: [{ driverName: 'X Driver', averageLapMs: 129000 }]
    },
    dashboardAnalysis: {
      driverComparison: {
        bestDriver: { driverName: 'D1', bestLapMs: 123000, averageLapMs: 125000 },
        currentDriver: { driverName: 'D2', lastLapMs: 126500, bestLapMs: 124500, averageLapMs: 127000 },
        deltas: {
          bestDriverBestLapToCurrentLastLapMs: 3500,
          bestDriverBestLapToCurrentBestLapMs: 1500,
          bestDriverAverageToCurrentAverageMs: 2000
        }
      },
      classComparison: {
        bestClassCar: { carNumber: '2', averageLapMs: 124000 },
        selectedCar: { carNumber: '56', averageLapMs: 130000 },
        ourCurrentStint: { averageLapMs: 127000 },
        deltas: {}
      }
    }
  }
};

const document = createFakeDocument();
let collectorUpdate = null;
let lastSettingsPatch = null;
const liveTiming = {
  getSettings: async () => settings,
  setSettings: async (patch) => {
    lastSettingsPatch = patch;
    Object.assign(settings, patch);
    return settings;
  },
  chooseFolder: async () => '/tmp/race-data',
  startCollector: async () => true,
  stopCollector: async () => true,
  getCollectorState: async () => initialState,
  openLiveWindow: async () => true,
  exportCurrent: async () => ({ csvPath: 'rows.csv', jsonPath: 'rows.json', historyPath: 'history.json' }),
  onCollectorUpdate: (callback) => { collectorUpdate = callback; return () => {}; }
};

const context = {
  window: { liveTiming, classBattle: {}, lapAnalytics: {}, pitstopPlanner: require('../src/shared/pitstopPlanner') },
  document,
  console,
  alert: () => {},
  setTimeout,
  clearTimeout
};

vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8'), context);

async function flushAsync() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

module.exports = (async () => {
  await flushAsync();

  assert.strictEqual(document.getElementById('session-name').textContent, 'Test Race');
  assert.strictEqual(document.getElementById('session-time').textContent, '55:54');
  assert.strictEqual(document.getElementById('info-car').textContent, '13');
  assert.strictEqual(document.getElementById('info-driver').textContent, 'Nigel Moore');
  assert.strictEqual(document.getElementById('info-class').textContent, 'LMP3');
  assert.strictEqual(document.getElementById('last-time').textContent, '2:05.000');
  assert.strictEqual(document.getElementById('best-time').textContent, '2:03.500');
  assert.strictEqual(document.getElementById('sector-1').textContent, '41.000');
  assert.strictEqual(document.getElementById('best-sector-1').textContent, '—');
  assert.strictEqual(document.getElementById('ideal-time').textContent, '—');
  assert.notStrictEqual(document.getElementById('best-sector-1').textContent, '0:00.000');

  assert.ok(collectorUpdate, 'renderer subscribes to collector updates');
  collectorUpdate(updatedState);
  await flushAsync();

  assert.strictEqual(document.getElementById('best-sector-1').textContent, '0:41.000');
  assert.strictEqual(document.getElementById('best-sector-2').textContent, '0:46.000');
  assert.strictEqual(document.getElementById('best-sector-3').textContent, '0:36.000');
  assert.strictEqual(document.getElementById('ideal-time').textContent, '2:03.000');
  assert.strictEqual(document.getElementById('best-d1-a').textContent, '2:03.000');
  assert.strictEqual(document.getElementById('last-d2').textContent, '2:06.500');
  assert.strictEqual(document.getElementById('delta-best-last').textContent, '-0:03.500');
  assert.ok(document.getElementById('delta-best-last-card').classList.contains('bad'));
  assert.strictEqual(document.getElementById('delta-bic').textContent, '+0:00.500');
  assert.ok(document.getElementById('delta-bic-card').classList.contains('good'));
  assert.strictEqual(document.getElementById('delta-xic').textContent, '+0:01.000');
  assert.ok(document.getElementById('delta-xic-card').classList.contains('good'));
  assert.strictEqual(document.getElementById('pit-status').textContent, 'Pit window open');
  assert.strictEqual(document.getElementById('pit-completed').textContent, '1');
  assert.strictEqual(document.getElementById('pit-required').textContent, '2');
  assert.strictEqual(document.getElementById('pit-next').textContent, 'Now');
  assert.ok(document.getElementById('pit-projection').textContent.includes('PIC 2'));

  document.getElementById('comparison-car').value = '56';
  await document.getElementById('comparison-car').trigger('change');
  assert.strictEqual(lastSettingsPatch.comparisonCar, '56');
  assert.strictEqual(lastSettingsPatch.pollIntervalMs, 5000);
  assert.strictEqual(lastSettingsPatch.pitRules.pitStopDurationMs, 75000);

  console.log('Renderer UI tests passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
