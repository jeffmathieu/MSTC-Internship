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
  ['best-time-card', 'predicted-lap-card', 'reference-lap-card'].forEach((id) => byId(id).classList.add('timing-row'));

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
      13: { currentStint: { stintNumber: 3, driverStintNumber: 2, driverName: 'Nigel Moore', stintTimeMs: 3900000, totalDriverTimeMs: 8080000 } }
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
      ruleTimingReference: 'pit-entry',
      buffer: { totalMs: 300000, lapBufferMs: 250000, fixedSafetyBufferMs: 30000, decisionLeadMs: 10000, timingUncertaintyMs: 10000 },
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
          { lapNumber: 1, lapTimeMs: 123500, driverName: 'Nigel Moore', driverInitials: 'NM', status: 'normal', highlight: 'class-best', marker: '', tooltip: 'Nigel Moore · Green flag' },
          { lapNumber: 2, lapTimeMs: 180000, driverName: 'Nigel Moore', driverInitials: 'NM', status: 'neutralized', highlight: 'none', marker: '', tooltip: 'Nigel Moore · FCY' },
          { lapNumber: 3, lapTimeMs: 140000, driverName: 'Nigel Moore', driverInitials: 'NM', status: 'pit-in', highlight: 'none', marker: 'P', tooltip: 'Nigel Moore · pit-in' },
          { lapNumber: 4, lapTimeMs: 135000, driverName: 'Nigel Moore', driverInitials: 'NM', status: 'pit-out', highlight: 'none', marker: '', tooltip: 'Nigel Moore · pit-out' }
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
  window: { location: { search: '' }, liveTiming, classBattle: {}, trackConditions: require('../src/shared/trackConditions'), lapAnalytics: require('../src/shared/lapAnalytics'), timingHighlights: require('../src/shared/timingHighlights'), pitstopCircuits: require('../src/shared/pitstopCircuits'), pitstopPlanner: require('../src/shared/pitstopPlanner'), normReference: require('../src/shared/normReference'), dashboardView: require('../src/shared/dashboardView') },
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
  assert.strictEqual(document.getElementById('last-time'), null, 'last time is represented by the lap strip instead of a duplicate card');
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

  assert.strictEqual(document.getElementById('info-stint').textContent, 'Driver stint 2 · 1u05 / total 2u14');
  assert.strictEqual(document.getElementById('info-car-stint').textContent, 'Car stint 3');
  const lapRows = document.getElementById('lap-strip-list').children;
  assert.strictEqual(lapRows.length, 4, 'all stored laps are rendered in the vertical strip');
  assert.strictEqual(lapRows[0].children[0].textContent, '4', 'newest lap appears first');
  assert.strictEqual(lapRows[0].classList.contains('pit-out'), true);
  assert.strictEqual(lapRows[0].children[2].textContent, 'NM', 'driver initials sit between time and pit marker');
  assert.strictEqual(lapRows[0].children[3].textContent, '', 'outlap is red without a P marker');
  assert.strictEqual(lapRows[1].classList.contains('pit-in'), true);
  assert.strictEqual(lapRows[1].children[3].textContent, 'P');
  assert.strictEqual(lapRows[2].classList.contains('neutralized'), true);
  assert.strictEqual(lapRows[3].classList.contains('class-best'), true);
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
  assert.ok(document.getElementById('pit-detail').textContent.includes('buffer 5:00'));
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
  document.getElementById('pit-decision-seconds').value = '20';
  document.getElementById('pit-uncertainty-seconds').value = '15';
  document.getElementById('pit-rule-reference').value = 'pit-exit';
  document.getElementById('pit-fcy-consider-seconds').value = '8';
  document.getElementById('pit-fcy-strong-seconds').value = '18';
  document.getElementById('pit-tyre-enabled').checked = true;
  document.getElementById('pit-current-tyre').value = 'dry';
  document.getElementById('pit-candidate-tyre').value = 'wet';
  document.getElementById('pit-tyre-gain-min').value = '2.5';
  document.getElementById('pit-tyre-gain-max').value = '4.0';
  document.getElementById('pit-tyre-expected-laps').value = '12';
  document.getElementById('pit-tyre-extra-seconds').value = '10';
  document.getElementById('pit-tyre-combined').checked = true;
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
  assert.strictEqual(lastSettingsPatch.pitRules.decisionLeadMs, 20000);
  assert.strictEqual(lastSettingsPatch.pitRules.timingUncertaintyMs, 15000);
  assert.strictEqual(lastSettingsPatch.pitRules.ruleTimingReference, 'pit-exit');
  assert.strictEqual(lastSettingsPatch.pitRules.fcyConsiderSavingsMs, 8000);
  assert.strictEqual(lastSettingsPatch.pitRules.fcyStrongSavingsMs, 18000);
  assert.deepStrictEqual({ ...lastSettingsPatch.tyreStrategy }, {
    enabled: true,
    currentTyre: 'dry',
    candidateTyre: 'wet',
    gainMinMsPerLap: 2500,
    gainMaxMsPerLap: 4000,
    expectedLaps: 12,
    additionalPitTimeMs: 10000,
    combinedWithPlannedStop: true
  });
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
  assert.strictEqual(document.getElementById('pit-last').textContent, '1:18');
  assert.strictEqual(document.getElementById('pit-last-delta').textContent, '+0:03');

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
        ahead: { row: { carNumber: '2' }, ourBestLapMs: 123500, rivalBestLapMs: 122000, bestLapDeltaMs: 1500, trendState: 'bad' },
        behind: { row: { carNumber: '56' }, ourBestLapMs: 123500, rivalBestLapMs: 125000, bestLapDeltaMs: -1500, trendState: 'good' }
      }
    }
  };
  collectorUpdate(qualifyingState);
  await flushAsync();
  assert.ok(document.getElementById('comparison-placeholder'), 'mode changes do not repopulate the reserved comparison area');
  assert.strictEqual(document.getElementById('battle-ahead-main').textContent, '#2 · Best Δ +1.500s');
  assert.strictEqual(document.getElementById('battle-ahead-delta').textContent, 'Their best 2:02.000');
  assert.strictEqual(document.getElementById('battle-ahead-trend').textContent, 'Our best 2:03.500');
  assert.strictEqual(document.getElementById('battle-ahead-prediction').textContent, 'Qualifying comparison');

  document.getElementById('comparison-xic-car').value = '9';
  await document.getElementById('comparison-xic-car').trigger('change');
  await flushAsync();
  assert.strictEqual(lastSettingsPatch.comparisonCar, '9', 'inline XIC selector persists the shared comparison-car setting');
  assert.strictEqual(document.getElementById('comparison-car').value, '9', 'inline and setup XIC inputs stay synchronized');

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
