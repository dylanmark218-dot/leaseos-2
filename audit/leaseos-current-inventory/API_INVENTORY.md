# LeaseOS — API / router inventory
**Branch** `main` · **HEAD** `f21cd1bc2070ae179d431177fd0f286965e0f3c3` · read-only audit.
**690 procedures** across **63 top-level routers** — 245 queries, 445 mutations, 0 subscriptions.
**490** map to a declared domain permission; **200** do not (portal `externalProcedure`, machine `integrationProcedure`, `adminProcedure`, `publicProcedure` and system paths — these are gated by their own middleware, not by the domain permission map).
**133 of 690 (19%) are reachable from the LeaseOS client.** **557 have no UI caller at all.**

## How to read the tables
- **auth** — `role` = `roleProcedure` with the named permission; `external` = portal bearer token + MFA; `machine` = `integrationProcedure`; `other` = admin/public/system.
- **UI** — `yes` means a file under `client/src` calls this exact path.
- **tests** — `yes` means the path string appears in a test file.
- Input/output schemas are Zod-defined at each call site; they are not transcribed here. Tables accessed and services called are given per router below rather than per procedure, because most procedures in a router share them.

---

## Summary by router
| Router | Procedures | Q / M | UI-reachable | Permission-mapped |
|---|---|---|---|---|
| `fieldRoute` | 85 | 36 / 49 | 53 | 0 |
| `commercialOffice` | 43 | 20 / 23 | 15 | 0 |
| `portal` | 36 | 18 / 18 | 23 | 0 |
| `facilityDirectory` | 28 | 13 / 15 | 5 | 16 |
| `academy` | 28 | 8 / 20 | 8 | 28 |
| `comms` | 26 | 7 / 19 | 3 | 26 |
| `shop` | 25 | 4 / 21 | 0 **← ZERO** | 25 |
| `payroll` | 22 | 9 / 13 | 0 **← ZERO** | 22 |
| `closeout` | 20 | 2 / 18 | 0 **← ZERO** | 20 |
| `records` | 19 | 5 / 14 | 0 **← ZERO** | 17 |
| `workforce` | 16 | 3 / 13 | 0 **← ZERO** | 16 |
| `finance` | 15 | 9 / 6 | 2 | 15 |
| `commercialSetup` | 15 | 10 / 5 | 6 | 15 |
| `spatial` | 15 | 4 / 11 | 1 | 15 |
| `contractorOperations` | 14 | 3 / 11 | 0 **← ZERO** | 14 |
| `geo` | 14 | 6 / 8 | 1 | 14 |
| `compliance` | 13 | 7 / 6 | 0 **← ZERO** | 13 |
| `insurance` | 12 | 4 / 8 | 0 **← ZERO** | 12 |
| `enforcement` | 11 | 3 / 8 | 0 **← ZERO** | 11 |
| `integration` | 11 | 3 / 8 | 0 **← ZERO** | 11 |
| `hos` | 10 | 4 / 6 | 0 **← ZERO** | 10 |
| `asset` | 10 | 3 / 7 | 0 **← ZERO** | 7 |
| `restrictedVault` | 9 | 2 / 7 | 0 **← ZERO** | 9 |
| `manifestCustody` | 9 | 1 / 8 | 0 **← ZERO** | 9 |
| `securityIncidents` | 9 | 2 / 7 | 0 **← ZERO** | 9 |
| `board` | 9 | 3 / 6 | 0 **← ZERO** | 9 |
| `project` | 9 | 1 / 8 | 0 **← ZERO** | 9 |
| `assistantAsk` | 8 | 2 / 6 | 5 | 0 |
| `funding` | 8 | 5 / 3 | 0 **← ZERO** | 8 |
| `dispatch` | 8 | 3 / 5 | 0 **← ZERO** | 8 |
| `ar` | 8 | 1 / 7 | 0 **← ZERO** | 8 |
| `ifta` | 7 | 1 / 6 | 0 **← ZERO** | 7 |
| `fuel` | 7 | 2 / 5 | 0 **← ZERO** | 7 |
| `invoicing` | 7 | 1 / 6 | 0 **← ZERO** | 7 |
| `telematics` | 7 | 3 / 4 | 0 **← ZERO** | 7 |
| `automationPolicy` | 6 | 3 / 3 | 0 **← ZERO** | 6 |
| `surfaces` | 6 | 6 / 0 | 5 | 6 |
| `audit` | 6 | 2 / 4 | 0 **← ZERO** | 6 |
| `timeOff` | 5 | 2 / 3 | 0 **← ZERO** | 4 |
| `shifts` | 5 | 3 / 2 | 0 **← ZERO** | 5 |
| `agent` | 5 | 1 / 4 | 0 **← ZERO** | 5 |
| `gst` | 5 | 1 / 4 | 0 **← ZERO** | 5 |
| `crews` | 4 | 1 / 3 | 0 **← ZERO** | 4 |
| `vendor` | 4 | 0 / 4 | 0 **← ZERO** | 4 |
| `device` | 4 | 0 / 4 | 0 **← ZERO** | 4 |
| `requirement` | 4 | 1 / 3 | 0 **← ZERO** | 1 |
| `commercial` | 4 | 1 / 3 | 0 **← ZERO** | 4 |
| `widgets` | 3 | 2 / 1 | 3 | 3 |
| `calendar` | 3 | 3 / 0 | 0 **← ZERO** | 3 |
| `contractors` | 3 | 1 / 2 | 0 **← ZERO** | 3 |
| `sync` | 3 | 0 / 3 | 0 **← ZERO** | 2 |
| `calibration` | 3 | 1 / 2 | 0 **← ZERO** | 3 |
| `period` | 3 | 1 / 2 | 0 **← ZERO** | 3 |
| `bank` | 3 | 1 / 2 | 0 **← ZERO** | 3 |
| `portalAdmin` | 3 | 0 / 3 | 0 **← ZERO** | 3 |
| `system` | 2 | 1 / 1 | 0 **← ZERO** | 0 |
| `readiness` | 2 | 2 / 0 | 0 **← ZERO** | 2 |
| `portals` | 2 | 2 / 0 | 1 | 2 |
| `roadside` | 2 | 0 / 2 | 0 **← ZERO** | 2 |
| `purchasing` | 2 | 0 / 2 | 0 **← ZERO** | 2 |
| `inbound` | 2 | 1 / 1 | 0 **← ZERO** | 0 |
| `auth` | 2 | 1 / 1 | 2 | 0 |
| `recovery` | 1 | 0 / 1 | 0 **← ZERO** | 1 |

---

## Full procedure list

### `academy` — 28 procedures, 8 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `academy.assessmentOpen` | mutation | `academy.assessment_own` | yes | no |
| `academy.assessmentSubmit` | mutation | `academy.assessment_own` | yes | no |
| `academy.assign` | mutation | `academy.assign` | **no** | yes |
| `academy.assignmentDetail` | query | `academy.read_own` | yes | yes |
| `academy.catalog` | query | `academy.read_own` | yes | no |
| `academy.certificateIssue` | mutation | `academy.certificate.issue` | **no** | yes |
| `academy.certificateSignOwn` | mutation | `academy.certificate.sign_own` | yes | no |
| `academy.directSupervisionAttest` | mutation | `academy.direct_supervision_attest_own` | **no** | yes |
| `academy.directSupervisionCreate` | mutation | `academy.direct_supervision.manage` | **no** | yes |
| `academy.dispatchCheck` | query | `dispatch.evaluate` | **no** | yes |
| `academy.foreignTdgRoadRecognize` | mutation | `compliance.credential.verify` | **no** | no |
| `academy.inspectorRequestAssemble` | mutation | `academy.certificate.issue` | **no** | yes |
| `academy.inspectorRequestCreate` | mutation | `academy.certificate.issue` | **no** | yes |
| `academy.inspectorRequestList` | query | `academy.certificate.issue` | **no** | yes |
| `academy.moduleComplete` | mutation | `academy.progress_own` | yes | no |
| `academy.myTraining` | query | `academy.read_own` | yes | no |
| `academy.practicalSignoff` | mutation | `academy.evaluate` | **no** | no |
| `academy.requirementList` | query | `academy.read_own` | **no** | no |
| `academy.requirementUpsert` | mutation | `academy.requirement.manage` | **no** | no |
| `academy.sheetPrintRun` | mutation | `academy.manage` | **no** | yes |
| `academy.sheetScanFile` | mutation | `academy.evaluate` | **no** | yes |
| `academy.sourceReview` | mutation | `academy.source.review` | **no** | no |
| `academy.statementOfExperienceCreate` | mutation | `academy.certificate.issue` | **no** | no |
| `academy.syncCatalog` | mutation | `academy.manage` | **no** | no |
| `academy.tdgCoverageApprove` | mutation | `academy.source.review` | **no** | yes |
| `academy.tdgCoverageSet` | mutation | `academy.manage` | **no** | yes |
| `academy.tdgCoverageStatus` | query | `academy.read_own` | **no** | yes |
| `academy.ticketPortfolio` | query | `academy.read_own` | yes | no |

