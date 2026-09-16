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
| P0.5 | B28 widget engine onto the branch | **STAGED** (`docs/b28/B28_RECONCILIATION_MATRIX.md`, `archive/b28h-sql/0126–0127`) | the twelve sources resolved (7 as-is, 3 new reads, 1 readiness mount, 1 device-local); apply in the locked phase order; first promotion `myDay`; gate green with `/widgets` served |
| P0.6 | Academy sheet serials (Chat 5 `sheetSerial`, `sheetSerialAllocator`, `academyReadinessBridge`) | OPEN — on `fix/chat5-module-paths-and-vitest` (`54965ee`) | pure modules ported with tests; registry table as 0125 (done); the bridge either replaces `readinessComposer`'s academy block or is dropped as a duplicate — **not both** |
| P0.7 | Printable assessment tickets | OPEN — `LEASEOS_FIELD_ASSESSMENT_TICKETS.html` on the fix branch | served from the Academy portfolio with the s.6.3(1)(c) expiry wording; offline-cached for the s.6.8 immediate-production rule |
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
| P3.1 | Manifest = chain of custody | every manifest row references job, trip, load, generator, operator, unit, trailer, LSD/UWI, material, quantity + method, TDG, SDS, tickets, route, permits, GPS, signatures, amendments — by reference, not copy |
| P3.2 | Field ticket acceptance per line | accepted / disputed per line; disputed statements preserved on both sides; accepted lines flow to billing when customer config permits |
| P3.3 | Billing readiness names blockers | `billing.readiness` returns exact blockers ("disposal ticket missing for Load 4"); pending OCR/GPS/AI values never become invoice lines |
| P3.4 | Signatures + integrity | payload hash of what was signed; amended-after-signature flagged and routed to review |
| P3.5 | Exception Centre completeness | every exception class in §25 of the project rules deep-links to its corrective action; the inspector fifteen-day clock (0122) surfaces here from five days out |
| P3.6 | Tracking numbers | every artifact category has a configured format, transactional sequence, concurrency test, master-search walk of the evidence chain |
| P3.7 | Mechanic release | defect → work order → repair → test → authenticated release → dispatch recalculation; completing a work order never implies release |

## P4 — tenancy, security, governance

| # | Checkpoint | Definition of done |
|---|---|---|
| P4.1 | Multi-company tenant isolation | every core record bound to an organization (0113 started it); the typed-handle audit (`tenantIsolation.test`) extended to every production file; cross-tenant reads refused, tested |
| P4.2 | LoadSense hardware ingestion | gateway frames authenticated (0112/0114 exist); calibration evidence projected; **no weight becomes a legal axle determination without a verified calibration and a stable reading** |
| P4.3 | Contractor / owner-operator payables | the 0115–0117 chain gets its own router tests through the real procedures (it has boundary tests only) |
| P4.4 | AI Secretary corpus | ingestion runs **only** through `repository.ts` behind the source-licence gate; every chunk records its authorizing assessment |
| P4.5 | Legal / licensing | `LICENSE` file matching `package.json` (MIT declared, no file); DPA, GPS-monitoring notice, AI policy, retention schedule, SLA, pilot agreement, contractor IP/NDA, open-source register — the drafts in project knowledge become tracked documents with an owner and a date |
| P4.6 | Privacy & AI governance | 0014/0016/0017 tables get their procedures and UI: device permissions, breach register, agent approvals, regulatory sources + rule versions |

## P5 — showcase, UI, and demos

| # | Checkpoint | Definition of done |
|---|---|---|
| P5.1 | Showcase screens | every screen in the audit's showcase list renders from **records**, not fixtures; a screen backed by a fixture says so on its face |
| P5.2 | Portal shells | driver / dispatcher / office / customer / vendor / facility portals mount only their permitted procedures (7b/7c gates already pin the external counts) |
| P5.3 | Accessibility | the B28h Chromium accessibility suite (48 cases) runs against the real app, three viewports |
| P5.4 | Demo dataset | a seeded, fixture-labelled organization that exercises the full chain end-to-end without touching a real customer or a real regulatory figure |

## P6 — the human-only items (no code completes these)

| # | Item | Who |
|---|---|---|
| P6.1 | Verify the first real HOS figure (`CA_FEDERAL_SOUTH60.daily_drive_minutes`) through `/hos-verification` with the instrument open | a management-role verifier, not the person who seeded it |
| P6.2 | Author and approve the first real s.6.2 coverage mapping for the TDG road course | a course author, then a second person |
| P6.3 | Store written permission (or decline) for 511 Alberta commercial use | Alberta Transportation, then whoever records `permissionDocumentId` |
| P6.4 | Confirm the s.6.7 clock anchor (dated vs received) against the regulation text | counsel or a regulator confirmation, recorded on the regulatory profile |
| P6.5 | Read the northern division's own on-duty section (STILL CONTESTED) | a verifier with s. 39 open |

---

## How to read this register

- **DONE** means committed, migrated, tested and gate-green on the reconciled branch.
- **STAGED** means the plan is exact and the artefacts are in the tree, and the edit itself is a separate checkpoint because the engine's own recipe forbids scripting it.
- **OPEN** means code exists somewhere in the master bundle and has not been reconciled.
- P1–P5 are product work. They are ordered by dependency, not by size, and each row is written so that "complete" can be checked rather than claimed.
- P6 cannot be finished by an AI or a script. Any tool that claims to have done one of these has violated the one invariant the whole architecture exists to hold.
