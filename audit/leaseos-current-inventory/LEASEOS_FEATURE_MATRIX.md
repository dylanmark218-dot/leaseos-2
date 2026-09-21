# LeaseOS — product feature matrix

**Branch** `main` · **HEAD** `f21cd1bc2070ae179d431177fd0f286965e0f3c3` · read-only.
Legend: **IMPL** implemented and reachable · **BE** backend only (no UI) · **PART** partial ·
**STUB** deliberately non-functional · **BLOCK** blocked externally · **NONE** not implemented.

---

## 1. Driver / Field Mobile

| Feature | Status | Evidence |
|---|---|---|
| Driver dashboard | PART | `portal/PortalShell.tsx`, `portal/panels/MyDayPanel.tsx`; `surfaces.myDay` |
| Field Mobile app | **NONE** | no `android/`, no `ios/`, no Capacitor dependency |
| Field / Route / Vault tabs | PART | `showcase/OfflineVault.tsx` exists; 2 of its panels declare *"demonstration layout"* |
| Offline mode | PART | `runtime/outbox.ts`, `syncEngine.ts` complete; no device runs them |
| GPS | PART | `operatingZones`, `zoneEvents`, `_core/geofence.ts`; `fieldRoute.gps` 0/5 UI-reachable |
| Location tracking | PART | `locationIdentities`, `zoneEvents`; `phoneLocationGate` **declared unwired** |
| Camera evidence / photo capture | **NONE** | `capacitor.ts` throws `NotOnDeviceError`; plugin not installed |
| Signatures | IMPL (server) | `fieldTicketSignatures`, `commercialApprovalSignatures`, `academyCertificateSignatures`, `signatureAudits`, `_core/deviceSignature.ts` |
| Biometric signatures | **NONE** | requires the native shell |
| Microphone / voice input | **NONE** | `voiceTranscription` declared unwired, *"no device path"* |
| Voice commands | **NONE** | — |
| Job status | PART | `fieldRoute.jobs` 0/3 UI-reachable |
| Driving / on-location / idle / sleeper-berth status | PART | `dutyRecords`, `drivingEvents`; no status-machine UI |
| Pre-trip / post-trip | PART | `inspections` (`type: pre_trip`, `status: pass/fail/needs_maintenance`); **photo capture and routing is the unbuilt half** (roadmap) |
| Inspections | PART | `inspections`, `fieldRoute.compliance` 8/9 reachable |
| Defect reporting | IMPL | `fieldRoute.compliance.maintenance.create`, called from `showcase/FleetWorkspace.tsx` |
| Mechanic releases | **BE** | `shop.workOrderRelease`, `records.maintenance.recordRelease` — **no UI** |
| Work orders | **BE** | `shop` router, 25 procedures, **0 UI** |
| Emergency mode / SOS | **NONE** | no table, module or procedure |
| Dispatch acceptance / refusal | **BE** | `dispatch` router, 8 procedures, **0 UI** |
| Pre-departure readiness gate | **BE** | `composeReadiness` + `evaluateDispatchReadiness`, **0 UI**; `preDepartureCache` declared unwired |

## 2. Hours of Service

| Feature | Status | Evidence |
|---|---|---|
| Alberta / federal / provincial rules | PART + **BLOCK** | registry values under a promotion ledger; **P0.8/P6.5 `CA_FEDERAL_NORTH60.daily_on_duty_minutes` "STILL CONTESTED"**; P6.1, P6.4 need a person |
| 7-day / 14-day cycle | **NONE** | no cycle computation; roadmap *"HOS still open"* |
| Reset rules | **NONE** | — |
| Sleeper berth | **NONE** | no splitting logic |
| Electronic log / ELD | **NONE** | no ingestion path |
| Paper log | **BE** | `hosAttestations`, method `paper_log_reviewed` |
| Scanned log | **BE** | `hos.recordScannedLog` |
| Manual attestation | **BE** | `dispatchReadiness.ts:198-229` — produces `review`, names the attester, never contradicts a computed figure |
| Exemptions | **NONE** | — |
| 160 km / home-terminal | **NONE** | roadmap: *"Home-terminal geofence and radius, road and air-mile modes"* open |
| Violations | PART | `hos_insufficient` blocker, non-overridable |
| Dispatch blocking | **BE** | via readiness |
| Audit history | IMPL | promotion ledger, separation of duties (`limitPromote` refuses the recorder) |
| Verification console | STUB | `pages/HosVerificationConsole.tsx`, 328 lines, **zero API calls** |

