const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Minimal classList implementation for running app.js without a browser. The
// renderer only needs add/remove/contains/toggle for these tests.
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

// Minimal DOM element used by the renderer test. It intentionally implements
// only the APIs app.js touches, so missing browser assumptions fail loudly.
class FakeElement {
  constructor(id = '', tagName = 'div') {
    this.id = id;
    this.tagName = tagName.toUpperCase();
    this.textContent = '';
    this._innerHTML = '';
    this.value = '';
    this.children = [];
    this.dataset = {};
    this.classList = new FakeClassList();
    this.listeners = {};
    this.parentElement = null;
    this.offsetWidth = 100;
    this.style = {};
    this.attributes = {};
  }
  set className(value) {
    this._className = String(value || '');
    this._className.split(/\s+/).filter(Boolean).forEach((name) => this.classList.add(name));
  }
  get className() { return this._className || ''; }
  set innerHTML(value) {
    this._innerHTML = String(value || '');
    this.children.forEach((child) => { child.parentElement = null; });
    this.children = [];
  }
  get innerHTML() { return this._innerHTML; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  appendChild(child) {
    child.parentElement = this;
    this.children.push(child);
    return child;
  }
  removeChild(child) {
    this.children = this.children.filter((candidate) => candidate !== child);
    child.parentElement = null;
    return child;
  }
  addEventListener(event, callback) {
    this.listeners[event] = callback;
  }
  async trigger(event, extra = {}) {
    if (this.listeners[event]) await this.listeners[event]({ target: this, ...extra });
  }
  querySelector(selector) {
    if (!selector.startsWith('.')) return null;
    const className = selector.slice(1);
    return this.children.find((child) => child.classList.contains(className)) || null;
  }
  querySelectorAll(selector) {
    if (!selector.startsWith('.')) return [];
    const className = selector.slice(1);
    const matches = [];
    const visit = (node) => {
      node.children.forEach((child) => {
        if (child.classList.contains(className)) matches.push(child);
        visit(child);
      });
    };
    visit(this);
    return matches;
  }
  focus() {}
  select() {}
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

// Builds a fake document from the real index.html IDs. This catches accidental
// ID drift between markup and renderer code.
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
    'delta-best-last-card', 'delta-best-best-card', 'delta-average-drivers-card', 'delta-bic-card', 'delta-xic-card',
    'predicted-lap-card', 'reference-lap-card', 'ref-sector1-card', 'ref-sector2-card', 'ref-sector3-card'
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
  const editReferenceLap = new FakeElement('edit-reference-lap', 'button');
  editReferenceLap.dataset = { refKey: 'lapMs', refLabel: 'reference lap time' };
  editReferenceLap.classList.add('edit-ref');
  byId('reference-lap-card').appendChild(editReferenceLap);
  elements.set('edit-reference-lap', editReferenceLap);

  const tableBodies = new Map([
    ['#cars-table tbody', new FakeElement('cars-table-body', 'tbody')],
    ['#driver-table tbody', new FakeElement('driver-table-body', 'tbody')],
    ['#history-table tbody', new FakeElement('history-table-body', 'tbody')],
    ['#class-table tbody', null]
  ]);

  return {
    elements,
    documentElement: new FakeElement('html', 'html'),
    body: new FakeElement('body', 'body'),
    getElementById: byId,
    createElement: (tagName) => new FakeElement('', tagName),
    querySelector: (selector) => tableBodies.has(selector) ? tableBodies.get(selector) : null,
    querySelectorAll: (selector) => selector === '.edit-ref' ? [editReferenceLap] : []
  };
}

// Settings and collector states below model one normal dashboard update: initial
// blank analytics, then a live update with sectors, comparisons, and pit data.
const settings = {
  theme: 'light',
  pitCircuitId: 'zolder',
  pitRules: { raceDurationMs: 4 * 60 * 60 * 1000, requiredPitStops: 2, pitStopDurationMs: 75000, circuitId: 'zolder' },
  timingUrl: 'https://example.com/live',
  followedCar: '13',
  followedCars: ['13'],
  comparisonCar: '56',
  referenceTimes: {
    lapMs: 124500,
    sector1Ms: 41000,
    sector2Ms: 46500,
    sector3Ms: 36500
  },
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
    followedCar: '13',
    cars: [{ carNumber: '13', bestSector1Ms: null, bestSector2Ms: '', bestSector3Ms: undefined }],
    driversByCar: {},
    dashboardAnalysis: null
  }
};

