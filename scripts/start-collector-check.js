// Exercises the real application, sandboxed preload, IPC and Start button.
// All settings and collected data stay in an isolated temporary directory.
const { app, BrowserWindow } = require('electron');
const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mstc-start-check-'));
app.setPath('userData', folder);
app.setPath('documents', folder);
let inactive = false;
const errors = [];
const server = http.createServer((_request, response) => {
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.end(`<h1>Start regression - Race</h1><div>Green flag</div>
    <div ${inactive ? '' : 'hidden'}>No active heat</div>
    <div style="display:none">Not connected to the LiveTiming server</div>
    <script type="application/json">{"inactiveLabel":"No active heat"}</script>
    <table><tr><th>#</th><th>DRIVER</th><th>LAST</th><th>BEST</th><th>LAPS</th></tr>
    <tr><td>33</td><td>Test Driver</td><td>2:00.000</td><td>1:59.000</td><td>1</td></tr></table>`);
});

const timeout = setTimeout(() => { console.error('Start integration test timed out'); app.exit(1); }, 20000);
async function waitFor(dashboard, expression) {
  return dashboard.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    let attempts = 0;
    const timer = setInterval(async () => {
      try {
        if (${expression}) { clearInterval(timer); resolve(true); }
        else if (++attempts > 100) { clearInterval(timer); reject(new Error('Expected Start state not reached')); }
      } catch (error) { clearInterval(timer); reject(error); }
    }, 50);
  })`);
}

server.listen(0, '127.0.0.1', async () => {
  try {
    fs.writeFileSync(path.join(folder, 'settings.json'), JSON.stringify({
      timingUrl: `http://127.0.0.1:${server.address().port}`, storageFolder: path.join(folder, 'data'),
      followedCar: '33', followedCars: ['33'], setupComplete: true, sessionMode: 'race', trackCondition: 'dry'
    }));
    let dashboard;
    app.on('browser-window-created', (_event, win) => {
      if (!dashboard) dashboard = win;
      win.webContents.on('render-process-gone', (_event, details) => errors.push(JSON.stringify(details)));
      win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
    });
    require('../src/main/main');
    await app.whenReady();
    await waitFor(dashboard, `document.getElementById('timing-url')?.value.startsWith('http://127.0.0.1:') && document.getElementById('info-car')?.textContent === '33'`);
    dashboard.hide();
    await dashboard.webContents.executeJavaScript(`document.getElementById('start').click()`);
    await waitFor(dashboard, `(await window.liveTiming.getCollectorState()).status === 'collecting'`);
    const collected = await dashboard.webContents.executeJavaScript('window.liveTiming.getCollectorState()');
    assert.strictEqual(collected.rows.length, 1);
    assert.strictEqual(collected.lapHistory.length, 1);
    assert.deepStrictEqual(collected.errors, []);
    await waitFor(dashboard, `document.getElementById('collector-health').classList.contains('is-ok') && !document.getElementById('start').disabled`);

    // A visible inactive-session message must still stop stale timing ingestion.
    inactive = true;
    await dashboard.webContents.executeJavaScript(`document.getElementById('start').click()`);
    await waitFor(dashboard, `(await window.liveTiming.getCollectorState()).status === 'waiting' && !document.getElementById('start').disabled`);
    const waiting = await dashboard.webContents.executeJavaScript(`({
      green: document.getElementById('collector-health').classList.contains('is-ok'),
      hidden: document.getElementById('collector-message').hidden,
      message: document.getElementById('collector-message').textContent
    })`);
    assert.deepStrictEqual(waiting, { green: false, hidden: false, message: 'No active heat' });

    await dashboard.webContents.executeJavaScript(`document.getElementById('timing-url').value = 'file:///invalid'; document.getElementById('start').click()`);
    await waitFor(dashboard, `document.getElementById('collector-message').textContent.startsWith('Could not start collection:') && !document.getElementById('start').disabled`);
    assert.deepStrictEqual(errors, []);
    console.log(JSON.stringify({ folder, collectedRows: collected.rows.length, storedLaps: collected.lapHistory.length,
      greenAfterStart: true, visibleWaitingMessage: waiting.message, startErrorHandled: true, errors }, null, 2));
    clearTimeout(timeout);
    server.close();
    app.quit();
  } catch (error) {
    console.error(error);
    clearTimeout(timeout);
    server.close();
    app.exit(1);
  }
});
