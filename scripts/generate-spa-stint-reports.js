#!/usr/bin/env node

// Builds one report page per contiguous driver stint from saved lap history.
// All eligibility and averages come from lapAnalytics.js, so PDF reporting uses
// exactly the same FCY/SC, pit and outlier rules as the dashboard.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const analytics = require('../src/shared/lapAnalytics');
const { buildStintInsights, classComparisonsForStint, classRankingForStint } = require('../src/shared/stintInsights');

const SPA_REFERENCE_TIMES = { lapMs: 180000, sector1Ms: 0, sector2Ms: 0, sector3Ms: 0 };

function argument(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

function readJsonLines(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

// Applies explicit report-only corrections without rewriting immutable raw race
// history. Excluded laps remain visible in charts, but cannot influence either
// lap or sector statistics.
function applyDriverOverrides(history, overrides = {}) {
  const driverOverrides = overrides.driverOverrides || overrides;
  const excludedLaps = overrides.excludedLaps || {};
  return history.map((entry) => {
    const carNumber = String(entry.carNumber);
    const rules = driverOverrides[carNumber] || [];
    const lapNumber = Number(entry.lapNumber);
    const rule = rules.find((candidate) => Number.isFinite(lapNumber)
      && lapNumber >= Number(candidate.fromLap)
      && lapNumber <= Number(candidate.toLap));
    const corrected = rule ? { ...entry, driverName: rule.driverName, driver: rule.driverName } : { ...entry };
    const manualSelection = excludedLaps[carNumber];
    if (Array.isArray(manualSelection)) {
      const isExcluded = manualSelection.map(Number).includes(lapNumber);

      // This curated post-race selection is authoritative for the report. Clear
      // imperfect live-feed flags/pit markers so every non-listed lap counts;
      // the immutable JSONL source and normal live analytics remain unchanged.
      corrected.lapPhase = '';
      corrected.isPitLap = false;
      corrected.state = '';
      corrected.pitInfo = '';
      corrected.pit = '';
      corrected.lapFlag = '';
      corrected.sessionFlag = '';
      corrected.sector1Flag = '';
      corrected.sector2Flag = '';
      corrected.sector3Flag = '';
      corrected.paceEligible = !isExcluded;
      corrected.sector1Eligible = !isExcluded;
      corrected.sector2Eligible = !isExcluded;
      corrected.sector3Eligible = !isExcluded;
      if (isExcluded) corrected.reportExclusionReason = 'manually-excluded-from-spa-analysis';
    }
    return corrected;
  });
}

function loadOverrides(file) {
  return file && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
}

function numericGapMs(value) {
  const text = String(value || '').trim().replace(',', '.');
  if (!text || /laps?|\d+\s*l\b/i.test(text)) return null;
  const parts = text.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 1) return Math.round(parts[0] * 1000);
  if (parts.length === 2) return Math.round((parts[0] * 60 + parts[1]) * 1000);
  return null;
}

function compactStats(stats) {
  const { laps, ...result } = stats;
  return result;
}

function statusForLap(lap, representativeSet) {
  if (lap.lapPhase === 'inlap') return 'pit-in';
  if (lap.lapPhase === 'outlap') return 'pit-out';
  if (!analytics.lapPaceEligible(lap)) return 'neutralized';
  if (!representativeSet.has(lap)) return 'outlier';
  return 'valid';
}

function statusForSector(lap, sectorNumber) {
  if (lap.lapPhase === 'inlap') return 'pit-in';
  if (lap.lapPhase === 'outlap') return 'pit-out';
  return analytics.sectorPaceEligible(lap, sectorNumber) ? 'valid' : 'neutralized';
}

function stintGroups(laps) {
  const groups = [];
  laps.forEach((lap) => {
    let current = groups.at(-1);
    if (!current || current.driverName !== lap.driverName) {
      current = { stintNumber: groups.length + 1, driverName: lap.driverName || 'Unknown', laps: [] };
      groups.push(current);
    }
    current.laps.push(lap);
  });
  return groups;
}

function elapsedMs(laps) {
  return laps.reduce((sum, lap) => sum + (Number(lap.lapTimeMs) || 0), 0);
}

function durationMs(value) {
  const match = String(value || '').trim().match(/^(\d+):(\d{2})$/);
  return match ? (Number(match[1]) * 60 + Number(match[2])) * 1000 : null;
}

// PIT is cumulative and L. PIT contains the provider-measured duration of the
// most recent stop. A counter increase therefore identifies one unique stop.
function pitStopsFromHistory(history, correctedLaps, carNumber) {
  const rawLaps = history.filter((lap) => String(lap.carNumber) === String(carNumber))
    .sort((a, b) => Number(a.lapNumber) - Number(b.lapNumber));
  const correctedByLap = new Map(correctedLaps.map((lap) => [Number(lap.lapNumber), lap]));
  const stops = [];
  let previousCount = 0;
  rawLaps.forEach((lap) => {
    const count = Number.parseInt(String(lap.pitInfo || lap.pit || ''), 10);
    if (!Number.isFinite(count) || count <= previousCount) return;
    const lapNumber = Number(lap.lapNumber);
    const before = correctedByLap.get(lapNumber - 1);
    const after = correctedByLap.get(lapNumber);
    stops.push({
      stopNumber: count,
      lapNumber,
      durationMs: durationMs(lap.lastPit),
      rawDuration: lap.lastPit || '',
      driverBefore: before?.driverName || '',
      driverAfter: after?.driverName || ''
    });
    previousCount = count;
  });
  return stops;
}

function flagCategory(value) {
  const flag = String(value || '');
  if (/full course|\bfcy\b/i.test(flag)) return 'fcy';
  if (/safety/i.test(flag)) return 'safetyCar';
  if (/red/i.test(flag)) return 'redFlag';
  return 'green';
}

// Rows from all cars share collection timestamps. Collapsing each timestamp
// before counting transitions prevents one FCY from being counted per car/lap.
function raceControlSummary(history) {
  const timeline = new Map();
  history.forEach((row) => {
    if (row.collectedAt && !timeline.has(row.collectedAt)) timeline.set(row.collectedAt, flagCategory(row.sessionFlag || row.lapFlag));
  });
  const counts = { fcy: 0, safetyCar: 0, redFlag: 0 };
  let previous = null;
  [...timeline.entries()].sort(([a], [b]) => a.localeCompare(b)).forEach(([, category]) => {
    if (category !== previous && category !== 'green') counts[category] += 1;
    previous = category;
  });
  return counts;
}

// Finds a Python interpreter that can actually import ReportLab. Codex ships a
// bundled runtime on development machines, while normal installations may use
// system Python or an explicitly configured PDF_PYTHON path.
function findPdfPython() {
  const candidates = [
    process.env.PDF_PYTHON,
    path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'bin', 'python3'),
    'python3',
    'python'
  ].filter(Boolean);
  for (const candidate of [...new Set(candidates)]) {
    const check = spawnSync(candidate, ['-c', 'import reportlab'], { stdio: 'ignore' });
    if (!check.error && check.status === 0) return candidate;
  }
  return null;
}

