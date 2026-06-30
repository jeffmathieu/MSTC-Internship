const http = require('http');
const {
  parseArgs,
  loadRaceData,
  createSimulator,
  renderPage
} = require('./core');

function send(response, status, contentType, body) {
  response.writeHead(status, { 'content-type': contentType });
  response.end(body);
}

function startServer(options = parseArgs()) {
  const data = loadRaceData();
  const simulator = createSimulator(data, options);
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, `http://${request.headers.host}`);
    if (url.pathname === '/state.json') {
      send(response, 200, 'application/json', JSON.stringify(simulator.snapshot(), null, 2));
      return;
    }
    if (url.pathname === '/control') {
      const op = url.searchParams.get('op');
      if (url.searchParams.has('lapSeconds')) simulator.setLapSeconds(url.searchParams.get('lapSeconds'));
      if (op === 'reset') simulator.reset();
      if (op === 'pause') simulator.setPaused(true);
      if (op === 'play') simulator.setPaused(false);
      response.writeHead(302, { location: '/' });
      response.end();
      return;
    }
    send(response, 200, 'text/html; charset=utf-8', renderPage(data, simulator));
  });
  server.listen(options.port, '127.0.0.1', () => {
    console.log(`Assen Club Challenge simulator: http://localhost:${options.port}`);
    console.log(`Use --lap-seconds ${options.lapSeconds} to change how quickly an average lap passes.`);
  });
  return { server, simulator, data };
}

if (require.main === module) startServer();

module.exports = { startServer };