### `agent` — 5 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `agent.awaitEvent` | mutation | `agent.act` | **no** | yes |
| `agent.decideApproval` | mutation | `agent.approve` | **no** | yes |
| `agent.get` | query | `agent.read` | **no** | yes |
| `agent.requestAction` | mutation | `agent.act` | **no** | yes |
| `agent.start` | mutation | `agent.use` | **no** | yes |

### `ar` — 8 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `ar.aging` | query | `ar.read` | **no** | yes |
| `ar.collectionEvent` | mutation | `ar.collect` | **no** | yes |
| `ar.creditDecide` | mutation | `ar.credit.decide` | **no** | yes |
| `ar.creditRequest` | mutation | `ar.credit.request` | **no** | yes |
| `ar.paymentAllocate` | mutation | `ar.payment.apply` | **no** | yes |
| `ar.paymentRecord` | mutation | `ar.payment.record` | **no** | yes |
| `ar.writeOffDecide` | mutation | `ar.writeoff.decide` | **no** | yes |
| `ar.writeOffRequest` | mutation | `ar.writeoff.request` | **no** | yes |

### `asset` — 10 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `asset.capitalReview` | mutation | `asset.capital.review` | **no** | yes |
| `asset.ccaClassSet` | mutation | `asset.cca.classify` | **no** | yes |
| `asset.ccaClassVerify` | mutation | `asset.cca.verify` | **no** | yes |
| `asset.dispose` | mutation | `asset.register` | **no** | yes |
| `asset.list` | query | `asset.read` | **no** | no |
| `asset.register` | mutation | `asset.register` | **no** | yes |
| `asset.schedule` | query | — | **no** | yes |
| `asset.schedulePrepare` | mutation | — | **no** | yes |
| `asset.scheduleReview` | mutation | — | **no** | yes |
| `asset.twin` | query | `asset.read` | **no** | yes |

### `assistantAsk` — 8 procedures, 5 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `assistantAsk.addPassage` | mutation | — | **no** | yes |
| `assistantAsk.addProbe` | mutation | — | **no** | yes |
| `assistantAsk.addProbeFromAsk` | mutation | — | yes | yes |
| `assistantAsk.ask` | mutation | — | yes | yes |
| `assistantAsk.history` | query | — | yes | yes |
| `assistantAsk.measureRetrieval` | mutation | — | yes | yes |
| `assistantAsk.passageList` | query | — | yes | yes |
| `assistantAsk.supersedePassage` | mutation | — | **no** | yes |

### `audit` — 6 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `audit.packageDownload` | mutation | `audit.package.read` | **no** | yes |
| `audit.packageGet` | query | `audit.package.read` | **no** | yes |
| `audit.packageList` | query | `audit.package.read` | **no** | yes |
| `audit.packagePrepare` | mutation | `audit.package.prepare` | **no** | yes |
| `audit.packageRelease` | mutation | `audit.package.release` | **no** | yes |
| `audit.packageWithdraw` | mutation | `audit.package.release` | **no** | no |

### `auth` — 2 procedures, 2 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `auth.logout` | mutation | — | yes | yes |
| `auth.me` | query | — | yes | no |

### `automationPolicy` — 6 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `automationPolicy.history` | query | `automation.policy.read` | **no** | yes |
| `automationPolicy.operationalOverride` | mutation | `automation.override.operational` | **no** | yes |
| `automationPolicy.resolve` | query | `automation.policy.read` | **no** | yes |
| `automationPolicy.set` | mutation | `automation.policy.manage` | **no** | yes |
| `automationPolicy.setEntitlement` | mutation | `automation.policy.manage` | **no** | yes |
| `automationPolicy.snapshotFor` | query | `automation.policy.read` | **no** | yes |

### `bank` — 3 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `bank.accountRegister` | mutation | `bank.import` | **no** | yes |
| `bank.reconciliation` | query | `bank.read` | **no** | no |
| `bank.statementImport` | mutation | `bank.import` | **no** | yes |

### `board` — 9 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `board.acknowledge` | mutation | `board.read` | **no** | yes |
| `board.acknowledgements` | query | `board.read` | **no** | yes |
| `board.createChannel` | mutation | `board.manage` | **no** | yes |
| `board.edit` | mutation | `board.post` | **no** | yes |
| `board.history` | query | `board.read` | **no** | yes |
| `board.open` | mutation | `board.read` | **no** | yes |
| `board.post` | mutation | `board.post` | **no** | yes |
| `board.read` | query | `board.read` | **no** | yes |
| `board.withdraw` | mutation | `board.post` | **no** | yes |

### `calendar` — 3 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `calendar.exceptions` | query | `calendar.scheduling` | **no** | yes |
| `calendar.forScheduling` | query | `calendar.scheduling` | **no** | yes |
| `calendar.mine` | query | `calendar.own` | **no** | yes |

### `calibration` — 3 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `calibration.deviceRegister` | mutation | `calibration.record` | **no** | yes |
| `calibration.eventRecord` | mutation | `calibration.record` | **no** | yes |
| `calibration.impact` | query | `calibration.impact` | **no** | yes |

### `closeout` — 20 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `closeout.adjustmentPayrollPropose` | mutation | `closeout.adjustment.payroll_propose` | **no** | yes |
| `closeout.authoritySet` | mutation | `closeout.authority.manage` | **no** | yes |
| `closeout.completionPackageRender` | mutation | `closeout.document.render` | **no** | yes |
| `closeout.delayRecord` | mutation | `closeout.delay.record` | **no** | no |
| `closeout.documentRender` | mutation | `closeout.document.render` | **no** | yes |
| `closeout.eventClose` | mutation | `closeout.event.record` | **no** | no |
| `closeout.eventRecord` | mutation | `closeout.event.record` | **no** | no |
| `closeout.lineAdd` | mutation | `closeout.ticket.write` | **no** | yes |
| `closeout.lineDecide` | mutation | `closeout.line.decide` | **no** | yes |
| `closeout.roadHazardReport` | mutation | `observation.record` | **no** | no |
| `closeout.sitePrepare` | mutation | `closeout.ticket.write` | **no** | no |
| `closeout.siteSign` | mutation | `closeout.sign.witness` | **no** | yes |
| `closeout.state` | query | `closeout.read` | **no** | yes |
| `closeout.supplementPrepare` | mutation | `closeout.supplement.prepare` | **no** | yes |
| `closeout.termsApply` | mutation | `closeout.terms.record` | **no** | yes |
| `closeout.termsApprove` | mutation | `closeout.terms.approve` | **no** | yes |
| `closeout.termsRecord` | mutation | `closeout.terms.record` | **no** | yes |
| `closeout.ticketOpen` | mutation | `closeout.ticket.write` | **no** | yes |
| `closeout.weatherObserve` | mutation | `observation.record` | **no** | no |
| `closeout.whyTheseHours` | query | `closeout.read` | **no** | no |

### `commercial` — 4 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `commercial.billingCheck` | query | `commercial.read` | **no** | yes |
| `commercial.poRecord` | mutation | `commercial.po.record` | **no** | yes |
| `commercial.rateCardCreate` | mutation | `commercial.ratecard.manage` | **no** | yes |
| `commercial.termsSet` | mutation | `commercial.terms.manage` | **no** | yes |

