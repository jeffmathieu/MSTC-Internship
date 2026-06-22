function cleanText(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function canonicalHeader(header) {
  const h = cleanText(header).toUpperCase();
  if (!h) return '';
  const compact = h.replace(/[^A-Z0-9]/g, '');

  const direct = {
    POS: 'position',
    POSITION: 'position',
    M: 'movement',
    NR: 'carNumber',
    NBR: 'carNumber',
    NO: 'carNumber',
    NUMBER: 'carNumber',
    STARTNUMBER: 'carNumber',
    STARTNR: 'carNumber',
    ETA: 'eta',
    TEAM: 'team',
    ENTRANT: 'team',
    CAR: 'car',
    VEHICLE: 'car',
    DRIVERINCAR: 'driver',
    DRIVER: 'driver',
    CURRENTDRIVER: 'driver',
    CLS: 'className',
    CLASS: 'className',
    PIC: 'classPosition',
    POSINCLASS: 'classPosition',
    GAP: 'gap',
    DIFF: 'diff',
    LAST: 'lastLap',
    LASTLAP: 'lastLap',
    BEST: 'bestLap',
    BESTLAP: 'bestLap',
    IN: 'inValue',
    LAP: 'lapNumber',
    LAPS: 'lapNumber',
    PIT: 'pit',
    PITSTOP: 'pit',
    PITSTOPS: 'pit',
    NAT: 'nationality'
  };

  if (direct[compact]) return direct[compact];
  if (/^SECT?OR?1$/.test(compact) || compact === 'SECT1' || compact === 'S1') return 'sector1';
  if (/^SECT?OR?2$/.test(compact) || compact === 'SECT2' || compact === 'S2') return 'sector2';
  if (/^SECT?OR?3$/.test(compact) || compact === 'SECT3' || compact === 'S3') return 'sector3';
  if (compact.includes('DRIVER') && compact.includes('CAR')) return 'driver';
  if (compact.includes('CLASS')) return 'className';
  return compact.toLowerCase();
}

function buildHeaderMap(headers) {
  const map = {};
  const seen = {};
  headers.forEach((header, index) => {
    const canonical = canonicalHeader(header);
    if (!canonical) return;
    if (map[canonical] === undefined) {
      map[canonical] = index;
    } else {
      seen[canonical] = (seen[canonical] || 1) + 1;
      map[`${canonical}_${seen[canonical]}`] = index;
    }
  });
  return map;
}

function parseInteger(value) {
  const text = cleanText(value);
  if (!text || text === '?' || text === '--') return null;
  const match = text.match(/-?\d+/);
  return match ? Number(match[0]) : null;
}

function parseLapTimeToMs(value) {
  const text = cleanText(value);
  if (!text) return null;
  if (/^(--|\?|IN PIT|OUT LAP|PIT OUT|PIT IN)$/i.test(text)) return null;
  const pure = text.replace(',', '.');
  if (!/\d/.test(pure)) return null;

  const parts = pure.split(':');
  let seconds = null;
  if (parts.length === 1) {
    const n = Number(parts[0]);
    if (Number.isFinite(n)) seconds = n;
  } else if (parts.length === 2) {
    const min = Number(parts[0]);
    const sec = Number(parts[1]);
    if (Number.isFinite(min) && Number.isFinite(sec)) seconds = min * 60 + sec;
  } else if (parts.length === 3) {
    // Most race engineers type norm times as m:ss:mmm or m:ss:cc, e.g. 2:04:00.
    // Treat that as 2:04.000 instead of 2 hours 4 minutes. True hour-format
    // still works when the first part is >= 10 or the third part contains decimals.
    const first = Number(parts[0]);
    const middle = Number(parts[1]);
    const last = parts[2];
    if (Number.isFinite(first) && Number.isFinite(middle)) {
      if (!last.includes('.') && first < 10 && middle < 60) {
        const milli = Number(String(last).padEnd(3, '0').slice(0, 3));
        if (Number.isFinite(milli)) seconds = first * 60 + middle + milli / 1000;
      } else {
        const sec = Number(last);
        if (Number.isFinite(sec)) seconds = first * 3600 + middle * 60 + sec;
      }
    }
  }

  if (seconds === null) return null;
  return Math.round(seconds * 1000);
}

function formatMs(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '';
  const sign = ms < 0 ? '-' : '';
  let remaining = Math.abs(ms);
  const hours = Math.floor(remaining / 3600000);
  remaining %= 3600000;
  const minutes = Math.floor(remaining / 60000);
  remaining %= 60000;
  const seconds = Math.floor(remaining / 1000);
  const milli = remaining % 1000;
  if (hours > 0) {
    return `${sign}${hours}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(milli).padStart(3, '0')}`;
  }
  return `${sign}${minutes}:${String(seconds).padStart(2, '0')}.${String(milli).padStart(3, '0')}`;
}

function valueAt(cells, headerMap, key) {
  const index = headerMap[key];
  return index === undefined ? '' : cleanText(cells[index]);
}

function parseTimingRow(headers, cells) {
  const headerMap = buildHeaderMap(headers);
  const raw = {};
  headers.forEach((header, index) => {
    const key = cleanText(header) || `column_${index}`;
    if (raw[key] === undefined) raw[key] = cleanText(cells[index]);
    else raw[`${key}_${index}`] = cleanText(cells[index]);
  });

  const carNumberRaw = valueAt(cells, headerMap, 'carNumber');
  const carNumber = parseInteger(carNumberRaw);

  return {
    position: parseInteger(valueAt(cells, headerMap, 'position')),
    movement: valueAt(cells, headerMap, 'movement'),
    carNumber,
    carNumberRaw,
    eta: valueAt(cells, headerMap, 'eta'),
    team: valueAt(cells, headerMap, 'team'),
    car: valueAt(cells, headerMap, 'car'),
    driver: valueAt(cells, headerMap, 'driver'),
    className: valueAt(cells, headerMap, 'className'),
    classPosition: parseInteger(valueAt(cells, headerMap, 'classPosition')),
    gap: valueAt(cells, headerMap, 'gap'),
    diff: valueAt(cells, headerMap, 'diff'),
    lastLap: valueAt(cells, headerMap, 'lastLap'),
    bestLap: valueAt(cells, headerMap, 'bestLap'),
    inValue: valueAt(cells, headerMap, 'inValue'),
    lapNumber: parseInteger(valueAt(cells, headerMap, 'lapNumber')) ?? parseInteger(valueAt(cells, headerMap, 'inValue')),
    sector1: valueAt(cells, headerMap, 'sector1'),
    sector2: valueAt(cells, headerMap, 'sector2'),
    sector3: valueAt(cells, headerMap, 'sector3'),
    pit: valueAt(cells, headerMap, 'pit'),
    lastLapMs: parseLapTimeToMs(valueAt(cells, headerMap, 'lastLap')),
    bestLapMs: parseLapTimeToMs(valueAt(cells, headerMap, 'bestLap')),
    sector1Ms: parseLapTimeToMs(valueAt(cells, headerMap, 'sector1')),
    sector2Ms: parseLapTimeToMs(valueAt(cells, headerMap, 'sector2')),
    sector3Ms: parseLapTimeToMs(valueAt(cells, headerMap, 'sector3')),
    raw,
    headerMap
  };
}

function looksLikeTimingHeaders(headers) {
  const map = buildHeaderMap(headers);
  const score = ['carNumber', 'team', 'driver', 'className', 'lastLap', 'bestLap'].filter((k) => map[k] !== undefined).length;
  return score >= 3 && map.carNumber !== undefined;
}

module.exports = {
  cleanText,
  canonicalHeader,
  buildHeaderMap,
  parseInteger,
  parseLapTimeToMs,
  formatMs,
  parseTimingRow,
  looksLikeTimingHeaders
};
