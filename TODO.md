# Dashboard improvement backlog

The P1 reliability fixes are implemented on `codex/p1-reliability-fixes`, branched from `afte-24h`. The items below remain to be implemented.

## Requested UI and driving-time changes

- [ ] Add a small export button in the top bar, with a clear action for exporting the current session/report.
- [ ] Make the Start/Stop buttons smaller so the export button fits without crowding the top bar.
- [ ] Ensure time in the pits is excluded from drivers' driving time in both the dashboard and PDF reports. Verify fuel plus pit intervals, same-driver stops, driver changes, incomplete pit observations and reopened archives; subtract overlapping service intervals only once.

## P2 security

- [ ] Harden the remote timing window: enable its sandbox, restrict permissions, navigation and popups, validate IPC senders, and tighten the local content security policy. Verify supported providers still work.
- [ ] Prevent CSV formula injection in provider-controlled text fields beginning with `=`, `+`, `-` or `@`, including whitespace/control-character variants. Preserve actual numeric values and document the export policy.

## P2 data collection and timing

- [ ] Choose the visible, populated timing table with the strongest timing evidence instead of the first matching header set. Cover empty and obsolete duplicate tables.
- [ ] Let observed completed laps without an official lap number establish that a session has started (`sessionTiming.completedLapEvidence`).
- [ ] Make automatic session completion consider every followed car/class. Revisit countdown expiry based on a primary car's average lap so slower classes do not end collection early.
- [ ] Persist race-control transitions independently of completed laps so short FCY/SC/red-flag periods appear in report counts and durations.

## P2 graphs and reports

- [ ] Use stored `historySequence` / `displayLapNumber` for graph fallback numbering before pace filtering. Label observed numbering and align comparison cars consistently.
- [ ] Invalidate cached stint PDFs when underlying laps, manual classifications, pit events or other report inputs change. Use a data revision/hash as well as a layout version.
- [ ] Keep missing report times and gaps unknown rather than converting `null` to zero (`formatMs`, `gapSamplesForStint` and downstream summaries).
- [ ] Make PDF generation work on a clean installed application without a user-installed Python/ReportLab runtime. Bring the fallback's insights, team/class comparisons and analysis appendices to content parity.
- [ ] Print report caveats in the ReportLab renderer, and use practice/qualifying labels instead of race-only overview captions.

## Collection and display efficiency

- [ ] Move remaining synchronous derived snapshot writes to a coalesced asynchronous writer while keeping canonical journal commits ahead of publication. Measure delayed-lap correction rewrites against a full 24-hour archive.
- [ ] Reduce repeated full DOM scans, `innerText` reads and layout queries with provider-specific selectors and cached table identification, with a robust fallback.
- [ ] Reuse report calculations and Python runtime detection across each report batch.
- [ ] Flush pending snapshot writes and report jobs during application shutdown.

## Verification follow-ups

- [ ] Replay real provider outages and independently updated lap-counter/LAST cells. Keep ambiguous long-delayed observations visible rather than inventing precision.
- [ ] Exercise the export UI and PDF engine on packaged Windows and macOS builds, including machines without Python.



## extra
- [ ] if there is a fuel or "F" where the pistsop "P" is, this is fuel time, could this be a separate column in the report? so total pitstop time is the sum of fuel and pitstop time, but the fuel time is also shown in a separate column.
