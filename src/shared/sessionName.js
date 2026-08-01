function cleanSessionName(value) {
  return String(value || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

// Connection messages describe the timing page transport, not the event. They
// may replace the page heading after a session finishes, so they must never
// overwrite the last confirmed session name used by storage and reports.
function isTransientSessionText(value) {
  const text = cleanSessionName(value);
  return !text || /not connected to (?:the )?livetiming|trying to reconnect|connecting to (?:the )?livetiming|waiting for (?:the )?livetiming data/i.test(text);
}

function isPlausibleSessionName(value) {
  const text = cleanSessionName(value);
  return Boolean(text)
    && !isTransientSessionText(text)
    && /\b(race|quali(?:fying|fication)?|practice|session|warm.?up)\b/i.test(text)
    && !/leader history|from lap|track limits|statistics|messages/i.test(text);
}

function preferStableSessionName(candidate, previous = '', fallback = '') {
  if (isPlausibleSessionName(candidate)) return cleanSessionName(candidate);
  if (isPlausibleSessionName(previous)) return cleanSessionName(previous);
  if (!isTransientSessionText(candidate)) return cleanSessionName(candidate);
  if (!isTransientSessionText(previous)) return cleanSessionName(previous);
  return cleanSessionName(fallback);
}

module.exports = {
  cleanSessionName,
  isTransientSessionText,
  isPlausibleSessionName,
  preferStableSessionName
};