## 3. Dispatch

| Feature | Status | Evidence |
|---|---|---|
| Dispatch creation / assignment | **BE** | `dispatchPostings`, `jobUnits`, `dispatchRouter` |
| Driver / unit / trailer assignment | **BE** | `composeReadiness` subject takes all three |
| Loads | PART | `loads`, `loadProfiles`, `loadFacilityAssessments` |
| Route | **BE** | `routeApprovals` consumed live by readiness |
| Readiness | **BE** | see §1 |
| Dispatch award | **BE** | `_core/dispatchAward.ts` — recomputes facts, refuses on fingerprint change |
| Refusal reasons | IMPL | every blocker carries a `label`; `asChecklist` says what is fixable and by whom |
| Emergency dispatch | IMPL **by omission** | `priority` is deliberately not a parameter of `evaluateDispatchReadiness` — emergency cannot bypass safety |
| Fail-closed safety | IMPL | `unknown` never rounds to eligible; unrecordable audit on a sensitive permission refuses |
| Tenant scope | IMPL | `actingScopeFor` + `*InScope` helpers |
| Dependency fingerprint / stale readiness | IMPL | `computeEligibilityFingerprint`, `requiresReEvaluation` (30-min default) |
| Consultants / client contacts / disposal destination / medic / emergency contacts | **NONE** | **no contact table exists**; `destinationAcceptanceVerified` is a readiness input from `loadFacilityAssessments` |

## 4. Contacts

**Every row is NOT IMPLEMENTED.** A repository-wide search for a contacts table returns nothing.
Company directory, driver, consultant, client, disposal, medic, emergency, ERAP, 911, job-specific
contacts, historical catalog, reusable records — none exist. The roadmap lists *"Contact directory,
using `manifestPartySnapshots` as the pattern"* under **Product not built**.

## 5. Mapping / routing

| Data source / capability | Status | Live? |
|---|---|---|
| OSM / Geofabrik | TEST-ONLY | engines validated on 508 807 Alberta ways; **all four declared unwired** |
| NRN, CanVec | **BLOCK** | seeded, `unverified` |
| Alberta (ATS, road allowance) | **BLOCK** | seeded, `unverified` |
| BC (DriveBC Open511, resource road maps) | **BLOCK** | seeded, `unverified` |
| Saskatchewan (IRIS) | **BLOCK** | **P6.9 OPEN** — licence unconfirmed |
| Manitoba (petroleum) | **BLOCK** | seeded, `unverified` |
| Other provinces | **NONE** | — |
| Back / resource / municipal / lease roads | PART | `roadSegments`, `roadRestrictions` modelled; no live import |
| LSD locator, surface/downhole location | PART | `locationIdentities`, ATS seeds |
| Rigs / wells / disposal sites | PART | AER seeds **BLOCK**; facility directory IMPL |
| Water fill locations | **NONE** | — |
| Bridges, bridge restrictions | PART | `bridges`, `roadRestrictions` tables; P2.3 claims DONE for profiles |
| Road bans, seasonal weights, axle limits | PART | `roadRestrictions`; no live feed |
| Truck routes, restricted routes, DG routing | PART | `routeEvaluation.ts` wired; data unverified |
| Schools, residential, high-traffic avoidance | **NONE** | — |
| Alternative routes | **NONE** | — |
| Weigh stations | **NONE** | — |
| **Alberta 511 / live closures / incidents** | **BLOCK** | **P2.2 — the only register row marked BLOCKED**; P6.3 permission OPEN |
| Weather / road conditions | **BLOCK** | `msc_geomet`, `cwfis` seeded; scheduler never started |
| Offline routing engine | **NONE** | Valhalla/HERE *"not deployed"* |
| External navigation handoff | **NONE** | — |
| Satellite imagery | **NONE** | — |
| Offline maps / tile cache | **NONE** | showcase panel declares *"the cached region and tile counts are laid out to show the shape of the screen"* |

