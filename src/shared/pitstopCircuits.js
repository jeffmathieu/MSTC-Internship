// Fixed circuit/pit-layout data used by the FCY pit-loss model.
//
// The pitstop duration entered on the dashboard is the complete measured time
// from pit entry to pit exit. During FCY, a non-pitting car still needs time to
// cover the regular track between those same points. The distance below lets
// the planner subtract that travel time from the entered pitstop duration.
(function initPitstopCircuits(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.pitstopCircuits = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function createPitstopCircuitsApi() {
  const PITSTOP_CIRCUITS = Object.freeze([
    Object.freeze({
      id: 'spa-full',
      label: 'Spa full (F1 entry, endurance exit)',
      regularTrackDistanceMeters: 1150,
      fcySpeedKph: 60
    }),
    Object.freeze({
      id: 'spa-f1',
      label: 'Spa F1 only',
      regularTrackDistanceMeters: 650,
      fcySpeedKph: 60
    }),
    Object.freeze({
      id: 'spa-endurance',
      label: 'Spa Endurance only',
      regularTrackDistanceMeters: 500,
      fcySpeedKph: 60
    }),
    Object.freeze({
      id: 'zolder',
      label: 'Zolder',
      regularTrackDistanceMeters: 950,
      fcySpeedKph: 60
    }),
    Object.freeze({
      id: 'assen',
      label: 'Assen',
      regularTrackDistanceMeters: 900,
      fcySpeedKph: 60
    })
  ]);

  function pitstopCircuitById(id) {
    return PITSTOP_CIRCUITS.find((circuit) => circuit.id === String(id || '')) || null;
  }

  function normalizePitstopCircuitId(id, fallback = 'zolder') {
    return pitstopCircuitById(id)?.id || pitstopCircuitById(fallback)?.id || PITSTOP_CIRCUITS[0].id;
  }

  return { PITSTOP_CIRCUITS, pitstopCircuitById, normalizePitstopCircuitId };
});
