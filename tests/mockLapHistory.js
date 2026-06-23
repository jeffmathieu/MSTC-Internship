function lap({ carNumber, className = 'LMP3', teamName, driverName, lapNumber, lapTimeMs, sector1Ms, sector2Ms, sector3Ms, ...extra }) {
  return {
    collectedAt: `2026-06-23T12:${String(lapNumber).padStart(2, '0')}:00.000Z`,
    sourceProvider: 'getraceresults',
    timingUrl: 'https://livetiming.getraceresults.com/demo#screen-results',
    sessionName: 'Analytics Test Race',
    carNumber: String(carNumber),
    className,
    teamName,
    driverName,
    lapNumber: String(lapNumber),
    lastLap: `${(lapTimeMs / 1000).toFixed(3)}`,
    sector1: `${(sector1Ms / 1000).toFixed(3)}`,
    sector2: `${(sector2Ms / 1000).toFixed(3)}`,
    sector3: `${(sector3Ms / 1000).toFixed(3)}`,
    lapTimeMs: String(lapTimeMs),
    sector1Ms: String(sector1Ms),
    sector2Ms: String(sector2Ms),
    sector3Ms: String(sector3Ms),
    bestLapMs: String(lapTimeMs),
    raw: {},
    ...extra
  };
}

function tenLapHistory() {
  const lapTimes = [100000, 99000, 101000, 98000, 102000, 97000, 103000, 96000, 104000, 95000];
  return lapTimes.map((lapTimeMs, index) => {
    const lapNumber = index + 1;
    return lap({
      carNumber: 33,
      teamName: 'Our Team',
      driverName: 'Average Tester',
      lapNumber,
      lapTimeMs,
      sector1Ms: 30000 + index * 100,
      sector2Ms: 40000 - index * 100,
      sector3Ms: lapTimeMs - (30000 + index * 100) - (40000 - index * 100)
    });
  });
}

function stintComparisonHistory() {
  const rows = [];
  const addRange = ({ carNumber, teamName, driverName, startLap, count, baseLapMs, sector1Ms, sector2Ms, sector3Ms }) => {
    for (let i = 0; i < count; i += 1) {
      rows.push(lap({
        carNumber,
        teamName,
        driverName,
        lapNumber: startLap + i,
        lapTimeMs: baseLapMs + i * 10,
        sector1Ms,
        sector2Ms,
        sector3Ms: sector3Ms + i * 10
      }));
    }
  };

  addRange({ carNumber: 33, teamName: 'Our Team', driverName: 'Driver 1', startLap: 1, count: 20, baseLapMs: 100000, sector1Ms: 30000, sector2Ms: 40000, sector3Ms: 30000 });
  addRange({ carNumber: 33, teamName: 'Our Team', driverName: 'Driver 2', startLap: 21, count: 20, baseLapMs: 101000, sector1Ms: 30300, sector2Ms: 40200, sector3Ms: 30500 });
  addRange({ carNumber: 33, teamName: 'Our Team', driverName: 'Driver 3', startLap: 41, count: 10, baseLapMs: 102000, sector1Ms: 30600, sector2Ms: 40500, sector3Ms: 30900 });

  addRange({ carNumber: 2, teamName: 'Best Class Car', driverName: 'Class Pro', startLap: 1, count: 20, baseLapMs: 99000, sector1Ms: 29600, sector2Ms: 39600, sector3Ms: 29800 });
  addRange({ carNumber: 9, teamName: 'Selected Rival', driverName: 'Rival Driver', startLap: 1, count: 20, baseLapMs: 100500, sector1Ms: 30100, sector2Ms: 40100, sector3Ms: 30300 });

  return rows;
}

module.exports = {
  lap,
  tenLapHistory,
  stintComparisonHistory
};
