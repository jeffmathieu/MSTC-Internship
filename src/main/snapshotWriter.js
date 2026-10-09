const fs = require('fs');

// Serial per destination, coalesced between polls, atomic on disk. Critical
// append-only lap/event logs are persisted separately before publication.
function createSnapshotWriter(onError = () => {}) {
  const pending = new Map();
  const running = new Map();
  const latest = new Map();
  function write(file, contents) {
    latest.set(file, contents);
    pending.set(file, contents);
    if (running.has(file)) return;
    const job = (async () => {
      while (pending.has(file)) {
        const text = pending.get(file);
        pending.delete(file);
        const temporary = `${file}.pending`;
        try {
          await fs.promises.writeFile(temporary, text);
          await fs.promises.rename(temporary, file);
        } catch (error) { onError(error, 'snapshot-write'); }
      }
    })().finally(() => { running.delete(file); latest.delete(file); });
    running.set(file, job);
  }
  return { write, latest: (file) => latest.get(file), flush: async () => { while (running.size) await Promise.all([...running.values()]); } };
}
module.exports = { createSnapshotWriter };
