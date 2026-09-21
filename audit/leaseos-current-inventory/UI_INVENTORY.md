# LeaseOS — UI inventory

**Branch** `main` · **HEAD** `f21cd1bc2070ae179d431177fd0f286965e0f3c3` · read-only audit.

React 18 + Vite, routed with `wouter`. **38 routes**, **146 client source files** (138 non-test), **8 DOM test files**.

There is **one** web application. There is **no Android app, no iOS app and no native shell** — see `SYSTEM_ARCHITECTURE.md`.

## A property worth knowing before reading this

The showcase pages **declare their own data source on screen**. `client/src/showcase/panelSource.ts` defines `fromQuery()` and `demonstration()`, and every panel renders a badge reading either *"from records — &lt;procedure&gt;, N rows"* or *"demonstration layout — &lt;reason&gt;"*. Its header states the rule: *"a query that returns nothing is NOT records. It is a demonstration layout with a named reason."*

**24 panels declare themselves demonstrations.** They are placeholders and they say so. That is unusually honest and it means this audit does not have to guess which panels are real — the code already answers.

---

## Routes

| Route | Component | Target user |
|---|---|---|
| `/` | `PortalShell` | staff — the default shell |
| `/portal` | `PortalShell` | staff |
| `/portal/:portal/*?` | `PortalShell` | staff, per-portal |
| `/customer` | `CustomerPortal` | customer (external) |
| `/vendor` | `VendorFacilityPortal` | vendor (external) |
| `/facility` | `VendorFacilityPortal` | disposal facility (external) |
| `/hos-verification` | `HosVerificationConsole` | HOS verifier |
| `/widgets` | `WidgetBoardPage` | staff |
| `/map` | `MapSurface` | staff |
| `/jobs` | `JobsSurface` | staff |
| `/evidence` | `EvidenceSurface` | staff |
| `/safety` | `SafetySurface` | safety staff |
| `/comms/package` | `CommunicationsPackage` | dispatch/driver |
| `/comms/transmit` | `TransmitCheck` | dispatch/driver |
| `/comms/status` | `CommunicationsPackageStatus` | dispatch |
| `/route/preview` | `RoutePreview` | dispatch |
| `/documents/ask` | `AssistantAsk` | staff |
| `/documents/calibration` | `AssistantCalibration` | staff |
| `/disposal-directory` | `DisposalDirectory` | dispatch/office |
| `/disposal-finder` | `DisposalFinder` | dispatch/driver |
| `/commercial-office` | `CommercialOffice` | office/finance |
| `/trip-operations` | `TripOperationsWorkspace` | dispatch |
| `/training-academy` | `TrainingAcademy` | driver/safety |
| `/showcase` | `Home` | demonstration |
| `/showcase/route-safety` | `RouteSafetyWorkspace` | demonstration |
| `/showcase/locations` | `LocationWorkspace` | demonstration |
| `/showcase/trips` | `TripOperationsWorkspace` | demonstration |
| `/showcase/fleet` | `FleetWorkspace` | demonstration |
| `/showcase/billing-safety` | `BillingSafetyWorkspace` | demonstration |
| `/showcase/compliance-engine` | `ComplianceEngine` | demonstration |
| `/showcase/offline-vault` | `OfflineVault` | demonstration |
| `/404` | `NotFound` | — |

Six further routes (`/fleet`, `/locations`, `/compliance-engine`, `/offline-vault`, `/billing-safety`, `/route-safety`) are redirects into `/showcase/*`.

---

## Screens and what they call

