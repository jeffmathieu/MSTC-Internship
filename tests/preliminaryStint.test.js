const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createReportQueue } = require('../src/main/reportQueue');
const { lap } = require('./mockLapHistory');

// One driver, three pit stops inside a single (still running) stint: the stint
// has no driver change, so only a preliminary report can exist until it ends.
module.exports = (async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mstc-preliminary-'));
  try {
    fs.mkdirSync(path.join(folder, 'data'));
    const pitLaps = [10, 22, 34];
    const rows = Array.from({ length: 36 }, (_, i) => {
      const n = i + 1;
      const pit = pitLaps.includes(n);
      return lap({ carNumber: 27, className: 'Cup', teamName: 'Team', driverName: 'Solo Driver', lapNumber: n,
        lapTimeMs: 92000 + (n % 7) * 350 + (pit ? 60000 : 0), sector1Ms: 30000, sector2Ms: 35000, sector3Ms: 27000,
        lapPhase: pit ? 'inlap' : pitLaps.includes(n - 1) ? 'outlap' : '', isPitLap: pit || pitLaps.includes(n - 1) });
    });
    fs.writeFileSync(path.join(folder, 'data', 'lap_history.jsonl'), `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`);

    const at = (minute, second = 0) => `2026-06-23T12:${String(minute).padStart(2, '0')}:${String(second).padStart(2, '0')}.000Z`;
    const event = (i, minute, lapNumber, closed = true) => ({ id: `27|s${i}`, carNumber: '27', stopNumber: null, entryAt: at(minute, 30),
      exitAt: closed ? at(minute + 1, 40) : null, lapNumber, driverBefore: 'Solo Driver', driverAfter: closed ? 'Solo Driver' : '',
      durationMs: closed ? 70000 : null, totalDurationMs: closed ? 70000 : null, closed });
    const pitEvents = [event(1, 10, 10), event(2, 22, 22), event(3, 34, 34, false)];
    const pitNotes = {
      '27|s1': { fuelAdded: true, tyresChanged: true, tyreSet: 'Set 2', driverNotes: 'Understeer on entry', pitNotes: 'Slow wheel nut' },
      '27|s2': { fuelAdded: true, tyresChanged: false, tyreSet: 'Set 2', driverNotes: 'Balance better', pitNotes: 'Clean stop' },
      '27|s3': { fuelAdded: false, tyresChanged: false, tyreSet: '', driverNotes: 'Pushing hard', pitNotes: '' }
    };

    const printed = [];
    const queue = createReportQueue(async (html, pdfPath) => { printed.push({ html, name: path.basename(pdfPath) }); fs.writeFileSync(pdfPath, '%PDF stub'); });
    const input = { sessionFolder: folder, carNumber: '27', session: { sessionName: 'Free Practice 2' }, pdfEngine: 'electron', sessionMode: 'practice',
      pitEvents, pitNotes, referenceTimes: {}, pitRules: {}, stintNumber: 1 };

    // 1. Running stint: preliminary PDF with all three stops and their notes.
    const live = await queue.enqueue('live', { ...input, preliminary: true, stintOptions: { generatedAt: at(40), closeFinalAt: null } });
    assert.strictEqual(live.results.length, 1);
    const pdf = path.join(folder, 'stints', 'car-27', 'STINT_1_Solo_Driver', 'STINT_1_Solo_Driver.pdf');
    assert.ok(fs.existsSync(pdf), 'a preliminary stint PDF is written while the stint is running');
    const preliminary = printed.at(-1).html;
    assert.ok(preliminary.includes('PRELIMINARY: stint in progress'));
    ['Stop 1', 'Stop 2', 'Stop 3', 'Slow wheel nut', 'Pushing hard'].forEach((text) => assert.ok(preliminary.includes(text), `${text} is in the preliminary PDF`));

    // 2. Same data and notes: the report is not rebuilt.
    const before = printed.length;
    const again = await queue.enqueue('live-again', { ...input, preliminary: true, stintOptions: { generatedAt: at(40), closeFinalAt: null } });
    assert.strictEqual(again.results[0].written, false, 'unchanged data keeps the existing preliminary PDF');
    assert.strictEqual(printed.length, before);

    // 3. Editing a note rebuilds it.
    const edited = await queue.enqueue('live-edit', { ...input, preliminary: true, pitNotes: { ...pitNotes, '27|s3': { ...pitNotes['27|s3'], pitNotes: 'Wheel gun jammed' } },
      stintOptions: { generatedAt: at(42), closeFinalAt: null } });
    assert.strictEqual(edited.results[0].written, true);
    assert.ok(printed.at(-1).html.includes('Wheel gun jammed'));

    // 4. The driver leaves (stint closes): the final report replaces the preliminary one.
    const final = await queue.enqueue('final', { ...input, pitNotes, stintOptions: { generatedAt: at(50), closeFinalAt: at(45) } });
    assert.strictEqual(final.results[0].written, true);
    assert.ok(!printed.at(-1).html.includes('PRELIMINARY'), 'the final report is no longer marked preliminary');
    assert.ok(printed.at(-1).html.includes('Stop 3'));
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
  console.log('Preliminary stint report tests passed.');
})();
