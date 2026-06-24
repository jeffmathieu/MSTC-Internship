const path = require('path');
const fs = require('fs');

const DATA_PATH = path.join(__dirname, 'assen-club-challenge-data.json');
const DEFAULT_PORT = 5177;
const DEFAULT_LAP_SECONDS = 20;
const SECTOR_SPLITS = [0.34, 0.37, 0.29];

function parseArgs(argv = process.argv.slice(2)) {
  const config = { port: DEFAULT_PORT, lapSeconds: DEFAULT_LAP_SECONDS, paused: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === '--port' && next) {
      config.port = Number(next);
      i += 1;
    } else if (arg === '--lap-seconds' && next) {
      config.lapSeconds = Number(next);
      i += 1;
    } else if (arg === '--paused') {
      config.paused = true;
    }
  }
  if (!Number.isFinite(config.port) || config.port <= 0) config.port = DEFAULT_PORT;
  if (!Number.isFinite(config.lapSeconds) || config.lapSeconds <= 0) config.lapSeconds = DEFAULT_LAP_SECONDS;
  return config;
}

function parseRaceTimeToMs(value) {
  const text = String(value || '').trim().replace(',', '.');
  const parts = text.split(':');
  if (parts.length === 2) return Math.round((Number(parts[0]) * 60 + Number(parts[1])) * 1000);
  if (parts.length === 3) return Math.round((Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2])) * 1000);
  const seconds = Number(text);
  return Number.isFinite(seconds) ? Math.round(seconds * 1000) : null;
}

function formatMs(ms) {
  if (!Number.isFinite(ms)) return '';
  const sign = ms < 0 ? '-' : '';
  let remaining = Math.abs(Math.round(ms));
  const hours = Math.floor(remaining / 3600000);
  remaining %= 3600000;
  const minutes = Math.floor(remaining / 60000);
  remaining %= 60000;
  const seconds = Math.floor(remaining / 1000);
  const milli = remaining % 1000;
  if (hours > 0) return `${sign}${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milli).padStart(3, '0')}`;
  return `${sign}${minutes}:${String(seconds).padStart(2, '0')}.${String(milli).padStart(3, '0')}`;
}