### `commercialOffice` — 43 procedures, 15 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `commercialOffice.ap.agingByOrganization` | query | — | yes | yes |
| `commercialOffice.approvals.policies` | query | — | **no** | yes |
| `commercialOffice.approvals.policyRetire` | mutation | — | **no** | no |
| `commercialOffice.approvals.policySet` | mutation | — | **no** | yes |
| `commercialOffice.approvals.requirement` | query | — | **no** | yes |
| `commercialOffice.ar.agingByOrganization` | query | — | yes | yes |
| `commercialOffice.ar.approvalLedger` | query | — | **no** | yes |
| `commercialOffice.categories.create` | mutation | — | **no** | yes |
| `commercialOffice.categories.list` | query | — | **no** | yes |
| `commercialOffice.disposal.lineResolve` | mutation | — | yes | yes |
| `commercialOffice.disposal.statementClose` | mutation | — | **no** | yes |
| `commercialOffice.disposal.statementImport` | mutation | — | **no** | yes |
| `commercialOffice.disposal.statementLines` | query | — | yes | yes |
| `commercialOffice.disposal.statements` | query | — | yes | yes |
| `commercialOffice.documents.deliveryRecord` | mutation | — | **no** | yes |
| `commercialOffice.documents.deliveryUpdate` | mutation | — | **no** | yes |
| `commercialOffice.documents.get` | query | — | yes | yes |
| `commercialOffice.documents.link` | mutation | — | **no** | no |
| `commercialOffice.documents.list` | query | — | yes | yes |
| `commercialOffice.documents.register` | mutation | — | **no** | yes |
| `commercialOffice.documents.retentionAssign` | mutation | — | **no** | yes |
| `commercialOffice.documents.supersede` | mutation | — | **no** | yes |
| `commercialOffice.documents.withdraw` | mutation | — | **no** | yes |
| `commercialOffice.gl.accountSet` | mutation | — | **no** | yes |
| `commercialOffice.gl.exportReadiness` | query | — | yes | yes |
| `commercialOffice.gl.list` | query | — | **no** | yes |
| `commercialOffice.gl.mappingSet` | mutation | — | **no** | yes |
| `commercialOffice.links.candidates` | query | — | yes | yes |
| `commercialOffice.links.end` | mutation | — | **no** | yes |
| `commercialOffice.links.list` | query | — | **no** | yes |
| `commercialOffice.links.set` | mutation | — | yes | yes |
| `commercialOffice.numbering.list` | query | — | **no** | yes |
| `commercialOffice.numbering.set` | mutation | — | **no** | yes |
| `commercialOffice.organizations.create` | mutation | — | yes | yes |
| `commercialOffice.organizations.list` | query | — | yes | yes |
| `commercialOffice.profitability.byDimension` | query | — | yes | yes |
| `commercialOffice.roleTypes.create` | mutation | — | **no** | yes |
| `commercialOffice.roleTypes.list` | query | — | yes | yes |
| `commercialOffice.roles.assign` | mutation | — | yes | yes |
| `commercialOffice.roles.end` | mutation | — | **no** | no |
| `commercialOffice.roles.list` | query | — | **no** | no |
| `commercialOffice.settings.get` | query | — | **no** | yes |
| `commercialOffice.settings.set` | mutation | — | **no** | yes |

### `commercialSetup` — 15 procedures, 6 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `commercialSetup.decisionGet` | query | `commercial.rates.read` | **no** | no |
| `commercialSetup.definitionApprove` | mutation | `commercial.rates.approve` | yes | yes |
| `commercialSetup.definitionList` | query | `commercial.rates.read` | yes | yes |
| `commercialSetup.definitionPropose` | mutation | `commercial.rates.propose` | yes | yes |
| `commercialSetup.definitionReject` | mutation | `commercial.rates.approve` | **no** | no |
| `commercialSetup.goLiveReadiness` | query | `commercial.rates.read` | yes | yes |
| `commercialSetup.marginSimulate` | query | `commercial.margin.view` | **no** | yes |
| `commercialSetup.poExposure` | query | `commercial.read` | **no** | no |
| `commercialSetup.pricingDecide` | mutation | `commercial.pricing.decide` | **no** | no |
| `commercialSetup.profileGet` | query | `commercial.rates.read` | yes | yes |
| `commercialSetup.profileSet` | mutation | `commercial.setup.write` | yes | yes |
| `commercialSetup.rateResolve` | query | `commercial.rates.read` | **no** | no |
| `commercialSetup.sheetGaps` | query | `commercial.rates.read` | **no** | no |
| `commercialSetup.ticketPricing` | query | `commercial.rates.read` | **no** | no |
| `commercialSetup.vendorRateVariances` | query | `commercial.rates.read` | **no** | no |

### `comms` — 26 procedures, 3 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `comms.assignmentRecord` | mutation | `comms.assignment.record` | **no** | yes |
| `comms.assignmentVerify` | mutation | `comms.assignment.verify` | **no** | no |
| `comms.assignmentsForSegments` | query | `comms.read` | **no** | yes |
| `comms.authorizationRecord` | mutation | `comms.authorization.manage` | **no** | yes |
| `comms.authorizationVerify` | mutation | `comms.authorization.verify` | **no** | yes |
| `comms.channelList` | query | `comms.read` | **no** | yes |
| `comms.channelRetire` | mutation | `comms.channel.verify` | **no** | yes |
| `comms.channelSeed` | mutation | `comms.channel.manage` | **no** | yes |
| `comms.channelVerify` | mutation | `comms.channel.verify` | **no** | yes |
| `comms.coverageRecord` | mutation | `comms.assignment.record` | **no** | yes |
| `comms.oosPolicyApprove` | mutation | `oos.policy.approve` | **no** | yes |
| `comms.oosPolicyPropose` | mutation | `oos.policy.manage` | **no** | yes |
| `comms.packageAcknowledge` | mutation | `comms.package.fetch` | **no** | yes |
| `comms.packageBuild` | mutation | `comms.package.build` | **no** | yes |
| `comms.packageFetch` | mutation | `comms.package.fetch` | yes | yes |
| `comms.packageStatus` | query | `comms.read` | yes | yes |
| `comms.planForPath` | mutation | `comms.plan.compute` | **no** | yes |
| `comms.planGet` | query | `comms.read` | **no** | yes |
| `comms.policyApprove` | mutation | `comms.policy.approve` | **no** | yes |
| `comms.policyCurrent` | query | `comms.read` | **no** | yes |
| `comms.policyPropose` | mutation | `comms.policy.manage` | **no** | yes |
| `comms.signDecide` | mutation | `comms.observation.decide` | **no** | yes |
| `comms.signObserve` | mutation | `comms.observation.record` | **no** | yes |
| `comms.signQueue` | query | `comms.read` | **no** | yes |
| `comms.transmitCheck` | query | `comms.read` | yes | yes |
| `comms.unitCapabilitySet` | mutation | `comms.unit.capability` | **no** | yes |

### `compliance` — 13 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `compliance.consentRecord` | mutation | `compliance.consent.record` | **no** | no |
| `compliance.credentialRecord` | mutation | `compliance.credential.record` | **no** | yes |
| `compliance.credentialVerify` | mutation | `compliance.credential.verify` | **no** | yes |
| `compliance.dangerousGoodsAssist` | query | `compliance.work.evaluate` | **no** | no |
| `compliance.driverQualification` | query | `compliance.work.evaluate` | **no** | no |
| `compliance.jobPassport` | query | `compliance.passport.read` | **no** | no |
| `compliance.knowledgeCatalog` | query | `compliance.passport.read` | **no** | no |
| `compliance.medicalEligibility` | query | `compliance.passport.read` | **no** | yes |
| `compliance.passport` | query | `compliance.passport.read` | **no** | yes |
| `compliance.profileReviewRecord` | mutation | `compliance.profile.review` | **no** | yes |
| `compliance.programPublish` | mutation | `compliance.program.publish` | **no** | yes |
| `compliance.requirementLoad` | mutation | `compliance.requirement.manage` | **no** | yes |
| `compliance.securementAssist` | query | `compliance.work.evaluate` | **no** | no |

### `contractorOperations` — 14 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `contractorOperations.crewAssign` | mutation | `dispatch.assign` | **no** | no |
| `contractorOperations.jobChainCreate` | mutation | `contractor.write` | **no** | yes |
| `contractorOperations.loadLink` | mutation | `contractor.write` | **no** | no |
| `contractorOperations.payableApprove` | mutation | `contractor.approve` | **no** | yes |
| `contractorOperations.payablePrepare` | mutation | `contractor.write` | **no** | yes |
| `contractorOperations.payableSubmitReview` | mutation | `contractor.write` | **no** | yes |
| `contractorOperations.payablesMine` | query | `contractor.read` | **no** | yes |
| `contractorOperations.profileUpsert` | mutation | `contractor.write` | **no** | yes |
| `contractorOperations.rateSet` | mutation | `contractor.approve` | **no** | yes |
| `contractorOperations.ratesMine` | query | `contractor.read` | **no** | yes |
| `contractorOperations.relationshipAccept` | mutation | `contractor.approve` | **no** | yes |
| `contractorOperations.relationshipCreate` | mutation | `contractor.write` | **no** | yes |
| `contractorOperations.relationships` | query | `contractor.read` | **no** | yes |
| `contractorOperations.workerAdd` | mutation | `contractor.write` | **no** | no |

### `contractors` — 3 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `contractors.settlementApprove` | mutation | `contractor.approve` | **no** | no |
| `contractors.settlementCreate` | mutation | `contractor.write` | **no** | yes |
| `contractors.settlementsList` | query | `contractor.read` | **no** | yes |

### `crews` — 4 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `crews.addMember` | mutation | `crews.manage` | **no** | yes |
| `crews.create` | mutation | `crews.manage` | **no** | yes |
| `crews.forecast` | query | `crews.read` | **no** | yes |
| `crews.removeMember` | mutation | `crews.manage` | **no** | yes |

### `device` — 4 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `device.activate` | mutation | `device.enroll_own` | **no** | yes |
| `device.enroll` | mutation | `device.enroll_own` | **no** | yes |
| `device.revoke` | mutation | `device.manage` | **no** | yes |
| `device.rotateKey` | mutation | `device.rotate_own` | **no** | yes |

