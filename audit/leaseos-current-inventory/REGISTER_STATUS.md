# LeaseOS — register and roadmap status, verified against code

**Branch** `main` · **HEAD** `f21cd1bc2070ae179d431177fd0f286965e0f3c3` · read-only.

## Sources read

| Document | What it is |
|---|---|
| `docs/REMAINING_BUILD_REGISTER.md` | the build register — **64 P-rows**, 41 claiming DONE |
| `docs/register/ROADMAP_2026-09-21.md` | owner's ordering, open items, "waiting on an owner decision" |
| `docs/register/AUDIT_RECONCILIATION_2026-09-21.md`, `SCOPE_RECONCILIATION_2026-09-21.md`, `RB01_CLOSURE.md` | reconciliation records |
| `docs/P_ROW_SUBSTANCE_AUDIT.md` | **a prior audit of this same register**, run at `0b0a37a` |
| `LEASEOS_CURRENT_STATE.md` | generated; CI gate 8 fails if it is stale |
| `audit/hardening-2026-09-21/REMEDIATION.md` | security remediation record |

## Verdicts used

**VERIFIED DONE** · **PARTIAL** · **BLOCKED** · **NOT STARTED** · **CLAIM DOES NOT MATCH CODE** · **CANNOT VERIFY**

---

## The register audits itself, and found three false DONEs