| File | Lines | Procedures called | Offline | Tests |
|---|---|---|---|---|
| `_core/hooks/useAuth.ts` | 98 | 2 — `auth.logout`, `auth.me` | no | yes |
| `pages/AssistantAsk.tsx` | 178 | 1 — `assistantAsk.ask` | no | no |
| `pages/AssistantCalibration.tsx` | 255 | 4 — `assistantAsk.addProbeFromAsk`, `assistantAsk.history`, `assistantAsk.measureRetrieval`, `assistantAsk.passageList` | no | no |
| `pages/CommercialOffice.tsx` | 56 | 15 — `commercialOffice.ap.agingByOrganization`, `commercialOffice.ar.agingByOrganization`, `commercialOffice.disposal.lineResolve`, `commercialOffice.disposal.statementLines` … | no | no |
| `pages/CommunicationsPackage.tsx` | 200 | 1 — `comms.packageFetch` | no | no |
| `pages/CommunicationsPackageStatus.tsx` | 180 | 1 — `comms.packageStatus` | no | no |
| `pages/ComponentShowcase.tsx` | 1440 | 1 — `fieldRoute.assistant.draft` | no | no |
| `pages/DisposalDirectory.tsx` | 366 | 2 — `fieldRoute.compliance.facilities.create`, `fieldRoute.compliance.facilities.list` | no | no |
| `pages/DisposalFinder.tsx` | 34 | 5 — `facilityDirectory.callAhead.record`, `facilityDirectory.driverView`, `facilityDirectory.lsdFind`, `facilityDirectory.vocabulary.list` … | no | no |
| `pages/RoutePreview.tsx` | 209 | 1 — `geo.routeCompute` | no | no |
| `pages/TrainingAcademy.tsx` | 208 | 8 — `academy.assessmentOpen`, `academy.assessmentSubmit`, `academy.assignmentDetail`, `academy.catalog` … | no | no |
| `pages/TransmitCheck.tsx` | 213 | 1 — `comms.transmitCheck` | no | no |
| `pages/WidgetBoardPage.tsx` | 80 | 3 — `widgets.boardResolve`, `widgets.layoutSave`, `widgets.offerable` | no | no |
| `pages/authoritative/Surfaces.tsx` | 63 | 1 — `spatial.routingSourceStatus` | no | no |
| `portal/PortalShell.tsx` | 100 | 4 — `portals.mine`, `surfaces.exceptions`, `surfaces.inbox`, `surfaces.myDay` | no | no |
| `portal/UniversalSearch.tsx` | 29 | 1 — `surfaces.search` | no | no |
| `portal/external/AlertsPanel.tsx` | 15 | 4 — `portal.alertAcknowledge`, `portal.alertPreferences`, `portal.alertPreferencesSet`, `portal.alerts` | no | no |
| `portal/external/ChainOfCustody.tsx` | 17 | 1 — `portal.chainOfCustody` | no | no |
| `portal/external/CustomerPortal.tsx` | 91 | 12 — `portal.adjustmentAuthorize`, `portal.approvalQueue`, `portal.dailyReport`, `portal.documentDownload` … | no | no |
| `portal/external/SignOffScreen.tsx` | 49 | 2 — `portal.fieldTicketSign`, `portal.fieldTicketView` | no | no |
| `portal/external/VendorFacilityPortal.tsx` | 39 | 5 — `portal.disposalTicketSubmit`, `portal.facilityStatement`, `portal.me`, `portal.vendorBillSubmit` … | no | no |
| `portal/panels/SetupPanel.tsx` | 161 | 8 — `commercialSetup.definitionApprove`, `commercialSetup.definitionList`, `commercialSetup.definitionPropose`, `commercialSetup.goLiveReadiness` … | no | no |
| `portal/panels/TimelinePanel.tsx` | 31 | 1 — `surfaces.timeline` | no | no |
| `showcase/BillingSafetyWorkspace.tsx` | 562 | 7 — `fieldRoute.billing.lines.create`, `fieldRoute.billing.rateCards.create`, `fieldRoute.billing.rateCards.list`, `fieldRoute.unitSafety.create` … | no | no |
| `showcase/ComplianceEngine.tsx` | 482 | 7 — `fieldRoute.complianceEngine.artifacts.create`, `fieldRoute.complianceEngine.artifacts.list`, `fieldRoute.complianceEngine.tailgates.create`, `fieldRoute.complianceEngine.tailgates.list` … | no | no |
| `showcase/FleetWorkspace.tsx` | 1589 | 17 — `fieldRoute.compliance.deliveries.create`, `fieldRoute.compliance.deliveries.list`, `fieldRoute.compliance.facilities.create`, `fieldRoute.compliance.facilities.list` … | no | no |
| `showcase/Home.tsx` | 2158 | 6 — `fieldRoute.evidence.list`, `fieldRoute.evidence.upload`, `fieldRoute.evidence.verify`, `fieldRoute.routeContext.list` … | no | no |
| `showcase/LocationWorkspace.tsx` | 447 | 3 — `fieldRoute.locations.list`, `fieldRoute.manifests.list`, `fieldRoute.scans.create` | no | no |
| `showcase/OfflineVault.tsx` | 443 | 2 — `fieldRoute.complianceEngine.artifacts.list`, `fieldRoute.complianceEngine.transfers.list` | no | no |
| `showcase/RouteSafetyWorkspace.tsx` | 448 | 2 — `fieldRoute.routeDecisions.create`, `fieldRoute.routeDecisions.list` | no | no |
| `showcase/TripOperationsWorkspace.tsx` | 568 | 10 — `fieldRoute.dutyRecords.create`, `fieldRoute.dutyRecords.list`, `fieldRoute.operatingZones.create`, `fieldRoute.operatingZones.list` … | no | no |

### Client files with **zero** API calls

| File | Lines | What it is |
|---|---|---|
| `components/AIChatBox.tsx` | 378 | **Presentational only.** No `fetch`, no mutation, no query. Mounted solely in `pages/ComponentShowcase.tsx`, a component gallery. There is no working AI chat in the product. |
| `pages/HosVerificationConsole.tsx` | 328 | HOS verification console — renders, but makes no server call from this file |
| `components/DashboardLayout.tsx` | 319 | layout shell |
| `widgets/WidgetBoard.tsx` | 270 | widget board renderer; data arrives via `WidgetBoardPage` |
| `pages/CommercialOfficeView.tsx` | 227 | presentational view; `CommercialOffice.tsx` holds the queries |
| `pages/DisposalFinderView.tsx` | 148 | presentational view; `DisposalFinder.tsx` holds the queries |
| `components/Map.tsx` | — | map component |
| `components/ManusDialog.tsx` | — | dialog |
| `pages/ComponentShowcase.tsx` | 1440 | component gallery — 1 call; this is where `AIChatBox` is mounted |

