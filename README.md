# MSTC Race Engineer Dashboard

MSTC Race Engineer Dashboard is a local desktop application for motorsport live timing analysis.  
It is built with Electron and is designed to support race engineers during live sessions by reading online timing data, storing completed laps, and turning that data into practical race, qualifying, and practice insights.

The app was developed for GetRaceResults / Circuit Zolder live timing, but the internal parser and debug output are structured so timing-page changes can be inspected and fixed more easily.

---

## What does it do?

The dashboard reads a live timing page, follows one or more selected cars, stores lap history locally, and shows race-engineering information such as:

- current session information
- followed-car status
- same-class timing comparison
- lap history
- pace analysis
- catch estimates
- pitstop planning
- qualifying comparisons
- parser/debug information

The goal is to give a clearer overview than a normal live timing table by combining raw timing data with practical race-engineering calculations.

---

## Main features

### Live timing dashboard

- Reads a GetRaceResults live timing URL.
- Displays the current live timing table.
- Tracks the selected car or cars.
- Shows session information and followed-car information.
- Updates automatically while the session is running.

### Follow up to three cars

- Follow one, two, or three car numbers at the same time.
- The first car uses the main dashboard.
- Additional cars open in separate dashboard windows.
- All dashboards share the same timing-page polling and lap-history data, so the app does not fetch the website multiple times unnecessarily.

### Session modes

The app supports different analysis modes depending on the type of session.

#### Race mode

Race mode focuses on race-engineering decisions:

- pitstop strategy
- recent pace comparison
- catch estimates
- same-class battle information
- race history tracking
- neutralized-lap handling

#### Practice mode

Practice mode focuses more on pace and reference comparisons:

- norm-time comparison
- pace comparison
- lap and sector analysis
- no race-specific pit/catch strategy view

#### Qualifying mode

Qualifying mode focuses on best-lap and flying-lap performance:

- best lap comparison
- latest valid flying lap comparison
- team-driver comparison
- BIC / XIC comparison
- adjacent class-car comparison

Each mode keeps its own reference lap and sector-time settings, so switching modes does not overwrite the reference values from another mode.

### Same-class race overview

The dashboard includes a same-class mini timing table that helps compare the followed car against relevant competitors.

It can show:

- nearby same-class cars
- class position context
- gap information
- catch estimates
- recent pace differences

### Lap history storage

Every completed lap is stored locally. The app avoids duplicate lap entries even when the live timing page is polled repeatedly.

Stored data can include:

- car number
- class
- driver
- lap time
- sector times
- best lap
- gaps
- session metadata
- flags or neutralized-session markers

### Pace and sector analysis

The app calculates race-engineering summaries from the stored lap history.

1. live timing URL, for example `https://livetiming.getraceresults.com/demo#screen-results`
2. one to three car numbers to follow, with the `+` button adding another dashboard
3. session mode: Race, Practice, or Qualifying
4. a dedicated folder for this race session
Examples:

- average lap pace
- best lap times
- best sector times
- driver statistics
- class statistics
- comparison deltas
- current lap prediction
- car-specific analysis summaries

### Neutralized-lap handling

The **Pitstop setup** button contains fixed pre-race information: total race
duration, mandatory pitstop count, and the circuit/pit formation. These values
are locked while live collection is active. The pit-in to pit-out duration stays
on the dashboard because service type and driver changes can alter it during a
race.

FCY pit loss uses the selected layout's regular-track distance between pit-in
and pit-out. Circuit distances and FCY speeds are maintained centrally in
`src/shared/pitstopCircuits.js`. Selecting a layout fills these defaults into
the Pitstop setup, where distance and speed can be overridden for race-specific
rules without modifying the central profile. If a future layout has no distance yet, the app
shows that configuration is missing instead of calculating a false rejoin
position. After FCY starts, predictions remain marked as provisional until a
fresh timing passage and stable gaps have been observed.

