# Spa race follow-up

This document is the hand-off for future implementation sessions. The source
data is stored in `tests/SPA`, especially `tests/SPA/RACE`.

## Priority 1: flags and one analytics source

Goal: every consumer uses exactly the same definition of a valid lap/sector.

1. Reconstruct per-car live sector state across polls.
2. When the session changes to FCY, SC or red, immediately mark the sector the
   car is currently driving as neutralized.
3. Keep sectors completed before the transition valid, but invalidate the full
   lap as a pace lap when any sector is neutralized.
4. Exclude inlaps, outlaps and representative-pace outliers consistently.
5. Persist one analytics snapshot with car, driver, stint and recent-window
   statistics, plus included/excluded counts and reasons.
6. Make dashboard, graphs, prediction and later reports read that snapshot.

Regression fixture: car 33 lap 2 has `lapFlag = Green flag` while its sector
flags are FCY. The final model must be internally consistent and the lap must
not affect pace averages or catch calculations.

Acceptance criteria:

- A flag transition during S2 leaves completed S1 eligible, marks S2 and later
  sectors neutralized, and excludes the full lap from lap averages.
- BIC and XIC show identical values when they refer to the same entity and
  statistic scope.
- Every shown average exposes its scope and sample count in the analytics JSON.

Important: Write extra focused tests for a flag transition during each sector and make sure that old tests dont fail now, and do not change gaps or UI yet.


## Priority 2: stable gaps

Goal: show the last trustworthy gap rather than every volatile timing poll.

1. Parse GAP and INT into a canonical source-aware interval model.
2. Track each car's completed lap and only commit a new gap sample when the
   relevant car crosses start/finish.
3. Sum intervals through all overall-position rows between two class cars.
4. Store confirmed gap samples per followed car and rival.
5. Suppress catch output for a rival that remains in the pits for a configurable
   number of our completed laps; restore it after the rival resumes.
6. Use confirmed gaps for adjacent battles, catch estimates, pit rejoin and a
   future gap-over-time graph.

Start with a 5-lap recent pace window for catch estimates, but keep this value
configurable and compare 3, 5 and 10 laps against the Spa dataset before fixing
the default.

Acceptance criteria:

- Other-class cars between class rivals do not corrupt the summed gap.
- Repeated polls within one lap do not replace the displayed confirmed gap.
- A confirmed new start/finish sample updates the gap once.
- Pit rejoin always returns a best available estimate and labels estimated data.

## Priority 3: UI consistency

- Reverse delta presentation so positive means time lost versus the reference
  and negative means faster.
- Show the confirmed gap prominently, then last-lap delta and catch trend.
- When all mandatory stops are completed, make the pit window green and stop
  calculating urgency/latest-safe-stop; continue pit-loss/rejoin calculation.
- Simplify graph tooltips to lap time and delta to our car.

## Priority 4: stint features and reporting

1. Detect stints from driver transitions and timestamps.
2. Store current-stint time and cumulative driving time per driver.
3. Add a scrollable lap strip with lap number and pit/neutralization status.
4. Generate `STINT_<number>_<driver>` folders automatically at stint close.
5. Generate a PDF from persisted analytics; combine stint PDFs into driver and
   race summaries after the event.

Do not start PDF generation before the analytics source and stint boundaries
are reliable.

## Suggested future prompts

### Phase 1

> Read `tests/SPA/SPA_FOLLOW_UP.md` and implement only Priority 1. Use the real
> Spa race data as regression fixtures, add focused tests for a flag transition
> during each sector, and do not change gaps or UI yet.

### Phase 2

> Read `tests/SPA/SPA_FOLLOW_UP.md`. Priority 1 is complete. Implement only the
> stable-gap model from Priority 2, including start/finish sampling, pit-state
> suppression and tests with other-class interlopers. Keep catch window length
> configurable.

### Later phases

> Read `tests/SPA/SPA_FOLLOW_UP.md` and implement Priority 3 only.

> Read `tests/SPA/SPA_FOLLOW_UP.md` and design Priority 4 first; do not implement
> PDF output until stint detection and analytics persistence tests pass.
