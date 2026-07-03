// Parser utilities shared by the Electron main process and tests. This file is
// intentionally dependency-free so timing formats and table headers can be
// validated without launching Electron.

// Normalizes text extracted from timing pages. Live timing HTML often contains
// non-breaking spaces and inconsistent whitespace, so all parser entry points
// should pass user/page text through this helper first.
function cleanText(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Converts provider-specific column labels into stable internal field names.
// Add aliases here when a timing provider uses a new header spelling for an
// existing concept, for example "START NO" for carNumber.
function canonicalHeader(header) {
  const h = cleanText(header).toUpperCase();
  if (h === '#') return 'carNumber';
  if (!h) return '';
  const compact = h.replace(/[^A-Z0-9]/g, '');

  // Direct aliases cover known compact header names from GetRaceResults and
  // similar motorsport timing tables.
  const direct = {
    POS: 'position',
    P: 'position',
    POSITION: 'position',
    STATE: 'state',
    NOW: 'state',
    M: 'movement',
    NR: 'carNumber',
    NUM: 'carNumber',
    NBR: 'carNumber',
    NO: 'carNumber',
    NUMBER: 'carNumber',
    STARTNUMBER: 'carNumber',
    STARTNR: 'carNumber',
    ETA: 'eta',
    TEAM: 'team',
    ENTRANT: 'team',
    TEAMNAME: 'team',
    TEAMINFO: 'team',
    CAR: 'car',
    CARMODEL: 'car',
    VEHICLE: 'car',
    DRIVERINCAR: 'driver',
    DRIVER: 'driver',
    DRIVERS: 'driver',
    DRIVERSONTRACK: 'driver',
    CURRENTDRIVER: 'driver',
    CLA: 'className',
    CLS: 'className',
    CLASS: 'className',
    CAT: 'className',
    CATEGORY: 'className',
    CATEGORIE: 'className',
    PIC: 'classPosition',
    POSINCLASS: 'classPosition',
    GAP: 'gap',
    DIFF: 'diff',
    INT: 'interval',
    INTERVAL: 'interval',
    LAST: 'lastLap',
    LASTTIME: 'lastLap',
    LASTLAP: 'lastLap',
    BEST: 'bestLap',
    BESTTIME: 'bestLap',
    BESTLAP: 'bestLap',
    IN: 'inValue',
    LAP: 'lapNumber',
    LAPS: 'lapNumber',
    PIT: 'pit',
    PITINFO: 'pit',
    LASTPIT: 'lastPit',
    LPIT: 'lastPit',
    PITSTOP: 'pit',
    PITSTOPS: 'pit',
    STINT: 'stint',
    NAT: 'nationality'
  };

  if (direct[compact]) return direct[compact];

  // RIS puts the session-best lap above BEST in the same header cell, e.g.
  // "2:50.798 | BEST", which compacts to 250798BEST.
  if (/^\d+BEST$/.test(compact)) return 'bestLap';

  // Sector headers vary a lot between providers, so these regexes accept common
  // spellings like SECT-1, SECTOR 1, SECT1, and S1.
  // RIS Timing places the session-best sector above the label in the same
  // header cell, producing text such as "43.575 | S1". After compaction this
  // becomes 43575S1, so accept a numeric prefix before the exact S1/S2/S3 tag.
  if (/^SECT?OR?1$/.test(compact) || compact === 'SECT1' || /^(?:\d+)?S1$/.test(compact)) return 'sector1';
  if (/^SECT?OR?2$/.test(compact) || compact === 'SECT2' || /^(?:\d+)?S2$/.test(compact)) return 'sector2';
  if (/^SECT?OR?3$/.test(compact) || compact === 'SECT3' || /^(?:\d+)?S3$/.test(compact)) return 'sector3';
  if (compact.includes('DRIVER') && compact.includes('CAR')) return 'driver';
  if (compact.includes('CLASS')) return 'className';
  return compact.toLowerCase();
}

// Builds a lookup from canonical field name to cell index. Duplicate headers are
// kept with suffixes, so raw/debug data can still show both NAT columns, etc.
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

// Parses integer-like table cells while treating placeholders as missing data.
function parseInteger(value) {
  const text = cleanText(value);
  if (!text || text === '?' || text === '--') return null;
  const match = text.match(/-?\d+/);
  return match ? Number(match[0]) : null;
}

// Parses race timing text into milliseconds. Supported forms include seconds
// ("102.112"), minutes/seconds ("1:42.112"), and compact engineer notation
// m:ss:mmm ("2:04:00"). Add new formats here when tests reveal provider drift.
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
    // Treat m:ss:mmm or m:ss:cc, e.g. 2:04:00, as 2:04.000 instead of
    // 2 hours 4 minutes. True hour-format
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

// Formats milliseconds back into a race timing string. Keep it aligned with
// parseLapTimeToMs() so parsed and displayed times round-trip consistently.
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

// Safely reads a cell by canonical field name and returns an empty string when
// the column is not available in the current provider table.
function valueAt(cells, headerMap, key) {
  const index = headerMap[key];
  return index === undefined ? '' : cleanText(cells[index]);
}

// RIS Timing puts team name on the first line of TEAM INFO and driver/car on
// the second line, for example "MSTC | JANSSENS Robbe - Mazda MX-5". The page
// extractor preserves that line boundary as " | ", allowing this parser to
// recover all three fields without guessing where the team name ends.
function splitTeamInfo(teamValue, driverValue = '', carValue = '') {
  const parts = String(teamValue ?? '')
    .split(/\s+\|\s+/)
    .map(cleanText)
    .filter(Boolean);
  if (parts.length < 2) {
    return { team: cleanText(teamValue), driver: cleanText(driverValue), car: cleanText(carValue) };
  }

  const team = parts[0];
  const details = parts.slice(1).join(' | ');
  const separator = details.match(/\s+-\s+/);
  if (!separator) {
    return { team, driver: cleanText(driverValue), car: cleanText(carValue) };
  }

  const separatorIndex = separator.index;
  return {
    team,
    driver: cleanText(driverValue) || cleanText(details.slice(0, separatorIndex)),
    car: cleanText(carValue) || cleanText(details.slice(separatorIndex + separator[0].length))
  };
}

// Converts one raw HTML table row into the normalized shape consumed by the app.
// If the UI needs a new column, add the canonical header above and map it here.
// Keep raw/headerMap in the result: parser_debug.json depends on that extra
// context when a timing provider changes its table layout.
function parseTimingRow(headers, cells) {
  const headerMap = buildHeaderMap(headers);
  // Preserve original header/cell data for parser debugging. This makes it
  // easier to inspect provider changes without losing the normalized fields.
  const raw = {};
  headers.forEach((header, index) => {
    const key = cleanText(header) || `column_${index}`;
    if (raw[key] === undefined) raw[key] = cleanText(cells[index]);
    else raw[`${key}_${index}`] = cleanText(cells[index]);
  });

  const carNumberRaw = valueAt(cells, headerMap, 'carNumber');
  const carNumber = parseInteger(carNumberRaw);
  const teamInfo = splitTeamInfo(
    valueAt(cells, headerMap, 'team'),
    valueAt(cells, headerMap, 'driver'),
    valueAt(cells, headerMap, 'car')
  );

  return {
    position: parseInteger(valueAt(cells, headerMap, 'position')),
    movement: valueAt(cells, headerMap, 'movement'),
    state: valueAt(cells, headerMap, 'state'),
    carNumber,
    carNumberRaw,
    eta: valueAt(cells, headerMap, 'eta'),
    team: teamInfo.team,
    car: teamInfo.car,
    driver: teamInfo.driver,
    className: valueAt(cells, headerMap, 'className'),
    classPosition: parseInteger(valueAt(cells, headerMap, 'classPosition')),
    gap: valueAt(cells, headerMap, 'gap'),
    diff: valueAt(cells, headerMap, 'diff'),
    interval: valueAt(cells, headerMap, 'interval'),
    lastLap: valueAt(cells, headerMap, 'lastLap'),
    bestLap: valueAt(cells, headerMap, 'bestLap'),
    inValue: valueAt(cells, headerMap, 'inValue'),
    lapNumber: parseInteger(valueAt(cells, headerMap, 'lapNumber')),
    sector1: valueAt(cells, headerMap, 'sector1'),
    sector2: valueAt(cells, headerMap, 'sector2'),
    sector3: valueAt(cells, headerMap, 'sector3'),
    pit: valueAt(cells, headerMap, 'pit'),
    lastPit: valueAt(cells, headerMap, 'lastPit'),
    stint: valueAt(cells, headerMap, 'stint'),
    lastLapMs: parseLapTimeToMs(valueAt(cells, headerMap, 'lastLap')),
    bestLapMs: parseLapTimeToMs(valueAt(cells, headerMap, 'bestLap')),
    sector1Ms: parseLapTimeToMs(valueAt(cells, headerMap, 'sector1')),
    sector2Ms: parseLapTimeToMs(valueAt(cells, headerMap, 'sector2')),
    sector3Ms: parseLapTimeToMs(valueAt(cells, headerMap, 'sector3')),
    raw,
    headerMap
  };
}

// Scores a table's headers to decide whether it is likely to be the live timing
// table. Tune the required fields if supporting a provider with fewer columns.
function looksLikeTimingHeaders(headers) {
  const map = buildHeaderMap(headers);
  const score = ['carNumber', 'team', 'driver', 'className', 'lastLap', 'bestLap'].filter((k) => map[k] !== undefined).length;
  return score >= 3 && map.carNumber !== undefined;
}

// Extracts provider-independent session metadata from the flattened page text.
// GetRaceResults labels the countdown "To go", while current RIS Timing pages
// use "Elapsed" and "Remaining" in their top status bar.
function parseSessionInfo(snapshot = {}) {
  const text = cleanText(snapshot.bodyText || '');
  const fields = snapshot.sessionFields || {};
  const session = {
    pageTitle: snapshot.title || '',
    url: snapshot.location || '',
    statusText: '',
    timeToGo: '',
    elapsed: '',
    flag: '',
    sessionName: '',
    circuit: '',
    pageUpdated: ''
  };

  if (fields.remaining) session.timeToGo = cleanText(fields.remaining);
  if (fields.elapsed) session.elapsed = cleanText(fields.elapsed);
  if (fields.sessionName) session.sessionName = cleanText(fields.sessionName);

  const risRemaining = text.match(/\bRemaining:\s*([0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?)/i);
  const risElapsed = text.match(/\bElapsed:\s*([0-9]{1,2}:[0-9]{2}(?::[0-9]{2})?)/i);
  const risStatus = text.match(/\bStatus:\s*([A-Z][A-Z ]*?)(?=\s+Elapsed:|\s+Remaining:|$)/i);
  if (!session.timeToGo && risRemaining) session.timeToGo = cleanText(risRemaining[1]);
  if (!session.elapsed && risElapsed) session.elapsed = cleanText(risElapsed[1]);
  const structuredOrParsedStatus = cleanText(fields.status || (risStatus ? risStatus[1] : ''));
  if (structuredOrParsedStatus) {
    session.statusText = structuredOrParsedStatus;
    const status = session.statusText.toLowerCase();
    if (status === 'green') session.flag = 'Green flag';
    else if (/fcy|full course yellow/.test(status)) session.flag = 'Full course yellow';
    else if (/safety car/.test(status)) session.flag = 'Safety car';
    else if (/yellow/.test(status)) session.flag = 'Yellow flag';
    else if (/red/.test(status)) session.flag = 'Red flag';
  }

  // RIS displays event and session as "Ligier Js Cup • Paying Practice".
  // Flattening the page prepends navigation labels, which are removed before
  // exposing this value to the dashboard.
  const risSession = text.match(/(.{1,180}?)\s*[•·]\s*([^•·]{1,80}?)\s+Status:/i);
  if (!session.sessionName && risSession) {
    const eventName = cleanText(risSession[1])
      .replace(/^.*RACES INFORMATION SERVICES\s+/i, '')
      .replace(/^(?:(?:LIVE DATA|OFFLINE|COMPACT|FULLSCREEN)\s+)+/i, '');
    const sessionType = cleanText(risSession[2]);
    if (eventName && sessionType) session.sessionName = `${eventName} - ${sessionType}`;
  }

  const toGo = text.match(/To go:\s*([^A-Z\n\r]+?)\s+([A-Z][A-Za-z0-9 .:&'()\-]+?\s-\s(?:Race|Qualifying|Practice|Session|Warm.?up))/i);
  if (toGo) {
    if (!session.timeToGo) session.timeToGo = cleanText(toGo[1]);
    session.sessionName = cleanText(toGo[2]);
  } else if (!session.timeToGo) {
    const simpleToGo = text.match(/To go:\s*([^\n\r]+)/i);
    if (simpleToGo) session.timeToGo = cleanText(simpleToGo[1]).split(/\s{2,}/)[0];
  }

  const flagMatch = text.match(/(Green flag|Red flag|Yellow flag|Safety car|Full course yellow|Code 60|Finished flag)/i);
  if (flagMatch) {
    const flag = cleanText(flagMatch[1]).toLowerCase();
    const canonicalFlags = {
      'green flag': 'Green flag',
      'red flag': 'Red flag',
      'yellow flag': 'Yellow flag',
      'safety car': 'Safety car',
      'full course yellow': 'Full course yellow',
      'code 60': 'Code 60',
      'finished flag': 'Finished flag'
    };
    session.flag = canonicalFlags[flag] || cleanText(flagMatch[1]);
  }

  const commonStatus = ['No active heat', 'Waiting for the LiveTiming data', 'Not connected to the LiveTiming server', 'Trying to reconnect to the LiveTiming server', 'Connecting to the LiveTiming server'];
  const foundStatus = commonStatus.find((line) => text.includes(line));
  if (foundStatus) session.statusText = foundStatus;

  if (!session.sessionName) {
    const sessionMatch = text.match(/([A-Z][A-Za-z0-9 .:&'()\-]+?\s-\s(?:Race|Qualifying|Practice|Session|Warm.?up))/i);
    if (sessionMatch) session.sessionName = cleanText(sessionMatch[1]);
  }

  const updated = text.match(/Page updated\s*([0-9:]+\s*\(UTC\))?/i);
  if (updated) session.pageUpdated = cleanText(updated[1] || '');
  return session;
}

// Export each parser primitive separately so tests can cover small pieces and
// the main process can compose them into higher-level collection logic.
module.exports = {
  cleanText,
  canonicalHeader,
  buildHeaderMap,
  parseInteger,
  parseLapTimeToMs,
  formatMs,
  splitTeamInfo,
  parseTimingRow,
  looksLikeTimingHeaders,
  parseSessionInfo
};