### Declared placeholder panels (24)

Each renders a *"demonstration layout"* badge naming its own reason. Verbatim reasons include:

- *JOB-08421 and its companions are demonstration jobs; no job record is read on this page*
- *the readiness engine is not run on this page; these states are the demonstration layout*
- *no routing engine result is read on this page*
- *the alert is laid out to show the shape of the screen; no duty record or HOS rule is read*
- *TR-2026-000812 is a demonstration trip; this passport reads no trip record*
- *the cached region and tile counts are laid out to show the shape of the screen*
- *a placard suggestion is a candidate for a person to verify, never a certification*
- *the handoff is laid out to show the chain; no manifest or ticket record is read here*
- *the shift figures are laid out to show the shape of the screen; no duty record is read*
- *these are the values typed into this form, not a verified vehicle profile*

---

# BACKEND FEATURES WITH NO UI

**557 of 690 procedures (81%) have no caller anywhere under `client/src`.** 133 are reachable. This is the defining gap in the product as it stands: the server is far ahead of the application.

## 48 routers are entirely unreachable from the application

| Router | Procedures | Capability that cannot be used through the app |
|---|---|---|
| `agent` | 5 | agent runtime |
| `ar` | 8 | accounts receivable |
| `asset` | 10 | capital assets, CCA schedules, disposals |
| `audit` | 6 | audit package assembly and access |
| `automationPolicy` | 6 | P8.2 entitlement, policy, operational override, history, snapshot |
| `bank` | 3 | bank reconciliation |
| `board` | 9 | dispatch/ops board semantics |
| `calendar` | 3 | financial calendar |
| `calibration` | 3 | measurement device calibration sweeps |
| `closeout` | 20 | site and trip closeout |
| `commercial` | 4 | commercial approvals |
| `compliance` | 13 | compliance documents, passports, requirements |
| `contractorOperations` | 14 | contractor / owner-operator operations and payables |
| `contractors` | 3 | contractor records |
| `crews` | 4 | crew scheduling |
| `device` | 4 | field device enrolment, seal verification |
| `dispatch` | 8 | **readiness, evaluate, override request/grant, award — the entire dispatch gate** |
| `enforcement` | 11 | **roadside stops, out-of-service orders, OOS release policy, inspector panel** |
| `fuel` | 7 | fuel purchases and reconciliation |
| `funding` | 8 | funding and recovery |
| `gst` | 5 | GST returns |
| `hos` | 10 | **hours-of-service attestation, scanned logs, limit promotion** |
| `ifta` | 7 | IFTA returns |
| `inbound` | 2 | machine inbound ingestion |
| `insurance` | 12 | policies, coverages, covered entities, claims |
| `integration` | 11 | machine clients, webhooks |
| `invoicing` | 7 | invoice create, finalize, void |
| `manifestCustody` | 9 | manifest chain of custody and seal overrides |
| `payroll` | 22 | pay runs, banking, tax identifiers, adjustments |
| `period` | 3 | accounting period open/close |
| `portalAdmin` | 3 | portal credential administration |
| `project` | 9 | commercial projects |
| `purchasing` | 2 | purchase authorizations |
| `readiness` | 2 | readiness surface |
| `records` | 19 | **maintenance release and revocation**, incidents, near-misses, legal holds, evidence, retention |
| `recovery` | 1 | recovery decisions |
| `requirement` | 4 | requirement profiles |
| `restrictedVault` | 9 | P8.5 restricted incident records |
| `roadside` | 2 | roadside service events |
| `securityIncidents` | 9 | security incident capture and handling |
| `shifts` | 5 | open shifts |
| `shop` | 25 | work orders, **mechanic releases**, parts, tires, tools, warranty, recalls |
| `sync` | 3 | **offline package receive / push** |
| `system` | 2 | owner notification, system health |
| `telematics` | 7 | fault codes, acknowledgement, defect creation from faults |
| `timeOff` | 5 | time-off requests |
| `vendor` | 4 | vendor records |
| `workforce` | 16 | applicants, onboarding, personnel records |

## Partially reachable

| Router | Reachable / total |
|---|---|
| `academy` | 8 / 28 |
| `assistantAsk` | 5 / 8 |
| `commercialOffice` | 15 / 43 |
| `commercialSetup` | 6 / 15 |
| `comms` | 3 / 26 |
| `facilityDirectory` | 5 / 28 |
| `fieldRoute` | 53 / 85 |
| `finance` | 2 / 15 |
| `geo` | 1 / 14 |
| `portal` | 23 / 36 |
| `portals` | 1 / 2 |
| `spatial` | 1 / 15 |
| `surfaces` | 5 / 6 |

The complete per-procedure list is in `API_INVENTORY.md`.