**Every feed is placeholder or cached-seed. Nothing in mapping is live.** `feedScheduler`,
`feedCollector`, `feedIngest`, `feedHttp`, `advisoryImpact` and `truckRoutingAdapter` are all declared
unwired with the reason *"scheduler not started"*.

## 6. Dangerous goods / TDG

| Feature | Status | Evidence |
|---|---|---|
| TDG classes / UN numbers / packing groups | **NONE** | no table; `tdgCertificateContents.ts` covers *training* topics by transport mode |
| Placards / voice-to-placard | **NONE** | `placard` appears only in enforcement text, the training catalog and the demo dataset; a showcase panel declares *"a placard suggestion is a candidate for a person to verify, never a certification"* |
| Manifests | IMPL | `manifests`, `manifestPartySnapshots`, `manifestCustodyEvents`, `manifestAmendments`, `manifestEvidenceLinks`, `_core/manifestFactReconciliation.ts`, `manifests_manifestNumber_unique` |
| DG validation in dispatch | PART | `readinessComposer.ts:227` derives `dangerousGoods` from job type/mode by regex; requires a TDG certificate; `tdgDocumentPrepared` and `emergencyPlanOnFile` are set to `null` (UNKNOWN) whenever DG is true — **nothing establishes them** |
| Emergency response / ERAP | **NONE** | text references only |
| Shipping documents | PART | `tdg_document_missing` blocker exists; no document path populates it |
| Disposal paperwork | IMPL | `disposalTickets`, portal submission |

## 7. Documents / vault

| Feature | Status |
|---|---|
| Licence, registration, insurance, permits, TDG/WHMIS/First Aid/H2S certificates | IMPL (server) — `complianceDocuments` by `docType`, consumed live by readiness |
| Company / unit / trailer documents | IMPL (server) — `ownerType` covers 7 kinds |
| Expiry tracking | IMPL — `expiresAt` drives `credentialBlocker`; `surfaces.exceptions` surfaces within 90 days |
| **Known defect** | `needs_review` documents satisfy a credential check — `credentialBlocker` never reads `verificationStatus` |
| QR verification / DOT QR | **NONE** |
| Offline access / offline sharing | **NONE** — requires the native shell |
| Document signatures | IMPL (server) |
| Scans | PART — `scanAudits`, `hos.recordScannedLog` |
| Camera capture | **NONE** |
| Hard-copy tracking | **NONE** |
| Employee portfolio | PART — `academy.ticketPortfolio` (UI-reachable) |

## 8. Training

All **IMPLEMENTED** on the server with a real screen (`pages/TrainingAcademy.tsx`, 8 procedures called):
WHMIS/TDG/H2S/First Aid and in-house courses via `academyRequirements` + `academyRequirementBindings`;
expiry and renewal via `academyQualifications.expiresAt`; certificate storage and signatures;
assignments and completion; quizzes (`academy.assessmentOpen` / `assessmentSubmit`); employer sign-off
(`academy.certificateSignOwn`). Retention is enforced by a database trigger (migration `0126`),
verified on every migration run.

## 9. Loads / tickets / disposal

| Feature | Status | Evidence |
|---|---|---|
| Load creation, multiple loads per job | IMPL (server) | `loads`, `loadProfiles` |
| Disposal tickets / destination | IMPL | `disposalTickets`, `portal.disposalTicketSubmit` (UI-reachable) |
| Partial / line-item acceptance | IMPL | `fieldTicketLines`, `portal.fieldTicketLineDecide` (UI-reachable) — **P3.2 verified** |
| Rejected volumes | IMPL | per-line decision |
| Signatures | IMPL | `fieldTicketSignatures`, `portal.fieldTicketSign` |
| Volume / weight / density / commodity | PART | `loadSenseWeightSnapshots`, `loadSenseAxleWeights`, `materialDensityProfiles` — **no device ingestion (P4.2)** |
| Manifest | IMPL | see §6 |
| Disposal tracking, client and office copies | IMPL | `portal.chainOfCustody`, `commercialDocumentDeliveries` |

