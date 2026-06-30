# Zolder Race Engineer Dashboard

This is a local desktop dashboard for GetRaceResults / Circuit Zolder live timing. It reads the rendered live timing table, stores completed laps, and shows a race-engineer style layout based on the sketch:

- left top: session and followed-car information
- left middle: same-class mini timing table with catch estimates
- right top: settings, status and controls
- lower details: full timing rows, stored laps and parser debug

## Run during development

```bash
npm install
npm run dev
```

## First launch

The app opens a setup screen where you choose:

1. live timing URL, for example `https://livetiming.getraceresults.com/demo#screen-results`
2. one to three car numbers to follow, with the `+` button adding another dashboard
3. session mode: Race, Practice, or Qualifying
4. data storage folder

These settings are remembered. The first number uses the main dashboard; every
additional number opens a separate dashboard window. All dashboards share one
timing-page poll, one live table and one lap-history file, so following three
cars does not fetch the website three times. You can reopen the setup window
with the **Setup** button.

Race mode enables pitstop strategy, recent-pace comparisons and catch
predictions. Practice mode keeps norm-time and pace comparisons but hides pit
and catch strategy. Qualifying mode compares best and latest valid flying laps
for team drivers, BIC, XIC and adjacent class cars. Each mode stores its own
reference lap and sector times, so switching modes does not overwrite another
mode's norm settings.

## Data storage

The folder you select is a base storage folder. Every time you press **Start
live**, the app creates a new session folder inside that base folder, for
example:

`2026-06-25T08-42-10Z_ris-timing_car-33`

All files for that live run are written into that session folder, so you do not
need to manually create a new folder for each race, qualifying, practice, or
race-weekend session.

Each session folder contains readable source files that contain the timing data
as it came in, and derived files that are recalculated from that source data.

- `latest_live_rows.csv`
- `latest_live_rows.json`
- `lap_history.csv`
- `lap_history.jsonl`
- `session_metadata.json`
- `parser_debug.json`
- `analytics_summary.json`
- `lap_prediction_car-<number>.json`
- `pitstop_plan_car-<number>.json`

`latest_live_rows.csv` and `latest_live_rows.json` are overwritten on every
successful poll. They contain the current timing table only: position, car
number, class, driver, last lap, best lap, sectors, gaps, and similar fields.
These files are useful when you want to inspect what the app sees right now.

`lap_history.csv` and `lap_history.jsonl` are the long-term source of truth.
Only new completed laps are appended, so polling every few seconds does not
create duplicate rows. These files keep all completed laps, including laps
driven under safety car, full course yellow, code 60, or yellow flags. Those
laps are stored because they are still part of the race history, but the
analytics can exclude them from pace averages.

`session_metadata.json` is overwritten with compact session information such as
the timing URL, detected timing provider, followed car, session name, and last
update time.

`parser_debug.json` is overwritten with parser diagnostics. It shows which table
headers were detected, how many rows were parsed, the first parsed rows, and any
parser warnings. This is mainly for troubleshooting when a timing website
changes its HTML.

`analytics_summary.json` is a derived cache built from `lap_history`. It stores
the current averages, best lap times, best sector times, driver statistics,
class statistics, and comparison deltas used by the dashboard. It does not copy
the full lap list again; detailed lap data stays in `lap_history.jsonl`.

The averages are therefore available without the renderer having to rebuild all
statistics from scratch every time. The app still keeps `lap_history` as the
source of truth, so if the averaging rule changes later, the summary can be
rebuilt from the saved laps.

The analytics summary contains a separate dashboard analysis for every followed
car. Current-lap predictions and pitstop plans are written to car-specific files
so each dashboard can update independently while using the same source data.

For neutralized laps, the storage keeps both the lap and its flag fields. A
full lap under safety car or FCY is excluded from lap-time pace averages, but a
sector can still count if that sector has its own green/eligible marker. For
example: if sector 1 was completed under green and FCY starts during sector 2,
sector 1 can still count for sector averages while the full lap does not count
for lap-time averages.

Pit/inlaps and the following outlaps also remain stored as race history, but are
excluded from lap and sector pace averages.

## Live mode

**Start live** reads the chosen GetRaceResults timing URL. The dashboard uses live timing data only.

## Build a Windows app

On Windows:

```bash
npm install
npm run dist:win
```

The output appears in `dist/`.