## Light and dark themes

Use the moon/sun button in the top information bar to switch themes. The choice
is saved and synchronized across the main dashboard, extra car dashboards, and
graph windows.

All dashboard colors are grouped in the two variable blocks at the top of
`src/renderer/styles.css`. Graph-window colors use the matching blocks at the
top of `src/renderer/graphs.css`. Edit the `:root` block for light mode and the
`:root[data-theme="dark"]` block for dark mode; component CSS does not need to
change.

## Data storage

Create and select one dedicated folder for each race, qualifying, or practice
session. The app writes directly into that selected folder and does not create
an automatic timestamp subfolder when **Start live** is pressed.

If the app closes or crashes, reopen it with the same session folder and press
**Start live** again. Existing `lap_history.jsonl` data is loaded first, its lap
identities rebuild the duplicate guard, and collection continues by appending
only newly completed laps. The latest stored pit state is restored as well, so
valid-stop counts and an active post-stop cooldown survive the restart. Select
a new empty folder when starting a genuinely new timing session.
Laps driven under safety car, full course yellow, code 60, yellow flags, or similar neutralized conditions are still stored as part of the session history.

However, they can be excluded from pace averages where appropriate.

For example:

- a full lap under FCY can be excluded from lap-time averages
- a green sector within a partially neutralized lap can still be used for sector averages
- pit in-laps and out-laps are stored but excluded from representative pace averages

### Pitstop strategy

For race sessions, the app can generate pitstop-related analysis for followed cars.

The generated pitstop plan is stored separately per car, so each followed-car dashboard can update independently while still using the same shared lap-history source.

### Data export

The app writes readable data files to the selected storage folder. This makes it possible to inspect or reuse the data outside the app.

Generated files can include:

- `latest_live_rows.csv`
- `latest_live_rows.json`
- `lap_history.csv`
- `lap_history.jsonl`
- `session_metadata.json`
- `parser_debug.json`
- `analytics_summary.json`
- `gap_state.json`
- `gap_history.jsonl`
- `lap_prediction_car-<number>.json`
- `pitstop_plan_car-<number>.json`

### Parser debug output

The app writes parser diagnostics to `parser_debug.json`.

This is useful when the timing website changes its HTML structure, because it shows:

- detected table headers
- parsed row count
- sample parsed rows
- parser warnings

### Auto-update support

Installed builds check GitHub Releases for newer versions when the app starts.

Development runs started with `npm start` or `npm run dev` do not check for updates.

When an update has been downloaded, the app asks whether to restart and install immediately or continue working and install later.

---

## Download and install

Download the newest version from the GitHub Releases page:

[GitHub Releases](https://github.com/jeffmathieu/MSTC-Internship/releases)

### Windows

Download the Windows installer:

MSTC Race Engineer Dashboard-Setup-<version>-x64.exe

Then run the installer.

Example:

MSTC Race Engineer Dashboard-Setup-1.0.0-x64.exe

Windows may show a SmartScreen warning because the app is currently unsigned.
For internal testing, click:

More info → Run anyway
macOS

Download the macOS .dmg file:

MSTC Race Engineer Dashboard-<version>-arm64.dmg

Then:

Open the .dmg.
Drag the app to Applications.
Start the app from Applications.

macOS may show a Gatekeeper warning because the app is currently unsigned/not notarized.

First launch

When the app opens for the first time, it shows a setup screen.

You need to choose:

the live timing URL
one to three car numbers to follow
the session mode
the data storage folder

Example timing URL:

https://livetiming.getraceresults.com/demo#screen-results

After configuration, press:

Start live

The app will then start reading the timing page and storing session data.

Basic usage
1. Enter the live timing URL

Paste the live timing page URL into the setup screen.

The app is intended for rendered live timing pages, not manually imported CSV files.

2. Select car numbers

Enter the car number you want to follow.

You can add extra dashboards with the + button, up to three followed cars.

3. Select the session mode

Choose one of:

Race
Practice
Qualifying

The selected mode changes which analysis panels are shown.

4. Select a storage folder

Choose a base folder where the app may write session data.

Every time you press Start live, the app creates a new session folder inside that base folder.

Example:

2026-06-25T08-42-10Z_ris-timing_car-33

This means you do not need to create a new folder manually for every race, practice, qualifying, or race-weekend session.

5. Start live mode

Press:

Start live

The dashboard starts polling the timing page and updating the analysis.

Data storage structure

Each live run gets its own session folder.

Typical generated files:

File	Purpose
latest_live_rows.csv	Current live timing table as CSV
latest_live_rows.json	Current live timing table as JSON
lap_history.csv	Stored completed laps in CSV format
lap_history.jsonl	Stored completed laps in append-friendly JSONL format
session_metadata.json	Timing URL, provider, followed car, session info and update time
parser_debug.json	Parser diagnostics for troubleshooting
analytics_summary.json	Derived pace, lap, sector and comparison statistics
gap_state.json	Latest start/finish-confirmed per-car gaps and pit-suppression state
gap_history.jsonl	Append-only confirmed gap samples for battles and future graphs
lap_prediction_car-<number>.json	Current-lap prediction for a followed car
pitstop_plan_car-<number>.json	Pitstop strategy output for a followed car

lap_history.csv and lap_history.jsonl are the long-term source of truth.

`gap_state.json` is restored when the same race folder is reopened, so volatile
live timing polls cannot replace the last confirmed start/finish gaps after a
restart. `gap_history.jsonl` grows only when a relevant car crosses the line,
not every five-second poll. The default catch estimate uses the latest five
valid laps; a rival that remains in the pits for five of our completed laps is
temporarily removed from catch output until it resumes.

analytics_summary.json, lap predictions, and pitstop plans are derived files that can be recalculated from the saved lap history and confirmed gap state.

Development
Requirements
Node.js
npm
Install dependencies
npm install
Run in development mode
npm run dev

or:

npm start
Run tests
npm test
Test coverage
npm run test:coverage
Building locally
Build for the current platform
npm run dist
Build Windows installer

On Windows:

npm run dist:win

The installer is written to:

dist/
Build macOS app

On macOS:

npm run dist:mac

The .dmg and .zip files are written to:

dist/
Release process

Releases are published through GitHub Actions when a version tag is pushed.

Recommended process:

Merge the intended changes into main.
Make sure tests pass:
npm test
Increment the version:
npm version patch

or:

npm version minor

or:

npm version major

For example, the first stable release should use:

npm version 1.0.0
Push the version commit and tag:
git push origin main
git push origin --tags

The pushed v* tag starts the release workflow.

GitHub Actions then builds:

the Windows NSIS installer
the macOS DMG
the macOS ZIP
auto-update metadata files

The generated files are attached to the GitHub Release.

Versioning

This project uses semantic versioning:

MAJOR.MINOR.PATCH

Examples:

Version	Meaning
1.0.0	First stable release
1.0.1	Bugfix release
1.1.0	New backwards-compatible feature
2.0.0	Larger breaking change
Code signing note

The current builds are unsigned.

This means:

Windows may show SmartScreen warnings.
macOS may show Gatekeeper warnings.
macOS auto-updates may require additional signing/notarization work for production use.

For internal testing this is acceptable, but before a broad production rollout the app should be signed.

Signing secrets must be stored in GitHub Actions secrets and must never be committed to the repository.

Tech stack
Electron
JavaScript
HTML
CSS
electron-builder
electron-updater
GitHub Actions
Repository structure
.github/workflows/   GitHub Actions release workflow
scripts/             Supporting scripts
src/                 Electron main process, renderer and app logic
tests/               Automated tests
package.json         App metadata, scripts and build configuration
License

MIT

Author

Jeff Mathieu