function buildPayload(history, carNumber, rawHistory = history) {
  const allLaps = analytics.completedLaps(history);
  const ourLaps = allLaps.filter((lap) => lap.carNumber === String(carNumber));
  if (!ourLaps.length) throw new Error(`No completed laps found for car #${carNumber}`);
  const teamName = ourLaps.find((lap) => lap.teamName)?.teamName || '';
  const className = ourLaps.find((lap) => lap.className)?.className || '';
  const sessionName = ourLaps.find((lap) => lap.sessionName)?.sessionName || 'Spa race';
  const driverTotals = Object.fromEntries(analytics.driverStats(history, carNumber).map((driver) => [driver.driverName, compactStats(driver)]));
  const raceStats = compactStats(analytics.statsForLaps(ourLaps));
  const pitStops = pitStopsFromHistory(rawHistory, ourLaps, carNumber);

  return {
    generatedAt: new Date().toISOString(),
    race: { sessionName, carNumber: String(carNumber), teamName, className, circuit: 'Spa-Francorchamps' },
    referenceTimes: SPA_REFERENCE_TIMES,
    raceSummary: {
      stats: raceStats,
      statsByCondition: Object.fromEntries(Object.entries(analytics.statsByCondition(ourLaps))
        .map(([condition, conditionStats]) => [condition, compactStats(conditionStats)])),
      recordedRaceTimeMs: elapsedMs(ourLaps),
      totalLaps: ourLaps.length,
      finalClassPosition: ourLaps.at(-1)?.classPosition || '',
      drivers: Object.values(driverTotals),
      pitStops,
      totalPitTimeMs: pitStops.every((stop) => Number.isFinite(stop.durationMs))
        ? pitStops.reduce((sum, stop) => sum + stop.durationMs, 0)
        : null,
      raceControl: raceControlSummary(rawHistory)
    },
    caveats: [
      'Class-gap history cannot be reconstructed reliably from lap-only records. Recorded GAP-to-overall-leader samples are shown instead.',
      'Stint duration is the sum of stored lap times; the first/last partial timing outside those laps is unavailable.'
    ],
    stints: stintGroups(ourLaps).map((stint) => {
      const stats = analytics.statsForLaps(stint.laps);
      const representative = new Set(analytics.representativePaceLaps(stint.laps));
      const driverTotal = driverTotals[stint.driverName] || null;
      const teammates = Object.values(driverTotals)
        .filter((driver) => driver.driverName !== stint.driverName)
        .map((driver) => ({
          driverName: driver.driverName,
          averageLapMs: driver.averageLapMs,
          bestLapMs: driver.bestLapMs,
          averageDeltaMs: Number.isFinite(stats.averageLapMs) && Number.isFinite(driver.averageLapMs) ? stats.averageLapMs - driver.averageLapMs : null,
          bestDeltaMs: Number.isFinite(stats.bestLapMs) && Number.isFinite(driver.bestLapMs) ? stats.bestLapMs - driver.bestLapMs : null
        }));
      const classComparisons = classComparisonsForStint(history, stint.laps, carNumber, className);
      const insights = buildStintInsights(stint.laps, SPA_REFERENCE_TIMES);
      insights.classRanking = classRankingForStint(stint.laps, classComparisons);
      return {
        stintNumber: stint.stintNumber,
        driverName: stint.driverName,
        startLap: stint.laps[0].lapNumber,
        endLap: stint.laps.at(-1).lapNumber,
        stintTimeMs: elapsedMs(stint.laps),
        totalDriverTimeMs: elapsedMs(stint.laps),
        stats: compactStats(stats),
        statsByCondition: Object.fromEntries(Object.entries(analytics.statsByCondition(stint.laps))
          .map(([condition, conditionStats]) => [condition, compactStats(conditionStats)])),
        driverRaceStats: driverTotal,
        teammates,
        classComparisons,
        insights,
        laps: stint.laps.map((lap) => ({
          lapNumber: lap.lapNumber,
          lapTimeMs: lap.lapTimeMs,
          sector1Ms: lap.sector1Ms,
          sector2Ms: lap.sector2Ms,
          sector3Ms: lap.sector3Ms,
          status: statusForLap(lap, representative),
          sector1Status: statusForSector(lap, 1),
          sector2Status: statusForSector(lap, 2),
          sector3Status: statusForSector(lap, 3),
          lapPhase: lap.lapPhase || '',
          lapCondition: lap.lapCondition || lap.trackCondition || 'unknown',
          sector1Condition: lap.sector1Condition || lap.lapCondition || lap.trackCondition || 'unknown',
          sector2Condition: lap.sector2Condition || lap.lapCondition || lap.trackCondition || 'unknown',
          sector3Condition: lap.sector3Condition || lap.lapCondition || lap.trackCondition || 'unknown',
          sessionFlag: lap.sessionFlag || lap.lapFlag || '',
          classPosition: lap.classPosition || '',
          gapToOverallLeaderMs: numericGapMs(lap.gap),
          gapRaw: lap.gap || ''
        }))
      };
    })
  };
}