const updatedState = {
  ...initialState,
  lapPrediction: {
    available: true,
    predictedLapMs: 124321,
    completedSectorCount: 1,
    driverName: 'Nigel Moore',
    predictionDeltaMs: 679
  },
  pitstopPlan: {
    label: 'Pit window open',
    status: 'open',
    canPitNow: true,
    waitMs: 0,
    completedPitStops: 1,
    lastPitElapsedMs: 3600000,
    validPitElapsedHistoryMs: [3600000, 7200000],
    remainingRequiredStops: 1,
    mustPitSoonMs: 1800000,
    clock: { elapsedMs: 3600000, remainingMs: 3600000, progress: 0.5 },
    rules: { requiredPitStops: 2, pitStopDurationMs: 75000, raceDurationMs: 14400000, pitClosedStartMs: 1500000, pitClosedEndMs: 1500000, pitCooldownMs: 1500000 },
    projection: {
      available: true,
      projectedClassPosition: 2,
      carAhead: { carNumber: '2', projectedGapToUsMs: -5000 },
      carBehind: { carNumber: '56', projectedGapToUsMs: 10000 }
    }
  },
  analyticsSummary: {
    followedCar: '13',
    cars: [{ carNumber: '13', bestSector1Ms: 41000, bestSector2Ms: 46000, bestSector3Ms: 36000 }],
    driversByCar: {
      2: [{ driverName: 'Fast Driver', averageLapMs: 123500 }],
      56: [{ driverName: 'X Driver', averageLapMs: 129000 }]
    },
    adjacentClassBattles: {
      available: true,
      lapWindow: 10,
      ahead: {
        row: { carNumber: '2' },
        lastLapDeltaLabel: '+0.500s',
        gapLabel: '5.000s',
        catchInfo: 'we catch #2 · 0.500s/lap · 10.0 laps · 20.8 min',
        trendState: 'good'
      },
      behind: {
        row: { carNumber: '56' },
        lastLapDeltaLabel: '-1.000s',
        gapLabel: '10.000s',
        catchInfo: '#56 catches us · 1.000s/lap · 10.0 laps · 20.8 min',
        trendState: 'bad'
      }
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
let graphsOpenCount = 0;
let lastGraphsCar = null;
let themeUpdate = null;
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
  openGraphsWindow: async (carNumber) => { graphsOpenCount += 1; lastGraphsCar = carNumber; return true; },
  onThemeUpdate: (callback) => { themeUpdate = callback; return () => {}; },
  exportCurrent: async () => ({ csvPath: 'rows.csv', jsonPath: 'rows.json', historyPath: 'history.json' }),
  onCollectorUpdate: (callback) => { collectorUpdate = callback; return () => {}; }
};

const context = {
  window: { location: { search: '' }, liveTiming, classBattle: {}, lapAnalytics: {}, pitstopCircuits: require('../src/shared/pitstopCircuits'), pitstopPlanner: require('../src/shared/pitstopPlanner'), normReference: require('../src/shared/normReference'), dashboardView: require('../src/shared/dashboardView') },
  document,
  URLSearchParams,
  console,
  alert: () => {},
  setTimeout,
  clearTimeout
};

// app.js is written for the browser, so the test loads it into a VM with our
// fake window/document/preload bridge.
vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'app.js'), 'utf8'), context);