`docs/P_ROW_SUBSTANCE_AUDIT.md` compared each DONE row against **its original definition** at `d6a3433`,
not its current wording — *"a row's current text is what I wrote when I closed it, so checking a row
against itself proves nothing."* It found **three rows closed without meeting a clause** (P3.6, P3.2,
P3.1), each since fixed, and recorded one it refused to fix (P8.5's ambiguity) as a question.

It also states what it does **not** cover: *"The 14 rows with no original text"* (P3.8, P4.7, P7.1–P7.8,
P8.1–P8.3, P8.5) and *"whether a clause is well implemented."* Those limits carry into this audit.

---

## Row-by-row

| Row | Claimed | Verified | Evidence / discrepancy |
|---|---|---|---|
| P0.1 | DONE | **CANNOT VERIFY** | knowledge/HOS tranche; cites commit `4531847`. Tables and console exist; the *clause* was not re-derived here |
| P0.2 | DONE | VERIFIED DONE | `_core/tdgCertificateContents.ts`, `tdgTopicCoverage.ts`, TDG router tests |
| P0.3 | DONE | VERIFIED DONE | `limitPromote` separation of duties; `hos.test.ts` |
| P0.4 | DONE | VERIFIED DONE | signed schemas carry no server defaults; refusals are rows |
| P0.5 | DONE (qualified) | **PARTIAL — and the row says so** | 12 widgets promoted; the row itself records `widgetSourceContract.ts` as **"still DESIGN ONLY"**, and `engineReachability` confirms it is unwired |
| P0.6 | DONE | VERIFIED DONE | `_core/trainingAcademy.ts` names the state (`never held`/`expired`/`pending`/`revoked`/`rejected`) and carries the requirement's own code |
| P0.7 | DONE (procedures) | **PARTIAL — and the row says so** | `academy.sheetPrintRun` / `sheetScanFile` exist; the row states the printable HTML *"is still to be served"* |
| P0.8 | OPEN | **BLOCKED** | *"STILL CONTESTED in the seed"* — needs a verifier reading s.39 |
| P1.1 | (Android shell) | **NOT STARTED** | no `android/`, no Capacitor dependency, plugins not installed |
| P1.2 | DONE | **PARTIAL** | `device.verifySeal` and `_core/deviceSignature.ts` exist and are tested; **camera capture requires the native shell, which does not exist** |
| P1.3 | PARTIAL | PARTIAL | `operatingZones`, `zoneEvents`, `_core/geofence.ts`; `fieldRoute.gps` 0/5 UI-reachable |
| P1.4 | DONE | **PARTIAL** | signing discipline exists server-side; **biometrics require the device** |
| P1.5 | (pre-departure cache) | **NOT STARTED** | `preDepartureCache` **declared unwired** |
| P1.6 | DONE | VERIFIED DONE | clock-skew reported on signatures |
| P1.7 | (native field tests) | **NOT STARTED** | no device |
| P2.1 | (province-wide routing) | **NOT STARTED** | Valhalla/HERE not deployed; the four OSM engines are declared unwired |
| P2.2 | **BLOCKED** | **BLOCKED** | Alberta 511 — the only row the register itself marks BLOCKED |
| P2.3 | DONE | VERIFIED DONE | `bridges`, `roadRestrictions`, profiles cite source/version/effective/verified; confirmed by the prior audit |
| P2.4 | (commercial mapping) | **BLOCKED** | licences |
| P2.5 | (radio / comms) | **PARTIAL** | `_core/commRoute.ts` is wired into live readiness; the 4 ISED sources are `unverified` |
| P3.1 | DONE | VERIFIED DONE | `_core/manifestFactReconciliation.ts` — **fixed after the prior audit found it false** |
| P3.2 | DONE | VERIFIED DONE | `fieldTicketLines` + `portal.fieldTicketLineDecide`; **fixed after the prior audit found it false** (migration `0161`) |
| P3.3 | DONE | VERIFIED DONE | `unconfirmedValues` blocks — *"cannot bill from an inference"* |
| P3.4 | DONE | VERIFIED DONE | payload hash; `amended_after_signature` blocker |
| P3.5 | DONE | VERIFIED DONE | `_core/exceptionCentre.ts` implements the five-day inspector surfacing by name |
| P3.6 | DONE | VERIFIED DONE | `_core/evidenceChainWalk.ts` — **fixed after the prior audit found it false** |
| P3.7 | DONE | **CLAIM DOES NOT MATCH CODE** | *"completing a work order never implies release"* holds in `mechanicRelease.ts`. But **readiness clears a critical defect from any later release row — unrelated, failed, or revoked** (`readinessComposer.ts:318-330`), confirmed by execution. The clause is met in the writer and defeated in the reader |
| P3.8 | DONE | VERIFIED DONE | facility directory; migration `0168`; `docs/register/RB01_CLOSURE.md` |
| P4.1 | DONE | **PARTIAL** | typed-handle audit and 12 tenant-scope suites exist. The roadmap's own step 3 says *"the test says org-wide isolation is not a property; the build register calls P4.1 done"* — and `actingScope.ts` states *"single-tenant in fact"* |
| P4.2 | OPEN | **BLOCKED** | LoadSense hardware |
| P4.3 | DONE | VERIFIED DONE | `contractorOperations.db.test.ts` — one caller, zero direct DB writes |
| P4.4 | DONE | **PARTIAL** | `_core/knowledge/` ingestion exists and is owner-signed; roadmap records `repository`, `perimeter`, `evaluationState` as **half-wired** |
| P4.5 | (legal/licensing) | **BLOCKED** | people |
| P4.6 | DONE | **PARTIAL** | `monitoringNotice` engine and `monitoringNotices` table exist; **both unreferenced by any router** |
| P4.7 | DONE | CANNOT VERIFY | calendar-fixture early warning; no original text |
| P5.1 | DONE | VERIFIED DONE | `panelSource.ts` — every panel declares *"from records"* or *"demonstration layout"*; **24 declare demonstration** |
| P5.2 | DONE | VERIFIED DONE | `portals.panelsFor` refuses a portal the session does not hold |
| P5.3 | DONE | CANNOT VERIFY | `client/src/a11y/` exists; not audited here |
| P5.4 | DONE | VERIFIED DONE | `demoDataset.db.test.ts` — one caller, zero direct writes, `DEMO` marks asserted |
| P6.1–P6.11 | OPEN / decisions | **BLOCKED** | each needs a person, a permission or a licence — see `EXTERNAL_DEPENDENCIES.md` |
| P6.7 | (PO limits) | **PARTIAL — suspected dead configuration** | two limit sources unresolved. **Flagged, not investigated, not fixed** |
| P7.1–P7.9 | DONE | **PARTIAL** | the four checkable Commercial Office rules hold (no hard delete of referenced clients; OCR produces proposals not accounting facts; unique manifest ID; `assertPeriodOpen` at 12 call sites). **But every finance router is 0/N UI-reachable**, and the prior audit left `invoicing.void` as an open question — it mutates in place with no period check and `invoices` has no accounting date |
| P8.1 | DONE | VERIFIED DONE | `interEngineStatus.ts` + `degradationSuite.test.ts` (25 cases enumerated from source). The prior audit found P8.1 originally broke mapping-only tenants; fixed at v22.99 |
| P8.2 | DONE | **PARTIAL** | mechanism complete and tested. **The mode has no operational consumer** — `committedProvenance` is called only from its own test. A missing test found by the prior audit was added at v22.88 |
| P8.3 | DONE | **PARTIAL** | built for **HOS only** (`hosAttestations`); **no UI**; the other seven capabilities have no attestation path |
| P8.4 | (safety floor) | **NOT STARTED — by design** | `SAFETY_CEILINGS = {}`, pinned by `automationPolicySurface.test.ts:67` so it cannot be decided by inference |
| P8.5 | DONE | **PARTIAL — and the prior audit says so** | the decision names *near misses, drug & alcohol results, internal investigations*. Only internal investigations are tier-gated; near misses are an incident type and **not gated at all**; **drug & alcohol results are not stored anywhere**. Recorded as an open question, not fixed |

---

## Roadmap claims verified

`docs/register/ROADMAP_2026-09-21.md` "Next up, in order":

| # | Item | Verified |
|---|---|---|
| 1 | Delete or gate `/manus-storage/*` — **DONE** | **VERIFIED DONE** — migration `0168`, `server/storageCapability.test.ts` |
| 2 | Production config validator — *"nothing refuses to boot"* | **CLAIM OUT OF DATE (in the right direction)** — `assertProductionSecrets` **now exists** at `env.ts:55` and is called at `index.ts:43` |
| 3 | Prove tenant isolation | **STILL OPEN** — see P4.1 |
| 4 | Provenance on `tripStops` writes | CANNOT VERIFY — not audited here |
| 5 | Unify billing / delete the second `resolveRate` | **STILL OPEN** — `billing` and `billingAdjustment` declared unwired, *"reachability not yet established"* |
| 6 | Wire baseline, passport and binder | **NOT STARTED** — `safetyBinder`, `siteBaseline`, `tripPassportPackage` all declared unwired, each naming the tables it still needs |
| 7 | Native Android runtime | **NOT STARTED** |
| 8 | Verified HOS, routing, data licences → E2E → pilot | **BLOCKED** |

The roadmap's **"Planned — checked against the tree"** section was itself verified by its author and
found three items already built. Spot-checks agree: P3.6 evidence-chain search **BUILT**; the standing
`NOT_EVALUATED` degradation suite **BUILT and genuinely standing**; automation onboarding presets
**PARTIAL** (the provenance slot exists, the preset library does not).

---

## Discrepancy summary

| Class | Count | Rows |
|---|---|---|
| **CLAIM DOES NOT MATCH CODE** | **1** | P3.7 — mechanic release: the clause holds in the writer and is defeated in the reader |
| **PARTIAL where DONE is claimed** | **12** | P0.5, P0.7, P1.2, P1.4, P4.1, P4.4, P4.6, P7.1–P7.9 (as a block), P8.2, P8.3, P8.5 |
| VERIFIED DONE | 19 | |
| BLOCKED | 15 | P0.8, P2.2, P2.4, P4.2, P4.5, P6.1–P6.11 |
| NOT STARTED | 7 | P1.1, P1.5, P1.7, P2.1, P8.4 (by design), roadmap 6, roadmap 7 |
| CANNOT VERIFY | 4 | P0.1, P4.7, P5.3, roadmap 4 |

**The register is unusually honest.** Several rows marked DONE state their own remaining work inside the
row text (P0.5's "DESIGN ONLY", P0.7's unserved HTML). The PARTIAL verdicts above are mostly a
difference of framing — the register means *"the server clause is met"*, and this audit additionally
asks *"can anyone use it"*. On that second question most of the DONE rows are backend-only.

**The one substantive contradiction is P3.7.**
