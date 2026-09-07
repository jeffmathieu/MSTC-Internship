const { Worker } = require('worker_threads');
const path = require('path');

// One report worker at a time keeps CPU/memory bounded on team laptops. Worker
// input contains a file path and small metadata, never the entire race archive.
function createReportQueue(printFallback) {
  let tail = Promise.resolve();
  const pending = new Map();
  function enqueue(key, input) {
    if (pending.has(key)) return pending.get(key);
    const job = tail.then(() => new Promise((resolve, reject) => {
      const worker = new Worker(path.join(__dirname, 'reportWorker.js'), { workerData: input });
      let settled = false;
      const finish = (error, result) => {
        if (settled) return;
        settled = true;
        worker.terminate();
        if (error) reject(error); else resolve(result);
      };
      worker.on('error', (error) => finish(error));
      worker.on('exit', (code) => { if (!settled) finish(new Error(`Report worker exited before completion (${code})`)); });
      worker.on('message', async (message) => {
        if (message.type === 'done') finish(null, message);
        else if (message.type === 'error') finish(new Error(message.error));
        else if (message.type === 'print') {
          try { await printFallback(message.html, message.pdfPath); worker.postMessage({ ok: true }); }
          catch (error) { worker.postMessage({ error: error.message }); }
        }
      });
    })).finally(() => pending.delete(key));
    tail = job.catch(() => {});
    pending.set(key, job);
    return job;
  }
  return { enqueue, flush: () => tail };
}
module.exports = { createReportQueue };
