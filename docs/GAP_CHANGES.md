# Gap fixes (October 2026), for review

Three commits on `feature/tidy-session-folder`, made after testing on the
GetRaceResults "TCR Europe - Race 2" demo page (`demo2`). Not pushed yet.

| Commit | What |
| --- | --- |
| `695eabd` | Exact gaps on pages with LAPS and a GAP to the leader (no DIFF/INT) |
| `cf2453e` | Gaps to cars that stopped crossing the line are no longer stale |
| `874d411` | Class gaps: show stopped and retired cars as "Out"; remove "OUT?" elsewhere |

## How gaps are calculated (short recap)

`src/shared/crossingTimeline.js` keeps, for every car, the moments it crossed
the finish line. LAST is exact, so a car's crossings are fixed relative to each
other. A time shown in the gap column ties one car's crossing to another car's
crossing exactly ("a link"). Without a link a crossing is only known to lie
between two polls (about ±2.5 s with 5 s polls): such gaps are estimates (`~`).

The gap between two cars = the difference of their crossings on the **last lap
both completed**. So a gap only changes when one of the two cars crosses the
line: the car ahead's gap when *we* complete a lap, the car behind's when
*they* do. In between the last value is kept.

## Problem 1: wrong gaps on the TCR page (screenshot: #19 → us shown ~5.228, real 3.501)

**Cause.** That page has LAPS and GAP but no DIFF/INT, and its GAP is the time
**to the leader** (values only go up along the order: 0.455, 1.486, … 37.971).
The timeline only used GAP as a link on pages where GAP rotates with
"-- N laps --" (time to the car directly ahead). Here it used nothing, so every
gap was a poll-window estimate, 1–2 s off.

**Fix.**
- GAP to the leader is now a link: a car crossed `g` seconds after the leader on
  the same lap.
- What a lone GAP column means is decided from the values (`voteGapMode`): if
  GAP (almost) never goes down along the order of cars on the same lap → to the
  leader; if it often does → to the car ahead. Default: to the leader on pages
  with LAPS, to the car ahead on rotating pages.
- GAP is only used when **no row on the page shows a DIFF/INT value**. GRR
  leaves DIFF empty everywhere; RIS always fills INT (at least `--`) and its GAP
  is to the first car on the same lap, so on RIS GAP is still never used.
- A gap cell that updates a poll after the crossing still counts.
- `gapMemory.js`: an exact gap read at the line (same lap for both cars) always
  wins over a `~` estimate.

**Result** (replays of your recordings in `test-mstc`):

| | estimated gaps | median error | p90 error |
| --- | --- | --- | --- |
| TCR session, old code | 106 of 123 | 0.56 s | 1.24 s |
| TCR session, new code | 12 of 123 | 0 | 0 |

The remaining estimates are in the first lap, before the links exist.

## Problem 2: #70 shown at +1.822 while two laps down

**Cause.** #70 crossed the line on lap 4 just behind us and then stopped
(state `?`). The gap was still taken from lap 4, the last lap both completed.

**Fix** (`overdueGap` in `crossingTimeline.js`). If one car has crossed the line
again and the other is overdue by more than 10 s compared with the last known
gap, the old gap is out of date:
- the gap becomes **"at least"** the time since the first car crossed that next
  lap (`>+20.000`), because the other car's crossing is still to come;
- once that is more than a full lap time, it shows the **laps down from the lap
  counts** (`2L`), as the timing page does. A short delay (a spin) does not
  count as laps down.

**Checked** on the Spa (RIS) race: 1,346 gaps were shown as "at least"; 1,303
could be checked against the next line crossing and 1,301 were right (2 were
13–20 s too high). The RIS replay script now counts these separately; the other
gaps are unchanged (median and p90 error 0).

## Problem 3: "calibrating…" for cars that are out, "OUT?" in every list

**Change** (`renderClassGaps` in `src/renderer/app.js`). On the Class gaps page
a car shows **`Out`** (grey row, no interval) with status:
- **Retired**: STATE/E.T.A. says RET, DNF, DNS, DSQ, …
- **Not moving**: not seen at the line for 3 of our laps, or more than a lap
  overdue at the line, and not in the pits.

Out cars are skipped when calculating the interval of the next car. The "OUT?"
tag is removed from the Laps / Averages / Sectors tabs; "PIT" (light blue) stays.

## What is shown when cars are not on the same lap

| Situation | Shown |
| --- | --- |
| Same lap, exact | `+3.501` / `-3.501` |
| Same lap, not linked yet | `~+3.6` (or `calibrating…` if it could be > 5 s off) |
| One car just crossed, the other not yet | last lap both completed (no jump) |
| Lapped car | `1L · +2:12.500` (time between their crossings of the same lap number; usually `~`, because "-- N laps --" cells carry no time) |
| More than 10 s overdue at the line | `>+20.000` |
| More than a lap overdue, in the pits | `2L` |
| More than a lap overdue, not in the pits / retired | `Out` |
| Right after an overtake (order changed) | `calibrating…` until both cars cross again |

The car ahead / behind boxes use the same numbers (`Gap 2L` for laps down).

## Files

- `src/shared/crossingTimeline.js`: GAP-to-leader links, `voteGapMode`,
  late links, `overdueGap`, `pollAt` in `resolve()`
- `src/shared/gapMemory.js`: exact over estimate, `atLeast` passed on
- `src/renderer/app.js`: `>` and `2L` formats, `Out` rows, no "OUT?" tag
- `src/renderer/styles.css`: grey out rows
- `scripts/ris-gap-replay.js`: scores "at least" gaps separately
- Tests: `tests/crossingTimeline.test.js` (TCR GAP-to-leader race, car that stops
  after lap 4, RIS INT never replaced by GAP), `tests/renderer.test.js` (`Out`,
  `Retired`, interval skips out cars)

## Not done / to check live

- Not tested in the live app yet, only with replays and tests.
- The timeline lives in memory: after an app restart the first lap again uses
  estimates until new links come in.
- Lapped cars on GAP-to-leader pages stay `~` estimates (about ±2.5 s).
- A car that loses more than 10 s in one lap (spin, drive-through) briefly
  shows `>+…` until it crosses the line; that is intended.
- "More than a lap" uses the last lap time of the car that did cross the line.
