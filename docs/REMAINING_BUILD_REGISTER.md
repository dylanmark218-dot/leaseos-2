# LeaseOS — Remaining Build Register (v22.22, 2026-09-16)

Every item still open across the LeaseOS/FieldRoute portfolio, as **checkpoints with a
definition of done**, in the order they should be built. Where this register says
DONE, the code is on `integration/reconciled-2026-09-16` and the gate proves it.
Where it says a thing needs a device, a licence or a person, no amount of code
completes it — and that is stated rather than papered over.

Ground rules that every checkpoint inherits: inspect before building; additive
changes; one source of truth; provenance on every important value; PROPOSE →
SHOW EVIDENCE → HUMAN CONFIRM → COMMIT; UNKNOWN stays UNKNOWN; the clean-database
gate is green before a checkpoint is called complete.

---

## P0 — reconciliation debt (code exists; it must become one working tree)

| # | Checkpoint | Status | Definition of done |
|---|---|---|---|
| P0.1 | Chat 4 knowledge / HOS tranche (0118–0120) | **DONE** (`4531847`) | licence gate, promotion ledger, verification console, one door to `verified`; 60 tests |
| P0.2 | Chat 5 TDG evidence modules (0121–0122) | **DONE** (`4531847`, `6720087`) | modules wired: coverage authored/approved, aspects derived at issuance, inspector requests; 10 router tests |
| P0.3 | HOS separation of duties (0124) | **DONE** (`6720087`) | `limitPromote` refuses the recorder of an unverified candidate; 5 tests |
| P0.4 | Field-signature design issues | **DONE** (`6720087`) | signed schemas carry no server defaults; refusals are rows; skew reported |
| P0.5 | B28 widget engine onto the branch | **STAGED** (`docs/b28/B28_RECONCILIATION_MATRIX.md`, `archive/b28h-sql/0127–0128`) | the twelve sources resolved (7 as-is, 3 new reads, 1 readiness mount, 1 device-local); apply in the locked phase order; first promotion `myDay`; gate green with `/widgets` served |
| P0.6 | Academy sheet serials (Chat 5 `sheetSerial`, `sheetSerialAllocator`, `academyReadinessBridge`) | OPEN — on `fix/chat5-module-paths-and-vitest` (`54965ee`) | pure modules ported with tests; registry tables as 0125 + guard 0126 (done); the bridge either replaces `readinessComposer`'s academy block or is dropped as a duplicate — **not both** |
| P0.7 | Printable assessment sheets | **DONE (procedures)**: `academy.sheetPrintRun` mints a block under the row lock and registers every sheet (an assessment sheet prints only from an approved item set; practice sheets never become credential evidence); `academy.sheetScanFile` files a returned sheet exactly once (the 0126 trigger refuses a second filing even around the router). The printable HTML (`LEASEOS_FIELD_ASSESSMENT_TICKETS.html` on the fix branch) is still to be served from the Academy portfolio with the s.6.3(1)(c) expiry wording and cached offline for s.6.8 |
| P0.8 | `CA_FEDERAL_NORTH60.daily_on_duty_minutes` | OPEN — STILL CONTESTED in the seed | a verifier with s. 39 open promotes or corrects it through `/hos-verification`; no script |

## P1 — the field runtime must run on a device

| # | Checkpoint | Definition of done |
|---|---|---|
| P1.1 | Android shell (Capacitor) | `client/src/runtime` boots on Android; encrypted SQLite (SQLCipher) behind Android Keystore; the P-256 device key lives in the keystore, never in JS; enrol/activate/push/rotate/revoke exercised on a real device against the 0110 server |
| P1.2 | Camera → sealed evidence | photo bytes hashed on-device before storage; seal recorded; server three-way hash verification passes on push |
| P1.3 | GPS → zone events | fixes queued offline with provenance `gps`; arrival/departure proposed, confirmed by the driver, then committed |
| P1.4 | Biometric signing | platform biometric authorizes a device-key signature; **no fingerprint or face template is ever stored** |
| P1.5 | Pre-departure cache | job, trip, route, tiles, facilities, permits, ERP, SDS cached before departure; `offlineCapability` classes wired; the six UI states (saved locally / queued / syncing / synchronized / failed / conflict) visibly distinct |
| P1.6 | Clock skew UX | the 0124-era refusal text (server time, skew) drives a "fix your clock" prompt instead of a silent retry |
| P1.7 | Native field tests | the 35 server field tests joined by device-side tests run on an emulator in CI |