### `dispatch` — 8 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `dispatch.award` | mutation | `dispatch.award` | **no** | yes |
| `dispatch.enforcementGet` | query | `dispatch.read` | **no** | yes |
| `dispatch.enforcementSet` | mutation | `dispatch.enforcement.manage` | **no** | yes |
| `dispatch.evaluate` | mutation | `dispatch.evaluate` | **no** | yes |
| `dispatch.overrideGrant` | mutation | `dispatch.override.grant` | **no** | yes |
| `dispatch.overrideRequest` | mutation | `dispatch.override.request` | **no** | yes |
| `dispatch.readiness` | query | `dispatch.read` | **no** | yes |
| `dispatch.whatAmIMissing` | query | `dispatch.readiness_own` | **no** | yes |

### `enforcement` — 11 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `enforcement.activeOrders` | query | `enforcement.read` | **no** | yes |
| `enforcement.eventConfirm` | mutation | `enforcement.confirm` | **no** | yes |
| `enforcement.eventGet` | query | `enforcement.read` | **no** | yes |
| `enforcement.extractionRecord` | mutation | `enforcement.capture` | **no** | yes |
| `enforcement.findingRecord` | mutation | `enforcement.finding.record` | **no** | yes |
| `enforcement.latchReport` | mutation | `enforcement.latch` | **no** | yes |
| `enforcement.latchStates` | query | `enforcement.latch` | **no** | yes |
| `enforcement.orderRelease` | mutation | `enforcement.release` | **no** | yes |
| `enforcement.panelGrantIssue` | mutation | `enforcement.panel.issue` | **no** | yes |
| `enforcement.panelGrantRevoke` | mutation | `enforcement.panel.issue` | **no** | yes |
| `enforcement.panelView` | mutation | `enforcement.panel.view` | **no** | yes |

### `facilityDirectory` — 28 procedures, 5 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `facilityDirectory.arcgis.importFeatures` | mutation | — | **no** | yes |
| `facilityDirectory.arcgis.importFromLayer` | mutation | — | **no** | no |
| `facilityDirectory.arcgis.inspect` | mutation | — | **no** | no |
| `facilityDirectory.arcgis.presets` | query | — | **no** | yes |
| `facilityDirectory.arcgis.runs` | query | — | **no** | yes |
| `facilityDirectory.assessLoad` | mutation | `facility.directory.write` | **no** | yes |
| `facilityDirectory.assessments` | query | `facility.directory.read` | **no** | yes |
| `facilityDirectory.callAhead.record` | mutation | — | yes | yes |
| `facilityDirectory.capabilitySet` | mutation | `facility.directory.review` | **no** | yes |
| `facilityDirectory.coordinateVerify` | mutation | `facility.directory.review` | **no** | yes |
| `facilityDirectory.driverView` | query | `facility.directory.read` | yes | yes |
| `facilityDirectory.duplicates` | query | `facility.directory.review` | **no** | yes |
| `facilityDirectory.evidenceRecord` | mutation | `facility.directory.write` | **no** | yes |
| `facilityDirectory.evidenceReview` | mutation | `facility.directory.review` | **no** | yes |
| `facilityDirectory.exportCsv` | query | `facility.directory.read` | **no** | no |
| `facilityDirectory.exportGeoJson` | query | `facility.directory.read` | **no** | no |
| `facilityDirectory.features` | query | `facility.directory.read` | **no** | yes |
| `facilityDirectory.get` | query | `facility.directory.read` | **no** | yes |
| `facilityDirectory.hours.set` | mutation | — | **no** | yes |
| `facilityDirectory.hydrovac.import` | mutation | — | **no** | yes |
| `facilityDirectory.licences.list` | query | — | **no** | yes |
| `facilityDirectory.lsdFind` | query | `facility.directory.read` | yes | yes |
| `facilityDirectory.nearby` | query | `facility.directory.read` | **no** | yes |
| `facilityDirectory.seedBrief` | mutation | `facility.directory.review` | **no** | yes |
| `facilityDirectory.seedLeads` | mutation | `facility.directory.review` | **no** | yes |
| `facilityDirectory.vocabulary.list` | query | — | yes | yes |
| `facilityDirectory.vocabulary.verify` | mutation | — | **no** | no |
| `facilityDirectory.wait.report` | mutation | — | yes | yes |

### `fieldRoute` — 85 procedures, 53 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `fieldRoute.assistant.acknowledge` | mutation | — | **no** | no |
| `fieldRoute.assistant.answer` | mutation | — | **no** | no |
| `fieldRoute.assistant.commit` | mutation | — | **no** | yes |
| `fieldRoute.assistant.draft` | mutation | — | yes | no |
| `fieldRoute.assistant.forms` | query | — | **no** | yes |
| `fieldRoute.assistant.get` | query | — | **no** | yes |
| `fieldRoute.assistant.pending` | query | — | **no** | yes |
| `fieldRoute.assistant.readBack` | mutation | — | **no** | no |
| `fieldRoute.assistant.reject` | mutation | — | **no** | yes |
| `fieldRoute.assistant.setStatus` | mutation | — | **no** | yes |
| `fieldRoute.billing.lines.create` | mutation | — | yes | no |
| `fieldRoute.billing.lines.list` | query | — | **no** | yes |
| `fieldRoute.billing.rateCards.create` | mutation | — | yes | yes |
| `fieldRoute.billing.rateCards.list` | query | — | yes | yes |
| `fieldRoute.billing.rateCards.update` | mutation | — | **no** | yes |
| `fieldRoute.compliance.deliveries.create` | mutation | — | yes | yes |
| `fieldRoute.compliance.deliveries.list` | query | — | yes | no |
| `fieldRoute.compliance.facilities.create` | mutation | — | yes | yes |
| `fieldRoute.compliance.facilities.list` | query | — | yes | no |
| `fieldRoute.compliance.loads.create` | mutation | — | yes | yes |
| `fieldRoute.compliance.loads.list` | query | — | **no** | yes |
| `fieldRoute.compliance.maintenance.create` | mutation | — | yes | yes |
| `fieldRoute.compliance.maintenance.list` | query | — | yes | yes |
| `fieldRoute.compliance.sign` | mutation | — | yes | yes |
| `fieldRoute.complianceEngine.artifacts.create` | mutation | — | yes | yes |
| `fieldRoute.complianceEngine.artifacts.list` | query | — | yes | no |
| `fieldRoute.complianceEngine.tailgates.create` | mutation | — | yes | yes |
| `fieldRoute.complianceEngine.tailgates.list` | query | — | yes | no |
| `fieldRoute.complianceEngine.transfers.acknowledge` | mutation | — | yes | yes |
| `fieldRoute.complianceEngine.transfers.create` | mutation | — | yes | yes |
| `fieldRoute.complianceEngine.transfers.list` | query | — | yes | yes |
| `fieldRoute.dutyRecords.create` | mutation | — | yes | yes |
| `fieldRoute.dutyRecords.list` | query | — | yes | yes |
| `fieldRoute.evidence.add` | mutation | — | **no** | yes |
| `fieldRoute.evidence.list` | query | — | yes | no |
| `fieldRoute.evidence.upload` | mutation | — | yes | yes |
| `fieldRoute.evidence.verify` | mutation | — | yes | yes |
| `fieldRoute.gps.breadcrumbs` | query | — | **no** | yes |
| `fieldRoute.gps.confirmZoneEvent` | mutation | — | **no** | yes |
| `fieldRoute.gps.pendingZoneEvents` | query | — | **no** | no |
| `fieldRoute.gps.submitBreadcrumb` | mutation | — | **no** | yes |
| `fieldRoute.gps.zoneEvents` | query | — | **no** | yes |
| `fieldRoute.identity.documents.create` | mutation | — | yes | yes |
| `fieldRoute.identity.documents.list` | query | — | yes | yes |
| `fieldRoute.identity.documents.review` | mutation | — | yes | yes |
| `fieldRoute.identity.inspections.create` | mutation | — | yes | yes |
| `fieldRoute.identity.inspections.list` | query | — | **no** | no |
| `fieldRoute.identity.jobUnits.create` | mutation | — | yes | yes |
| `fieldRoute.identity.jobUnits.list` | query | — | yes | no |
| `fieldRoute.identity.operators.create` | mutation | — | **no** | yes |
| `fieldRoute.identity.operators.list` | query | — | yes | yes |
| `fieldRoute.identity.units.create` | mutation | — | yes | yes |
| `fieldRoute.identity.units.list` | query | — | yes | yes |
| `fieldRoute.jobs.byCode` | query | — | **no** | yes |
| `fieldRoute.jobs.create` | mutation | — | **no** | yes |
| `fieldRoute.jobs.list` | query | — | **no** | yes |
| `fieldRoute.locations.create` | mutation | — | **no** | yes |
| `fieldRoute.locations.list` | query | — | yes | no |
| `fieldRoute.manifests.create` | mutation | — | **no** | yes |
| `fieldRoute.manifests.list` | query | — | yes | yes |
| `fieldRoute.operatingZones.create` | mutation | — | yes | yes |
| `fieldRoute.operatingZones.list` | query | — | yes | no |
| `fieldRoute.routeContext.create` | mutation | — | **no** | yes |
| `fieldRoute.routeContext.list` | query | — | yes | no |
| `fieldRoute.routeDecisions.create` | mutation | — | yes | yes |
| `fieldRoute.routeDecisions.list` | query | — | yes | yes |
| `fieldRoute.safety.create` | mutation | — | yes | yes |
| `fieldRoute.safety.list` | query | — | yes | yes |
| `fieldRoute.scans.create` | mutation | — | yes | yes |
| `fieldRoute.scans.list` | query | — | **no** | yes |
| `fieldRoute.tripStops.create` | mutation | — | yes | yes |
| `fieldRoute.tripStops.list` | query | — | yes | yes |
| `fieldRoute.tripStops.update` | mutation | — | **no** | yes |
| `fieldRoute.trips.create` | mutation | — | yes | yes |
| `fieldRoute.trips.list` | query | — | yes | yes |
| `fieldRoute.trips.update` | mutation | — | **no** | no |
| `fieldRoute.unitSafety.create` | mutation | — | yes | no |
| `fieldRoute.unitSafety.list` | query | — | yes | no |
| `fieldRoute.unitSafety.update` | mutation | — | **no** | no |
| `fieldRoute.vendors.create` | mutation | — | yes | yes |
| `fieldRoute.vendors.list` | query | — | yes | yes |
| `fieldRoute.vendors.update` | mutation | — | **no** | yes |
| `fieldRoute.workOrders.create` | mutation | — | yes | yes |
| `fieldRoute.workOrders.list` | query | — | yes | yes |
| `fieldRoute.workOrders.update` | mutation | — | **no** | no |

