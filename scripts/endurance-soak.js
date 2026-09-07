#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { performance } = require('perf_hooks');
const { mainHarness } = require('../tests/helpers/mainHarness');
const analytics = require('../src/shared/lapAnalytics');
const graphData = require('../src/shared/graphData');
const { createRendererChannel, mergeRendererState } = require('../src/main/rendererState');

async function runSoak({ hours = 24, cars = 45, livePolls = 120 } = {}) {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mstc-endurance-soak-'));
  const collector = mainHarness(folder);
  const settings = collector.normalizeSettings({ storageFolder: folder, followedCar: '1', followedCars: ['1', '2', '3'],
    sessionMode: 'race', trackCondition: 'dry', analysisConditionFilter: 'combined' });
  collector.setSettings(settings);
  collector.setState({ storageSessionFolder: folder, lapHistory: analytics.prepareHistory([]) });
  const start = performance.now();
  const channels = ['1', '2', '3'].map(() => createRendererChannel());
  const renderers = [{}, {}, {}];
  let maxSteadyBytes = 0;
  const measurements = [];
  let state;
  try {
    for (let second = 0; second <= hours * 3600; second += 5) {
      const completed = Math.floor(second / 125);
      const collectedAt = new Date(Date.UTC(2026, 8, 7) + second * 1000).toISOString();
      const rows = Array.from({ length: cars }, (_, i) => ({ carNumber: String(i + 1), className: `Class ${i % 3}`,
        position: i + 1, classPosition: Math.floor(i / 3) + 1, teamName: `Team ${i + 1}`,
        driverName: `Driver ${i + 1}-${Math.floor(completed / 180)}`, lapNumber: String(completed),
        sourceProvider: 'getraceresults', timingUrl: 'https://timing.invalid/24h', collectedAt,
        lastLap: completed ? `2:05.${String(completed % 20).padStart(3, '0')}` : '',
        sector1: '40.000', sector2: '45.000', sector3: '40.000', bestLap: '2:05.000', pitInfo: '0',
        state: 'RUN', sessionFlag: 'Green flag', trackCondition: 'dry', gap: `${i * 1.5}`, diff: i ? '1.500' : '--' }));
      collector.updateLapHistory(settings, rows);
      collector.updateServiceEvents(settings, rows, { collectedAt });
      if (second > 0 && second % 3600 === 0) {
        collector.setState({ rows });
        const samples = [];
        for (let repeat = 0; repeat < 3; repeat++) {
          const t = performance.now();
          collector.rebuildCollectorDerivedState(settings, { collectedAt, session: { timeToGo: '01:00:00', flag: 'Green flag' } }, rows);
          samples.push(performance.now() - t);
        }
        state = collector.getState();
        for (let i = 0; i < channels.length; i++) {
          const initial = channels[i](state, String(i + 1));
          const hydrated = mergeRendererState(renderers[i], initial);
          assert.strictEqual(hydrated.lapHistory.length, completed);
          const steady = channels[i](state, String(i + 1));
          renderers[i] = mergeRendererState(hydrated, steady);
          assert.strictEqual(steady.historyPatch, null);
          assert.strictEqual(steady.stripPatch, null);
          maxSteadyBytes = Math.max(maxSteadyBytes, Buffer.byteLength(JSON.stringify(steady)));
        }
        measurements.push({ hour: second / 3600, firstMs: +samples[0].toFixed(1), cachedMs: +samples[2].toFixed(1) });
      }
      if (second % 600 === 0) await new Promise(setImmediate);
    }
    const expected = cars * Math.floor(hours * 3600 / 125);
    assert.strictEqual(collector.getState().lapHistory.length, expected, 'no archive cap');
    await collector.flush();
    const restored = collector.loadExistingHistory(settings);
    assert.strictEqual(restored.length, expected, 'all laps survive a restart');
    assert.strictEqual(analytics.lapsForCar(restored, '1')[0].historySequence, 1);
    assert.strictEqual(analytics.lapsForCar(restored, '1').at(-1).historySequence, expected / cars);
    const graphStarted = performance.now();
    for (const option of graphData.GRAPH_OPTIONS) graphData.buildGraph(option.value, restored, '1');
    const graphMs = performance.now() - graphStarted;
    // A second phase runs EVERY live update against the full archive, with
    // staggered finishes (two cars per 5s poll), not only hourly checkpoints.
    collector.setState({ lapHistory: restored });
    let rows = state.rows;
    const liveMs = [];
    for (let poll = 0; poll < livePolls; poll++) {
      const collectedAt = new Date(Date.UTC(2026, 8, 7) + hours * 3600000 + (poll + 1) * 5000).toISOString();
      rows = rows.map((row, i) => {
        const changes = i === (poll * 2) % cars || i === (poll * 2 + 1) % cars;
        return { ...row, collectedAt, ...(changes ? { lapNumber: String(Number(row.lapNumber) + 1),
          lastLap: `2:05.${String((poll + 1) % 100).padStart(3, '0')}` } : {}) };
      });
      const t = performance.now();
      collector.updateLapHistory(settings, rows);
      collector.updateServiceEvents(settings, rows, { collectedAt });
      collector.setState({ rows });
      collector.rebuildCollectorDerivedState(settings, { collectedAt, session: { timeToGo: '00:30:00', flag: 'Green flag' } }, rows);
      for (let i = 0; i < channels.length; i++) channels[i](collector.getState(), String(i + 1));
      liveMs.push(performance.now() - t);
      await new Promise(setImmediate);
    }
    liveMs.sort((a, b) => a - b);
    const live = { polls: livePolls, p50Ms: +liveMs[Math.floor(liveMs.length * 0.5)].toFixed(1),
      p95Ms: +liveMs[Math.floor(liveMs.length * 0.95)].toFixed(1), maxMs: +liveMs.at(-1).toFixed(1) };
    assert.ok(maxSteadyBytes < 100000, 'per-window steady-state payload stays below 100 KB');
    return { hours, cars, polls: Math.floor(hours * 3600 / 5) + 1, records: expected,
      elapsedSeconds: +((performance.now() - start) / 1000).toFixed(1), maxSteadyBytes,
      graphDatasetMs: +graphMs.toFixed(1), live, measurements };
  } finally {
    await collector.flush();
    fs.rmSync(folder, { recursive: true, force: true });
  }
}

if (require.main === module) runSoak().then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => { console.error(error); process.exitCode = 1; });
module.exports = { runSoak };
