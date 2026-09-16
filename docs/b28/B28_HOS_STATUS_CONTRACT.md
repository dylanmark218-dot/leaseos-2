# B28 — `hos.status` Source Contract

Documented from the 0088 worktree diff. Fields listed are fields seen. Nothing
normalized, nothing redesigned.

## Procedure

`roleProcedure("hos.status")`, permission **`hos.read`** — both CONFIRMED.

### Input

```
CONTEXT.extend({
  operatorId:   z.number().int().positive(),
  lookbackDays: z.number().int().min(1).max(30).default(16),
})
```

`CONTEXT` is `OperatingContext`, seen in full:

| field | type | note |
|---|---|---|
| `carrierAuthority` | `federal \| provincial \| territorial` \| null | optional **on purpose** |
| `jurisdiction` | string \| null | |
| `crossedBoundary` | boolean \| null | |
| `registeredWeightKg` | number \| null | |
| `operationClass` | string \| null | |
| `latitude` | number \| null | |
| `at` | Date | the only required one |

The type's own comment: *"Every field is optional because the point of this type
is to describe incomplete knowledge honestly — an absent field is a rung of the
ladder nobody has established, and the selector says so."*

The widget must pass real operating context. It cannot default `jurisdiction` or
`latitude` to make a tile render.

### Output

```
{ operatorId, dutyRecordsRead, selection, clocks, determination, shiftBasis }
```

- **`selection`** — a three-way `SelectionOutcome`, not a boolean:
  ```
  | { outcome: "selected"; profile; reasons: string[]; alsoApplicable: string[] }
  | { outcome: "unknown";  reasons: string[]; missing: string[]; candidates: string[] }
  | { outcome: "conflict"; reasons: string[]; candidates: string[] }
  ```
- **`clocks`** — see below. Elapsed minutes.
- **`determination`** — `determine(clocks, profile)`. **Shape not visible.**
- **`shiftBasis`** — a sentence naming the basis, which says when it is a
  default: *"work shift taken to begin after 8 h of rest — a default, because no
  verified core-rest figure applies"*.

### `Clocks`, in full

```
continuousDriveMinutes, dailyDriveMinutes, dailyOnDutyMinutes,
dailyOffDutyMinutes, dailySleeperMinutes,
shiftDriveMinutes, shiftOnDutyMinutes, shiftElapsedMinutes,
lastRestMinutes, longestRestInCycle1Minutes, longestRestInCycle2Minutes,
cycle1OnDutyMinutes, cycle2OnDutyMinutes,
sinceMandatoryRestHours: number | null,
currentStatus: DutyStatus | null, currentStatusMinutes
```

**Every clock is elapsed, not remaining.** There is no `drivingRemainingMinutes`
anywhere in this shape.

### Dependencies

`dutyRecords` (`dutyStatus`, `startedAt`, `endedAt`), read back `lookbackDays`
(default 16). Profile via `selectProfile`. Core rest read as
`limitKey === "core_rest_minutes" && verificationStatus === "verified"`.

## The finding that overturns a B27 assumption

`HOS_PROJECTORS` in `widgetProjection.ts` project from a `HosSummary` carrying
`drivingRemainingMinutes`, `onDutyRemainingMinutes`, `cycleRemainingMinutes` and
`breakDueInMinutes`. **None of those exist.** The real engine returns elapsed
clocks plus a `determination` whose shape is not visible.

Remaining time is therefore `limit − elapsed`, and the limit comes from a
`hosRuleLimits` row that may be unverified — in which case the honest answer is
`unknown`, not a number. A projector computing `limit − elapsed` on its own would
be manufacturing a compliance conclusion, which is exactly what a projector may
not do.

**The projectors are not rewritten here.** Rewriting them against a guessed
`determination` shape would replace one invention with another. They are marked
CONTRACT_PARTIAL, and `determine()` is the first thing to read when the branch
arrives.

## Projection classification

| widget | class | reads |
|---|---|---|
| Current Duty Status | **DIRECT_FIELD** | `clocks.currentStatus`, `clocks.currentStatusMinutes` |
| Hours Remaining | **REQUIRES_ADDITIONAL_ENGINE** | needs `determination`; elapsed alone is not remaining |
| Driving Hours Remaining | REQUIRES_ADDITIONAL_ENGINE | `clocks.dailyDriveMinutes` + a verified limit |
| On-Duty Hours Remaining | REQUIRES_ADDITIONAL_ENGINE | `clocks.dailyOnDutyMinutes` + a verified limit |
| Cycle Hours Remaining | REQUIRES_ADDITIONAL_ENGINE | `clocks.cycle1OnDutyMinutes` / `cycle2OnDutyMinutes` + limit |
| Required Rest Countdown | REQUIRES_ADDITIONAL_ENGINE | `clocks.sinceMandatoryRestHours` + limit |
| Cycle Reset information | **DERIVABLE_WITHOUT_NEW_AUTHORITY** | `longestRestInCycle1/2Minutes`, if the reset threshold is a verified limit |
| HOS Warning | **NOT_EVIDENCED** | `determination` shape unknown |

Contract state: **CONTRACT_PARTIAL** — input CONFIRMED, `clocks` CONFIRMED,
`selection` CONFIRMED, `determination` NO_EVIDENCE.