function formatGapMs(ms) {
  if (!Number.isFinite(ms)) return '';
  if (Math.abs(ms) >= 60000) return formatMs(ms);
  return (ms / 1000).toFixed(3);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function loadRaceData(filePath = DATA_PATH) {
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const cars = raw.cars.map((car) => {
    const lapTimeMs = car.lapTimes.map(parseRaceTimeToMs);
    const cumulativeMs = [];
    lapTimeMs.reduce((sum, lapMs) => {
      const total = sum + lapMs;
      cumulativeMs.push(total);
      return total;
    }, 0);
    return { ...car, lapTimeMs, cumulativeMs };
  });
  return { ...raw, cars };
}

function bestLapFor(car, completedLaps) {
  const laps = car.lapTimeMs.slice(0, completedLaps).filter(Number.isFinite);
  return laps.length ? Math.min(...laps) : null;
}

function driverForLap(car, completedLaps) {
  const names = car.driverNames && car.driverNames.length ? car.driverNames : ['Unknown'];
  const lapBlockSize = Math.ceil(car.lapTimeMs.length / names.length);
  const index = Math.min(names.length - 1, Math.floor((Math.max(1, completedLaps) - 1) / lapBlockSize));
  return names[index];
}

function sectorTimeForCurrentLap(car, completedLaps, sectorIndex) {
  const lapMs = car.lapTimeMs[completedLaps];
  if (!Number.isFinite(lapMs)) return '';
  return formatMs(lapMs * SECTOR_SPLITS[sectorIndex]);
}

function completedLapsAt(car, raceMs, initialGridGapSeconds) {
  const startOffsetMs = (car.gridPosition - 1) * initialGridGapSeconds * 1000;
  let completed = 0;
  while (completed < car.cumulativeMs.length && startOffsetMs + car.cumulativeMs[completed] <= raceMs) completed += 1;
  return { completed, startOffsetMs, totalAtLineMs: startOffsetMs + (completed ? car.cumulativeMs[completed - 1] : 0) };
}

function buildRowsAtRaceTime(data, raceMs) {
  const initialGridGapSeconds = data.source.initialGridGapSeconds || 0.5;
  const rows = data.cars.map((car) => {
    const progress = completedLapsAt(car, raceMs, initialGridGapSeconds);
    const currentLapStartMs = progress.startOffsetMs + (progress.completed ? car.cumulativeMs[progress.completed - 1] : 0);
    const currentLapMs = car.lapTimeMs[progress.completed];
    const currentLapElapsedMs = raceMs - currentLapStartMs;
    const s1Limit = currentLapMs * SECTOR_SPLITS[0];
    const s2Limit = currentLapMs * (SECTOR_SPLITS[0] + SECTOR_SPLITS[1]);
    return {
      car,
      completedLaps: progress.completed,
      totalAtLineMs: progress.totalAtLineMs,
      isFinished: progress.completed >= car.lapTimeMs.length,
      lastLapMs: progress.completed ? car.lapTimeMs[progress.completed - 1] : null,
      bestLapMs: bestLapFor(car, progress.completed),
      sector1: Number.isFinite(currentLapMs) && currentLapElapsedMs >= s1Limit ? sectorTimeForCurrentLap(car, progress.completed, 0) : '',
      sector2: Number.isFinite(currentLapMs) && currentLapElapsedMs >= s2Limit ? sectorTimeForCurrentLap(car, progress.completed, 1) : '',
      sector3: '',
      driverName: driverForLap(car, progress.completed || 1)
    };
  });

  rows.sort((a, b) => {
    if (b.completedLaps !== a.completedLaps) return b.completedLaps - a.completedLaps;
    return a.totalAtLineMs - b.totalAtLineMs;
  });

  rows.forEach((row, index) => {
    const leader = rows[0];
    const previous = rows[index - 1];
    row.position = index + 1;
    row.classPosition = index + 1;
    row.gap = index === 0 ? '' : formatRelativeGap(row, leader);
    row.diff = index === 0 ? '' : formatRelativeGap(row, previous);
  });
  return rows;
}

function formatRelativeGap(row, reference) {
  const lapDelta = reference.completedLaps - row.completedLaps;
  if (lapDelta > 0) return `-- ${lapDelta} lap${lapDelta === 1 ? '' : 's'} --`;
  if (lapDelta < 0) return '';
  return formatGapMs(row.totalAtLineMs - reference.totalAtLineMs);
}

function averageOurLapMs(data) {
  const ourCar = data.cars.find((car) => car.carNumber === data.source.ourCarNumber) || data.cars[0];
  const total = ourCar.lapTimeMs.reduce((sum, lapMs) => sum + lapMs, 0);
  return total / ourCar.lapTimeMs.length;
}

function raceDurationMs(data) {
  const initialGridGapSeconds = data.source.initialGridGapSeconds || 0.5;
  return Math.max(...data.cars.map((car) => (car.gridPosition - 1) * initialGridGapSeconds * 1000 + car.cumulativeMs.at(-1)));
}

function createSimulator(data, options = {}) {
  const state = {
    lapSeconds: options.lapSeconds || DEFAULT_LAP_SECONDS,
    paused: Boolean(options.paused),
    pausedRaceMs: 0,
    startedAtMs: Date.now()
  };

  const durationMs = raceDurationMs(data);
  const getScale = () => averageOurLapMs(data) / (state.lapSeconds * 1000);
  const currentRaceMs = () => {
    if (state.paused) return state.pausedRaceMs;
    return Math.min(durationMs, state.pausedRaceMs + (Date.now() - state.startedAtMs) * getScale());
  };
  const setPaused = (paused) => {
    state.pausedRaceMs = currentRaceMs();
    state.startedAtMs = Date.now();
    state.paused = paused;
  };
  return {
    state,
    durationMs,
    currentRaceMs,
    setPaused,
    reset() {
      state.pausedRaceMs = 0;
      state.startedAtMs = Date.now();
    },
    setLapSeconds(value) {
      const next = Number(value);
      if (!Number.isFinite(next) || next <= 0) return;
      state.pausedRaceMs = currentRaceMs();
      state.startedAtMs = Date.now();
      state.lapSeconds = next;
    },
    snapshot() {
      const raceMs = currentRaceMs();
      return {
        raceMs,
        durationMs,
        lapSeconds: state.lapSeconds,
        paused: state.paused,
        rows: buildRowsAtRaceTime(data, raceMs)
      };
    }
  };
}

function renderPage(data, simulator) {
  const snapshot = simulator.snapshot();
  const timeLeftMs = Math.max(0, snapshot.durationMs - snapshot.raceMs);
  const rows = snapshot.rows;
  const tableRows = rows.map((row) => `
      <tr class="${row.car.carNumber === data.source.ourCarNumber ? 'ours' : ''}">
        <td>${row.position}</td>
        <td>${row.isFinished ? 'Finish' : 'Run'}</td>
        <td>${escapeHtml(row.car.carNumber)}</td>
        <td>${escapeHtml(row.car.teamName)}</td>
        <td>${escapeHtml(row.car.carModel)}</td>
        <td>${escapeHtml(row.driverName)}</td>
        <td>${escapeHtml(row.car.className)}</td>
        <td>${row.classPosition}</td>
        <td>${escapeHtml(row.gap)}</td>
        <td>${escapeHtml(row.diff)}</td>
        <td>${formatMs(row.lastLapMs)}</td>
        <td>${formatMs(row.bestLapMs)}</td>
        <td>${row.completedLaps}</td>
        <td>${row.sector1}</td>
        <td>${row.sector2}</td>
        <td>${row.sector3}</td>
        <td></td>
      </tr>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GetRaceResults Live Timing Demo - Assen Club Challenge</title>
  <style>
    body { margin: 0; padding: 24px; background: #101318; color: #e8edf7; font-family: Arial, sans-serif; }
    header { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; margin-bottom: 18px; }
    h1 { margin: 0 0 6px; font-size: 24px; }
    p { margin: 4px 0; color: #aeb8c8; }
    form { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; justify-content: flex-end; }
    input { width: 72px; padding: 8px; border: 1px solid #48546a; border-radius: 4px; background: #080b12; color: #fff; }
    button, a.button { padding: 8px 12px; border: 1px solid #48546a; border-radius: 4px; background: #1b2330; color: #fff; text-decoration: none; cursor: pointer; }
    table { width: 100%; border-collapse: collapse; background: #171c25; }
    th, td { padding: 8px 10px; border-bottom: 1px solid #2a3342; text-align: left; white-space: nowrap; }
    th { background: #242c38; color: #cbd5e1; font-size: 12px; letter-spacing: .06em; text-transform: uppercase; }
    tr.ours { background: #203b67; }
    .meta { font-size: 13px; }
  </style>
  <script>setTimeout(() => window.location.reload(), 1000);</script>
</head>
<body>
  <header>
    <section>
      <h1>Belcar Endurance Championship - Race</h1>
      <p>To go: ${escapeHtml(formatMs(timeLeftMs))} Belcar Endurance Championship - Race</p>
      <p>Green flag · Page updated ${new Date().toISOString().slice(11, 19)} (UTC) · Club Challenge only</p>
      <p class="meta">Race time ${escapeHtml(formatMs(snapshot.raceMs))} / ${escapeHtml(formatMs(snapshot.durationMs))} · simulated lap speed ${escapeHtml(snapshot.lapSeconds)}s · our car ${escapeHtml(data.source.ourCarNumber)}</p>
    </section>
    <form action="/control" method="get">
      <label>Lap seconds <input name="lapSeconds" value="${escapeHtml(snapshot.lapSeconds)}"></label>
      <button name="op" value="speed">Apply speed</button>
      <button name="op" value="${snapshot.paused ? 'play' : 'pause'}">${snapshot.paused ? 'Play' : 'Pause'}</button>
      <button name="op" value="reset">Reset</button>
      <a class="button" href="/state.json">JSON</a>
    </form>
  </header>
  <table>
    <thead>
      <tr>
        <th>POS</th><th>STATE</th><th>NR</th><th>TEAM</th><th>CAR</th><th>DRIVER IN CAR</th><th>CLS</th><th>PIC</th><th>GAP</th><th>DIFF</th><th>LAST</th><th>BEST</th><th>LAPS</th><th>SECT-1</th><th>SECT-2</th><th>SECT-3</th><th>PIT</th>
      </tr>
    </thead>
    <tbody>${tableRows}</tbody>
  </table>
</body>
</html>`;
}

module.exports = {
  DEFAULT_PORT,
  DEFAULT_LAP_SECONDS,
  parseArgs,
  parseRaceTimeToMs,
  formatMs,
  loadRaceData,
  buildRowsAtRaceTime,
  createSimulator,
  renderPage
};