### `finance` — 15 procedures, 2 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `finance.entitiesList` | query | `tax.read_business` | yes | yes |
| `finance.entityCreate` | mutation | `finance.entity.write` | yes | yes |
| `finance.expenseAssess` | query | `tax.expense.create` | **no** | yes |
| `finance.expenseCreate` | mutation | `tax.expense.create` | **no** | no |
| `finance.expenseDuplicates` | query | `tax.expense.review` | **no** | no |
| `finance.expenseSetTreatment` | mutation | `tax.expense.review` | **no** | yes |
| `finance.expensesList` | query | `tax.read_business` | **no** | yes |
| `finance.filingProfile` | query | `tax.read_business` | **no** | yes |
| `finance.myTaxDocAdd` | mutation | `tax.read_personal_own` | **no** | yes |
| `finance.myTaxDocShare` | mutation | `tax.read_personal_own` | **no** | yes |
| `finance.myTaxDocs` | query | `tax.read_personal_own` | **no** | yes |
| `finance.registrationsList` | query | `tax.read_business` | **no** | yes |
| `finance.taxRuleLoad` | mutation | `tax.rules.manage` | **no** | yes |
| `finance.taxRulesList` | query | `tax.read_business` | **no** | yes |
| `finance.thresholdCheck` | query | `tax.read_business` | **no** | yes |

### `fuel` — 7 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `fuel.anomalies` | query | `fuel.review` | **no** | yes |
| `fuel.dispenseRecord` | mutation | `fuel.dispense.record` | **no** | yes |
| `fuel.readingRecord` | mutation | `fuel.reading.record` | **no** | yes |
| `fuel.statementImport` | mutation | `fuel.statement.import` | **no** | yes |
| `fuel.statementLineResolve` | mutation | `fuel.statement.import` | **no** | yes |
| `fuel.tankReconcile` | query | `fuel.review` | **no** | yes |
| `fuel.tankRegister` | mutation | `fuel.tank.manage` | **no** | yes |

### `funding` — 8 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `funding.claimRecord` | mutation | `funding.claim` | **no** | yes |
| `funding.match` | query | `funding.read` | **no** | yes |
| `funding.opportunitiesList` | query | `funding.read` | **no** | no |
| `funding.opportunityAdvance` | mutation | `funding.manage` | **no** | yes |
| `funding.programLoad` | mutation | `funding.programs.manage` | **no** | yes |
| `funding.programsList` | query | `funding.read` | **no** | yes |
| `funding.purchaseAdvisory` | query | `funding.read` | **no** | yes |
| `funding.stackingCheck` | query | `funding.read` | **no** | yes |

### `geo` — 14 procedures, 1 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `geo.accessConfirmPassage` | mutation | `geo.access.passage` | **no** | yes |
| `geo.accessDecide` | mutation | `geo.access.decide` | **no** | yes |
| `geo.accessForLsd` | query | `geo.read` | **no** | yes |
| `geo.accessPropose` | mutation | `geo.access.propose` | **no** | yes |
| `geo.accessRoadsImport` | mutation | `geo.import` | **no** | yes |
| `geo.atsImportTownship` | mutation | `geo.import` | **no** | yes |
| `geo.corridorEvaluate` | query | `geo.read` | **no** | yes |
| `geo.coverage` | query | `geo.read` | **no** | yes |
| `geo.graphBuild` | mutation | `geo.graph.build` | **no** | yes |
| `geo.locationVerifyFromGrid` | mutation | `geo.locationVerifyFromGrid` | **no** | yes |
| `geo.lsdLocate` | query | `geo.read` | **no** | yes |
| `geo.positionToLsd` | query | `geo.read` | **no** | yes |
| `geo.routeCompute` | query | `geo.read` | yes | yes |
| `geo.sourceReview` | mutation | `geo.source.review` | **no** | yes |

### `gst` — 5 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `gst.adjustmentRecord` | mutation | `gst.prepare` | **no** | yes |
| `gst.return` | query | `gst.read` | **no** | yes |
| `gst.returnFinalize` | mutation | `gst.finalize` | **no** | yes |
| `gst.returnPrepare` | mutation | `gst.prepare` | **no** | yes |
| `gst.treatmentSet` | mutation | `gst.classify` | **no** | yes |

### `hos` — 10 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `hos.attestHours` | mutation | `hos.attest` | **no** | yes |
| `hos.limitPromote` | mutation | `hos.rule.verify` | **no** | yes |
| `hos.limitVerify` | mutation | `hos.rule.verify` | **no** | yes |
| `hos.profileFor` | query | `hos.read` | **no** | yes |
| `hos.profileList` | query | `hos.read` | **no** | yes |
| `hos.profileSeed` | mutation | `hos.rule.manage` | **no** | yes |
| `hos.profileVerify` | mutation | `hos.rule.verify` | **no** | yes |
| `hos.recordScannedLog` | mutation | `hos.recordScannedLog` | **no** | yes |
| `hos.status` | query | `hos.read` | **no** | yes |
| `hos.tripFeasibility` | query | `hos.read` | **no** | yes |

### `ifta` — 7 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `ifta.distanceRecord` | mutation | `ifta.distance.record` | **no** | yes |
| `ifta.distanceVerify` | mutation | `ifta.distance.verify` | **no** | yes |
| `ifta.fuelJurisdictionSet` | mutation | `ifta.fuel.classify` | **no** | yes |
| `ifta.quarter` | query | `ifta.read` | **no** | yes |
| `ifta.quarterFinalize` | mutation | `ifta.finalize` | **no** | yes |
| `ifta.quarterPrepare` | mutation | `ifta.prepare` | **no** | yes |
| `ifta.tripSplit` | mutation | `ifta.distance.record` | **no** | yes |

### `inbound` — 2 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `inbound.ingest` | mutation | — | **no** | yes |
| `inbound.me` | query | — | **no** | yes |

### `insurance` — 12 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `insurance.certificateIssue` | mutation | `insurance.certificate.issue` | **no** | yes |
| `insurance.claimCostRecord` | mutation | `insurance.claim.financial` | **no** | yes |
| `insurance.claimFinancials` | query | `insurance.claim.financial` | **no** | yes |
| `insurance.claimOpen` | mutation | `insurance.claim.create` | **no** | yes |
| `insurance.claimRecoveryRecord` | mutation | `insurance.claim.financial` | **no** | yes |
| `insurance.coverageAssign` | mutation | `insurance.write_policy` | **no** | yes |
| `insurance.coverageForEntity` | query | `insurance.read_summary` | **no** | yes |
| `insurance.coverageVerify` | mutation | `insurance.verify_coverage` | **no** | yes |
| `insurance.policyRecord` | mutation | `insurance.write_policy` | **no** | yes |
| `insurance.renewalCalendar` | query | `insurance.read_policy` | **no** | yes |
| `insurance.requirementMatch` | query | `insurance.read_policy` | **no** | yes |
| `insurance.requirementSet` | mutation | `insurance.manage_requirements` | **no** | yes |

