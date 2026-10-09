# Dashboard improvement backlog

The P1 fixes are merged into `afte-24h` and `main`. The directly implementable improvements below are completed on `codex/todo-improvements`, branched from `main`. Unchecked items require external verification.

## Requested UI and driving-time changes

- [x] Add a small export button in the top bar, with a clear action for exporting the current session/report.
- [x] Make the Start/Stop buttons smaller so the export button fits without crowding the top bar.
- [x] Ensure time in the pits is excluded from drivers' driving time in both the dashboard and PDF reports. Verify fuel plus pit intervals, same-driver stops, driver changes, incomplete pit observations and reopened archives; subtract overlapping service intervals only once.

## P2 security

- [x] Harden the remote timing window: enable its sandbox, restrict permissions, navigation and popups, validate IPC senders, and tighten the local content security policy. Sandboxed dashboard/preload verified in Electron; live-provider compatibility remains a verification follow-up below.
- [x] Prevent CSV formula injection in provider-controlled text fields beginning with `=`, `+`, `-` or `@`, including whitespace/control-character variants. Preserve actual numeric values and document the export policy.

## P2 data collection and timing

- [x] Choose the visible, populated timing table with the strongest timing evidence instead of the first matching header set. Cover empty and obsolete duplicate tables.
- [x] Ignore hidden provider error/status panels and script text when checking feed availability. Verify the real Start flow through sandboxed IPC and show genuine waiting/errors visibly.
- [x] Let observed completed laps without an official lap number establish that a session has started (`sessionTiming.completedLapEvidence`).
- [x] Make automatic session completion consider every followed car/class. Revisit countdown expiry based on a primary car's average lap so slower classes do not end collection early.
- [x] Persist race-control transitions independently of completed laps so short FCY/SC/red-flag periods appear in report counts and durations.

## P2 graphs and reports

- [x] Use stored `historySequence` / `displayLapNumber` for graph fallback numbering before pace filtering. Label observed numbering and align comparison cars consistently.
- [x] Invalidate cached stint PDFs when underlying laps, manual classifications, pit events or other report inputs change. Use a data revision/hash as well as a layout version.
- [x] Keep missing report times and gaps unknown rather than converting `null` to zero (`formatMs`, `gapSamplesForStint` and downstream summaries).
- [x] Make PDF generation work on a clean installed application without a user-installed Python/ReportLab runtime. Bring the fallback's insights, team/class comparisons and analysis appendices to content parity.
- [x] Print report caveats in the ReportLab renderer, and use practice/qualifying labels instead of race-only overview captions.

## Collection and display efficiency

- [x] Move remaining synchronous derived snapshot writes to a coalesced asynchronous writer while keeping canonical journal commits ahead of publication. Measure delayed-lap correction rewrites against a full 24-hour archive.
- [x] Reduce repeated full DOM scans, `innerText` reads and layout queries by caching label/header elements, using native table rows/cells, reading session text once and reusing parsed rows, with a fallback for changed markup.
- [x] Reuse report calculations and Python runtime detection across each report batch.
- [x] Flush pending snapshot writes and report jobs during application shutdown.

## Verification follow-ups

- [ ] Verify live timing providers with sandbox and navigation restrictions enabled, including redirects and changing DOM layouts. Offline provider fixtures and the stored race archive pass.
- [ ] Replay real provider outages and independently updated lap-counter/LAST cells. Keep ambiguous long-delayed observations visible rather than inventing precision.
- [ ] Exercise the export UI and PDF engine on packaged Windows and macOS builds, including machines without Python.

## Additional requests

- [x] if there is a fuel or "F" where the pistsop "P" is, this is fuel time, could this be a separate column in the report? so total pitstop time is the sum of fuel and pitstop time, but the fuel time is also shown in a separate column.
- [x] remove the refuel and fuel estimation for now, comment it out, as it is not needed yet and will be reimplemented later. (refuel time in pitstop analysis can still be there.)

## Implementation notes

- The export button uses the existing export action. Start/Stop controls are compact.
- CSV exports prefix potentially executable text with an apostrophe; numeric time/counter fields remain numeric.
- Finish countdowns are advisory until every followed class has finished. Missing followed cars keep collection active.
- Independent race-control observations retain short flag periods at polling precision. Unobserved periods remain unrecoverable.
- Packaged installs select the built-in Electron PDF engine. ReportLab remains optional during development. Both engines retain caveats, insights, comparisons and graph appendices.
- Observed fuel/pit timers remain active. Estimation/calibration/refuel advice are disabled; their UI is commented out and saved configuration is retained.
- Unknown pit intervals stay unknown/estimated. Driving time excludes known service intervals once; old lap-only archives cannot recover exact missing entry/exit timestamps.

## Validation

- `npm test`: complete suite passes.
- `npm run test:ui`: sandboxed preload, Chromium table replacement, top-bar layout, scrolling/graphs and both PDF engines pass; reports inspected visually.
- `npm run test:start`: actual Start button collects a populated feed despite hidden inactive/error panels, shows genuine waiting messages and handles invalid URLs. Real GetRaceResults demo verified on 9 October 2026: 24 cars, no collector errors.
- `npm run replay -- "race kopie" --smoke`: 12,568 records loaded without renderer errors.
- `npm run test:24h`: 45 cars, 17,281 polls, 31,095 laps; no archive cap or restart loss. Full live updates: median 208 ms / p95 280 ms; delayed-LAST correction: 712 ms, with identity retained after restart. This is a simulated load test, not a 24-hour hardware run.
