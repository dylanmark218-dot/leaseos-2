# LeaseOS — v21.19 Checkpoint: Telematics & Video Safety

| | v21.18 | **v21.19** |
|---|---|---|
| Tables | 231 | **235** (+4; inbound feeds extended to 8) |
| Migrations | 53 | **54** |
| Role-authorized procedures | 313 | **320** (+7, `telematicsRouter.ts`) |
| Externally-gated procedures | 33 | **33** |
| Integration-gated procedures | 2 | **2** (four new feeds through the same gate) |
| Bare `protectedProcedure` | 0 | **0** |
| Sensitive (fail-closed) | 75 | **78** (+3) |
| Tests | 1,414 | **1,421** (+7, `telematics.test.ts`) |
| Test files | 73 | **74** |
| Parity | 231/231 | **235/235 column-level** |
| CI gate | PASS | **PASS** |

Every count is read from the source. Reserved slots 0016/0017 untouched.

---

## Telemetry is evidence, and the odometer is reconciled

Four feeds enter through the gateway a machine already has: `vehicle_telemetry`,
`fault_code`, `safety_event`, `video_clip` — each accepted only in the client's
scope and only well-formed, idempotent by the client's key, and named for what
it becomes. A telemetry snapshot is append-only with its source. **The truck's
odometer is reconciled against the trips and the shop, not trusted over
them**: consistent within tolerance, a discrepancy when the trips since the
shop's last reading do not account for the advance, and *REVIEW* when the
reading is below the shop's — a rolled-back or swapped unit.

## A fault is an observation until a mechanic decides

A fault code counts and spans per unit and code — three reports are one row
seen three times. **Its severity is a rule, and no fault rule is verified**, so
an active fault is *UNKNOWN* on the dispatch board — "severity not
determined; a mechanic decides" — overridable by a manager, never clear,
never blocking by itself. The mechanic's acknowledgement makes it a
maintenance defect carrying the mechanic's words and the severity the
mechanic determined, recorded as such and not as a rule's; an acknowledged
critical fault **blocks dispatch and is not overridable**, and the fault does
not clear until the defect resolves. Seen again after acknowledgement, it
keeps its status and its count grows.

## A review is a person's, and nothing is scored

A driving event — harsh brake, rapid acceleration, cornering, speeding,
seatbelt, distraction, suspected collision — is queued **by unit, oldest
first, and sums nothing per driver**; the queue holds no score and no
operator column. It is coached, dismissed or escalated **once**, with a note a
colleague can read, and **only after the video is viewed** when there is one —
escalation alone may proceed unviewed. A posted limit from a feed is carried
as *unverified*. Escalation says to open an incident in the safety module
with the event as evidence; the event does not become an incident by itself.

## Video is its own permission

A clip arrives as a pointer with its SHA-256 and attaches to its event. Viewing
it is `safety.video.read` — safety and management only, sensitive — with a
stated purpose and a logged row, returning a short-lived URL when the clip is
in the vault and the reference and hash when it is not; never the bytes.

---

## Files

**New:** `0055_telematics_video_safety.sql` (4 tables; `inboundEvents.feed`
extended) · `telematics.ts` · `telematicsRouter.ts` (7) · `telematics.test.ts` (7)

**Changed:** `integrationGateway.ts` and `integrationRouter.ts` (the four
feeds) · `readinessComposer.ts` (the fault contribution) ·
`recordsAuthorization.ts` (4 permissions, 3 sensitive, 7 mapped) ·
`routers.ts` · `schema.ts` · drift guards · inventory · generator

## Corrected on the way

The new table was first named `safetyEvents`, which already exists as the
safety module's incidents and near-misses. A harsh-braking signal is not an
incident; it is now `drivingEvents`, and the distinction is in the code.

## Not built, and named

Video clips in the vault (pointers and hashes only today). Posted speed
limits from a verified source. Fault-code severity as verified rule rows
(P9 — every fault stays a mechanic's call). Operator attribution on driving
events (a unit's event is not a driver's until a person says so).

## Blockers — unchanged

**P9** — no verified rule. **AER ST37 / ST102 / Alberta 511** — pending.
**P0/P5** — no routing source.