### `integration` — 11 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `integration.clientRegister` | mutation | `integration.client.manage` | **no** | yes |
| `integration.clientRevoke` | mutation | `integration.client.manage` | **no** | yes |
| `integration.deliveries` | query | `integration.read` | **no** | yes |
| `integration.inboundList` | query | `integration.read` | **no** | yes |
| `integration.loadSenseBindGateway` | mutation | `integration.client.manage` | **no** | no |
| `integration.loadSenseCalibrate` | mutation | `integration.client.manage` | **no** | no |
| `integration.ownershipAssign` | mutation | `integration.client.manage` | **no** | yes |
| `integration.ownershipList` | query | `integration.read` | **no** | no |
| `integration.webhookDispatch` | mutation | `integration.webhook.manage` | **no** | yes |
| `integration.webhookSetStatus` | mutation | `integration.webhook.manage` | **no** | yes |
| `integration.webhookSubscribe` | mutation | `integration.webhook.manage` | **no** | yes |

### `invoicing` — 7 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `invoicing.disputeResolve` | mutation | `invoicing.dispute.resolve` | **no** | no |
| `invoicing.draftFromTicket` | mutation | `invoicing.draft` | **no** | no |
| `invoicing.finalize` | mutation | `invoicing.finalize` | **no** | yes |
| `invoicing.get` | query | `invoicing.read` | **no** | no |
| `invoicing.render` | mutation | `invoicing.render` | **no** | no |
| `invoicing.send` | mutation | `invoicing.send` | **no** | no |
| `invoicing.void` | mutation | `invoicing.void` | **no** | yes |

### `manifestCustody` — 9 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `manifestCustody.amend` | mutation | `manifest.write` | **no** | yes |
| `manifestCustody.bind` | mutation | `manifest.write` | **no** | yes |
| `manifestCustody.chain` | query | `manifest.read` | **no** | yes |
| `manifestCustody.close` | mutation | `manifest.write` | **no** | yes |
| `manifestCustody.custodyRecord` | mutation | `manifest.write` | **no** | yes |
| `manifestCustody.evidenceAttach` | mutation | `manifest.write` | **no** | yes |
| `manifestCustody.evidenceProfileApprove` | mutation | `manifest.write` | **no** | yes |
| `manifestCustody.evidenceProfileSet` | mutation | `manifest.write` | **no** | yes |
| `manifestCustody.reconciliationOverride` | mutation | `manifest.override.grant` | **no** | yes |

### `payroll` — 22 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `payroll.adjustmentApprove` | mutation | `payroll.approve` | **no** | no |
| `payroll.adjustmentRequest` | mutation | `payroll.adjust` | **no** | no |
| `payroll.disputeResolve` | mutation | `payroll.review` | **no** | no |
| `payroll.disputesList` | query | `payroll.review` | **no** | yes |
| `payroll.earningPropose` | mutation | `payroll.run` | **no** | no |
| `payroll.earningsList` | query | `payroll.read_employee` | **no** | yes |
| `payroll.export` | mutation | `payroll.export` | **no** | yes |
| `payroll.myPay` | query | `payroll.read_own` | **no** | yes |
| `payroll.myStatements` | query | `payroll.read_own` | **no** | yes |
| `payroll.myTimeEntries` | query | `payroll.read_own` | **no** | yes |
| `payroll.periodOpen` | mutation | `payroll.run` | **no** | yes |
| `payroll.periodsList` | query | `payroll.read_employee` | **no** | yes |
| `payroll.profileUpsert` | mutation | `payroll.profile.write` | **no** | yes |
| `payroll.profilesList` | query | `payroll.read_employee` | **no** | yes |
| `payroll.raiseDispute` | mutation | `payroll.dispute.raise_own` | **no** | no |
| `payroll.rateCreate` | mutation | `payroll.rate.write` | **no** | no |
| `payroll.ratesList` | query | `payroll.rate.read` | **no** | yes |
| `payroll.reconcileDay` | mutation | `payroll.review` | **no** | no |
| `payroll.runApprove` | mutation | `payroll.approve` | **no** | yes |
| `payroll.runCreate` | mutation | `payroll.run` | **no** | yes |
| `payroll.runsList` | query | `payroll.read_all` | **no** | yes |
| `payroll.submitTime` | mutation | `payroll.time.submit_own` | **no** | no |

### `period` — 3 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `period.close` | mutation | `period.close` | **no** | yes |
| `period.readiness` | query | `period.read` | **no** | yes |
| `period.reopen` | mutation | `period.reopen` | **no** | yes |

### `portal` — 36 procedures, 23 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `portal.adjustmentAuthorize` | mutation | — | yes | yes |
| `portal.alertAcknowledge` | mutation | — | yes | yes |
| `portal.alertPreferences` | query | — | yes | yes |
| `portal.alertPreferencesSet` | mutation | — | yes | yes |
| `portal.alerts` | query | — | yes | yes |
| `portal.approvalQueue` | query | — | yes | yes |
| `portal.chainOfCustody` | query | — | yes | yes |
| `portal.changeOrderAuthorize` | mutation | — | **no** | yes |
| `portal.customerStatement` | query | — | **no** | yes |
| `portal.dailyReport` | query | — | yes | yes |
| `portal.disposalTicketSubmit` | mutation | — | yes | yes |
| `portal.documentDownload` | mutation | — | yes | yes |
| `portal.documents` | query | — | yes | yes |
| `portal.facilityStatement` | query | — | yes | yes |
| `portal.fieldTicketLineDecide` | mutation | — | yes | yes |
| `portal.fieldTicketSign` | mutation | — | yes | yes |
| `portal.fieldTicketView` | query | — | yes | yes |
| `portal.invitationAccept` | mutation | — | yes | yes |
| `portal.invoiceAccept` | mutation | — | **no** | yes |
| `portal.invoiceDispute` | mutation | — | **no** | yes |
| `portal.invoiceView` | mutation | — | **no** | yes |
| `portal.invoices` | query | — | **no** | yes |
| `portal.jobBoard` | query | — | yes | yes |
| `portal.jobTimeline` | query | — | yes | yes |
| `portal.me` | query | — | yes | yes |
| `portal.mfaConfirm` | mutation | — | **no** | yes |
| `portal.mfaEnroll` | mutation | — | **no** | yes |
| `portal.notices` | query | — | yes | yes |
| `portal.observations` | query | — | **no** | yes |
| `portal.preClearance` | query | — | yes | yes |
| `portal.quoteAccept` | mutation | — | **no** | yes |
| `portal.quotes` | query | — | **no** | yes |
| `portal.rfiAnswer` | mutation | — | **no** | yes |
| `portal.tokenRotate` | mutation | — | **no** | yes |
| `portal.vendorBillSubmit` | mutation | — | yes | yes |
| `portal.vendorStatement` | query | — | yes | yes |

### `portalAdmin` — 3 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `portalAdmin.identityInvite` | mutation | `portal.identity.manage` | **no** | yes |
| `portalAdmin.identityRevoke` | mutation | `portal.identity.manage` | **no** | yes |
| `portalAdmin.submissionReview` | mutation | `portal.submission.review` | **no** | yes |

### `portals` — 2 procedures, 1 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `portals.mine` | query | `portal.compose_own` | yes | yes |
| `portals.panelsFor` | query | `portal.compose_own` | **no** | yes |

### `project` — 9 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `project.budgetApprove` | mutation | `project.budget.approve` | **no** | yes |
| `project.budgetCreate` | mutation | `project.budget.manage` | **no** | yes |
| `project.changeOrderPropose` | mutation | `project.change.manage` | **no** | yes |
| `project.forecast` | query | `project.read` | **no** | yes |
| `project.percentCompleteState` | mutation | `project.budget.manage` | **no** | yes |
| `project.quoteCreate` | mutation | `project.quote.manage` | **no** | yes |
| `project.quoteIssue` | mutation | `project.quote.issue` | **no** | yes |
| `project.quoteRevise` | mutation | `project.quote.manage` | **no** | yes |
| `project.rfiAsk` | mutation | `project.rfi.manage` | **no** | yes |

### `purchasing` — 2 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `purchasing.approve` | mutation | `purchasing.approve` | **no** | yes |
| `purchasing.request` | mutation | `purchasing.request` | **no** | yes |

### `readiness` — 2 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `readiness.forShift` | query | `readiness.read` | **no** | yes |
| `readiness.forTime` | query | `readiness.read` | **no** | yes |

