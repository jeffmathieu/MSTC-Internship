# Zolder Race Engineer Dashboard

This is a local desktop dashboard for GetRaceResults / Circuit Zolder live timing. It reads the rendered live timing table, stores completed laps, and shows a race-engineer style layout based on the sketch:

- left top: session and followed-car information
- left middle: same-class mini timing table with catch estimates
- left bottom: norm/reference-time warning
- right top: settings, status and controls
- right main: switchable graph panel
- lower details: full timing rows, stored laps and parser debug

## Run during development

```bash
npm install
npm run dev
```

## First launch

The app opens a setup screen where you choose:

1. live timing URL, for example `https://livetiming.getraceresults.com/demo#screen-results`
2. our car number, default `33`
3. reference / norm time, default `1:42.000`
4. data storage folder

These settings are remembered. You can reopen the setup window with the **Setup** button.

## Data storage

The app stores readable data in the folder you select:

- `latest_live_rows.csv`
- `latest_live_rows.json`
- `latest_session_info.json`
- `lap_history.csv`
- `lap_history.jsonl`

Only new completed laps are appended to the lap history, so polling every few seconds does not create duplicate rows.

## Live and replay mode

- **Start live** reads the chosen GetRaceResults timing URL.
- **Replay** plays the built-in Belcar replay data so graphs and catch estimates can be tested quickly.

## Graphs

Graphs are defined in `src/renderer/app.js` in the `graphRegistry` array. To add another graph later, add another object with:

```js
{
  id: 'myGraph',
  label: 'My graph name',
  description: 'What this graph shows',
  render(container, state) {
    // draw graph here
  }
}
```

Current graph types:

- Our lap time over race, colored by driver/stint
- Same-class lap comparison
- Driver sector comparison

## Build a Windows app

On Windows:

```bash
npm install
npm run dist:win
```

The output appears in `dist/`.