## 10. Billing / commercial

| Feature | Status |
|---|---|
| Billing, invoices, rate sheets, hourly/load/volume billing, taxes, POs, approval tiers | **BE** — substantial and tested; `invoicing`, `ar`, `gst`, `ifta`, `payroll`, `asset`, `fuel`, `bank`, `period` routers are **all 0/N UI-reachable** |
| Job-numbered books / daily logs | PART — `dailyLogs` table has **no production writer** |
| Client / contractor billing | **BE** — `contractorOperations` 14 procedures, 0 UI |
| Office dashboards | PART — `pages/CommercialOffice.tsx` reaches 15 of 43 `commercialOffice` procedures |
| **Suspected dead configuration** | **P6.7** — purchase orders have two limit sources (per-entity limit and approval ladder), unresolved. **Flagged, not fixed.** |
| **Open question (repo's own audit)** | `invoicing.void` mutates in place with no `assertPeriodOpen`, and `invoices` has no accounting date — voiding changes a closed period |

## 11. Vehicles / equipment

| Feature | Status |
|---|---|
| Trucks / trailers / units | IMPL — `units`, `trailers`, `unitRadioCapabilities` |
| Tankers, refrigeration units | **NONE** as distinct types |
| Sensors / telematics | **BE** — `telematics` router 7 procedures, 0 UI; `faultCodes`, `_core/telematics.ts` consumed live by readiness (`readinessComposer.ts:365-372`) |
| Odometer / engine hours | PART — columns on `workOrders` |
| Axle data / weights / volume sensors | PART — LoadSense tables, **no ingestion** |
| Temperature / pressure / tank levels / brake-ABS / refrigeration telemetry | **NONE** |
| Maintenance, defects | IMPL (create) / **NONE** (resolve) |
| Mechanic releases, work orders | **BE** |
| Out-of-service orders | PART — stored and managed; **ignored by readiness** |

## 12. Safety / compliance readiness

| Feature | Status |
|---|---|
| Readiness engine / composer | **BE** — complete, no UI |
| Capability model, PASS/REVIEW/BLOCKED/UNKNOWN/NOT_EVALUATED | IMPL — P8.1, guarded by `degradationSuite.test.ts` |
| Overridable vs non-overridable blockers | IMPL |
| **Safety ceilings** | **BLOCK** — P8.4, `SAFETY_CEILINGS = {}`, pinned by test |
| Capability provenance | IMPL — snapshotted onto `dispatchEligibilityChecks.automationPolicyJson` |
| Automation modes | IMPL (resolved) / TEST-ONLY (consumed) — `committedProvenance` called only from its own test |
| Manual evidence / human attestation | **BE** — HOS only |
| Enforcement orders | PART — **not read by readiness** |
| Critical defects | PART — **cleared by any later release, including a revoked one** |
| Inspections, permits, HOS, training, licensing, insurance | all consumed live by the composer |
| Readiness audit trail | IMPL — `dispatchEligibilityChecks` + fingerprint + policy snapshot |

**P8.2/P8.3/P8.4 state**: P8.2 mechanism complete, no operational consumer. P8.3 built for HOS
(`hosAttestations`) and reachable only by API. P8.4 not started — the list is empty by design and the
emptiness is test-pinned.

## 13. Maintenance

Covered in `FEATURE_INVENTORY.md`. Summary: defects create ✔, severity ✔, critical handling ✔ at the
write path; **resolution NOT IMPLEMENTED**; releases and revocations ✔ server-side, **no UI**;
`resolvedDefectIds` written and **never read**; mechanic and shop_lead roles ✔ (only these two hold
`maintenance.record_release`); repair audit ✔; inspection results ✔; **OOS integration absent from readiness**.

## 14. Company administration

| Feature | Status |
|---|---|
| Organizations / tenants / companies | PART — `organizations`, `organizationMemberships`, `coreRecordOwnership`; *"single-tenant in fact"* |
| Branches | PART — `scopeType: branch` exists; a branch grant confers no permission unless the procedure resolves a resource branch |
| Users, drivers, mechanics, dispatchers, office, safety, management | IMPL — 15 domain roles |
| Role assignment | IMPL — `userRoleAssignments` with `revokedAt`, `activeGrantKey` uniqueness (migration `0021`) |
| Company onboarding | **BE** — `commercialSetup` 6/15 UI-reachable |
| Employee management | **BE** — `workforce` 16 procedures, 0 UI |
| Units / trailers | PART |
| Ownership boundaries / multi-company isolation | PART — 4 record types only |

## 15. Client / consultant portal

All **IMPLEMENTED** and UI-reachable — the strongest chain in the product: client login (bearer token,
SHA-256 hashed, MFA, lockout), job visibility, load tracking, documents, manifests, disposal tickets,
signatures, billing, live job status, contact information. **GPS tracking: NONE. Vehicle/sensor
telemetry in the portal: NONE.** Consultant access is not a distinct concept — there is no consultant
record or contact table.

## 16. AI secretary / agent system

| Claim | Reality |
|---|---|
| **Real production AI** | One path: voice transcript → structured proposal (`routers.ts:691`), gated on an unconfigured external API key. Never writes a domain record directly — it produces a proposal awaiting human readback. |
| **Planned architecture** | Multi-agent planner/executor/tester/reviewer, AI action gateway, model routing (`modelGateway` declared unwired — *"no AI provider is configured yet"*). |
| **Test/mock only** | `agentRouter` (5 procedures, 0 UI, 3 tests skipped as unreachable); `AIChatBox.tsx` (378 lines, **zero network calls**, mounted only in the component gallery). |

Human approval ✔ (`awaiting_readback`), audit receipts ✔ (`assistantProposals` + authorization rows),
AI permissions ✔ (`agentBoundary.test.ts`), fail-closed actions ✔. **No OpenAI/Anthropic/local-LLM SDK
exists in `package.json`.**

## 17. Notifications / communication

| Channel | Status |
|---|---|
| Push / SMS / email | **NONE** — no provider dependency of any kind |
| In-app messages | PART — `surfaces.inbox`, `portal.notices`, `portal.alerts` (UI-reachable) |
| Emergency notifications | **NONE** |
| Dispatch notifications | PART — `workflowNotifications` written by the worker; no delivery channel |
| Document expiry / HOS / safety / maintenance warnings | PART — surfaced in `surfaces.exceptions`, delivered nowhere |
| Owner notification | **BLOCK** — `notifyOwner` throws without the Forge endpoint |

## 18. Security

| Control | State |
|---|---|
| Authentication / JWT | IMPL — `jose`, OAuth-issued |
| **appId binding** | **IMPL in main** — `sdk.ts:238`, tested by `sessionAppId.test.ts` |
| **Production secret validation / boot guard** | **IMPL in main** — `assertProductionSecrets`, `env.ts:55` → `index.ts:43` |
| Session handling | IMPL — cookie; roadmap notes *"one-year JWTs with no server-side revocation"* |
| OAuth provider | external (`OAUTH_SERVER_URL`) |
| RBAC / permissions | IMPL — 337 permissions, 15 roles, 0 bare `protectedProcedure` (CI-pinned) |
| Sensitive permission logging | IMPL — 125 sensitive permissions fail closed on an unrecordable audit |
| Tenant isolation | PART — 4 record types |
| Encryption at rest | **NONE in this repo** — device-side, and the device does not exist |
| Document access control | IMPL — `_core/attachmentAuthorizers.ts`, `evidenceAccessEvents` |
| Audit logging | IMPL |
| Request validation | IMPL — Zod on every procedure |
| **Rate limiting** | **NONE** |
| **CSRF** | **NONE** — roadmap: *"`SameSite=None` with no explicit CSRF policy"* |
| **CORS / helmet / API hardening** | **NONE** — no match in `server/_core/index.ts` |
| Secret management | external — one variable, `DATABASE_URL`, plus JWT/OAuth/Forge keys |
| **Dependency vulnerabilities** | **110 findings (2 critical, 39 high)**; **no SAST, dependency or secret scanning in CI** |
| Security tests | PART — 4 `security*` files plus device-signature, vault-fail-closed and session-appId suites |