### `records` — 19 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `records.evidence.amend` | mutation | `evidence.amend` | **no** | yes |
| `records.evidence.export` | mutation | `evidence.export` | **no** | yes |
| `records.evidence.listForOperator` | query | `evidence.read_own` | **no** | yes |
| `records.evidence.queueSend` | mutation | `evidence.send` | **no** | no |
| `records.evidence.requestDeviceDeletion` | mutation | `evidence.delete_device_copy` | **no** | no |
| `records.evidence.seal` | mutation | `evidence.seal` | **no** | yes |
| `records.incident.capture` | mutation | `incident.create` | **no** | no |
| `records.incident.readInvestigation` | query | `incident.read_investigation` | **no** | yes |
| `records.incident.review` | mutation | `incident.review` | **no** | yes |
| `records.legalHold.place` | mutation | `legal_hold.place` | **no** | yes |
| `records.legalHold.release` | mutation | `legal_hold.release` | **no** | yes |
| `records.maintenance.recordRelease` | mutation | `maintenance.record_release` | **no** | yes |
| `records.maintenance.revokeRelease` | mutation | `maintenance.revoke_release` | **no** | no |
| `records.nearMiss.report` | mutation | `incident.create` | **no** | no |
| `records.retention.disposition` | query | `retention.dispose` | **no** | yes |
| `records.roadside.open` | query | `roadside.open` | **no** | yes |
| `records.roles.bootstrapManagement` | mutation | — | **no** | no |
| `records.roles.bootstrapStatus` | query | — | **no** | no |
| `records.roles.grant` | mutation | `roles.grant` | **no** | yes |

### `recovery` — 1 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `recovery.propose` | mutation | `recovery.propose` | **no** | yes |

### `requirement` — 4 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `requirement.authorize` | mutation | — | **no** | yes |
| `requirement.calibrationSweep` | mutation | `loadsense.calibration.sweep` | **no** | no |
| `requirement.packActivate` | mutation | — | **no** | no |
| `requirement.workAuthorization` | query | — | **no** | yes |

### `restrictedVault` — 9 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `restrictedVault.accessHistory` | query | `restricted.audit.read` | **no** | yes |
| `restrictedVault.breakGlass` | mutation | `restricted.read` | **no** | yes |
| `restrictedVault.grantRevoke` | mutation | `restricted.read` | **no** | yes |
| `restrictedVault.investigationDecide` | mutation | `restricted.read` | **no** | yes |
| `restrictedVault.investigationPropose` | mutation | `vault.matter.manage` | **no** | yes |
| `restrictedVault.matterOpen` | mutation | `vault.matter.manage` | **no** | yes |
| `restrictedVault.mattersForIncident` | query | `vault.matter.manage` | **no** | yes |
| `restrictedVault.restrictedIndex` | mutation | `restricted.read` | **no** | yes |
| `restrictedVault.restrictedRead` | mutation | `restricted.read` | **no** | yes |

### `roadside` — 2 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `roadside.assignVendor` | mutation | `roadside.manage` | **no** | no |
| `roadside.open` | mutation | `roadside.report` | **no** | yes |

### `securityIncidents` — 9 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `securityIncidents.breachAssess` | mutation | `incident.review` | **no** | yes |
| `securityIncidents.close` | mutation | `incident.review` | **no** | yes |
| `securityIncidents.list` | query | `incident.read_summary` | **no** | yes |
| `securityIncidents.obligationCreate` | mutation | `incident.review` | **no** | yes |
| `securityIncidents.obligationSent` | mutation | `incident.review` | **no** | yes |
| `securityIncidents.open` | mutation | `incident.create` | **no** | yes |
| `securityIncidents.organizationAffect` | mutation | `incident.review` | **no** | no |
| `securityIncidents.timelineAppend` | mutation | `incident.create` | **no** | yes |
| `securityIncidents.view` | query | `incident.read_investigation` | **no** | yes |

### `shifts` — 5 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `shifts.eligibility` | query | `shifts.read` | **no** | yes |
| `shifts.expressInterest` | mutation | `shifts.interest` | **no** | yes |
| `shifts.interests` | query | `shifts.read` | **no** | yes |
| `shifts.list` | query | `shifts.read` | **no** | yes |
| `shifts.post` | mutation | `shifts.post` | **no** | yes |

### `shop` — 25 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `shop.coreReturn` | mutation | `shop.parts.move` | **no** | yes |
| `shop.partCount` | mutation | `shop.parts.count` | **no** | yes |
| `shop.partCreate` | mutation | `shop.parts.manage` | **no** | yes |
| `shop.partIssue` | mutation | `shop.parts.move` | **no** | yes |
| `shop.partReceive` | mutation | `shop.parts.move` | **no** | yes |
| `shop.partReturn` | mutation | `shop.parts.move` | **no** | no |
| `shop.recallRecord` | mutation | `shop.recall.record` | **no** | yes |
| `shop.recallUnitDecide` | mutation | `shop.recall.record` | **no** | yes |
| `shop.recallVerify` | mutation | `shop.recall.verify` | **no** | yes |
| `shop.stock` | query | `shop.read` | **no** | yes |
| `shop.tireHistory` | query | `shop.read` | **no** | yes |
| `shop.tireInstall` | mutation | `shop.tires.manage` | **no** | yes |
| `shop.tireMeasure` | mutation | `shop.tires.manage` | **no** | yes |
| `shop.tireRegister` | mutation | `shop.tires.manage` | **no** | yes |
| `shop.tireRemove` | mutation | `shop.tires.manage` | **no** | yes |
| `shop.toolCheckout` | mutation | `shop.tools.manage` | **no** | yes |
| `shop.toolRegister` | mutation | `shop.tools.manage` | **no** | yes |
| `shop.toolReturn` | mutation | `shop.tools.manage` | **no** | yes |
| `shop.unitCost` | query | `shop.read` | **no** | yes |
| `shop.warrantyClaimDecide` | mutation | `shop.warranty.decide` | **no** | yes |
| `shop.warrantyClaimRaise` | mutation | `shop.warranty.raise` | **no** | yes |
| `shop.warrantyPolicyRecord` | mutation | `shop.warranty.raise` | **no** | yes |
| `shop.workOrderAdvance` | mutation | `shop.workorder.advance` | **no** | yes |
| `shop.workOrderCost` | query | `shop.read` | **no** | yes |
| `shop.workOrderRelease` | mutation | `shop.release` | **no** | yes |

### `spatial` — 15 procedures, 1 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `spatial.lastPosition` | query | `spatial.read` | **no** | yes |
| `spatial.locationGet` | query | `spatial.read` | **no** | yes |
| `spatial.locationRegister` | mutation | `spatial.location.manage` | **no** | yes |
| `spatial.locationVerify` | mutation | `spatial.location.verify` | **no** | yes |
| `spatial.restrictionRecord` | mutation | `spatial.restriction.record` | **no** | yes |
| `spatial.restrictionVerify` | mutation | `spatial.restriction.verify` | **no** | yes |
| `spatial.routeApprovalCheck` | query | `spatial.read` | **no** | yes |
| `spatial.routeApprove` | mutation | `spatial.route.approve` | **no** | yes |
| `spatial.routeEvaluateSegments` | mutation | `spatial.route.evaluate` | **no** | yes |
| `spatial.routeRequest` | mutation | `spatial.route.evaluate` | **no** | yes |
| `spatial.routingSourceStatus` | query | `spatial.read` | yes | yes |
| `spatial.structureRecord` | mutation | `spatial.structure.record` | **no** | yes |
| `spatial.structureVerify` | mutation | `spatial.structure.verify` | **no** | yes |
| `spatial.vehicleProfileSet` | mutation | `spatial.vehicle.manage` | **no** | yes |
| `spatial.vehicleProfileVerify` | mutation | `spatial.vehicle.verify` | **no** | yes |

### `surfaces` — 6 procedures, 5 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `surfaces.chain` | query | `surface.timeline.read` | **no** | no |
| `surfaces.exceptions` | query | `surface.exceptions.read` | yes | yes |
| `surfaces.inbox` | query | `inbox.read_own` | yes | yes |
| `surfaces.myDay` | query | `myday.read_own` | yes | yes |
| `surfaces.search` | query | `surface.search` | yes | yes |
| `surfaces.timeline` | query | `surface.timeline.read` | yes | yes |

### `sync` — 3 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `sync.receivePackage` | mutation | `sync.push_own` | **no** | yes |
| `sync.resolveConflict` | mutation | `sync.resolve_conflict` | **no** | yes |
| `sync.verifySeal` | mutation | — | **no** | no |

### `system` — 2 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `system.health` | query | — | **no** | no |
| `system.notifyOwner` | mutation | — | **no** | no |

### `telematics` — 7 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `telematics.eventReview` | mutation | `safety.event.review` | **no** | yes |
| `telematics.faultAcknowledge` | mutation | `telematics.fault.acknowledge` | **no** | yes |
| `telematics.faultClear` | mutation | `telematics.fault.acknowledge` | **no** | yes |
| `telematics.faults` | query | `telematics.read` | **no** | no |
| `telematics.reviewQueue` | query | `telematics.read` | **no** | yes |
| `telematics.unit` | query | `telematics.read` | **no** | yes |
| `telematics.videoView` | mutation | `safety.video.read` | **no** | yes |

### `timeOff` — 5 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `timeOff.callOff` | mutation | `timeOff.request` | **no** | yes |
| `timeOff.decide` | mutation | `timeOff.decide` | **no** | yes |
| `timeOff.mine` | query | `timeOff.request` | **no** | yes |
| `timeOff.request` | mutation | `timeOff.request` | **no** | yes |
| `timeOff.schedulingWindow` | query | — | **no** | yes |

