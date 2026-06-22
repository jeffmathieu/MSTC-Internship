// Norm-time prediction module.
//
// This file is written as a small UMD-style module so it can be used in two
// places without a build step:
// - in the browser renderer through window.normPrediction
// - in Node tests through require('../src/shared/normPrediction')
(function initNormPrediction(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.normPrediction = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function createNormPredictionApi() {
  // Norm-time prediction settings. These constants are deliberately grouped here
  // so the rule can be tuned later when the exact race regulation is clearer.
  const config = {
    // Use at most this many recent completed laps to learn the driver's sector
    // pattern. Lower values react faster; higher values are calmer.
    recentLaps: 12,
    // Prefer a driver-specific model once this many complete sector laps exist.
    minDriverLaps: 3,
    // Fallback to all followed-car laps once this many complete sector laps exist.
    minCarLaps: 3
  };

  function average(values) {
    const usable = values.filter((value) => Number.isFinite(value));
    if (!usable.length) return null;
    return usable.reduce((sum, value) => sum + value, 0) / usable.length;
  }

  function lapsForCar(history, carNumber) {
    return (history || [])
      .filter((entry) => String(entry.carNumber) === String(carNumber) && Number.isFinite(entry.lastLapMs))
      .sort((a, b) => (Number(a.lapNumber) - Number(b.lapNumber)) || (new Date(a.recordedAt) - new Date(b.recordedAt)));
  }

  // A lap can train the predictor only when the final lap time and all sector
  // times are present. Incomplete/current laps are intentionally excluded.
  function completeSectorLaps(history, carNumber, driver = null, options = config) {
    return lapsForCar(history, carNumber)
      .filter((lap) => !driver || lap.driver === driver)
      .filter((lap) => [lap.lastLapMs, lap.sector1Ms, lap.sector2Ms, lap.sector3Ms].every(Number.isFinite))
      .slice(-options.recentLaps);
  }

  // Builds remaining-sector expectations from completed laps. This is the main
  // function to change if the official rule later says prediction should use
  // best sectors, rolling median, class averages, or another model.
  function predictionProfileFromLaps(laps, source) {
    if (!laps.length) return null;
    return {
      source,
      sampleSize: laps.length,
      averageLapMs: average(laps.map((lap) => lap.lastLapMs)),
      remainingAfterS1Ms: average(laps.map((lap) => lap.sector2Ms + lap.sector3Ms)),
      remainingAfterS2Ms: average(laps.map((lap) => lap.sector3Ms))
    };
  }

  // Chooses the best available model for the current driver. Driver-specific
  // data is preferred because different drivers can have different sector
  // distributions. If that is not available yet, it falls back to all completed
  // laps for the followed car.
  function predictionProfileForRow(row, history, options = config) {
    if (!row || row.carNumber == null) return null;
    if (row.driver) {
      const driverLaps = completeSectorLaps(history, row.carNumber, row.driver, options);
      if (driverLaps.length >= options.minDriverLaps) {
        return predictionProfileFromLaps(driverLaps, `driver ${row.driver}`);
      }
    }

    const carLaps = completeSectorLaps(history, row.carNumber, null, options);
    if (carLaps.length >= options.minCarLaps) {
      return predictionProfileFromLaps(carLaps, 'car average');
    }

    return null;
  }

  // Predicts the current lap time from the latest visible sector data. Once S1
  // or S2 appears, the app estimates the final lap by adding the learned
  // remaining sectors from the selected profile.
  function predictCurrentLap(row, history, options = config) {
    const profile = predictionProfileForRow(row, history, options);
    if (!profile) return null;

    const s1 = row?.sector1Ms;
    const s2 = row?.sector2Ms;
    const s3 = row?.sector3Ms;
    if (Number.isFinite(s1) && Number.isFinite(s2) && Number.isFinite(s3)) {
      return { stage: 'S3', elapsedMs: s1 + s2 + s3, predictedMs: s1 + s2 + s3, profile };
    }
    if (Number.isFinite(s1) && Number.isFinite(s2)) {
      return { stage: 'S2', elapsedMs: s1 + s2, predictedMs: s1 + s2 + profile.remainingAfterS2Ms, profile };
    }
    if (Number.isFinite(s1)) {
      return { stage: 'S1', elapsedMs: s1, predictedMs: s1 + profile.remainingAfterS1Ms, profile };
    }

    return null;
  }

  return {
    config,
    completeSectorLaps,
    predictionProfileForRow,
    predictCurrentLap
  };
});