## P2 — routing runtime and data licensing

| # | Checkpoint | Definition of done |
|---|---|---|
| P2.1 | Province-wide routing service | HERE Routing v8 (approved direction) behind the existing four-axis evaluator (legal / physical / operational / confidence); every result carries dataset version, jurisdiction, verification date; UNKNOWN never rounds to PASS |
| P2.2 | Alberta 511 | API key in env; **commercial use stays BLOCKED** until written permission is stored against `gov-ab-511` in `knowledgeSources` — the source-licence gate enforces this and refuses `rag_ingestion` / `commercial_redisplay` today |
| P2.3 | Bridge / road-ban / municipal truck-route profiles | regulatory profiles loaded as data with source, effective date, version, last verified; routes cite them by version |
| P2.4 | Commercial mapping resources | fuel/cardlock, DEF, water, disposal, scales, weigh stations, parking, washout, repair — each with source and verification state; no fabricated coverage |
| P2.5 | Radio / comms | repeater and dead-zone data only where legally sourced; no invented frequencies; public vs company-private separated |

## P3 — operations completeness (end-to-end chains)

| # | Checkpoint | Definition of done |
|---|---|---|
| P3.1 | Manifest = chain of custody | **DONE** (0129/0130, `manifestCustodyRouter`): canonical references beside the captured text (operator, unit, trailer, facilities, trip, load), party snapshots as rows (backfilled from the legacy text), custody as a sequenced event chain that seals on departure, evidence through the registry with a named relationship, append-only amendments with previous/replacement hashes needing a reason and a second person, closing against a per-load-class evidence profile — none seeded, REVIEW without one, BLOCKED naming what is missing. The 0130 trigger refuses a silent rewrite of a sealed manifest even by raw SQL. Five invariants tested through the real router. **Not yet**: the legacy `manifests.create/list` still accept text parties (draft only; binding replaces them), and route stays a reference to route evidence because there is no routes table |
| P3.2 | Field ticket acceptance per line | **DONE**: `closeout.lineDecide` (accepted / disputed, customer quantity and statement kept beside the crew's); `invoicing.draftFromTicket` excludes disputed lines and names them |
| P3.3 | Billing readiness names blockers | **DONE**: `invoicing.draftFromTicket` returns `{ drafted: false, blockers[] }` with named blockers (`invoiceDraft.ts`), including `amended_after_signature`; `closeout.whyTheseHours` explains the hours |
| P3.4 | Signatures + integrity | **DONE**: `fieldTicketSignatures.payloadHash`; supplements carry `siteRevisionHash`; `amended_after_signature` blocks invoicing (`billing.ts`, `invoiceDraft.ts`) |
| P3.5 | Exception Centre completeness | **DONE for the inspector clock** (`0122` → `exceptionCentre.ts`): an open s.6.7 request surfaces from five days out as `high`, becomes `critical` once overdue, names the authority and the due date, deep-links to the request, requires `academy.certificate.issue`, and says when part of the evidence is irrecoverable. The other exception classes in §25 of the project rules were already sources; each still deep-links to its corrective action |
| P3.6 | Tracking numbers | **PARTIAL → engine DONE**: `trackingNumbers.ts` over `trackingSequences` (format is configuration; row-locked counter; 150 numbers across 6 concurrent callers tested). Wired: **FT** and **INV**. Still `ref()`: DLY, SIG, CR, BB, DSP, MF, and every other prefix — one call each; master search is `surfaces.search` |
| P3.7 | Mechanic release | **DONE**: `shop.workOrderRelease` (full / restricted / revoked) is a separate door from `shop.workOrderAdvance`; `evaluateMechanicRelease` gates it; `readinessComposer` consumes the release and refuses to report a unit available on release alone |

## P4 — tenancy, security, governance

| # | Checkpoint | Definition of done |
|---|---|---|
| P4.1 | Multi-company tenant isolation | **IN PROGRESS** — router 3 done (compliance `documents`: a document belongs to whoever owns the record it is about — operators/units/trailers/equipment through `coreRecordOwnership`, jobs through `jobs.orgRef`; carrier/user documents stay with the default scope; filing against another organization's record is refused). `loads` need no router: every reader reaches them through their job, so they inherit router 1. Router 2 done (`units`/`operators` scoped through `coreRecordOwnership`, the table that already answers `recordBelongsToOrganization`; a member's new unit or operator is assigned to their organization in the same call; unowned legacy records visible only to the default scope). Router 1 done (`0132`, `jobs`/`trips`: `orgRef` beside the row, `orgScopeWhere()` in `db.ts`, a member sees their organization's rows, the `default` scope sees the unowned legacy rows, a legacy row is never guessed onto an organization; refusal-tested by list and by code across two organizations). Census 2026-09-17 before this: of 554 role procedures, **82 resolve the acting scope** (contractor operations, widgets, manifest custody, security incidents, Academy coverage, portal/device work) and **472 are legacy single-tenant** — they read and write the whole database, which is correct for one company on one deployment and unsafe for two. Largest unscoped surfaces: `routers.ts` 85/85, `payrollRouter` 40/40, `trainingAcademyRouter` 28/28, `shopRouter` 25/25, `commsRouter` 24/26, `closeoutRouter` 20/20, `recordsRouter` 17/17, `workforceRouter` 16/16. Done when every core table carries `orgRef` (backfilled through `coreRecordOwnership`), every read goes through `resolveActingScope`, and a two-organization refusal test exists per router. This is a multi-session program, one router per commit, starting with the tables the Commercial Office chain (P7) will depend on: jobs, trips, loads, units, operators, documents |
| P4.2 | LoadSense hardware ingestion | gateway frames authenticated (0112/0114 exist); calibration evidence projected; **no weight becomes a legal axle determination without a verified calibration and a stable reading** |
| P4.3 | Contractor / owner-operator payables | **DONE**: `contractorOperations.db.test` drives the 0115–0117 chain through the real router with two organizations — relationship proposed and accepted (never self-accepted), chain numbered from the job code, private rate between exactly the parties, payable prepared from evidence at 10.5 h × $95.00 = $997.50, review before approval, second person approves, both parties see it and a stranger does not; wrong-party rates and salary rates refused by reason |
| P4.4 | AI Secretary corpus | ingestion runs **only** through `repository.ts` behind the source-licence gate; every chunk records its authorizing assessment |
| P4.5 | Legal / licensing | **STARTED**: `LICENSE` (MIT, matching `package.json`; **copyright holder line needs the legal entity's name**); `docs/legal/LEGAL_DOCUMENT_REGISTER.md` lists the twenty instruments drafted in project knowledge with status, owner and the milestone each is needed before — all DRAFT-PK until counsel signs off |
| P4.7 | Calendar-fixture early warning | **DONE** (`server/calendarFixtures.test.ts`): a tripwire, not a zero rule — a test file that holds a date the calendar will pass within 60 days *and* makes a genuine clock read must carry a reviewed verdict (`clock_independent`, with the reason) or it fails three weeks before the date arrives; a reviewed file whose dates change is back to unreviewed; the rest are listed as warnings in the run. 13 files reviewed on 2026-09-17; 5 remain listed (capitalAssets, commercialPortal, crewForecast, openShiftsApi, timeOffApi), none within three weeks |
| P4.6 | Privacy & AI governance | **Corrected, then partly DONE.** The register assumed governance migrations 0014/0016/0017 existed; on this tree 0014 is assistant proposals, 0016/0017 are the reserved empty slots, 0018 is billing adjustments — the governance SQL lived only as project-knowledge drafts. What the tree already had: retention policies + legal holds, safety incident reports, compliance consents, agent approvals (wired in `agentRouter`). **Built now (0131)**: security incidents distinct from safety incidents — append-only sequenced timeline, affected organizations, privacy breach assessments where the notification decision is a reviewer's (`uncertain` is a valid answer, `pending` is not, nothing infers it), notification obligations with a person-cited basis and a person-set due date (no statute encoded as a number), closure refused while a notification is required and unsent or a privacy decision is missing; both surface in the Exception Centre. **Still open**: device permissions / GPS-monitoring notices (the 0014 draft), regulatory sources + rule versions as a general register (the HOS ledger covers HOS only), and the office UI for all of it |

## P5 — showcase, UI, and demos

| # | Checkpoint | Definition of done |
|---|---|---|
| P5.1 | Showcase screens | every screen in the audit's showcase list renders from **records**, not fixtures; a screen backed by a fixture says so on its face |
| P5.2 | Portal shells | driver / dispatcher / office / customer / vendor / facility portals mount only their permitted procedures (7b/7c gates already pin the external counts) |
| P5.3 | Accessibility | the B28h Chromium accessibility suite (48 cases) runs against the real app, three viewports |
| P5.4 | Demo dataset | a seeded, fixture-labelled organization that exercises the full chain end-to-end without touching a real customer or a real regulatory figure |

## P7 — Commercial Office chain (filed here so it does not overwrite the P3 rows already done)

Depends on P3.1 (done). Gated on the business decisions in the owner's answer set: organization roles, numbering, accounting target, approval ladder, thresholds, document types, waste categories, profitability dimensions.

| # | Checkpoint | Definition of done |
|---|---|---|
| P7.1 | Organization master + Commercial Office configuration | **DONE** (`0133`; `server/commercialOfficeRouter.ts` at `commercialOffice.*`; `server/_core/commercialPolicy.ts`). The owner's five decisions of 2026-09-17 are **seeded defaults a business may override** (`bookOrgRef` NULL = default, a value = that business's own answer, which wins): (1) five built-in role types, one organization holds any combination, custom role types per business; (2) numbering per sequence per business (`CLI-000123`, `VEN-000087`, `PO-2026-001245`, `MF-2026-004812`, `INV-2026-003117` seeded; a business's own prefix/digits/reset win, minted through the tracking engine on a namespaced sequence); (3) accounting-neutral core, QuickBooks Online seeded as first target, `sage`/`xero`/`none`/`custom`+label per business; (4) approval ladder per category per business — an amount no tier covers is **UNKNOWN → review**, the defaults never fill a business's gap, separation of duties refuses the preparer by name, second person named above the top tier; (5) profitability dimensions seeded (client, job, load, unit, driver, branch, contractor); load categories and document types start **empty** until the business adds its own. Permissions `commercial.read/write` (office, bookkeeper, management) and `commercial.policy` (management). Tests: 5 pure + 4 DB. **Human items:** the ladder's supervisor/manager/administrator were mapped to office/management/management+second person and say so in each row's `source` — confirm or change (P6.6); no existing `vendors`/`facilities` rows were linked to organizations by name — linking is a person's act (P7.2) |
| P7.2 | Commercial relationships | client accounts, vendor approvals, contracts, POs, rate sheets, billing rules, payment terms — building on the 0115–0117 contractor chain, not beside it |
| P7.3 | Disposal + load reconciliation | manifest ↔ facility ↔ disposal ticket ↔ scale ticket ↔ accepted quantity, over P3.1's evidence links |
| P7.4 | AR source chain | job / load / ticket / time / rate → invoice line → invoice → credit / payment, referencing evidence not copying it |
| P7.5 | AP source chain | PO / manifest / vendor ticket → vendor bill → approval → payment / remittance |
| P7.6 | Tax / accounting dimensions | **DONE for what the evidence supports** (`0138`; `commercialOffice.gl.*`, `commercialOffice.profitability.*`; `server/_core/profitability.ts`). The tax ledger itself already existed (`gstReturns`, `gstAdjustments`, `taxRegistrations`, `taxRules`) and is untouched. Added: the **GL mapping** the accounting-neutral export needs, as per-business configuration — **no chart of accounts is seeded** (a business's accounts are its own); a mapping to an account not in the chart is refused by name; `gl.exportReadiness` walks a period's invoice lines and vendor bills and names every unmapped service code, coding category and GST treatment (and an unknown treatment) as blockers — nothing is exported yet (the QBO exporter is P7.9/P8 work). **Profitability by dimension from evidence links only:** job (invoices and bills carry jobId; contractor payables reach the job through the chain), client (jobs rolled up to their linked client organization; unlinked by captured name), contractor (payables by payee); **unit is cost-only** (invoices carry no unit — splitting revenue would be an allocation, not evidence); **load, driver and branch are reported not derivable with the reason** (no evidence link on either side). A business hides a dimension by retiring it in its own book — which exposed and fixed a `layerFor` bug: a retired own-row must override the default, not restore it (pinned). Tests: +1 pure, +2 DB |
| P7.7 | Document registry | canonical documents, hashes, versions, retention classes, multi-record linkage (the records vault is the base) |
| P7.8 | Audit packages | reproducible job / vendor / client / tax bundles; read-only accountant / auditor access (7b external gate already pins the count) |
| P7.9 | Office administration UI | clients, vendors, AP, AR, manifests, disposal exceptions, document search, month-close dashboard |

## P6 — the human-only items (no code completes these)

| # | Item | Who |
|---|---|---|
| P6.1 | Verify the first real HOS figure (`CA_FEDERAL_SOUTH60.daily_drive_minutes`) through `/hos-verification` with the instrument open | a management-role verifier, not the person who seeded it |
| P6.2 | Author and approve the first real s.6.2 coverage mapping for the TDG road course | a course author, then a second person |
| P6.3 | Store written permission (or decline) for 511 Alberta commercial use | Alberta Transportation, then whoever records `permissionDocumentId` |
| P6.4 | Confirm the s.6.7 clock anchor (dated vs received) against the regulation text | counsel or a regulator confirmation, recorded on the regulatory profile |
| P6.7 | Purchase orders have two limit sources: the per-entity purchasing limits (`limitsFor`, existing, tested) and the `purchase_order` tiers seeded in 0133. Decide which governs, or that the ladder is the ceiling and the entity limits refine it, before P7.9 exposes both | human |
| P6.6 | Confirm the approval-ladder role mapping seeded in 0133/0136 (supervisor→**controller**, manager→management, administrator/owner→management with a second person) or set the business's own tiers through `commercialOffice.approvals.policySet` | human |
| P6.5 | Read the northern division's own on-duty section (STILL CONTESTED) | a verifier with s. 39 open |

---

## How to read this register

- **DONE** means committed, migrated, tested and gate-green on the reconciled branch.
- **STAGED** means the plan is exact and the artefacts are in the tree, and the edit itself is a separate checkpoint because the engine's own recipe forbids scripting it.
- **OPEN** means code exists somewhere in the master bundle and has not been reconciled.
- P1–P5 are product work. They are ordered by dependency, not by size, and each row is written so that "complete" can be checked rather than claimed.
- P6 cannot be finished by an AI or a script. Any tool that claims to have done one of these has violated the one invariant the whole architecture exists to hold.
