const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const rendererCss = fs.readFileSync(path.join(__dirname, '..', 'src', 'renderer', 'styles.css'), 'utf8');
assert.strictEqual(
  /\.pit-window\.complete\s+\.pit-bar/.test(rendererCss),
  false,
  'completed mandatory stops keep red pit-history and closed-window segments visible'
);
[
  '--lap-strip-pit-color',
  '--lap-strip-neutralized-color',
  '--lap-strip-personal-best-color',
  '--lap-strip-class-best-color'
].forEach((variable) => assert.ok(rendererCss.includes(variable), `${variable} remains independently editable`));

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
    if (!selector.includes('.metric-box') && !selector.includes('.timing-row')) return null;
    let node = this;
    while (node) {
      if (node.classList.contains('metric-box') || node.classList.contains('timing-row')) return node;
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

  ['best-sector1-card', 'best-sector2-card', 'best-sector3-card',
    'ref-sector1-card', 'ref-sector2-card', 'ref-sector3-card'
  ].forEach((id) => byId(id).classList.add('metric-box'));
  ['last-time-card', 'best-time-card', 'predicted-lap-card', 'reference-lap-card'].forEach((id) => byId(id).classList.add('timing-row'));

  const metricChildren = {
    'best-time': 'best-time-card',
    'best-sector-1': 'best-sector1-card',
    'best-sector-2': 'best-sector2-card',
    'best-sector-3': 'best-sector3-card'
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
    getElementById: (id) => elements.get(id) || null,
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

let lastPitNotesPayload = null;
const updatedState = {
  ...initialState,
  lapHistory: [
    { carNumber: '13', driverName: 'Nigel Moore', lapNumber: 1, lapTimeMs: 125000, pitInfo: '0', sessionFlag: 'Green flag', collectedAt: '2026-06-25T10:02:05.000Z' },
    { carNumber: '13', driverName: 'Nigel Moore', lapNumber: 2, lapTimeMs: 180000, pitInfo: '0', sessionFlag: 'FCY', collectedAt: '2026-06-25T10:05:05.000Z' },
    { carNumber: '13', driverName: 'Nigel Moore', lapNumber: 3, lapTimeMs: 140000, pitInfo: '1', state: 'IN', sessionFlag: 'Green flag', collectedAt: '2026-06-25T10:07:25.000Z' },
    { carNumber: '13', driverName: 'Nigel Moore', lapNumber: 4, lapTimeMs: 135000, pitInfo: '1', state: 'RUN', sessionFlag: 'Green flag', collectedAt: '2026-06-25T10:09:40.000Z' }
  ],
  stintState: {
    cars: {
      13: { currentStint: { stintNumber: 3, driverStintNumber: 2, driverName: 'Nigel Moore', stintTimeMs: 3900000, totalDriverTimeMs: 8080000, drivingTimeEstimated: true } }
    }
  },
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
    lastPitDurationMs: 78000,
    lastPitTargetDurationMs: 75000,
    lastPitRawDuration: '1:18',
    lastPitElapsedMs: 3600000,
    validPitElapsedHistoryMs: [3600000, 7200000],
    remainingRequiredStops: 1,
    mustPitSoonMs: 1800000,
    latestPossiblePitElapsedMs: 5300000,
    schedule: {
      buffer: { totalMs: 280000, lapBufferMs: 250000, fixedSafetyBufferMs: 30000 },
      next: { latestSafeEntryElapsedMs: 5000000, latestPossibleEntryElapsedMs: 5300000 }
    },
    recommendation: { action: 'PLAN PIT', reason: 'Keep this stop before the safe deadline.', level: 'normal' },
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
    timingHighlightsByCar: {
      13: {
        bestLap: { valueMs: 123500, classBestMs: 123500, isClassBest: true },
        bestSectors: {
          sector1: { valueMs: 41000, classBestMs: 41000, isClassBest: true },
          sector2: { valueMs: 46000, classBestMs: 45500, isClassBest: false },
          sector3: { valueMs: 36000, classBestMs: 36000, isClassBest: true }
        },
        lapStrip: [
          { lapNumber: 1, lapTimeMs: 123500, driverName: 'Nigel Moore', driverInitials: 'MOO', status: 'normal', highlight: 'class-best', marker: '', tooltip: 'Nigel Moore · Green flag' },
          { lapNumber: 2, lapTimeMs: 180000, driverName: 'Nigel Moore', driverInitials: 'MOO', status: 'neutralized', highlight: 'none', marker: '', manualLapStatus: 'invalid', tooltip: 'Nigel Moore · FCY' },
          { lapNumber: 3, lapTimeMs: 140000, driverName: 'Nigel Moore', driverInitials: 'MOO', status: 'pit-in', highlight: 'none', marker: 'P', tooltip: 'Nigel Moore · pit-in' },
          { lapNumber: 4, lapTimeMs: 135000, driverName: 'Nigel Moore', driverInitials: 'MOO', status: 'pit-out', highlight: 'none', marker: '', tooltip: 'Nigel Moore · pit-out' }
        ]
      }
    },
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

updatedState.analyticsSummary.comparisonView = {
  matrix: {
    classCars: [
      {
        carNumber: '13',
        isOurCar: true,
        metrics: [],
        sectors: []
      },
      {
        carNumber: '2',
        isBic: true,
        metrics: [],
        sectors: []
      },
      {
        carNumber: '56',
        metrics: [],
        sectors: []
      }
    ],
    averageCars: [
      {
        carNumber: '13',
        isOurCar: true,
        totalAverageMs: 127000,
        totalAverageDeltaMs: 0,
        averages: [{ label: 'MOO', valueMs: 127000, deltaMs: 0 }]
      },
      {
        carNumber: '2',
        isBic: true,
        totalAverageMs: 124000,
        totalAverageDeltaMs: 3000,
        averages: [{ label: 'DRI', valueMs: 124000, deltaMs: 3000 }]
      },
      {
        carNumber: '56',
        isXic: true,
        totalAverageMs: 130000,
        totalAverageDeltaMs: -3000,
        averages: [{ label: 'DRI', valueMs: 130000, deltaMs: -3000 }]
      }
    ]
  }
};

const document = createFakeDocument();
let collectorUpdate = null;
let lastSettingsPatch = null;
let graphsOpenCount = 0;
let lastGraphsCar = null;
let themeUpdate = null;
let lastLapStatusPayload = null;
const liveTiming = {
  getSettings: async () => settings,
  updateFuel: async ({ carNumber, config }) => {
    settings.fuelByCar = { ...settings.fuelByCar, [carNumber]: config };
    return { settings, state: updatedState };
  },
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
  updateLapStatus: async (payload) => { lastLapStatusPayload = payload; return { ok: true, state: updatedState }; },
  onThemeUpdate: (callback) => { themeUpdate = callback; return () => {}; },
  savePitNotes: async (payload) => { lastPitNotesPayload = payload; return { ok: true, state: null }; },
  exportCurrent: async () => ({ csvPath: 'rows.csv', jsonPath: 'rows.json', historyPath: 'history.json' }),
  onCollectorUpdate: (callback) => { collectorUpdate = callback; return () => {}; }
};

const context = {
  window: { location: { search: '' }, liveTiming, classBattle: require('../src/shared/classBattle'), trackConditions: require('../src/shared/trackConditions'), lapAnalytics: require('../src/shared/lapAnalytics'), timingHighlights: require('../src/shared/timingHighlights'), pitstopCircuits: require('../src/shared/pitstopCircuits'), pitstopPlanner: require('../src/shared/pitstopPlanner'), normReference: require('../src/shared/normReference'), dashboardView: require('../src/shared/dashboardView') },
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
  assert.strictEqual(document.getElementById('last-time').textContent, '2:05.000', 'last lap receives a prominent timing card');
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

  assert.strictEqual(document.getElementById('info-stint').textContent, 'Driver stint 2 · 1u05 driving / total 2u14');
  assert.strictEqual(document.getElementById('info-car-stint').textContent, 'Car stint 3');
  const lapRows = document.getElementById('lap-strip-list').children;
  assert.strictEqual(lapRows.length, 4, 'all stored laps are rendered in the vertical strip');
  assert.strictEqual(lapRows[0].children[0].textContent, '4', 'newest lap appears first');
  assert.strictEqual(lapRows[0].classList.contains('pit-out'), true);
  assert.strictEqual(lapRows[0].children[2].textContent, 'MOO', 'surname-based driver code sits between time and pit marker');
  assert.strictEqual(lapRows[0].children[3].textContent, '', 'outlap is red without a P marker');
  assert.strictEqual(lapRows[1].classList.contains('pit-in'), true);
  assert.strictEqual(lapRows[1].children[3].textContent, 'P');
  assert.strictEqual(lapRows[2].classList.contains('neutralized'), true);
  assert.strictEqual(lapRows[2].classList.contains('manual-invalid'), true);
  assert.strictEqual(lapRows[2].children[3].textContent, 'INV', 'manual invalid laps show why they are excluded from averages');
  assert.strictEqual(lapRows[3].classList.contains('class-best'), true);
  await document.getElementById('lap-edit-toggle').trigger('click');
  await flushAsync();
  const editableRows = document.getElementById('lap-strip-list').children;
  assert.strictEqual(document.getElementById('lap-strip').classList.contains('editing'), true, 'lap strip enters manual status edit mode');
  const statusSelect = editableRows[0].children[4];
  assert.strictEqual(statusSelect.className, 'lap-status-select');
  statusSelect.value = 'track-limits';
  await statusSelect.trigger('change');
  await flushAsync();
  assert.strictEqual(lastLapStatusPayload.carNumber, '13');
  assert.strictEqual(lastLapStatusPayload.lapNumber, 4);
  assert.strictEqual(lastLapStatusPayload.lapTimeMs, 135000);
  assert.strictEqual(lastLapStatusPayload.status, 'track-limits', 'manual lap status edits are sent to the main process');
  const manyLapState = {
    ...updatedState,
    lapHistory: Array.from({ length: 25 }, (_, index) => ({
      carNumber: '13',
      driverName: 'Nigel Moore',
      lapNumber: index + 1,
      lapTimeMs: 125000 + index,
      pitInfo: '0',
      sessionFlag: 'Green flag',
      collectedAt: `2026-06-25T10:${String(index).padStart(2, '0')}:00.000Z`
    }))
  };
  collectorUpdate(manyLapState);
  await flushAsync();
  assert.strictEqual(
    [...document.getElementById('lap-strip-list').children].filter((row) => row.children[4]?.className === 'lap-status-select').length,
    25,
    'manual status edit mode exposes every stored lap, not only the latest 20'
  );
  document.getElementById('lap-strip-list').scrollTop = 84;
  collectorUpdate(updatedState);
  await flushAsync();
  assert.strictEqual(document.getElementById('lap-strip-list').scrollTop, 84, 'polling preserves manual lap-history scroll position');
  const stateWithFreshLapAndStaleHighlights = {
    ...updatedState,
    lapHistory: [
      ...updatedState.lapHistory,
      { carNumber: '13', driverName: 'Nigel Moore', lapNumber: 5, lapTimeMs: 124000, pitInfo: '0', sessionFlag: 'Green flag', collectedAt: '2026-06-25T10:11:44.000Z' }
    ]
  };
  collectorUpdate(stateWithFreshLapAndStaleHighlights);
  await flushAsync();
  const refreshedLapRows = document.getElementById('lap-strip-list').children;
  assert.strictEqual(refreshedLapRows.length, 5, 'lap strip follows fresh history even when the analytics summary is one poll behind');
  assert.strictEqual(refreshedLapRows[0].children[0].textContent, '5', 'the newly completed lap is immediately visible at the top');
  collectorUpdate(updatedState);
  await flushAsync();
  assert.strictEqual(document.getElementById('best-time').classList.contains('class-best-value'), true);

  assert.strictEqual(document.getElementById('best-sector-1').textContent, '0:41.000');
  assert.strictEqual(document.getElementById('best-sector-2').textContent, '0:46.000');
  assert.strictEqual(document.getElementById('best-sector-1').classList.contains('class-best-value'), true);
  assert.strictEqual(document.getElementById('best-sector-2').classList.contains('class-best-value'), false);
  collectorUpdate({ ...updatedState, session: { ...updatedState.session, flag: 'Full course yellow' } });
  assert.strictEqual(document.getElementById('session-status-block').classList.contains('flag-caution'), true);
  assert.strictEqual(document.getElementById('session-status-block').classList.contains('flag-red'), false);
  assert.strictEqual(document.getElementById('status-text').textContent, 'FCY');
  collectorUpdate({ ...updatedState, session: { ...updatedState.session, flag: 'Safety car' } });
  assert.strictEqual(document.getElementById('status-text').textContent, 'SC');
  collectorUpdate({ ...updatedState, session: { ...updatedState.session, flag: 'NO ACTIVE HEAT' } });
  assert.strictEqual(document.getElementById('status-text').textContent, 'GREEN', 'active timing rows override stale RIS no-heat text');
  collectorUpdate({ ...updatedState, session: { ...updatedState.session, flag: 'Red flag' } });
  assert.strictEqual(document.getElementById('session-status-block').classList.contains('flag-red'), true);
  assert.strictEqual(document.getElementById('session-status-block').classList.contains('flag-caution'), false);
  assert.strictEqual(document.getElementById('status-text').textContent, 'RED');
  collectorUpdate({
    ...updatedState,
    session: { ...updatedState.session, flag: 'Finish' },
    finishCountdown: { active: true, remainingMs: 127000 }
  });
  assert.strictEqual(document.getElementById('status-text').textContent, '🏁 FINISH');
  assert.strictEqual(document.getElementById('session-time-label').textContent, 'Finish watch');
  assert.strictEqual(document.getElementById('session-time').textContent, '2:07');
  assert.strictEqual(document.getElementById('session-status-block').classList.contains('flag-red'), false);
  collectorUpdate(updatedState);
  assert.strictEqual(document.getElementById('session-time-label').textContent, 'Time left');
  assert.strictEqual(document.getElementById('session-time').textContent, '55:54');
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

  assert.ok(document.getElementById('comparison-placeholder'), 'the redesigned comparison area remains intentionally empty');
  assert.strictEqual(document.getElementById('pit-status').textContent, 'Pit window open');
  assert.strictEqual(document.getElementById('pit-stops-summary').textContent, '1/2');
  assert.strictEqual(document.getElementById('pit-next').textContent, 'PLAN PIT');
  assert.ok(document.getElementById('pit-detail').textContent.includes('safe by 1:23:20'));
  assert.ok(document.getElementById('pit-detail').textContent.includes('legal limit 1:28:20'));
  assert.ok(document.getElementById('pit-detail').textContent.includes('buffer 4:40'));
  assert.ok(document.getElementById('pit-projection').textContent.includes('PIC 2'));
  assert.ok(document.getElementById('pit-projection').textContent.includes('0:05.000 behind #2'));
  assert.ok(document.getElementById('pit-projection').textContent.includes('0:10.000 ahead #56'));
  collectorUpdate({
    ...updatedState,
    pitstopPlan: {
      ...updatedState.pitstopPlan,
      label: 'Mandatory pitstops complete',
      status: 'complete',
      requirementsComplete: true,
      completedPitStops: 2,
      remainingRequiredStops: 0,
      mustPitSoonMs: null,
      latestSafePitElapsedMs: null
    }
  });
  await flushAsync();
  assert.strictEqual(document.getElementById('pit-status').textContent, 'Mandatory pitstops complete');
  assert.strictEqual(document.getElementById('pit-next').textContent, 'Optional');
  assert.ok(document.getElementById('pit-window').classList.contains('complete'));
  assert.ok(!document.getElementById('pit-detail').textContent.includes('latest safe stop'));
  assert.ok(document.getElementById('pit-projection').textContent.includes('PIC 2'), 'rejoin projection stays visible after required stops');
  collectorUpdate(updatedState);
  await flushAsync();
  assert.strictEqual(document.getElementById('pit-bar').style.gridTemplateColumns, '1500000fr 11400000fr 1500000fr');
  const cooldownPeriods = document.getElementById('pit-cooldown-overlays').children;
  assert.strictEqual(cooldownPeriods.length, 2);
  assert.strictEqual(cooldownPeriods[0].style.left, '25%');
  assert.ok(cooldownPeriods[0].style.width.startsWith('10.416'));
  assert.strictEqual(cooldownPeriods[1].style.left, '50%');
  assert.strictEqual(document.getElementById('battle-ahead-main').textContent, '#2 · Gap 5.000s');
  assert.strictEqual(document.getElementById('battle-ahead-delta').textContent, 'Last lap Δ +0.500s');
  assert.ok(document.getElementById('battle-ahead-trend').textContent.includes('we catch #2'));
  assert.ok(document.getElementById('battle-ahead-prediction').textContent.includes('10.0 laps'));
  assert.ok(document.getElementById('battle-ahead-card').classList.contains('good'));
  assert.strictEqual(document.getElementById('battle-behind-main').textContent, '#56 · Gap 10.000s');
  assert.ok(document.getElementById('battle-behind-card').classList.contains('bad'));
  const cachedBattles = updatedState.analyticsSummary.adjacentClassBattles;
  collectorUpdate({ ...updatedState, analyticsSummary: { ...updatedState.analyticsSummary,
    adjacentClassBattles: { ...cachedBattles,
      ahead: { ...cachedBattles.ahead, relativeGap: 291299, gapLabel: '291.299s',
        lastLapDeltaLabel: '-4.688s', trendLabel: 'we are not catching · we lose 0.769s/l' },
      behind: { ...cachedBattles.behind, relativeGap: null, gapLabel: 'gap unknown' }
    }
  } });
  await flushAsync();
  assert.strictEqual(document.getElementById('battle-ahead-main').textContent, '#2 · Gap 4:51.299');
  assert.strictEqual(document.getElementById('battle-ahead-delta').textContent, 'Last lap Δ -4.688s');
  assert.strictEqual(document.getElementById('battle-ahead-trend').textContent, 'we are not catching · we lose 0.769s/l');
  assert.strictEqual(document.getElementById('battle-behind-main').textContent, '#56 · Gap unknown');
  collectorUpdate(updatedState);
  await flushAsync();

  await document.getElementById('open-graphs').trigger('click');
  assert.strictEqual(graphsOpenCount, 1, 'graph icon opens the detachable graphs window');
  assert.strictEqual(lastGraphsCar, '13', 'graph window follows the car displayed by this dashboard');

  await document.getElementById('open-pit-setup').trigger('click');
  assert.strictEqual(document.getElementById('pit-setup-modal').classList.contains('hidden'), false);
  assert.strictEqual(document.getElementById('pit-circuit').children.length, 5, 'all supported pit formations appear in the dropdown');
  document.getElementById('pit-race-hours').value = '6';
  document.getElementById('pit-required-input').value = '3';
  document.getElementById('pit-closed-start-minutes').value = '20';
  document.getElementById('pit-closed-end-minutes').value = '30';
  document.getElementById('pit-cooldown-minutes').value = '24';
  document.getElementById('pit-circuit').value = 'spa-f1';
  await document.getElementById('pit-circuit').trigger('change');
  assert.strictEqual(document.getElementById('pit-distance-meters').value, '650');
  assert.strictEqual(document.getElementById('pit-fcy-speed').value, '60');
  assert.ok(document.getElementById('pit-distance-note').textContent.includes('39.0s'));
  document.getElementById('pit-distance-meters').value = '700';
  document.getElementById('pit-fcy-speed').value = '70';
  document.getElementById('pit-safety-laps').value = '1.5';
  document.getElementById('pit-safety-seconds').value = '45';
  await document.getElementById('pit-fcy-speed').trigger('input');
  assert.ok(document.getElementById('pit-distance-note').textContent.includes('36.0s'));
  await document.getElementById('pit-setup-save').trigger('click');
  await flushAsync();
  assert.strictEqual(lastSettingsPatch.pitCircuitId, 'spa-f1');
  assert.strictEqual(lastSettingsPatch.pitRules.raceDurationMs, 6 * 60 * 60 * 1000);
  assert.strictEqual(lastSettingsPatch.pitRules.requiredPitStops, 3);
  assert.strictEqual(lastSettingsPatch.pitRules.pitClosedStartMs, 20 * 60 * 1000);
  assert.strictEqual(lastSettingsPatch.pitRules.pitClosedEndMs, 30 * 60 * 1000);
  assert.strictEqual(lastSettingsPatch.pitRules.pitCooldownMs, 24 * 60 * 1000);
  assert.strictEqual(lastSettingsPatch.pitRules.regularTrackDistanceMeters, 700);
  assert.strictEqual(lastSettingsPatch.pitRules.fcySpeedKph, 70);
  assert.strictEqual(lastSettingsPatch.pitRules.safetyBufferLaps, 1.5);
  assert.strictEqual(lastSettingsPatch.pitRules.fixedSafetyBufferMs, 45000);
  assert.strictEqual('tyreStrategy' in lastSettingsPatch, false);
  assert.strictEqual(document.getElementById('pit-setup-modal').classList.contains('hidden'), true);

  collectorUpdate({ ...updatedState, mode: 'live', status: 'collecting' });
  await flushAsync();
  assert.strictEqual(document.getElementById('open-pit-setup').disabled, false, 'pit strategy remains adjustable during live collection');
  await document.getElementById('open-pit-setup').trigger('click');
  assert.strictEqual(document.getElementById('pit-setup-modal').classList.contains('hidden'), false);
  document.getElementById('pit-safety-laps').value = '3';
  await document.getElementById('pit-setup-save').trigger('click');
  await flushAsync();
  assert.strictEqual(lastSettingsPatch.pitRules.safetyBufferLaps, 3, 'live pit strategy changes are persisted immediately');
  assert.strictEqual(document.getElementById('pit-setup-modal').classList.contains('hidden'), true);
  collectorUpdate(updatedState);
  await flushAsync();
  assert.strictEqual(document.getElementById('service-pit-timer').textContent, '1:18');
  assert.strictEqual(document.getElementById('pit-last-delta').textContent, '+0:03');
  collectorUpdate({ ...updatedState, pitstopPlan: { ...updatedState.pitstopPlan,
    serviceTimers: { active: false, fuelDurationMs: 45000, pitDurationMs: 75000, totalDurationMs: 120000 },
    projection: { available: true, projectedClassPosition: 6,
      carAhead: { carNumber: '96', projectedGapToUsMs: null },
      carBehind: { carNumber: '1', projectedGapToUsMs: 531641 } }
  } });
  await flushAsync();
  assert.strictEqual(document.getElementById('service-state').textContent, 'Last stop');
  assert.strictEqual(document.getElementById('service-total-timer').textContent, '2:00');
  assert.strictEqual(document.getElementById('service-pit-timer').textContent, '1:15');
  assert.strictEqual(document.getElementById('fuel-timer').textContent, '0:45');
  assert.strictEqual(document.getElementById('pit-last-delta').textContent, '+0:00');
  assert.strictEqual(document.getElementById('pit-projection').textContent, 'PIC 6 · gap unknown behind #96 · 8:51.641 ahead #1');
  collectorUpdate({ ...updatedState, pitstopPlan: { ...updatedState.pitstopPlan,
    projection: { available: true, projectedClassPosition: 6, carAhead: null, carBehind: null }
  } });
  await flushAsync();
  assert.ok(!document.getElementById('pit-projection').textContent.includes('class lead'), 'older saved projections cannot label sixth place a lead');
  const missingIntervalSnapshot = require('./fixtures/afterPitMissingInterval.json');
  const boundedProjection = require('../src/shared/pitstopPlanner').projectClassAfterPit(missingIntervalSnapshot.rows,
    '33', missingIntervalSnapshot.pitLossMs, missingIntervalSnapshot);
  collectorUpdate({ ...updatedState, pitstopPlan: { ...updatedState.pitstopPlan, projection: boundedProjection } });
  await flushAsync();
  assert.strictEqual(document.getElementById('pit-projection').textContent, 'PIC 6 · 6:12.902 behind #34 · gap unknown ahead #1');
  collectorUpdate({ ...updatedState, pitstopPlan: { ...updatedState.pitstopPlan,
    serviceTimers: { active: true, phase: 'fuel', fuelDurationMs: 10000, pitDurationMs: 0, totalDurationMs: 10000 },
    projection: { available: true, projectedClassPosition: 1, carAhead: null, carBehind: null }
  } });
  await flushAsync();
  assert.strictEqual(document.getElementById('service-state').textContent, 'Live fuel');
  assert.strictEqual(document.getElementById('service-pit-timer').textContent, '0:00', 'live pit time cannot reuse the previous stop');
  assert.strictEqual(document.getElementById('pit-last-delta').classList.contains('hidden'), true);
  assert.ok(document.getElementById('pit-projection').textContent.includes('class lead'));
  collectorUpdate(updatedState);
  await flushAsync();
  assert.strictEqual(document.getElementById('pit-last-delta').classList.contains('hidden'), false);

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
          { topLabel: 'Best team driver', topMs: 123000, bottomLabel: 'Last current', bottomMs: 124000, deltaLabel: 'Delta current vs best', deltaMs: 1000 },
          { topLabel: 'Best team driver', topMs: 123000, bottomLabel: 'Best current', bottomMs: 123500, deltaLabel: 'Delta current vs best', deltaMs: 500 },
          { topLabel: 'Last team driver', topMs: 124500, bottomLabel: 'Last current', bottomMs: 124000, deltaLabel: 'Delta current vs team', deltaMs: -500 },
          { topLabel: 'Best BIC', topMs: 122000, bottomLabel: 'Last BIC', bottomMs: 123000, deltaLabel: 'Delta best - last', deltaMs: 1000 },
          { topLabel: 'Best XIC', topMs: 125000, bottomLabel: 'Last XIC', bottomMs: 126500, deltaLabel: 'Delta best - last', deltaMs: 1500 }
        ]
      },
      adjacentClassBattles: {
        available: true,
        mode: 'qualifying',
        ahead: { row: { carNumber: '2' }, ourBestLapMs: 123500, rivalBestLapMs: 122000, bestLapDeltaMs: -1500, trendState: 'good' },
        behind: { row: { carNumber: '56' }, ourBestLapMs: 123500, rivalBestLapMs: 125000, bestLapDeltaMs: 1500, trendState: 'bad' }
      }
    }
  };
  collectorUpdate(qualifyingState);
  await flushAsync();
  assert.ok(document.getElementById('comparison-placeholder'), 'mode changes do not repopulate the reserved comparison area');
  assert.strictEqual(document.getElementById('battle-ahead-main').textContent, '#2 · 2:02.000');
  assert.strictEqual(document.getElementById('battle-ahead-delta').textContent, 'Delta -1.500s');
  assert.strictEqual(document.getElementById('battle-ahead-trend').textContent, '');
  assert.strictEqual(document.getElementById('battle-ahead-prediction').textContent, '');
  assert.ok(document.getElementById('battle-ahead-card').classList.contains('qualifying-compact'));

  assert.strictEqual(document.getElementById('comparison-tab-title').textContent, 'Best / Last / Last 10');
  await document.getElementById('comparison-next-tab').trigger('click');
  await flushAsync();
  assert.strictEqual(document.getElementById('comparison-tab-title').textContent, 'Averages');
  const xicInput = document.getElementById('comparison-tab-averages').querySelectorAll('.comparison-xic-input')[0];
  assert.ok(xicInput, 'averages tab provides an inline XIC car selector');
  xicInput.value = '56';
  await xicInput.trigger('change');
  await flushAsync();
  assert.strictEqual(lastSettingsPatch.comparisonCar, '56', 'inline XIC selection is persisted');
  await document.getElementById('comparison-next-tab').trigger('click');
  await flushAsync();
  assert.strictEqual(document.getElementById('comparison-tab-title').textContent, 'Sectors');
  await document.getElementById('comparison-prev-tab').trigger('click');
  await flushAsync();
  assert.strictEqual(document.getElementById('comparison-tab-title').textContent, 'Averages');

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

  // Pit stop notes: the header button asks for notes after a stop is detected
  // and settles once they are saved.
  const notesButton = document.getElementById('open-pit-notes');
  const stopView = (needsAttention) => ({ latest: { eventId: '13|a', stopNumber: 1, detectedAt: '2026-10-16T14:00:00.000Z', closed: true,
    driverBefore: 'A', driverAfter: 'B', durationMs: 50000, editable: true, needsAttention, notes: needsAttention ? null : { tyresChanged: true } }, history: [] });
  collectorUpdate({ ...updatedState, pitNotesByCar: { 13: stopView(true) } });
  await flushAsync();
  assert.ok(notesButton.classList.contains('needs-notes'), 'a detected stop without notes colours the notes button');
  collectorUpdate({ ...updatedState, pitNotesByCar: { 13: stopView(false) } });
  await flushAsync();
  assert.ok(!notesButton.classList.contains('needs-notes') && notesButton.classList.contains('has-notes'), 'saved notes clear the colour');
  await notesButton.trigger('click');
  assert.strictEqual(document.getElementById('pit-notes-driver-name').textContent, '(A)', 'the stint notes name the driver of the stint that ended');
  assert.ok(!document.getElementById('pit-notes-modal').classList.contains('hidden'), 'the notes popup is open');
  document.getElementById('pit-notes-tyreset').value = 'Set 7';
  await document.getElementById('pit-notes-save').trigger('click');
  await flushAsync();
  assert.strictEqual(lastPitNotesPayload.notes.tyreSet, 'Set 7');
  assert.ok(document.getElementById('pit-notes-modal').classList.contains('hidden'), 'saving closes the notes popup');

  // Class gaps page: every class car with its gap to us (laps + exact time for a
  // lapped car) and the interval to the car ahead in class.
  const gapRows = [
    { position: 1, carNumber: 2, className: 'LMP3', classPosition: 1, lastLap: '2:00.100', eta: '01:10' },
    { position: 2, carNumber: 13, className: 'LMP3', classPosition: 2, lastLap: '2:00.500', eta: '01:20' },
    { position: 3, carNumber: 56, className: 'LMP3', classPosition: 3, lastLap: '2:01.000', eta: 'In Pit' },
    { position: 4, carNumber: 77, className: 'LMP3', classPosition: 4, lastLap: '2:03.000', eta: '01:00' },
    { position: 5, carNumber: 70, className: 'LMP3', classPosition: 5, lastLap: '2:04.000', eta: '?' }
  ];
  const gapView = { available: true, classCoordinates: [
    { carNumber: '2', gapToUsMs: -4250, lapGap: 0, estimated: false, source: 'line-crossing-timeline' },
    { carNumber: '13', gapToUsMs: 0, estimated: false },
    { carNumber: '56', gapToUsMs: 10000, lapGap: 0, estimated: false, source: 'line-crossing-timeline' },
    { carNumber: '77', gapToUsMs: 132500, lapGap: 1, estimated: false, source: 'line-crossing-timeline' },
    { carNumber: '70', gapToUsMs: 251000, lapGap: 2, estimated: true, atLeast: true, source: 'line-crossing-timeline' }] };
  collectorUpdate({ ...updatedState, rows: gapRows, timingPageWarning: 'The timing page is filtered on class LMP3.',
    analyticsSummary: { ...updatedState.analyticsSummary, gapModel: { viewsByCar: { 13: gapView } } } });
  await flushAsync();
  const gapTexts = document.getElementById('comparison-tab-gaps').children.map((row) => row.children.map((cell) => cell.textContent));
  assert.deepStrictEqual(gapTexts[1].slice(0, 3), ['1', '#2', '-4.250'], 'the car ahead in class has a negative gap');
  assert.strictEqual(gapTexts[2][2], 'OUR CAR');
  assert.deepStrictEqual(gapTexts[3].slice(2, 4), ['+10.000', '+10.000'], 'the car behind, with its interval to us');
  assert.strictEqual(gapTexts[3][5], 'In pit');
  assert.deepStrictEqual(gapTexts[4].slice(2, 4), ['1L · +2:12.500', '+2:02.500'], 'a lapped car keeps its exact time');
  assert.deepStrictEqual(gapTexts[5].slice(2, 4), ['2L', '—'], 'a stopped car shows the laps it is down, no ticking time');
  assert.strictEqual(document.getElementById('collector-message').textContent, 'The timing page is filtered on class LMP3.',
    'a class filter on the timing page is shown as a warning');

  // Ending a session: a "please wait" overlay shows the current step until the
  // final reports are written.
  await document.getElementById('messages-close').trigger('click');
  collectorUpdate({ ...updatedState, finalizing: { active: true, detail: 'Generating the final reports: stints, overview and debrief…', startedAt: new Date(Date.now() - 65000).toISOString() } });
  await flushAsync();
  assert.ok(!document.getElementById('finalizing-overlay').classList.contains('hidden'), 'the overlay is shown while the session ends');
  assert.strictEqual(document.getElementById('finalizing-detail').textContent, 'Generating the final reports: stints, overview and debrief…');
  assert.strictEqual(document.getElementById('finalizing-elapsed').textContent, 'Busy for 1:05');
  collectorUpdate({ ...updatedState, finalizing: null });
  await flushAsync();
  assert.ok(document.getElementById('finalizing-overlay').classList.contains('hidden'), 'and hidden when the reports are done');

  // Race control messages: a general message makes the button flash, a message
  // about this dashboard's car opens the popup by itself.
  const messagesButton = document.getElementById('open-messages');
  await document.getElementById('messages-close').trigger('click'); // start from a closed popup
  const now = new Date().toISOString();
  const general = { id: 'm1', text: 'Pit lane closed', firstSeenAt: now, lastSeenAt: now, cars: [] };
  collectorUpdate({ ...updatedState, raceMessages: [general] });
  await flushAsync();
  assert.ok(messagesButton.classList.contains('has-unread'), 'a new message makes the messages button flash');
  assert.ok(document.getElementById('messages-modal').classList.contains('hidden'), 'a general message does not open the popup');
  const ours = { id: 'm2', text: 'Car #13 - drive through penalty', firstSeenAt: now, lastSeenAt: now, cars: ['13'] };
  collectorUpdate({ ...updatedState, raceMessages: [general, ours] });
  await flushAsync();
  assert.ok(!document.getElementById('messages-modal').classList.contains('hidden'), 'a message about our car opens the popup');
  assert.strictEqual(document.getElementById('messages-title').textContent, 'Message about car #13');
  assert.ok(document.getElementById('messages-list').innerHTML !== '' || document.getElementById('messages-list').children.length > 0);
  await document.getElementById('messages-close').trigger('click');
  assert.ok(!messagesButton.classList.contains('has-unread') && !messagesButton.classList.contains('car-alert'), 'opened messages count as read');

  console.log('Renderer UI tests passed.');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
