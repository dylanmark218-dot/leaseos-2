# LeaseOS B23.2 — Scheduling Intelligence

Status: **first slice, gate-verified locally** · no migration · 2026-10-01

## Purpose

One answer for dispatch, composed from the engines that already decide and cited line by line:

> "Dylan and Unit 147 are available for this job from 06:00, but the remaining hours of service
> mean the projected job cannot finish before the duty window ends."

## What it reads, and what it never does

| Clause | Engine | Read as |
|---|---|---|
| "available from 06:00" | `availabilityFor` (B23.1) over the scheduler's view of the calendar | windows and record types; never a title |
| "remaining hours of service … duty window ends" | `determinationFor` — the same answer `hos.status` shows | a verified window limit projects an end, labelled projected; UNKNOWN stays UNKNOWN; `tripFeasibility` for the driving estimate |
| "already booked" | `resourceBookings` through the availability read | dispatch's own record |
| "Unit 147 … blocked / needs review" | `composeReadiness` | the composer's verdict and blockers, under its own reference |

The engine (`server/_core/schedulingIntelligence.ts`) decides none of these again. It narrows the
window by what is taken, checks the job fits what is left, puts the findings side by side, and
states the composite: `FEASIBLE`, `FEASIBLE_WITH_REVIEW`, `UNKNOWN` or `NOT_FEASIBLE`.

Rules kept:
- **UNKNOWN never rounds to feasible.** No HOS determination, an unverified rule, no rotation and
  no booking, no unit named — each is an unknown finding, and one makes the composite UNKNOWN
  unless something else already blocks it.
- **A projection says so.** The duty window's end is arithmetic on a clock read at a moment, and
  the line carries the moment and the word "projected".
- **Advice, not an award.** A FEASIBLE answer is a reason to look. Dispatch assigns, and the
  readiness gate runs at award on that moment's facts. The procedure writes nothing.

## Surface

`work.scheduleAssess` (permission `work.scheduling`): up to 20 candidates, a window of at most 14
days, the job's estimated duration and optional driving estimate, an optional unit and job, and
the HOS context. Returns the assessments ranked feasible → review → unknown → not feasible, each
with its findings, `availableFrom`, `dutyWindowEndsAt` and the composite sentence.

`hosRouter` now exports `determinationFor`, the reader `hos.status` uses, so this surface and the
HOS screen cannot disagree.

## Tests

| File | Cases | Proves |
|---|---|---|
| `server/_core/schedulingIntelligence.test.ts` | 11 | the brief's sentence verbatim, UNKNOWN on an unverified rule, exceeded blocks in the engine's words, driving through `tripFeasibility`, taken spans narrow and block only when the job does not fit, a whole window taken, rostered off is review, readiness states, ranking |
| `server/schedulingIntelligence.db.test.ts` | 4 | through `appRouter`: a private appointment arrives as a window with no words, the HOS line is `hos.status`'s and UNKNOWN until a figure is verified, the unit's line is the composer's, candidates rank, nothing is booked by asking, a driver is refused, bad windows and unknown units are refused |

Pinned counts moved deliberately: operational procedures 662 → 663, mounted paths 724 → 725,
inventory 389 → 390. `server/capitalAssets.test.ts` was reviewed for the calendar-fixture tripwire
as its date entered the three-week band.

## Known limitations

- HOS duty status is not yet fed into the availability read; the composite reads it only through
  the determination.
- Equipment availability is the readiness composer's verdict; unit bookings in `resourceBookings`
  are not yet overlaid as taken spans for the unit.
- No screen yet. The dispatch readiness panel is the natural host for the ranked list.

## Recommended next checkpoint

Put the ranked answer on the dispatcher's readiness panel beside the gate's own verdict, with each
finding's reference opening the record it cites, and overlay unit bookings as taken spans.
