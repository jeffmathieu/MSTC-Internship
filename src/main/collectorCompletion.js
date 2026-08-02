'use strict';

// Stops every live-collection component before report generation or a modal
// notification can block the main process. Each step is attempted even when a
// previous step fails, because stopping collection is more important than a
// window-close or renderer-notification error.
function haltCollectorForCompletion({
  clearPolling,
  closeLiveSource,
  markFinished,
  publishState
}) {
  const steps = [
    ['clearPolling', clearPolling],
    ['closeLiveSource', closeLiveSource],
    ['markFinished', markFinished],
    ['publishState', publishState]
  ];
  const errors = [];

  for (const [name, callback] of steps) {
    try {
      if (typeof callback !== 'function') throw new TypeError(`${name} must be a function`);
      callback();
    } catch (error) {
      errors.push({ name, error });
    }
  }

  return errors;
}

module.exports = { haltCollectorForCompletion };