// init() is async; flushAsync waits for the promises scheduled during load.
async function flushAsync() {
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

module.exports = (async () => {
  await flushAsync();

  assert.strictEqual(document.getElementById('session-name').textContent, 'Test Race');
  assert.strictEqual(document.getElementById('session-time').textContent, '55:54');
  assert.strictEqual(document.getElementById('status-text').textContent, '—');
  assert.strictEqual(document.getElementById('collector-health').classList.contains('is-ok'), true);
  assert.strictEqual(document.getElementById('info-car').textContent, '13');
  assert.strictEqual(document.getElementById('info-driver').textContent, 'Nigel Moore');
  assert.strictEqual(document.getElementById('info-class-pic').textContent, 'LMP3 / 1');
  assert.strictEqual(document.getElementById('last-time').textContent, '2:05.000');
  assert.strictEqual(document.getElementById('best-time').textContent, '2:03.500');
  assert.strictEqual(document.getElementById('sector-1').textContent, '41.000');
  assert.strictEqual(document.getElementById('reference-lap-time').textContent, '2:04.500');
  assert.strictEqual(document.getElementById('ref-sector-1').textContent, '0:41.000');
  assert.strictEqual(document.getElementById('ref-sector-1-delta').textContent, 'Last 0.000s · Best —');
  assert.strictEqual(document.getElementById('best-sector-1').textContent, '—');
  assert.strictEqual(document.getElementById('ideal-time').textContent, '—');
  assert.notStrictEqual(document.getElementById('best-sector-1').textContent, '0:00.000');
  assert.strictEqual(document.body.attributes['data-theme'], 'light');
  assert.strictEqual(document.getElementById('theme-toggle').textContent, '☾');

  await document.getElementById('theme-toggle').trigger('click');
  await flushAsync();
  assert.strictEqual(lastSettingsPatch.theme, 'dark', 'theme toggle persists dark mode');
  assert.strictEqual(document.body.attributes['data-theme'], 'dark');
  assert.strictEqual(document.getElementById('theme-toggle').textContent, '☀');
  assert.strictEqual(document.getElementById('theme-toggle').attributes['aria-label'], 'Switch to light mode');
  themeUpdate('light');
  assert.strictEqual(document.body.attributes['data-theme'], 'light', 'theme updates synchronize open windows');
  assert.strictEqual(document.getElementById('theme-toggle').textContent, '☾');

  assert.ok(collectorUpdate, 'renderer subscribes to collector updates');
  collectorUpdate(updatedState);
  await flushAsync();

  assert.strictEqual(document.getElementById('best-sector-1').textContent, '0:41.000');
  assert.strictEqual(document.getElementById('best-sector-2').textContent, '0:46.000');
  collectorUpdate({ ...updatedState, session: { ...updatedState.session, flag: 'Full course yellow' } });
  assert.strictEqual(document.getElementById('session-status-block').classList.contains('flag-caution'), true);
  assert.strictEqual(document.getElementById('session-status-block').classList.contains('flag-red'), false);
  assert.strictEqual(document.getElementById('status-text').textContent, 'FULL COURSE YELLOW');
  collectorUpdate({ ...updatedState, session: { ...updatedState.session, flag: 'Red flag' } });
  assert.strictEqual(document.getElementById('session-status-block').classList.contains('flag-red'), true);
  assert.strictEqual(document.getElementById('session-status-block').classList.contains('flag-caution'), false);
  assert.strictEqual(document.getElementById('status-text').textContent, 'RED FLAG');
  collectorUpdate({ ...updatedState, status: 'error', message: 'Timing page unavailable' });
  assert.strictEqual(document.getElementById('collector-health').classList.contains('is-error'), true);
  assert.strictEqual(document.getElementById('collector-health').attributes.title, 'Timing page unavailable');
  assert.strictEqual(document.getElementById('best-sector-3').textContent, '0:36.000');
  assert.strictEqual(document.getElementById('ideal-time').textContent, '2:03.000');
  assert.strictEqual(document.getElementById('ideal-time-delta').textContent, 'Delta -1.500s');
  assert.ok(document.getElementById('ideal-time').classList.contains('norm-bad'));
  assert.strictEqual(document.getElementById('predicted-lap-time').textContent, '2:04.321');
  assert.strictEqual(document.getElementById('predicted-lap-delta').textContent, 'Delta +0.679s');
  assert.ok(document.getElementById('predicted-lap-card').classList.contains('norm-bad'));
  assert.strictEqual(document.getElementById('ref-sector-2-delta').textContent, 'Last -0.500s · Best -0.500s');
  assert.ok(document.getElementById('ref-sector2-card').classList.contains('norm-bad'));

  await document.getElementById('edit-reference-lap').trigger('click');
  const refEditor = document.getElementById('reference-lap-card').querySelector('.ref-edit-input');
  assert.ok(refEditor, 'clicking the pen opens an inline reference editor');
  refEditor.value = '2:06.000';
  await refEditor.trigger('blur');
  await flushAsync();
  assert.strictEqual(lastSettingsPatch.referenceTimes.lapMs, 126000);

  assert.strictEqual(document.getElementById('best-d1-a').textContent, '2:03.000');
  assert.strictEqual(document.getElementById('last-d2').textContent, '2:06.500');
  assert.strictEqual(document.getElementById('delta-best-last').textContent, '-3.500s');
  assert.ok(document.getElementById('delta-best-last-card').classList.contains('bad'));
  assert.strictEqual(document.getElementById('delta-bic').textContent, '+0.500s');
  assert.ok(document.getElementById('delta-bic-card').classList.contains('good'));
  assert.strictEqual(document.getElementById('delta-xic').textContent, '+1.000s');
  assert.ok(document.getElementById('delta-xic-card').classList.contains('good'));
  assert.strictEqual(document.getElementById('pit-status').textContent, 'Pit window open');
  assert.strictEqual(document.getElementById('pit-stops-summary').textContent, '1/2');
  assert.strictEqual(document.getElementById('pit-next').textContent, 'Now');
  assert.ok(document.getElementById('pit-projection').textContent.includes('PIC 2'));
  assert.ok(document.getElementById('pit-projection').textContent.includes('0:05.000 behind #2'));
  assert.ok(document.getElementById('pit-projection').textContent.includes('0:10.000 ahead #56'));
  assert.strictEqual(document.getElementById('pit-bar').style.gridTemplateColumns, '1500000fr 11400000fr 1500000fr');
  const cooldownPeriods = document.getElementById('pit-cooldown-overlays').children;
  assert.strictEqual(cooldownPeriods.length, 2);
  assert.strictEqual(cooldownPeriods[0].style.left, '25%');
  assert.ok(cooldownPeriods[0].style.width.startsWith('10.416'));
  assert.strictEqual(cooldownPeriods[1].style.left, '50%');
  assert.strictEqual(document.getElementById('battle-ahead-main').textContent, '#2 · Gap 5.000s');
  assert.ok(document.getElementById('battle-ahead-detail').textContent.includes('Last lap Δ +0.500s'));
  assert.ok(document.getElementById('battle-ahead-detail').textContent.includes('10.0 laps'));
  assert.ok(document.getElementById('battle-ahead-card').classList.contains('good'));
  assert.strictEqual(document.getElementById('battle-behind-main').textContent, '#56 · Gap 10.000s');
  assert.ok(document.getElementById('battle-behind-card').classList.contains('bad'));

  await document.getElementById('open-graphs').trigger('click');
  assert.strictEqual(graphsOpenCount, 1, 'graph icon opens the detachable graphs window');
  assert.strictEqual(lastGraphsCar, '13', 'graph window follows the car displayed by this dashboard');

  await document.getElementById('open-pit-setup').trigger('click');
  assert.strictEqual(document.getElementById('pit-setup-modal').classList.contains('hidden'), false);
  assert.strictEqual(document.getElementById('pit-circuit').children.length, 5, 'all supported pit formations appear in the dropdown');
  document.getElementById('pit-race-hours').value = '6';
  document.getElementById('pit-required-input').value = '3';
  document.getElementById('pit-circuit').value = 'spa-f1';
  await document.getElementById('pit-circuit').trigger('change');
  assert.strictEqual(document.getElementById('pit-distance-meters').value, '650');
  assert.strictEqual(document.getElementById('pit-fcy-speed').value, '60');
  assert.ok(document.getElementById('pit-distance-note').textContent.includes('39.0s'));
  document.getElementById('pit-distance-meters').value = '700';
  document.getElementById('pit-fcy-speed').value = '70';
  await document.getElementById('pit-fcy-speed').trigger('input');
  assert.ok(document.getElementById('pit-distance-note').textContent.includes('36.0s'));
  await document.getElementById('pit-setup-save').trigger('click');
  await flushAsync();
  assert.strictEqual(lastSettingsPatch.pitCircuitId, 'spa-f1');
  assert.strictEqual(lastSettingsPatch.pitRules.raceDurationMs, 6 * 60 * 60 * 1000);
  assert.strictEqual(lastSettingsPatch.pitRules.requiredPitStops, 3);
  assert.strictEqual(lastSettingsPatch.pitRules.regularTrackDistanceMeters, 700);
  assert.strictEqual(lastSettingsPatch.pitRules.fcySpeedKph, 70);
  assert.strictEqual(document.getElementById('pit-setup-modal').classList.contains('hidden'), true);

  collectorUpdate({ ...updatedState, mode: 'live', status: 'collecting' });
  await flushAsync();
  assert.strictEqual(document.getElementById('open-pit-setup').disabled, true, 'fixed pit setup locks during live collection');
  await document.getElementById('open-pit-setup').trigger('click');
  assert.strictEqual(document.getElementById('pit-setup-modal').classList.contains('hidden'), true);
  collectorUpdate(updatedState);
  await flushAsync();

  await document.getElementById('setup-add-car').trigger('click');
  const extraCars = document.getElementById('setup-extra-cars');
  assert.strictEqual(extraCars.children.length, 1, 'plus button adds a second car field');
  const secondCarInput = extraCars.children[0].children[0];
  secondCarInput.value = '2';
  await secondCarInput.trigger('input');
  await document.getElementById('setup-save').trigger('click');
  await flushAsync();
  assert.deepStrictEqual(Array.from(lastSettingsPatch.followedCars), ['13', '2']);

  const qualifyingState = {
    ...updatedState,
    pitstopPlan: null,
    pitstopPlansByCar: {},
    analyticsSummary: {
      ...updatedState.analyticsSummary,
      sessionMode: 'qualifying',
      comparisonView: {
        mode: 'qualifying',
        columns: [
          { topLabel: 'Best team driver', topMs: 123000, bottomLabel: 'Last current', bottomMs: 124000, deltaLabel: 'Delta best - last', deltaMs: -1000 },
          { topLabel: 'Best team driver', topMs: 123000, bottomLabel: 'Best current', bottomMs: 123500, deltaLabel: 'Delta best - best', deltaMs: -500 },
          { topLabel: 'Last team driver', topMs: 124500, bottomLabel: 'Last current', bottomMs: 124000, deltaLabel: 'Delta last - last', deltaMs: 500 },
          { topLabel: 'Best BIC', topMs: 122000, bottomLabel: 'Last BIC', bottomMs: 123000, deltaLabel: 'Delta best - last', deltaMs: 1000 },
          { topLabel: 'Best XIC', topMs: 125000, bottomLabel: 'Last XIC', bottomMs: 126500, deltaLabel: 'Delta best - last', deltaMs: 1500 }
        ]
      },
      adjacentClassBattles: {
        available: true,
        mode: 'qualifying',
        ahead: { row: { carNumber: '2' }, ourBestLapMs: 123500, rivalBestLapMs: 122000, bestLapDeltaMs: -1500, trendState: 'bad' },
        behind: { row: { carNumber: '56' }, ourBestLapMs: 123500, rivalBestLapMs: 125000, bestLapDeltaMs: 1500, trendState: 'good' }
      }
    }
  };
  collectorUpdate(qualifyingState);
  await flushAsync();
  assert.strictEqual(document.getElementById('comparison-3-top-label').textContent, 'Last team driver');
  assert.strictEqual(document.getElementById('average-d1').textContent, '2:04.500');
  assert.strictEqual(document.getElementById('comparison-4-top-label').textContent, 'Best BIC');
  assert.strictEqual(document.getElementById('delta-bic').textContent, '+1.000s');
  assert.strictEqual(document.getElementById('battle-ahead-main').textContent, '#2 · Best Δ -1.500s');
  assert.ok(document.getElementById('battle-ahead-detail').textContent.includes('Their best 2:02.000'));

  document.getElementById('mode-race').checked = false;
  document.getElementById('mode-qualifying').checked = true;
  await document.getElementById('setup-save').trigger('click');
  await flushAsync();
  assert.strictEqual(lastSettingsPatch.sessionMode, 'qualifying');
  assert.strictEqual(lastSettingsPatch.referenceTimesByMode.race.lapMs, 126000);

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
