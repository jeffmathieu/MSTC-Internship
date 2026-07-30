// Creates compact, stable driver labels for narrow dashboard columns.
//
// The normal label is the first three letters of the second name part:
// "Robbe Janssens" becomes "JAN". When drivers in the same car would receive
// the same label, first-name letters are added until every label is unique:
// "Robbe Janssens" and "Jeroen Jans" become "RJA" and "JJA".
(function initDriverLabels(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.driverLabels = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function createDriverLabelsApi() {
  function nameParts(name) {
    return String(name || '').trim().split(/\s+/).filter(Boolean);
  }

  function normalizedLetters(value) {
    return String(value || '').replace(/[^\p{L}\p{N}]/gu, '').toUpperCase();
  }

  function driverNameParts(name) {
    const parts = nameParts(name);
    const firstName = normalizedLetters(parts[0] || '');
    const surname = normalizedLetters(parts[1] || parts[0] || '');
    return { firstName, surname };
  }

  function baseDriverCode(name) {
    const { surname } = driverNameParts(name);
    return surname.slice(0, 3) || '—';
  }

  function uniqueDriverCodes(names = []) {
    const uniqueNames = [...new Set(names.map((name) => String(name || '').trim()).filter(Boolean))];
    const groups = new Map();
    uniqueNames.forEach((name) => {
      const base = baseDriverCode(name);
      if (!groups.has(base)) groups.set(base, []);
      groups.get(base).push(name);
    });

    const codes = {};
    groups.forEach((group, base) => {
      if (group.length === 1) {
        codes[group[0]] = base;
        return;
      }

      const unresolved = [...group];
      let firstNameLength = 1;
      while (unresolved.length && firstNameLength <= 12) {
        const candidates = new Map();
        unresolved.forEach((name) => {
          const { firstName, surname } = driverNameParts(name);
          const candidate = `${firstName.slice(0, firstNameLength)}${surname.slice(0, 2)}` || base;
          if (!candidates.has(candidate)) candidates.set(candidate, []);
          candidates.get(candidate).push(name);
        });
        candidates.forEach((candidateNames, candidate) => {
          if (candidateNames.length !== 1) return;
          const [name] = candidateNames;
          codes[name] = candidate;
          unresolved.splice(unresolved.indexOf(name), 1);
        });
        firstNameLength += 1;
      }

      unresolved.forEach((name, index) => {
        const { firstName, surname } = driverNameParts(name);
        codes[name] = `${firstName}${surname.slice(0, 2)}${index + 1}` || `${base}${index + 1}`;
      });
    });
    return codes;
  }

  return {
    baseDriverCode,
    uniqueDriverCodes
  };
});