### `vendor` — 4 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `vendor.billApprove` | mutation | `vendor.bill.approve` | **no** | yes |
| `vendor.billMatch` | mutation | `vendor.bill.review` | **no** | yes |
| `vendor.billRecord` | mutation | `vendor.bill.review` | **no** | yes |
| `vendor.paymentRelease` | mutation | `payment.release` | **no** | yes |

### `widgets` — 3 procedures, 3 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `widgets.boardResolve` | query | `myday.read_own` | yes | yes |
| `widgets.layoutSave` | mutation | `myday.read_own` | yes | yes |
| `widgets.offerable` | query | `myday.read_own` | yes | yes |

### `workforce` — 16 procedures, 0 UI-reachable

| Procedure | Type | Permission | UI | Tests |
|---|---|---|---|---|
| `workforce.applicantCreate` | mutation | `hr.applicant.manage` | **no** | yes |
| `workforce.applicantDecide` | mutation | `hr.applicant.manage` | **no** | yes |
| `workforce.applicantList` | query | `hr.applicant.read` | **no** | yes |
| `workforce.competencySignoff` | mutation | `hr.competency.signoff` | **no** | yes |
| `workforce.offboardingClose` | mutation | `hr.offboarding.manage` | **no** | yes |
| `workforce.offboardingOpen` | mutation | `hr.offboarding.manage` | **no** | yes |
| `workforce.offboardingRevokeAccess` | mutation | `hr.access.revoke` | **no** | yes |
| `workforce.offboardingStatus` | query | `hr.offboarding.manage` | **no** | yes |
| `workforce.onboardingStatus` | query | `hr.onboarding.manage` | **no** | yes |
| `workforce.probationDecide` | mutation | `hr.probation.decide` | **no** | yes |
| `workforce.probationRecommend` | mutation | `hr.probation.recommend` | **no** | yes |
| `workforce.screeningRecord` | mutation | `hr.applicant.manage` | **no** | yes |
| `workforce.taskComplete` | mutation | `hr.onboarding.manage` | **no** | yes |
| `workforce.taskVerify` | mutation | `hr.training.verify` | **no** | yes |
| `workforce.trainingRecord` | mutation | `hr.training.record` | **no** | yes |
| `workforce.trainingVerify` | mutation | `hr.training.verify` | **no** | yes |

---

## Flagged: server capability with no UI

**557 of 690 procedures have no caller anywhere under `client/src`.** This is the single largest structural finding in the audit. It is not a handful of admin endpoints — it is most of the product.

### 48 routers are entirely unreachable from the application

Every procedure in each of these is mounted, permission-gated, tested — and cannot be invoked by any screen.

| Router | Procedures | What it governs |
|---|---|---|
| `agent` | 5 | agent runtime |
| `ar` | 8 | accounts receivable |
| `asset` | 10 | capital assets, CCA schedules, disposals |
| `audit` | 6 | audit package assembly and access |
| `automationPolicy` | 6 | P8.2 entitlement, policy set, operational override, history, snapshot |
| `bank` | 3 | bank reconciliation |
| `board` | 9 | dispatch/ops board semantics |
| `calendar` | 3 | financial calendar |
| `calibration` | 3 | measurement device calibration sweeps |
| `closeout` | 20 | site and trip closeout |
| `commercial` | 4 | commercial approvals |
| `compliance` | 13 | compliance documents, passports, requirements |
| `contractorOperations` | 14 | contractor/owner-operator operations and payables |
| `contractors` | 3 | contractor records |
| `crews` | 4 | crew scheduling |
| `device` | 4 | field device enrolment, seal verification |
| `dispatch` | 8 | readiness, evaluate, override request/grant, award — the whole dispatch gate |
| `enforcement` | 11 | roadside stops, out-of-service orders, OOS release policy, inspector panel |
| `fuel` | 7 | fuel purchases and reconciliation |
| `funding` | 8 | funding and recovery |
| `gst` | 5 | GST returns |
| `hos` | 10 | hours-of-service attestation, scanned logs, limit promotion |
| `ifta` | 7 | IFTA returns |
| `inbound` | 2 | machine inbound ingestion |
| `insurance` | 12 | policies, coverages, covered entities, claims |
| `integration` | 11 | machine clients, webhooks, inbound gateway |
| `invoicing` | 7 | invoice create, finalize, void |
| `manifestCustody` | 9 | manifest chain of custody and seal overrides |
| `payroll` | 22 | pay runs, banking, tax identifiers, adjustments |
| `period` | 3 | accounting period open/close |
| `portalAdmin` | 3 | portal credential administration |
| `project` | 9 | commercial projects |
| `purchasing` | 2 | purchase authorizations |
| `readiness` | 2 | readiness surface |
| `records` | 19 | maintenance releases/revocations, incidents, near-misses, legal holds, evidence, retention |
| `recovery` | 1 | recovery decisions |
| `requirement` | 4 | requirement profiles |
| `restrictedVault` | 9 | P8.5 restricted incident records |
| `roadside` | 2 | roadside service events |
| `securityIncidents` | 9 | security incident capture and handling |
| `shifts` | 5 | open shifts |
| `shop` | 25 | work orders, mechanic releases, parts, tires, tools, warranty, recalls |
| `sync` | 3 | offline package receive/push |
| `system` | 2 | owner notification, system health |
| `telematics` | 7 | fault codes, device acknowledgement, defect creation from faults |
| `timeOff` | 5 | time-off requests |
| `vendor` | 4 | vendor records |
| `workforce` | 16 | applicants, onboarding, personnel records |

### Partially reachable routers

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

### Procedures with neither a UI caller nor a test reference (89)

These are the least-exercised paths in the system — mounted and permission-gated, but nothing in the repository calls them and no test names them.

```
academy.foreignTdgRoadRecognize
academy.practicalSignoff
academy.requirementList
academy.requirementUpsert
academy.sourceReview
academy.statementOfExperienceCreate
academy.syncCatalog
asset.list
audit.packageWithdraw
bank.reconciliation
closeout.delayRecord
closeout.eventClose
closeout.eventRecord
closeout.roadHazardReport
closeout.sitePrepare
closeout.weatherObserve
closeout.whyTheseHours
commercialOffice.approvals.policyRetire
commercialOffice.documents.link
commercialOffice.roles.end
commercialOffice.roles.list
commercialSetup.decisionGet
commercialSetup.definitionReject
commercialSetup.poExposure
commercialSetup.pricingDecide
commercialSetup.rateResolve
commercialSetup.sheetGaps
commercialSetup.ticketPricing
commercialSetup.vendorRateVariances
comms.assignmentVerify
compliance.consentRecord
compliance.dangerousGoodsAssist
compliance.driverQualification
compliance.jobPassport
compliance.knowledgeCatalog
compliance.securementAssist
contractorOperations.crewAssign
contractorOperations.loadLink
contractorOperations.workerAdd
contractors.settlementApprove
facilityDirectory.arcgis.importFromLayer
facilityDirectory.arcgis.inspect
facilityDirectory.exportCsv
facilityDirectory.exportGeoJson
facilityDirectory.vocabulary.verify
fieldRoute.assistant.acknowledge
fieldRoute.assistant.answer
fieldRoute.assistant.readBack
fieldRoute.gps.pendingZoneEvents
fieldRoute.identity.inspections.list
fieldRoute.trips.update
fieldRoute.unitSafety.update
fieldRoute.workOrders.update
finance.expenseCreate
finance.expenseDuplicates
funding.opportunitiesList
integration.loadSenseBindGateway
integration.loadSenseCalibrate
integration.ownershipList
invoicing.disputeResolve
invoicing.draftFromTicket
invoicing.get
invoicing.render
invoicing.send
payroll.adjustmentApprove
payroll.adjustmentRequest
payroll.disputeResolve
payroll.earningPropose
payroll.raiseDispute
payroll.rateCreate
payroll.reconcileDay
payroll.submitTime
records.evidence.queueSend
records.evidence.requestDeviceDeletion
records.incident.capture
records.maintenance.revokeRelease
records.nearMiss.report
records.roles.bootstrapManagement
records.roles.bootstrapStatus
requirement.calibrationSweep
requirement.packActivate
roadside.assignVendor
securityIncidents.organizationAffect
shop.partReturn
surfaces.chain
sync.verifySeal
system.health
system.notifyOwner
telematics.faults
```

## Flagged: UI with no corresponding server action

Every one of the 133 client call expressions resolves to a real mounted procedure — there are **zero** client calls to a path that does not exist. Where a screen does nothing, it is because the control is a local-state placeholder rather than a broken call; those are listed in `UI_INVENTORY.md`.

## Flagged: procedures that appear unreachable

No procedure is unreachable in the routing sense — all 690 are mounted on `appRouter` and served at `/api/trpc`. "Unreachable" in this codebase means **operationally** unreachable: no UI, and in 89 cases no test either. An authenticated staff member with the right role can still call any of them over HTTP.