function main() {
  const input = path.resolve(argument('input', path.join(__dirname, '..', 'tests', 'SPA', 'RACE', 'lap_history.jsonl')));
  const carNumber = argument('car', '33');
  const overridesPath = path.resolve(argument('overrides', path.join(path.dirname(input), 'report_driver_overrides.json')));
  const output = path.resolve(argument('output', path.join(__dirname, '..', 'output', 'pdf')));
  const temp = path.resolve(argument('temp', path.join(__dirname, '..', 'tmp', 'pdfs')));
  fs.mkdirSync(output, { recursive: true });
  fs.mkdirSync(temp, { recursive: true });
  const payloadPath = path.join(temp, `spa-stints-car-${carNumber}.json`);
  const rawHistory = readJsonLines(input);
  const history = applyDriverOverrides(rawHistory, loadOverrides(overridesPath));
  fs.writeFileSync(payloadPath, JSON.stringify(buildPayload(history, carNumber, rawHistory), null, 2));

  // The CLI and the Electron app intentionally share one renderer. Keeping the
  // canonical layout under src prevents manual and automatic PDFs from drifting.
  const renderer = path.join(__dirname, '..', 'src', 'main', 'reports', 'render-stint-report.py');
  const python = findPdfPython();
  if (!python) {
    throw new Error(
      'No Python interpreter with ReportLab was found. Install it with "python3 -m pip install reportlab pypdf" '
      + 'or set PDF_PYTHON to a Python executable that already contains ReportLab.'
    );
  }
  const result = spawnSync(python, [renderer, '--input', payloadPath, '--output', output], { stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`PDF renderer exited with status ${result.status}`);
  console.log(`Stint reports written to ${output}`);
}

if (require.main === module) main();

module.exports = {
  numericGapMs,
  applyDriverOverrides,
  loadOverrides,
  stintGroups,
  elapsedMs,
  durationMs,
  pitStopsFromHistory,
  raceControlSummary,
  findPdfPython,
  buildPayload
};
