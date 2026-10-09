const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { prepareHistory } = require('../shared/lapAnalytics');
const { drivingStintsForCar: stintsForCar } = require('../shared/stintTracker');
const { loadSessionHistory, readJsonLines } = require('../shared/storageSession');
const { lapIdentity } = require('../shared/storageSchema');
const { writeClosedStintArtifacts, writeEventSummaryArtifacts, buildCanonicalReportPayload, renderReportLabPdf } = require('./stintReports');

(async () => {
  const input = workerData;
  const { entries } = loadSessionHistory({ fs, jsonlPath: path.join(input.sessionFolder, 'lap_history.jsonl'), identityForLap: lapIdentity });
  const history = prepareHistory(entries);
  const allStints = stintsForCar(history, input.carNumber, { ...input.stintOptions, pitEvents: input.pitEvents });
  const printFallback = (html, pdfPath) => new Promise((resolve, reject) => {
    parentPort.once('message', (reply) => reply.error ? reject(new Error(reply.error)) : resolve());
    parentPort.postMessage({ type: 'print', html, pdfPath });
  });
  const gapsPath = path.join(input.sessionFolder, 'gap_history.jsonl');
  const gapSamples = fs.existsSync(gapsPath)
    ? readJsonLines(fs, gapsPath).entries : input.gapSamples || [];
  const raceControlEvents = readJsonLines(fs, path.join(input.sessionFolder, 'race_control_events.jsonl')).entries;
  const preparedReportPayload = buildCanonicalReportPayload({ ...input, history, gapSamples, raceControlEvents,
    stints: allStints.filter((stint) => stint.closed && stint.lapCount > 0) });
  const options = { ...input, history, gapSamples, printFallback, raceControlEvents, preparedReportPayload,
    renderPdf: input.pdfEngine === 'electron' ? () => ({ rendered: false, reason: 'built-in-electron-engine' }) : renderReportLabPdf };
  const results = [];
  for (const stint of allStints.filter((item) => item.closed && item.lapCount > 0)) {
    if (input.stintNumber != null && stint.stintNumber !== input.stintNumber) continue;
    results.push(await writeClosedStintArtifacts({ ...options, stint, force: Boolean(input.final) }));
  }
  const summaries = input.final
    ? await writeEventSummaryArtifacts({ ...options, stints: allStints }) : [];
  parentPort.postMessage({ type: 'done', results, summaries });
})().catch((error) => parentPort.postMessage({ type: 'error', error: error.stack || error.message }));
