# LeaseOS — v21.0 Checkpoint: Universal Surfaces (Exception Centre, Inbox, My Day, Search, Timeline)

| | Previous | New |
|---|---|---|
| Version | v20.23 | **v21.0** |
| Tables | 173 | **173** — no schema change |
| Migrations | 37 | **37** |
| Procedures (role-authorized) | 194 | **199** |
| Bare `protectedProcedure` | 0 | **0** |
| Permissions | 147 | **152** |
| Universal permissions | 5 | **7** |
| Tests | 1,205 | **1,225** |
| Test files | 53 | **54** |
| Parity | 173/173 column-level | **173/173** |
| CI gate | PASS | **PASS** |

Reserved slots 0016/0017 untouched. No new table — that is the point.

---

## Why this is v21.0

Every domain document ended the same way: the backend is far ahead of the
UI, and the biggest experience improvement is an exception centre — people
should not browse thirty modules to find problems; LeaseOS should tell them.
The roadmap named it the Portal Foundation. Nineteen tranches of domain work
produced 194 procedures and no single place to see what needs attention. This
tranche is that place, and the four surfaces beside it, on the server, in the
form the UI needs to render.

---

## Exceptions are derived, never stored

An expired credential *is* an exception until it is renewed. A mismatched
bill *is* an exception until it is matched. There is no row to create when a
problem appears and forget to close when it goes away — every exception is a
pure function of the current state of the record it points at, so the list is
always right. `operationalTasks` and `workflowNotifications` already existed
for things *assigned* to someone; the engine does not compete with them.

Thirteen sources, one typed feed, each item carrying: a stable key the UI can
diff on, a category, a severity, the *corrective action* (not just the record),
a deep link into the right portal, and **the permission needed to act on it**.

| Source | Becomes |
|---|---|
| Critical defect, open | CRITICAL — "Unit 144 cannot dispatch"; action: repair, test, mechanic release |
| Roadside event, open | CRITICAL (no vendor) / HIGH (vendor assigned) |
| Vendor bill: mismatch, duplicate, missing receipt, needs approval or coding | BILLING — high when past due; the office action per status |
| Purchase request awaiting approval | PURCHASING — CRITICAL if emergency, MEDIUM otherwise |
| Credential expiring ≤30d / expired / awaiting verification | WORKFORCE or FLEET by owner |
| AI proposal awaiting read-back; unanswered questions | AI, low |
| Sync conflict unresolved | SYNC — high when material |
| Revoked device with queued packages | DEVICES, high — "evidence will be refused on arrival" |
| Calibration failed / expired / unknown / due soon | CALIBRATION — critical → low, in that order |
| Insurance policy within 90 days | INSURANCE — walks the renewal calendar up to CRITICAL at expiry |
| Carrier profile: unmatched regulator events; review overdue | COMPLIANCE |

Sorted critical → high → medium → low, then by due date. Deduped by key.

---

## The centre shows what you may act on, not what others worry about

`visibleTo` filters the feed to the caller's grants, per item. The suite pins
what that means in practice: a **driver's exception centre is empty** — not
because they lack access, but because nothing in it is theirs to fix; their
held unit reaches them through My Day and dispatch eligibility, their
proposal through the inbox. A dispatcher and a mechanic see the held unit and
not the bill. A bookkeeper sees the bill and nothing else. Office sees all
four. No role, nothing.

**The test caught a design error in the engine.** Credential exceptions were
gated on `compliance.passport.read` — which every driver holds to read a
passport — so a driver's centre filled with *other people's* expiring TDG
certificates. That is precisely the window into others' worries the engine
says it is not. Regated on `compliance.credential.verify`: the people who
chase renewals.

---

## The other four surfaces

**Inbox** — from the two existing tables plus what awaits the caller:
proposals awaiting *their* read-back, questions asked of *them*, *their*
purchase requests pending, and — for those who may — approvals to give (never
one's own request) and conflicts to resolve. Self-scoped: the procedure has
no input, and a source-level test asserts it.

**My Day** — portals composed from the session, the attention summary,
to-do and waiting-for from the inbox, and a single *next* action: the most
urgent critical exception if one is theirs, otherwise the top inbox item. The
driver's next action is their own read-back; the dispatcher's is the held
unit.

**Search** — one query resolves a unit number, job code, trip, load,
disposal or facility ticket, invoice, work order, purchase authorization,
vendor bill or invoice number, roadside event, device, measurement device,
policy or fuel ref. Hits carry a read permission and are filtered. A bill
resolves for office and not for a driver.

**Timeline** — an entity's history in order, from the records that mention
it: defects, mechanic releases, roadside events, fuel, disposal tickets,
trips, loads. `occurredAt` and `recordedAt` are both kept — the event and
when LeaseOS learned of it. Events filtered per reader.

---

## A second bug the suite caught, and the guard it earned

Search gated units on `"unit.read"`. That permission does not exist, so
`authorize` correctly refused it for *every* caller and nobody could find a
truck. A gate that is not a permission is a lock with no key. Units now
resolve under `roadside.report` — every operational role may name a unit —
and a new test cross-checks **every** `readPermission` and
`requiredPermission` string in the surfaces against the `Permission` union.
Inventing a permission name now fails the build.

---

## Files

**New:** `exceptionCentre.ts` · `surfacesService.ts` · `surfacesRouter.ts`
(5 procedures) · `surfaces.test.ts` (19)

**Changed:** `recordsAuthorization.ts` (5 permissions, 2 universal, 5
mapped) · `routers.ts` · drift guards · `ci-gate.sh` · inventory

---

## Genuine blockers — unchanged

**P0** — Spatial, LoadSense, Integrated Operations source never supplied.
**AER ST37 / ST102 / Alberta 511** — inspection-only pending written permission.
**P9** — no authoritative tax, HOS, retention, funding, compliance or
insurance rule loaded. Every determination on the seeds is UNKNOWN.

---

## Exact next tranche

The server now answers the five questions a portal shell asks. What remains
on this line is the shell itself — `PortalShell`, `PortalSwitcher`, the panel
registry, Quick Capture — which is client work this container cannot run or
test, and which should be built against `portals.mine`, `surfaces.myDay`,
`surfaces.exceptions`, `surfaces.inbox` and `surfaces.search` exactly as they
are.

On the server, the families the domain documents deferred are ready to be
rule packs: bulk fuel and the fuel statement import, tire assets and
inventory, warranty, period close, the digital twin. And P9 is the standing
ask that only a person can close: **every seeded rule awaits verification
against its authority**, and the loading paths are controller-only and ready.
