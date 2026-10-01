# LeaseOS — Document Control + Controlled Numbering: Design (Checkpoint 0)

Status: **approved design (PR #18).** On 2026-09-24 the owner adopted the implementation already built on `claude/document-control-architecture-jlffzk` instead of building from this document, within the D-00 carve-out (`DC_RECONCILIATION_BRIEF_2026-09-24.md`). This document remains the approved intent and the record of rulings; `document-control-design.md` and `checkpoints/DC_IMPLEMENTATION_RECORD.md` describe what is built. One invariant is amended below (I-1).

| | |
|---|---|
| Surveyed at | `929f7211120843d2d434899af31e25e15bf5de47` (release `v23.25`: `main`'s merge-base `f21cd1b` plus PR #7's four AI-Secretary commits). **Rebased 2026-09-24 onto `origin/main` = `6f52b57` (SPINE item 1, #10; recovered SPINE plan, #13; dispatch Checkpoint I, #11)**; schema line citations re-verified against that tree; PR #7's `server/_core/ai/` is therefore *not* on this branch and is cited as PR #7 where it appears |
| Working tree | clean |
| Migration head at the survey SHA | `0168_retire_storage_capability_urls.sql` (165 files for 0000–0168; 0016/0017 absent and gated; 0094/0095/0098 unused; `0157` used twice) |
| Migration head on `main` (this branch's base) | `0174_dispatch_override_provenance.sql` (0169 defect resolution, 0170/0171 dispatch roles, 0174 override provenance; 0172/0173 held by an open branch; 410 tables) — see §1.10 |
| Companion registers read | `docs/architecture/MIGRATION_COLLISION_REGISTER.md` (main), `docs/compliance/unified-compliance-engine-design.md` (main, approved 2026-09-23), `docs/compliance/credential-store-reconciliation.md` (main, D-05 decided), `docs/register/SECRETARY_SPINE_MORATORIUM.md`, `docs/register/ROADMAP_2026-09-21.md`, `docs/hybrid-seam/HS_CONTRACTS.md`, `docs/register/PORTAL_ORG_SCOPE_DEFERRED.md` (main) |
| Owner rulings | D-00 carve-out, D-01 yearly, D-02 archival numbers optional per class, D-03 company-wide — **decided 2026-09-24** (§27; `D00_MORATORIUM_DECISION_BRIEF.md`) |
| Document placement | `docs/document-control/`, following `docs/compliance/` and `docs/facility-map/` (one initiative, one folder). The repository has no `docs/plans/` |

The question this subsystem must answer for any piece of paper or PDF that touches a job:

> Who issued this document, under which number, in which revision, from which template, from what frozen facts, signed by whom, printed when and how many times, linked to which job, load, unit, driver and invoice, and what happened to every number LeaseOS ever handed out?

LeaseOS already answers pieces of that in eleven places (§1). This design **reconciles** them under one record layer. It does not add a parallel vault, a parallel numbering scheme, a parallel proposal store or a parallel sync protocol.

---

## 0. Two binding constraints the prompt did not mention

### 0.1 The SPINE moratorium

`docs/register/SPINE_WIRING_PLAN.md:3`: *"The moratorium stands: no new engines until this path is wired."* At the survey SHA the plan existed only in the sibling `leaseos` repository; `main` has since restored it byte-for-byte (PR #13, `docs/register/SPINE_WIRING_PLAN_PROVENANCE.md`) and made it self-proving: `server/spineWiringPlan.test.ts` checks the file's hash, the moratorium sentence, the ordering section, that every spine engine exists and is declared or reached, and that nothing in the tree cites the plan by another path. SPINE item 1 (per-boundary confirmation) is done on `main` (PR #10, `docs/register/SPINE_ITEM1_BOUNDARY_CONFIRMATION.md`), and its two modules are themselves declared unwired. `server/engineReachability.test.ts:28` still lists all thirteen spine engines as `DECLARED_UNWIRED` (and, on PR #7's branch, the 21 AI modules). Nothing has lapsed; `drizzle/0169_trip_stop_provenance.sql` remains a sibling-only migration.

Two of the thirteen matter here directly: **`fieldTicket`** (the live field-ticket path is `closeoutRouter`, and `server/_core/fieldTicket.ts` is a declared-unwired duplicate, one of the "four duplications" the plan orders resolved) and **`offlineCapability`** (the offline envelope Document Control's device claims would ride).

**Document Control is a new engine.** Checkpoint 1 of this design adds tables and a router. That is exactly what the moratorium forbids, and the compliance initiative met the same wall and resolved it by owner ruling (its D-01: reconciliation and safety fixes permitted, standalone engine surface deferred). This design takes the same posture:

* Writing this document is permitted (documentation only, the precedent is `docs/register/AI_RUNTIME_TERMINOLOGY.md`).
* Implementing **any** checkpoint below needed owner decision **D-00** (§27): either the moratorium is lifted for this initiative, or Checkpoint 1 is re-scoped to the subset that is "a resolver or a router over something already written" — which, honestly assessed, is only the external-reference adapter over `disposalTickets.facilityTicketNumber` and the tenant column on `trackingSequences`. Everything else is new.

The prompt said: if the design conflicts with the repository, stop and explain. This was the conflict, and it was put to the owner in `D00_MORATORIUM_DECISION_BRIEF.md`. **Ruling, 2026-09-24: carve out**, bounded as the brief states — Checkpoints 1, 2 and 6 permitted in that order as the spine's record layer, Checkpoint 6 counted as SPINE item 2 work; Checkpoints 3, 4, 5, 7, 8 and 9 deferred until the spine is wired; every new module reached from a mounted router in its own PR or declared with a reason; the AI worker-boundary ruling kept separate. Implementation still starts only after this design PR is reviewed.

### 0.2 Migration numbering is contested and must not be reserved here

`docs/architecture/MIGRATION_COLLISION_REGISTER.md` (main) records three claimants on `0169`, two on `0170`, and open branches holding `0172`/`0173`; `docs/hybrid-seam/HS_CONTRACTS.md:84` claims `0169` for the sync-command ledger. This design **reserves nothing**. At implementation, each checkpoint takes the next number free on `main` *and* on every open branch at its own rebase, records the scan in the PR body, and updates the collision register. The provisional first free number as of this survey is `0175`; that sentence will be stale by the time anyone reads it, which is the point of not reserving.

---

## 1. Repository survey

Every claim cites the file it was read in. "Unwired" means listed in `DECLARED_UNWIRED` in `server/engineReachability.test.ts`. Status vocabulary is the register's: **BUILT · PARTIAL · SPEC · MISSING**.

### 1.1 Schema and tenancy conventions

* 408 `mysqlTable(` declarations in `drizzle/schema.ts` (8,787 lines); `scripts/verify-parity.sh` pins the SQL table count to match. 406 tables use `id int autoincrement` PKs; the two exceptions are counter tables with varchar PKs (`commercialChainSequences.scopeRef` :7844, `sheetSerialSequences.scope` :8146). **No UUID/ULID columns anywhere.** Human identity is a separate unique varchar `*Ref` or `*Number`; the house rule at schema.ts:929-932 is "Human tracking numbers are issued labels, never primary keys".
* Table and column names are camelCase; SQL column names identical. No foreign keys declared (one exception, `widgetLayoutItems_layout_fk`, 0127). No `deletedAt` anywhere: the pattern is a status enum (`void | withdrawn | superseded | revoked | retired`) plus `supersedes*Id`/`supersededBy*Id`. `mysqlEnum` for closed vocabularies, `varchar` for open ones, `text("xxxJson")` for JSON (native `json()` only in 0133+ tables). Money is integer cents/millis.
* **Tenant key is `orgRef` varchar(64)** on 36 tables; 19 older tables carry `tenantId varchar(40)`; 13 commercial-office tables carry `bookOrgRef` ("whose book"). No `organizationId`/`companyId`. `NULL` means the historical single tenant (`SINGLE_TENANT_ID = "default"`, `server/_core/actingScope.ts:43`); `orgScopeWhere` (`server/db.ts:160`) matches `orgRef IS NULL OR = 'default'` for the default scope. `PORTAL_ORG_SCOPE_DEFERRED.md` §4 (main) names the `tenantId`/`orgRef` reconciliation as open.
* **Most core operational tables carry no tenant column** (loads, fieldTickets, invoices, disposalTickets, units, operators, evidenceRecords, workOrders, complianceDocuments) and are scoped through the job (`jobInScope`, `fieldTicketInScope`, `db.ts:707-1030`) or through `coreRecordOwnership` (unit/operator/load/financial_entity, schema.ts:5514, `server/_core/coreRecordOwnership.ts`). `server/tenantIsolation.test.ts:4`: *"Organization-wide isolation is not a property this system has."* Roadmap item 3 ("Prove tenant isolation") is open.
* Acting scope: `resolveActingScope(db, userId)` (`actingScope.ts:65`) derives the org from `organizationMemberships`, refuses `AmbiguousOrganization` for multi-org users, and "Never reads tenant, branch or terminal from client input" (:62). `ctx` itself carries only `{ req, res, user }` (`server/_core/context.ts`).
* Branch: `userRoleAssignments.scopeType global|branch` + `scopeRef` is the enforced branch grant; `organizationMemberships.branchId`; no branches master table; `trackingSequences.branch` exists but no caller passes one.
* Anti-enumeration: **NOT_FOUND, never FORBIDDEN** (`server/_core/entityScope.ts:8,19` `notFound()`; `db.ts:799`), pinned by the `tenantScope*.db.test.ts` suites. Exceptions that return FORBIDDEN across orgs and should not be copied: `deviceRouter.ts:81,95,117,189`, `manifestCustodyRouter.ts:85-105`, `contractorOperationsRouter.ts:43`.

### 1.2 Authorization

* Builders in `server/_core/trpc.ts`: `publicProcedure`, `protectedProcedure` (:28, user only), `adminProcedure` (:30), **`roleProcedure(procedureName)`** (:71-136), `externalProcedure` (:156, portal token + MFA on sensitive writes), `integrationProcedure` (:227, machine key, supplies `ctx.integration.orgRef`).
* `roleProcedure` resolves the permission from `OPERATIONAL_PROCEDURE_PERMISSIONS` / `RECORDS_PROCEDURE_PERMISSIONS` (`server/_core/recordsAuthorization.ts:2154,2182`) at wiring time and throws if none is mapped; `ProcedureName` is a union of both maps (:2951), so an invented name does not compile. Every decision, denials included, writes `authorizationDecisions` (schema.ts:3104); an allowed **sensitive** permission whose audit row failed to write is refused (`trpc.ts:111-118`).
* Roles (`DomainRole`, :26): driver, dispatcher, mechanic, shop_lead, safety, office, management, hr, legal, auditor, bookkeeper, payroll_admin, tax_preparer, controller, external_accountant. `GRANTS` (:349) lists permissions per role explicitly; `DENIALS` (:1702) beat grants; `UNIVERSAL_PERMISSIONS` (:1668) are self-scoped (`device.enroll_own`, `sync.push_own`); `SENSITIVE_PERMISSIONS` (:1737) fail closed.
* Permission naming is dotted `domain.action[_qualifier]`, three-part where a sub-domain exists: `dispatch.award`, `invoicing.void`, `evidence.read_own`, `audit.package.prepare`. A `documents.*` **procedure** namespace exists (`documents.list/create/review` → `compliance.read/write/review`, :2197-2199); no `document.*` permission namespace exists.
* Gate 5 of `scripts/ci-gate.sh` and `server/procedureAuthorization.test.ts` pin zero bare `protectedProcedure`, 36 external, 2 integration procedures.

### 1.3 Audit, history, events, outbox

* **No general audit-log table or helper exists.** `auditRouter.ts` is audit *packages*. The universal trail is `authorizationDecisions` (who was allowed/denied what), not domain change.
* Per-domain append-only history is the convention: `fieldTicketEvents` (schema.ts:1276), `manifestCustodyEvents` (:493, unique `(manifestId, sequence)`), `dispatchAuditEvents` (:2086), `recordAmendments` (:1354, "Append-only. Never update a row here"), `workflowTransitions` (:2441), `deviceKeyEvents`, `evidenceAccessEvents`, `externalAccessLog`, `enforcementEvents`, `hosRuleLimitHistory`. One hash-chained log, `academyAuditEvents` (:7678), whose writer reads the previous hash without a lock (chain can fork under concurrency) and hashes with FNV, not SHA-256.
* Append-only is enforced by convention plus a handful of triggers: academy retention guards (0108, 0121), `academyAssessmentSheets_transcribe_once` (0126), `manifests_seal_guard` (0130, `SIGNAL SQLSTATE '45000'` on a changed sealed manifest). No trigger protects `evidenceVersions`, `evidenceSeals`, `fieldTicketRevisions`, `fieldTicketDocuments` or `commercialDocuments`.
* Outbox: `domainEventOutbox` (schema.ts:2316; eventId, eventType, eventVersion, aggregateType/Id, `tenantId` NOT NULL, branchId, correlation/causation, actorSource `human|system|ai|integration`, payloadJson, claim/retry/dead-letter columns). Writer: `emitDomainEvent(tx, input)` in `server/_core/eventEmitter.ts:115`, raw INSERT inside the caller's transaction. **`domainEmitters.ts` has no production caller** (unwired); the only production publisher is `enqueueEnforcementEvent` (`enforcementOutbox.ts:43`) with a deterministic `EVT-sha256(...)` eventId so a retried confirm cannot enqueue twice. Drain: `productionWorker.ts` / `workflowRuntime.ts:362` claims with `FOR UPDATE SKIP LOCKED`, lease 120 s, backoff, dead letter. Consumers must be idempotent (`workerLifecycle.ts:30`); there is no consumer-side processed-event table. Registering a new aggregate = an emitter + `workflowSeeds.ts` rules and/or a `DomainEventHandler` in `productionWorker.ts`.
* The AI-side rule: no model call inside a request handler; the one pre-existing violation (`routers.ts:690`) is pinned at exactly one by `server/_core/ai/workerBoundary.test.ts`.

### 1.4 Idempotency, fingerprints, canonical hashing

* **No generic idempotency table, no `commandId`.** `HS_CONTRACTS.md` §4 proposes `CommandEnvelope { commandId, deviceId, requestHash, capturedAt }` and a server ledger (`accepted → applied | rejected | conflict`, `COMMAND_ID_COLLISION`) at slot 0169; not built.
* Per-domain patterns in use: `evidenceRecords.clientCaptureRef` unique (v21.6; lookup at `db.ts:202` is **not org-scoped**); `syncPackages.packageRef` unique + `deviceSyncNonces` unique `(fieldDeviceId, nonce)`; dispatch `awardIdempotencyKey` (FNV-1a) checked inside the posting `FOR UPDATE` and replayed as `replayed: true` (`dispatchTransaction.ts:82-128`); `assistantCommitReceipts.proposalId` unique with proposal row locked (`assistantCommitService.ts:129-140`); `inboundEvents` unique `(clientId, idempotencyKey)`, differing payload hash reported (`integrationRouter.ts:187`); `clientAdjustments.idempotencyHash`; workflow `dedupeKey`.
* `server/_core/documentFingerprint.ts`: `contentHash(bytes)` = SHA-256; structured keys per document type (`disposal|facilityRef|TICKETNO|LOADREF`, fuel, receipt); `assessDuplicate → unique | exact_duplicate | possible_duplicate | cannot_assess`; exact refused, possible needs a recorded human override; stored in `documentFingerprints` (schema.ts:3734, **no orgRef**); used with `.for("update")` in `assistantCommitService.ts:251-300`.
* Canonical JSON is **duplicated four times** (`deviceSignature.ts:5`, `siteCloseout.ts:48`, `commPackage.ts:37`, `client/src/runtime/crypto.ts`). The compliance C1a introduced "one shared sha256 canonical hasher" for eligibility fingerprints (main); this design uses that one.

### 1.5 Numbering today — the fact that changes the design most

Three counter mechanisms exist, one of them mature:

**A. `trackingSequences` + `nextTrackingNumber`** (`schema.ts:934`; `server/_core/trackingNumbers.ts:60-92`; SQL unique `(sequenceType, branch, periodKey)` at 0010:12, absent from schema.ts). **BUILT and locked.** Format is stored per row (prefix, separator, yearDigits, includeMonth, sequenceDigits, `resetPeriod never|yearly|monthly`); `periodKey` `YYYY` / `YYYY-MM` / `ALL`; the allocation is `INSERT IGNORE` the period row outside the transaction (to avoid the shared→exclusive lock upgrade deadlock the sheet allocator documents), then `UPDATE … SET nextNumber = LAST_INSERT_ID(nextNumber)+1` under the row lock, then `SELECT LAST_INSERT_ID()` on the same connection. Tested with 6×25 concurrent callers (`server/trackingNumbers.db.test.ts`). Prefixes minted this way: `FT` (fieldTickets, `closeoutRouter.ts:140`), `INV`, `BB`, `CR`, `WO`(write-off), `DSP` (disposalTickets from a facility-portal submission, `commercialRouter.ts:158`), `DLY`, `SIG`, `ORG`, **`DOC` (`commercialDocuments.documentRef`, `commercialOfficeRouter.ts:571,585`)**, `MRO`, `CSW`, `CLI`/`VEN`. `server/trackingNumberCoverage.test.ts` pins the canonical set.
   * Gaps: **no `orgRef`** (one global counter per type across tenants); **the number is minted outside the caller's transaction** (every caller passes `db`, never `tx`; a failed insert after minting leaves an unexplained gap, e.g. `invoicingRouter.ts:158-159`); **no ledger** of what happened to a number; no device blocks.
**B. `sheetSerialSequences` + `sheetSerialAllocations`** (`schema.ts:8233-8248`; `server/_core/sheetSerialAllocator.ts:128-196`; 0125). **BUILT.** Block allocation (`nextValue = LAST_INSERT_ID(nextValue)+count`), allocation row in the same transaction ("so a gap is always explainable"), states `reserved | printed | voided`, per print batch, cap 5000 per block; serials `TICKET.VERSION.000123.<checksum>` (`sheetSerial.ts:49-53`); `academyAssessmentSheets` state `issued|printed|returned|transcribed|void` with a transcribe-once trigger. **This is a working pre-numbered print → scan-back precedent**, per batch rather than per device.
**C. `commercialChainSequences`** (`schema.ts:7931`; 0117): upsert + `FOR UPDATE` inside the caller's transaction; `${jobCode}-C01/-S01/-L001`.

Also: `commercialNumberingPolicies` (schema.ts:8323; 0133) — per-book format rows seeded `CLI, VEN, PO, MF, INV`, consumed only for CLI/VEN role numbers. Numbers that are **client-typed** with no generator: `jobs.jobCode` (varchar(32), `routers.ts:266`), `trips.tripNumber`, `manifests.manifestNumber`, `workOrders.workOrderNumber`, `incidentReports.incidentNumber`, `legalHolds.holdNumber`. Numbers **derived**: `WO-<idempotencyKey12>` (enforcement), `DSP-AI-<proposalId>` (AI disposal commit, `assistantCommitService.ts:611`), `${ticketNumber}-R${rev}` document refs. Numbers minted **unlocked**: `incidentMatters.trackingNumber` COUNT+1 (`restrictedVault.ts:57-62`), `securityIncidentEvents.sequence` max+1. No writer at all for `loads.loadNumber`, `dispatchPostings.postingNumber`, `disposalBatches.batchNumber`, `dailyLogs.logNumber`; `trackingReferences` ("universal index", :941) is never written. **No `SELECT MAX()+1` allocation exists**; no `GET_LOCK` remains (`commsRouter.ts:551` replaced one with `FOR UPDATE`).

### 1.6 Document-shaped tables that already exist

| Table | What it is | Verdict for this design |
|---|---|---|
| `evidenceRecords` (:48) + `evidenceRelationships` (:2737, entityType enum of 24) + `evidenceVersions` (:2756) + `evidenceSeals` (:2772) + `evidenceAccessEvents` | The records vault (B20, 0019): `trackingNumber`, `clientCaptureRef` (idempotent), `recordType`, `sealState draft|sealed|amended|superseded`, `legalHold`; versions with `supersedesVersion`, content/manifest hashes; seals with canonical manifest. **No SHA-256 at upload** (`evidence.upload`, `routers.ts:403-455`); the hash arrives at seal time **from the client** (`recordsRouter.ts:99-107`) and is recomputed server-side during device sync (`deviceRouter.ts:283-296`) | **R** — every scan original is an evidence record. The upload-time hash gap is fixed in the scan checkpoint |
| `commercialDocuments` (:8633) + `commercialDocumentLinks` (:8659) + `commercialDocumentDeliveries` (:8667) | 0144 registry over the vault: `documentRef DOC-…`, `documentType` (from `commercialCategoryTypes(kind='document_type')`), `version` + `supersedesDocumentId`/`supersededByDocumentId` (**a new row per version**), `contentHash` NOT NULL, `sourceSnapshotHash`, `evidenceRecordId | fieldTicketDocumentId | storageKey`, `counterpartyOrgRef`, retention class, `status current|superseded|withdrawn`; links `(recordType, recordRef)`; deliveries `channel email|portal|print|api|courier|other` **hand-recorded, no transport** | **U** — the nearest existing thing to a controlled record, but it registers *bytes* and conflates record identity with version (each version is a new `documentRef`). §7 keeps it as the commercial registry and links each row to a controlled revision rather than extending it into the record layer |
| `commercialCategoryTypes(kind='document_type')` (:8273) | Per-book label registry: `bookOrgRef`, `categoryKey`, `label`, `builtIn`, `status`, `source` | **E** — the resolution rule (tenant row first, built-in second) is reused for definitions; the table itself holds no behaviour |
| `complianceDocuments` (:180) | Document-backed credentials: `ownerType`, `docType`, `identifier`, `expiresAt`, `jurisdiction`, `verificationStatus needs_review|verified|rejected`, `privateDetail`, `evidenceRecordId`. **No version, issuer or org column.** D-05 (main) made it the canonical authority for document-backed credentials | **R** — the credential domain owner. Document Control links to it and never re-decides validity |
| `complianceArtifacts` (:717) | `trackingNumber`, `artifactType`, `jurisdiction`, `regulatoryProfile/Version`, `retentionUntil`, `status … legal_hold` | PARTIAL registry; fold by read adapter later, not extended |
| `fieldTicketRevisions` (:4949) | `documentRef`, `revision`, `kind site_signed|post_site_supplement|final|amendment`, `snapshotJson`, `snapshotHash`, `supersedesRevisionId` | **R** — the frozen-revision pattern; a controlled revision of a field ticket references it |
| `fieldTicketDocuments` (:5066) | Rendered PDFs: `kind site_ticket_r1|post_site_ticket|completion_package|invoice`, `storageKey`, `contentHash`, `sourceSnapshotHash`, `byteLength`; re-verified before serving (`portalRouter.ts:425`) | **R/U** — the rendered-artifact pattern; generalized as `documentArtifacts` in the field-ticket slice |
| `manifests` (:442) + party snapshots + custody events + amendments + `manifestEvidenceLinks` + `manifestReconciliationOverrides` (0162) | Sealed manifests with `currentHash`, chained amendments, party snapshots ("what each party was represented as, at the time"), `generatedFromReferenceJson` (which printed fields came from the record vs were typed) | **R** — the manifest domain owner; its "captured name beside canonical id" and "generated-from-reference" ideas are reused in the record model |
| `disposalTickets` (:1048) | `ticketNumber` (DSP-), `loadId`, `facilityId`, **`facilityTicketNumber` varchar(80), no unique index**, weights, `verificationStatus`, `evidenceRefs` text | **R/E** — domain owner; its external number becomes an external reference, projected back |
| `documentExtractions` (:3686), `assistantProposals` (:2182), `proposalFields` (:2239), `assistantQuestions`, `documentFingerprints`, `merchantMemory` | The proposal store: engine/version, classification confidence and source, per-field `source × precision × status`, `correctedFrom`, `sourceUtterance`. **No confirmedBy/At per field** (the actor is on `assistantCommitReceipts` at commit); **no source region**; `replaceProposalFields` deletes and re-inserts fields (`db.ts:1179`), so field history is lost | **R/E** — the only proposal store; two columns added in the scan checkpoint |
| `formDefinitions` (:2172) | `formKey`, `version`, `fieldsJson` — **dead schema, nothing reads or writes it**; forms live in code as `FORMS` (`aiProposal.ts:112`: `unload_stop`, `defect_report`, `expense_receipt`, `disposal_ticket`, `fuel_receipt`) | noted; definitions reference `FORMS` keys |
| `fieldTicketSignatures` (:1226), `commercialApprovalSignatures`, `academyCertificateSignatures`, `signatureAudits` (legacy) | Site sign-off: `signatureMethod drawn|device_auth|pin|paper_scan|portal_link`, `payloadHash` (SHA-256 of the canonical site snapshot, mismatch refused), `signedScopeStatement`, authority, device attestation (0157). **No unique `(fieldTicketId, revision)`; `recordSignature` (`closeoutRouter.ts:51-95`) is check-then-insert with no transaction** | **R/E** — the signature record; the gaps are fixed in the field-ticket slice |
| `retentionPolicies` (:2797), `recordRetentionState` (:2818), `legalHolds` (:2838), `legalHoldRecords` | Statutory minimum `unverified` by default; company default 120 months office / 14 days device (`retentionPolicy.ts:40-41`) explicitly "not asserted as the statutory rule"; hold overrides deletion; `records.retention.disposition` returns **eligibility only** — no destruction executor, nothing writes `dispositionedAt` | **R** — the retention model. Document Control adds no durations |
| `trackingReferences` (:951), `recordAmendments` (:1354), `dailyLogs` (:1096) | Never written / never read in production | dead schema; not extended |

### 1.7 Rendering, templates, printing, QR

* **One renderer**: `server/_core/ticketPdf.ts` writes PDF 1.4 by hand (`renderPdf(title, lines)`, :18; Helvetica/Courier base-14, A4, 54 lines/page, non-ASCII → `?`). Four callers: `closeout.documentRender` (:328 → `fieldTicketDocuments`), `closeout.completionPackageRender` (:475), `invoicing.render` (:58, from `billingSnapshots.calculatedLinesJson`), `audit.packagePrepare` cover (`auditRouter.ts:205`). Byte-deterministic for the same lines (pinned at `portalHardening.test.ts:80-83`), but ticket and completion renders embed `generatedAt = new Date()` into the lines, so a re-render is not byte-identical; idempotency is "return the existing row". **No `rendererVersion` anywhere.** Storage keys get a random suffix (`storage.ts:44-49`). BUILT, minimal.
* **No template library.** Layouts are TypeScript string builders. `template.json` at the root is Manus scaffolding, unrelated.
* **No print audit.** `evidenceAccessEvents.action='printed'` and `restrictedAccessEvents.action='PRINT'` are enum values nothing writes; `commercialDocumentDeliveries(channel='print')` is a delivery row. The academy sheet print run (`academy.sheetPrintRun`, `trainingAcademyRouter.ts:799-825`) is the only real print registry.
* **No QR library, no QR image generation, no verification endpoint.** `units.qrTag`; `scanAudits` (qr|nfc over unit/location/manifest); `roadsidePanelGrants` (0088) implement "the QR carries a reference, not authority" with a TTL'd grant, but `grantRef` is `Date.now()+Math.random()` (not cryptographically random) and `panelView` is a `roleProcedure`. Portal tokens: `randomBytes(32)` base64url, stored hashed, 90-day TTL, rotation grace, TOTP MFA (`externalIdentityPolicy.ts`). The manifest lists a "QR verification endpoint" as planned; not built.

### 1.8 Scan, OCR, extraction

* `server/_core/documentExtraction.ts` is an **engine-neutral contract**: `OcrField { key, confidence 0-100, value, sourceText? }` (no bounding box/page), `OcrResult { engine, engineVersion?, documentTypeHint?, rawText, fields }`, `CONFIDENCE_POLICY { autoFile: 98, review: 85 }`, `ALWAYS_HUMAN` (totals, weights, dates, ticket numbers), `classifyDocument` (keyword scoring; ambiguous within 25 points), `extractToProposal` (every field `source: photo_ocr`, `status: proposed`, "Never confirmed from here"; an unmapped type is refused with "file it as evidence, do not extract"). **No OCR engine is wired; `extractToProposal` and `classifyDocument` have no callers outside tests; `documentExtractions` is inserted only by a test.** The AI provider boundary is text-only (`ai/llm/provider.ts`: "no tools, no images").
* The typed commit path is BUILT: `assistantCommitService.executeAssistantCommit` (proposal `FOR UPDATE`, receipt replay, re-authorization with an `authorizationDecisions` row, fingerprint duplicate gate, adapter `applyIntent`, auto-filed `evidenceRelationships`, receipt with `fieldManifestHash`). Disposal tickets commit as `needs_review`.
* Capture kinds already include `load_ticket`, `disposal_ticket`, `fuel_receipt`, `expense_receipt`, `signature`, `tdg_document`, `roadside_enforcement`, `oos_order` (`client/src/runtime/contracts.ts:27-32`).

### 1.9 Device identity, offline runtime, native shell

* `fieldDevices` (:4035): `deviceRef`, `userId`, `orgRef` (nullable for legacy), P-256 `keyFingerprint`/SPKI, `keystoreAttestation hardware|software|unknown|failed` (client-declared, not platform-verified), status `enrolled|active|suspended|revoked`; `deviceKeyEvents`, `deviceSyncNonces`. Enrol binds to `ctx.user.id` and `resolveActingScope().tenantId` (`deviceRouter.ts:37-47`). Package verification: ECDSA P-256 over exact wire bytes (`verificationMode exact_wire|reconstructed`), ±10 min freshness, nonce, key-history lookup, 72 h rotation grace, server-recomputed content hashes. **`receivePackage` runs no DB transaction.** No per-device allocation of anything exists.
* Client runtime (`client/src/runtime/`, 917 lines, tested): `contracts.ts` (six `SyncState`s, `LocalCapture` with `captureAuthorizationClaim` "never upgraded by later sync"), durable `outbox.ts`, `syncEngine.ts` (clientCaptureRef upload → seal → signed package; HOS/enforcement first), AES-GCM `crypto.ts`, `adapters/memory.ts`. **Capacitor is not installed**: no dependency, no config, no android/ios folder; `adapters/capacitor.ts` loads plugins dynamically and throws `NotOnDeviceError`. Mounted only as `browser_fallback` (`portal/runtimeBootstrap.ts`). Roadmap item 7 is the native Android runtime.
* Server contracts that are BUILT but unreached: `offlineCapability.ts` (`OfflineClass`, `SyncEnvelope`, `DeviceAuthorityRefused`), `preDepartureCache.ts`, `evidenceSync.ts`. `syncPackageItems.captureAuthorizationClaim` is stored as a claim with no server default.

### 1.10 Pending and unmerged work that touches this design

| Where | What | Effect here |
|---|---|---|
| `main` since the survey SHA (now this branch's base) | 0169 defect resolution, 0170/0171 dispatch role types and assignment events, 0174 override provenance; `docs/compliance/*` (approved compliance design, C1a done, D-05 credential decision); `docs/architecture/MIGRATION_COLLISION_REGISTER.md`; `docs/register/AI_RUNTIME_TERMINOLOGY.md`, `PORTAL_ORG_SCOPE_DEFERRED.md`; the recovered `SPINE_WIRING_PLAN.md` + guard (#13); SPINE item 1 `boundaryConfirmation.ts`/`boundaryEvidence.ts` (#10, declared unwired) | Slot numbers; D-05 fixes the credential authority this design defers to; the C1a shared canonical hasher is the one to reuse; the moratorium is now testable in this tree |
| PR #7 (`claude/secretary-model-dialogue-yzszcv`), not on `main` | `server/_core/ai/` (21 modules, declared unwired), agent tools, test id bands | The AI-Secretary boundary described in §29 is PR #7's; on `main` today there is no `server/_core/ai/` |
| `claude/training-academy-workforce-q3mdse` | 0172/0173 wallet renewal and history guards | claims slots; touches the wallet |
| `claude/driver-portfolio-credential-wallet-ya8928` | 0169/0170 driver portfolio, append-only events | collides; the Driver Wallet UI this design must not merge with |
| `claude/leaseos-auth-workspace-system-t008ad` | 0170 organization-scoped role grants | the org-scope change `PORTAL_ORG_SCOPE_DEFERRED.md` waits on |
| `docs/hybrid-seam/HS_CONTRACTS.md` | sync-command ledger at 0169 (`commandId`, `COMMAND_ID_COLLISION`) | the idempotency vocabulary for offline document mutations (§16) |

### 1.11 Domain chain and where external numbers live today

job (`jobs.jobCode`, client-typed) → `dispatchPostings`/`jobUnits` → `trips` (`tripNumber`, client-typed; `tripStops.ticketNumber` free text) → `loads` (`loadNumber`, **no production writer**; `loadTicketNumber`) → `manifests` (`scaleTickets` text) / `loadFacilityAssessments` (destination acceptance) → `disposalTickets` (`DSP-…` or `DSP-AI-…`; `facilityTicketNumber`) → `fieldTickets` (`FT-YYYY-NNNNNN`; lines with `sourceTrackingNumber`, disposition) → `billingBookEntries` (`disposalTicketId`, `fieldTicketLineId`) → `invoices` (`INV-…`, `billingSnapshots.payloadHash`) → `invoiceLines (fieldTicketLineId, pricingDecisionRef)`. The live invoice path drafts **from a signed field ticket** (`invoicingRouter.draftFromTicket`), not from loads. `billing.ts`, `disposalReconciliation.ts`, `fieldTicket.ts`, `tracking.ts`, `tripBillingProjection.ts` are all unwired. Partial acceptance has **two sources**: `customerContractTerms.partialAcceptanceBillable` (0161, read only by unwired `billing.ts`) and `customerBillingConfigs.partialAcceptanceAllowed` (read by the live path). External identifiers today: `disposalTickets.facilityTicketNumber`, `facilityStatementLines.facilityTicketNumber`, `facilityStatements.facilityStatementNumber`, `tripStops.ticketNumber`, `loads.loadTicketNumber`, `manifests.scaleTickets`, `fieldTickets.afeNumber`, `billingBooks.purchaseOrder/afeNumber`, `customerPurchaseOrders.poNumber/afeNumber`. **No generic "issuing organization" concept**; partial fields: `qualificationTypes.issuingBody`, `outOfServiceOrders.issuingAgency`, `facilityEvidence.publisher`, `commercialDocuments.counterpartyOrgRef`. Facilities are a **shared registry across tenants** (`facilities.orgRef` is the facility's own org link, not a tenant owner); operators link through `organizations` + `organizationRecordLinks`.

### 1.12 HOS, AI Secretary, wallet, fleet, jurisdiction, search, portals, delivery

* **HOS**: `dutyRecords` (insert-only by convention, no update/delete anywhere; amendments are new rows with `source: "amendment by user N"`), `hosRuleProfiles/Limits/LimitHistory` (verify/promote, two-person), `hosAttestations` (0155, supersede-only), `hos.ts` ("IT REFUSES TO COMPUTE A LIMIT NOBODY HAS VERIFIED"; elapsed clocks only). `dailyLogs` unused. **No RODS export/render exists.** `hosRouter.recordScannedLog` writes a `complianceDocuments(docType='hos_daily_log', source='scanned_paper', needs_review)` row and "deliberately touches nothing the readiness engine reads". B28: a projector computing `limit − elapsed` "would be manufacturing a compliance conclusion".
* **AI Secretary** (PR #7): `FORMS` × 5; `assistant.*` procedures (`routers.ts:657-860`); `contextPack.ts` item kinds `trip | stop | open_ticket | unit | unit_capacity | facility | geofence_arrival | eligibility | form` — **company identity, customer, job, lease/LSD and driver name are not in the pack**; `openTicketNumbers` are field-ticket numbers from `closeout.state`; tools are typed `ProcedureName`, called as the driver, `FORBIDDEN_CATEGORIES` include commit, delete, payment, outbound_email, outbound_web; "stated" fields need a verbatim `evidenceQuote` (silent-guess pinned at 0); `detectOverreach`; injection guard. **No canonical semantic field paths exist anywhere** (grep for `driver.fullName`-style paths: none); form keys are flat (`facilityTicketNumber`, `unitNumber`, `jobRef`).
* **Wallet / qualifications**: `documentValidity.ts` ("a document on file is not a document in force", newest *verified* version wins), `qualificationValidity.ts` (verified-with-no-expiry is not held), `compliancePassport.ts` (unverified requirement → UNKNOWN); the live gate `readinessComposer.credentialState` counts `needs_review` as present (compliance R-*, being fixed on main). D-05: `complianceDocuments` + `academyQualifications` canonical; `workerQualifications` becomes a projection; `operators.license*` legacy read-only.
* **Fleet**: no `trailers` table (trailers are `units` rows); no capacity column; `units.inspectionStatus/maintenanceStatus` + `readinessComposer` own operational state; unit documents are `complianceDocuments(ownerType='unit'…)`; `inspections.type` has no CVIP value.
* **Jurisdiction**: codes `CA-AB`, `CA`, `US-MT`, `*`; the pattern is rules-as-data seeded `unverified` (`taxRules`, `complianceRequirements` + `compliancePacks`/`companyPackActivations`, `hosRuleProfiles`, `retentionPolicies.jurisdiction`, `regulatoryThresholds`); `server/_core/jurisdiction.ts` unwired; Alberta hard-coded in `dls.ts`, `invoicing.finalize` default `CA-AB`, `complianceSecretary.ts`. No FMCSA/OSHA/US-EPA rows anywhere.
* **Search**: `surfaces.search` → `searchEverything` (`surfacesService.ts:206-245`), `LIKE %q%` over units, jobs, trips, loads, disposal tickets (internal and facility number), invoices, work orders, vendor bills, devices, insurance, fuel; **not** manifests, field tickets, customers, operators, facilities, complianceDocuments; per-hit permission filter, **no tenant filter in the service**. `surfaces.chain` walks load/disposal ↔ job/trip/book/manifest/field ticket/invoice, omitting hops the caller may not read (owner decision 2026-09-19). FULLTEXT only on `knowledgePassages.body`.
* **Portals**: `externalProcedure`, `externalAccessLog`; customer portal downloads `fieldTicketDocuments` as base64 (hash re-verified), signs field tickets as `portal_link` (the paper-scan option in `SignOffScreen.tsx` is dropped by the zod input and always recorded as `portal_link`, `portalRouter.ts:583-595`), accepts invoices; vendor/facility portals accept **structured submissions only** (`portalSubmissions`, `payloadHash`), **no file upload**. Facility acceptance is `manifestCustodyEvents accepted_by_facility|rejected_by_facility`, `manifestEvidenceLinks facility_acceptance`, `disposalTickets.verificationStatus`.
* **Delivery**: **no email or SMS transport exists** (no nodemailer/sendgrid/twilio); channels are portal alerts (`workflowNotifications`, in-app), signed webhooks (`webhookDispatchService.ts`), and hand-recorded `commercialDocumentDeliveries`. Audit-package "release" writes an access row with `action: send`; nothing is transmitted.
* **Client**: no PDF viewer, no signature pad (`<canvas>` absent), no camera/scan UI in production (`QuickCapture.tsx` hands off to `window.leaseosRuntime.capture` or redirects), no print button outside `/showcase`.

### 1.13 Contradictions between the prompt's assumptions and the tree

| Prompt assumed | Tree says |
|---|---|
| "deterministic rendering already exists in some areas" | One hand-written renderer; deterministic per input but the ticket render embeds a clock line; no renderer version recorded |
| "existing audit/history infrastructure" | Per-domain append-only tables and `authorizationDecisions`; no generic audit ledger; `domainEmitters` unwired |
| "existing idempotency/fingerprint conventions" | Per-domain keys; no generic command ledger (HS3 proposes one); `documentFingerprint.ts` is content + structured-key hashing for duplicate detection, not request idempotency |
| "existing scan/proposal/confirmation behaviour" | The proposal store and typed commit are real and live for voice; the OCR half is a contract with no engine and no caller |
| "field runtime contracts … Capacitor may not be implemented" | Confirmed: contracts and a browser fallback only |
| "customer/vendor/facility portal document handling" | Customer: view/download/sign/accept. Vendor/facility: structured submissions, no documents |
| Example number `FT-2026-004812` | Matches the live format exactly (`FT-YYYY-NNNNNN`, yearly reset, 6 digits) — the existing allocator already produces the owner's example |
| Example series `DT`, `MAN`, `BOL`, `TDG`, `SAF` | Live prefixes are `FT`, `DSP` (disposal), `INV`, `BB`, `DOC`; `MF` is seeded in `commercialNumberingPolicies` but never minted; no BOL/TDG/SAF/JSA series exists |
| "records vault" as a place to put documents | It is an *evidence* vault keyed on captured objects; the commercial registry sits over it; neither is a lifecycle record with origin and numbering |

---

## 2. Existing components reused (R), extended (E), unified (U), and genuinely new (N)

| Capability | Existing | Missing | R/E/N/U | Checkpoint |
|---|---|---|---|---|
| Sequence allocation | `trackingSequences` + `nextTrackingNumber` (row-locked, formatted, yearly reset) | tenant column; allocation inside the caller's transaction; a ledger; device blocks | **E** (columns) + **N** (ledger, allocations) | 1, 2 |
| Block allocation precedent | `sheetSerialAllocator.allocateSerialBlock` (block + allocation row in one tx, state per block) | per-device binding, per-number ledger, reconciliation | **R** (pattern) | 2 |
| Per-book number format | `commercialNumberingPolicies` | — | **R** for commercial series; document series use `trackingSequences` rows directly | 1 |
| Evidence originals, hashing, sealing, versions, relationships | vault (0019) | SHA-256 at upload; immutability triggers | **R** + **E** | 1, 4 |
| Document registry (commercial) | `commercialDocuments` + links + deliveries | origin, issuer, lifecycle, number ledger, record-vs-revision separation | **U** (kept; linked to controlled revisions; its `documentRef DOC-` series becomes the archival series) | 1, 6 |
| Configurable document types | `commercialCategoryTypes(document_type)` | behaviour | **E** resolution rule; **N** `documentDefinitions` | 1 |
| Frozen revision + hash | `fieldTicketRevisions`, `billingSnapshots`, `quotes.snapshot*` | one generic revision table | **R** pattern; **N** `documentRevisions` | 1 |
| Rendered artifact + hash | `fieldTicketDocuments` | renderer version; generic kinds; derivatives | **U** into `documentArtifacts` (field-ticket slice) | 1 (thin), 3, 6 |
| Renderer | `ticketPdf.ts` | version constant; clock out of the bytes; template input | **E** | 3 |
| Template library | none | everything | **N** `documentTemplateRevisions` | 3 |
| Proposal store / OCR | `documentExtractions`, `assistantProposals`, `proposalFields`, `assistantQuestions`, `documentFingerprints` | engine wiring; `sourceRegionJson`; per-field confirmedBy/At (or rely on `documentEvents`) | **R** + **E** | 4 |
| Typed commit | `assistantCommitService` + adapters | a `document_record` adapter target | **E** | 4 |
| Signatures | `fieldTicketSignatures` (+ device attestation, `payloadHash`) | generic revision binding; unique `(ticket, revision)`; transaction | **E** (D-08) | 6 |
| Print audit | none (enum values only); academy sheet print run as precedent | everything | **N** `documentPrintEvents` | 5 |
| QR / verification | `roadsidePanelGrants` (reference-not-authority), portal tokens (hashed, TTL) | a random `verificationRef`, a resolver procedure, a QR image at render | **E** pattern; **N** column + procedure | 3 |
| Links | `evidenceRelationships` enum; `commercialDocumentLinks` | links from a record that has no evidence row; new entity types | **N** `documentLinks` sharing the enum constant | 1 |
| External identifiers | one column per table; free text | issuer-scoped normalized references with confirmation | **N** `documentExternalReferences`; **E** read/write adapters over the columns | 1 |
| Audit trail | per-domain event tables; outbox; `authorizationDecisions` | a document event table; document emitters | **N** `documentEvents` (the convention) + **E** outbox emitters | 1 |
| Idempotency | `clientCaptureRef`, `packageRef`+nonce, receipts, `awardIdempotencyKey` | `consumptionRef`, `clientRequestRef`, `printRef` | **R** pattern; HS3 command ledger when it lands | 1, 2 |
| Tenant scope, anti-enumeration | `resolveActingScope`, `orgScopeWhere`, `entityScope.notFound` | — | **R** | every |
| Authorization | `roleProcedure`, permission maps, sensitive fail-closed | `document.*` permissions | **E** (map entries) | every |
| Retention / holds | `retentionPolicies`, `recordRetentionState`, `legalHolds` | holds on non-evidence rows (the compliance C9 item) | **R** | 1 (reference), 9 |
| Sync protocol | `syncPackages/Items/Receipts`, nonces, device keys | the number-claim item kind; HS3 command ledger | **E** | 2, 7 |
| Offline runtime | `client/src/runtime/*` (browser fallback), native adapters (stubs) | native shell | **R**; native = roadmap item 7 | 7, 8 |
| Search | `surfaces.search`, `surfaces.chain` | document hits; job register | **E** | 6 |
| Delivery | `commercialDocumentDeliveries`, portal alerts, webhooks | email/SMS transport | **R**; transport is not this initiative | — |
| Retention durations, regulatory text | `retentionPolicies.statutorySourceStatus`, knowledge registry | verified sources | **R**; **nothing invented** | — |

### 2.1 What must NOT be rebuilt

* A second vault, a second seal, a second version chain (`evidenceRecords/Versions/Seals`).
* A second proposal/confirmation store or a second confidence policy (`proposalFields`, `documentExtraction.CONFIDENCE_POLICY`).
* A second sequence counter (`trackingSequences`) or a second block allocator pattern (`sheetSerialAllocator`).
* A second sync protocol, device identity, nonce or package signature (`syncPackages`, `fieldDevices`, `deviceSignature.ts`).
* A second event bus (`domainEventOutbox`, `emitDomainEvent`).
* A second canonical hasher (use the C1a shared sha256 canonical hasher; do not add a fifth `canonicalJson`).
* A second authorization wrapper or permission catalogue.
* A second retention or legal-hold model, or any retention *duration*.
* A second credential-validity engine (`documentValidity.ts` / D-05 projection) or a second readiness composer.
* A second HOS record, sequence or edit history.
* A second facility registry or a second "issuing organization" table (`organizations` + `organizationRecordLinks` + `facilities`).
* A second delivery log (`commercialDocumentDeliveries`).

## 3. Repository survey — one-paragraph verdict

The tree already holds the *pieces* of Document Control: a locked sequence allocator with the owner's exact number format, a block allocator with explainable gaps, an evidence vault with seals and legal holds, a frozen-revision-plus-rendered-artifact pattern, a proposal store that never confirms on its own, a signature record bound to a payload hash, a registry with links and deliveries, and retention that refuses to invent durations. What it lacks is the **one record layer that ties them together**: a definition of how each document class behaves, a record identity that survives revisions, a per-number ledger, issuer-scoped external references, and a per-document event trail. That layer is what this design specifies. It is small, and it is, under the moratorium, still new.

---

## 4. Domain boundaries

Document Control is the **system of record for the identity, provenance, lifecycle, numbering and evidence of a controlled document**. It is not the authority for the facts a document states. That authority stays where it is:

| Fact | Authority (unchanged) | Document Control's role |
|---|---|---|
| What happened on site, durations, quantities | `fieldTickets`, `fieldTicketLines`, `fieldTicketRevisions` (live path `closeoutRouter`) | numbers the ticket, holds the controlled revision that references the domain's frozen snapshot, records renderings, prints, links, external refs |
| Disposal weights, facility acceptance, reconciliation | `disposalTickets`, `loadFacilityAssessments` (`destinationAcceptance.ts`), `facilityStatements/Lines`, `disposalReconciliation.ts` (unwired) | archives the facility's paper, records its ticket number under the facility's authority, links it to the load |
| Whether a driver is qualified now | `complianceDocuments` + `academyQualifications` through `readinessComposer` (D-05) | stores artifact provenance, version and evidence; **never** answers "in force" |
| Whether a unit may leave the yard | `readinessComposer`, `inspections`, `maintenanceDefects`, `workOrderReleases`, enforcement | attaches inspection/registration/insurance artifacts to the unit |
| Hours of service | `dutyRecords`, HOS profiles/ledger, `hosAttestations`, `hos.ts` | archives a scanned paper log (already `complianceDocuments hos_daily_log`) and, when an export exists one day, its artifact; never edits HOS (§12.4) |
| Money | `invoices`, `billingSnapshots`, billing book, AR | links the invoice artifact and the ticket revisions it was drafted from; never prices |
| Bytes, seals, versions, holds, retention | vault + `legalHolds` + `retentionPolicies` | **reuses** them: every scan original and every rendered artifact is, or points at, an evidence record |

**Rule:** a controlled record may point at a domain row and a domain row may point back, but neither copies the other's facts. The frozen revision payload is a snapshot taken at a boundary event, labelled as such (`snapshotJson` + `snapshotHash`, the `fieldTicketRevisions` pattern), not a second live copy.

## 5. Terminology

Repository names win over industry names (`docs/register/AI_RUNTIME_TERMINOLOGY.md`). *(proposed)* marks a name this design introduces.

| Term | Meaning | Existing anchor |
|---|---|---|
| **Document definition** *(proposed: `documentDefinitions`)* | Class and behaviour of a kind of controlled record; versioned, immutable once active | `commercialCategoryTypes(document_type)` (label only), `complianceRequirements` (`requirementKey`+`version`, `jurisdiction`, `packKey`), `FORMS` (`aiProposal.ts:112`) |
| **Controlled record** *(proposed: `documentRecords`)* | One document's immutable identity, definition version, origin, issuer, number and lifecycle state | `commercialDocuments` (registry), `complianceArtifacts` |
| **Revision** *(proposed: `documentRevisions`)* | A frozen payload of a record plus the template and renderer that rendered it. Never rewritten | `fieldTicketRevisions`, `evidenceVersions`, `manifests.currentHash` |
| **Artifact** *(proposed: `documentArtifacts`)* | Hashed bytes derived from a revision or a scan: rendered PDF, thumbnail, OCR text, corrected image | `fieldTicketDocuments` |
| **Scan / evidence** | The untouched original a person captured: an `evidenceRecords` row | vault |
| **Extraction proposal** | OCR/model output about a scan; a proposal until confirmed | `documentExtractions`, `proposalFields` |
| **Series** | A `trackingSequences` row family (`sequenceType`, format, reset period), now tenant-owned | `trackingSequences`, `nextTrackingNumber` |
| **Controlled number** | The human-readable LeaseOS number: a rendering of `(sequenceType, periodKey, sequence)` stored on the ledger row that owns it | `fieldTickets.ticketNumber` (`FT-2026-000123`) |
| **Allocation** *(proposed: `documentSequenceAllocations`)* | A server-issued contiguous block of a series, bound to the server pool or to one enrolled device | `sheetSerialAllocations` (per print batch) |
| **Ledger row** *(proposed: `documentSequenceLedger`)* | One row per number ever allocated; its state answers "what happened to N" | none |
| **External reference** *(proposed: `documentExternalReferences`)* | An identifier another organization issued, scoped by its issuer | `disposalTickets.facilityTicketNumber`, `facilityStatementLines.facilityTicketNumber`, `fieldTickets.afeNumber` |
| **Origin** | How the document entered LeaseOS and whose form it is | `proposalFields.source` (per field), `manifests.generatedFromReferenceJson` |
| **Issuer** | The organization whose authority stands behind the document's own number | `facilities`, `organizations` + `organizationRecordLinks`, `manifestPartySnapshots` (captured name beside canonical id) |
| **Template revision** *(proposed: `documentTemplateRevisions`)* | Immutable released layout + field mapping, with source, hash, renderer version | `writtenProgramVersions` (versioned documents) |
| **Print event** *(proposed: `documentPrintEvents`)* | One attempt to put one artifact of one revision on paper | `academy.sheetPrintRun`, `commercialDocumentDeliveries(print)` |
| **Document event** *(proposed: `documentEvents`)* | Append-only history row for anything Document Control does | `fieldTicketEvents`, `manifestCustodyEvents`, `dispatchAuditEvents` |
| **Jurisdiction pack** | `packKey` configuration naming which definitions, required fields, retention references and terminology apply where | `compliancePacks`, `companyPackActivations`, `complianceRequirements.jurisdiction` (`*` = any) |

## 6. Invariants

Numbered so tests (§24) and failure cases (§21) cite them.

**Identity**
* **I-1** A controlled record has exactly one internal identity (`documentRecords.id` + opaque `recordRef`) that never changes and is never reused.
  *Amended 2026-09-24 (adoption ruling):* as built, a controlled document is **one control number and one supersede chain** in the extended `commercialDocuments` register. Each version is a row with its own `documentRef`; a correction adds a row, and the control number moves to it in the same transaction, so the number always sits on the current version and is unique per business. Rows are never reused or deleted, and any version's reference resolves to the whole chain.
* **I-2** A controlled record has at most one LeaseOS controlled number, owned by exactly one ledger row, stored as `(sequenceType, periodKey, sequence)` plus its rendered `displayNumber`. No code parses the display string to decide anything.
* **I-3** A record may carry any number of external references. None overwrites, replaces or stands in for the controlled number; each names its issuer scope.
* **I-4** Every rendered revision names the template revision, template content hash, renderer version and rendered-artifact hash. A later template revision never changes a stored revision.

**Numbering**
* **I-5** A number, once allocated (pool or device), is never returned to the pool; its ledger row is never deleted; its terminal state is one of an explicit set (§8.4).
* **I-6** Two allocations of one series never overlap; two records never hold one number. Database-enforced: unique `(sequenceType, branch, periodKey, sequence)` on the ledger; allocations cut only from the row-locked `nextNumber`.
* **I-7** A device consumes only numbers inside a block the server allocated to that device, for that tenant, that is not retired. Anything else is refused and recorded, never silently accepted.
* **I-8** A series, an allocation and a ledger row belong to one organization and cannot move to another.

**Lifecycle**
* **I-9** Once a revision crosses its definition's freeze boundary, its payload is immutable. Change is a new revision with `supersedesRevisionId`, a reason and an actor.
* **I-10** Void, cancel and reject keep the record and the number and add a state, a reason and an actor. Nothing is deleted through application workflows.
* **I-11** An externally issued document is never represented as LeaseOS-issued: `origin` and `issuerKind` are mandatory; a generated origin requires `issuerKind='tenant'`; an archived origin refuses it.

**Evidence**
* **I-12** A scan's original bytes are an evidence record with a content hash; derivatives are separate artifacts naming their source. No derivative replaces an original.
* **I-13** OCR and model output are proposals. A field becomes a fact only through the existing `proposalFields` confirmation (`confirmed | corrected`) with a recorded actor.
* **I-14** A document with no template match and no recognised class still enters Document Control (`unclassified`, review pending). Failure to classify is never failure to record.

**Tenancy and authorization**
* **I-15** Tenant scope comes from `resolveActingScope`, never from the request body. Every Document Control table carries `orgRef`, written from acting scope.
* **I-16** Every procedure is a `roleProcedure` with a mapped permission. Cross-tenant references answer NOT_FOUND (`entityScope.notFound`).

**Audit**
* **I-17** Every state transition of a record, revision, ledger row, allocation, external reference, link, artifact or print is a `documentEvents` row written in the same transaction, with actor, time, reason and the hashes in play, and is emitted to `domainEventOutbox` from that transaction.

## 7. Entity and data model

### 7.1 The smallest coherent set

Nine tables in Checkpoint 1, two more in Checkpoints 3 and 5; two existing tables extended. Everything else is reuse. Conventions: camelCase table, `int autoincrement` PK, opaque unique `*Ref` varchar, `orgRef` varchar(64), `text("…Json")`, status enums, supersession pointers, no FKs, `createdAt` default now.

| Table | Purpose | Why not an existing table |
|---|---|---|
| `documentDefinitions` (N) | class + behaviour, versioned | `commercialCategoryTypes` holds a label; extending it would give a load category a numbering policy |
| `documentRecords` (N) | identity, definition version, origin, issuer, lifecycle, number, current revision | `commercialDocuments` registers *bytes* (`contentHash` NOT NULL) and issues a new `documentRef` per version, so record identity is not stable across revisions (violates I-1); `complianceArtifacts` has no revisions or provenance |
| `documentRevisions` (N) | frozen payload + hash, template revision, renderer, supersedes chain | `fieldTicketRevisions` is field-ticket-only and stays the domain's own snapshot; a controlled revision references it |
| `documentLinks` (N) | polymorphic links to LeaseOS entities | `evidenceRelationships` is keyed by `evidenceRecordId`; a generated document without a scan has no evidence row. Same `entityType` enum, exported as one shared constant |
| `documentExternalReferences` (N) | issuer-scoped external identifiers with confirmation state | today: one column per table plus free text |
| `documentArtifacts` (N, thin in CP1) | rendered PDFs and scan derivatives with `derivedFrom` | `fieldTicketDocuments` is the pattern, field-ticket-only; `evidenceVersions` is an amendment chain, not a derivative chain |
| `documentSequenceAllocations` (N) | server-issued blocks, pool or device | `sheetSerialAllocations` is per print batch of one academy scope |
| `documentSequenceLedger` (N) | one row per number, its state, its record | none; this makes I-5/I-6 database facts |
| `documentEvents` (N) | append-only history for the whole subsystem | the per-domain convention (`fieldTicketEvents` etc.); no generic audit table exists |
| `trackingSequences` (E) | + `orgRef`, `formatVersion`, `status active|retired`, `retiredAt` | the existing allocator becomes tenant-safe and retirable; nothing else changes |
| `evidenceRelationships.entityType` (E) | + `dispatch`, `lease`, `contact`, `vendorBill`, `purchaseOrder`, `qualification`, `trainingCertificate` via the shared constant | one enum for both link tables |
| `documentTemplateRevisions` (N, CP3) | immutable released template + mapping, source, hash | none |
| `documentPrintEvents` (N, CP5) | one print attempt of one artifact of one revision | `commercialDocumentDeliveries(print)` records a delivery, not revision/hash/copy kind/printer outcome |

Not added: a separate `documentTemplates` identity table (`templateKey`+`version` on one table, the `complianceRequirements` pattern); a separate `documentSeries` table (a series *is* a `trackingSequences` family); a scan table (scans are `evidenceRecords`); an OCR table (`documentExtractions` + `proposalFields`); a signature table (D-08: generalize `fieldTicketSignatures`); a retention table; an idempotency table (per-column keys now; the HS3 command ledger when it lands).

### 7.2 `documentDefinitions` (proposed)

This and §8 are the two decisions the owner asked to inspect. The definition describes **how a class behaves**; it holds no document.

```
documentDefinitions
  id                    int PK
  definitionKey         varchar(60)     field_ticket | disposal_ticket | external_disposal_receipt | scale_ticket |
                                        bill_of_lading | proof_of_delivery | load_ticket | manifest | jsa | tailgate |
                                        incident_report | driver_licence | training_certificate | insurance_certificate |
                                        vehicle_inspection | work_order | fuel_receipt | supplier_invoice | sds |
                                        hos_paper_log | hos_export | unclassified_external | …
  version               int             unique (orgRef, definitionKey, version); immutable once status != draft
  orgRef                varchar(64) NULL  NULL + builtIn = LeaseOS built-in (the commercialCategoryTypes / capabilityEntitlements convention)
  builtIn               boolean
  category              enum: operational | credential_evidence | financial | regulated_record | reference | incident_evidence
  displayName           varchar(160), description varchar(500)
  domainOwner           varchar(60) NULL   the authoritative domain table for the facts: fieldTicket | disposalTicket | manifest |
                                        load | complianceDocument | academyQualification | inspection | workOrder | invoice |
                                        vendorBill | incident | hos | none
  formKey               varchar(60) NULL   the FORMS entry (aiProposal.ts) whose slots are the semantic fields; NULL for evidence-only
  lifecycleKey          enum: controlled_issue | evidence_capture | reference_version          (§10)
  originPolicyJson      json    { allowed: [origin…], default }                                  (§7.4)
  numberingPolicy       enum: leaseos_sequence_required | leaseos_sequence_optional | archival_sequence_only |
                              external_sequence_only | domain_managed_sequence | no_human_sequence   (§8.1)
  defaultSequenceType   varchar(24) NULL   the trackingSequences.sequenceType a leaseos_* policy draws from (FT, DSP, BOL, JSA, DOC…)
  externalRefPolicyJson json    { allowed: [referenceType…], required: [...], issuerKinds: [...] }      (§7.6)
  templatePolicyJson    json    { leaseosTemplate, organizationTemplate, customerTemplate, externalForm: bool }   (§11)
  importPolicyJson      json    { scan: bool, digitalImport: bool, ocrProfileKey: string|null }
  requiredFieldsJson    json    semantic paths required before COMPLETED; optional paths                   (§11.4)
  allowedLinksJson      json    subset of the shared entityType enum
  signaturePolicyJson   json    { required: [{ role: driver|customer_rep|facility|supervisor|second_person,
                                  methods: [drawn|device_auth|pin|paper_scan|portal_link] }], freezeOn: signed | issued }
  revisionPolicy        enum: immutable_after_freeze | amend_by_revision | reference_version
  printPolicyJson       json    { markOriginal, markCopies, reprintReasonRequired, receiptWidthLayout: bool }
  retentionPolicyKey    varchar(80) NULL   → retentionPolicies.policyKey (its statutorySourceStatus stays the authority)
  jurisdictionsJson     json    ['*'] | ['CA', 'CA-AB', …]   (complianceRequirements convention)
  packKey               varchar(60) NULL   → compliancePacks.packKey where pack-supplied
  sensitivity           enum: normal | private   (the existing sensitive fail-closed path)
  status                enum: draft | active | superseded | retired
  effectiveFrom, effectiveUntil, supersededByVersion int NULL
  createdByUserId, approvedByUserId, createdAt
```

Design choices, and why:

* **Behaviour a constraint or a query depends on is a column** (`numberingPolicy`, `lifecycleKey`, `revisionPolicy`, `category`, `status`, `jurisdictionsJson`). Behaviour the application interprets is JSON, so a company adds a definition **without a migration** (extensibility requirement, §28).
* **No permissions column.** Permissions stay in the `roleProcedure` map keyed by category and action (§15). A per-definition permission list would be string-built authorization.
* **`formKey` is a reference, not a copy.** `FORMS` already defines slots, precision sensitivity and types. Where no form exists (licence, SDS), `formKey` is NULL and `requiredFieldsJson` lists metadata only.
* **`domainOwner` is declarative**: it selects the adapter that freezes the payload (`fieldTicketRevisions` for a field ticket, `disposalTickets` for a disposal ticket, `complianceDocuments` for a credential) and names the authority Document Control defers to.
* **Versioning is the `complianceRequirements` pattern**; a record stores the definition *version* it was created under, so a policy change never re-classifies history.
* **Built-ins are seed rows** (`orgRef NULL`, `builtIn=true`); a tenant overrides by its own `(orgRef, definitionKey)` row, resolved tenant-first (the `commercialCategoryTypes` rule). Built-in seeds carry `jurisdictionsJson` and `packKey` **only** for classes whose applicability is a product fact (a field ticket applies everywhere); anything that depends on a regulation is `jurisdictionsJson: ['*']` with a pack that is itself `unverified` until a person verifies its source, exactly as `complianceRequirements` behaves.

### 7.3 `documentRecords` and `documentRevisions` (proposed)

```
documentRecords
  id, recordRef (opaque, unique)                                                   I-1
  orgRef                  varchar(64)  written from acting scope                    I-15
  clientRequestRef        varchar(96) NULL, unique (orgRef, clientRequestRef)      idempotent create (§16)
  definitionId            → documentDefinitions (the version used)
  origin                  enum (§7.4)                                               I-11
  issuerKind              enum: tenant | facility | customer | vendor | regulator | manufacturer | government | other | unknown
  issuerFacilityId NULL, issuerOrgRef NULL, issuerNameCaptured varchar(220)          captured beside canonical (manifestPartySnapshots)
  ledgerId                NULL → documentSequenceLedger (the controlled number)     I-2
  archivalLedgerId        NULL → documentSequenceLedger (DOC archival series, D-02)
  domainRecordType varchar(40) NULL, domainRecordId int NULL                        the authoritative domain row
  state                   enum per lifecycleKey (§10)
  reviewState             enum: none | pending_classification | pending_confirmation | reviewed
  currentRevisionId       NULL → documentRevisions
  verificationRef         char(26) unique   128 random bits, base32 (§17)
  legalHold               boolean default false   (mirror; the hold itself is legalHolds)
  createdByUserId, createdAt, updatedAt

documentRevisions
  id, revisionRef, orgRef
  documentRecordId, revision int, unique (documentRecordId, revision)
  kind                    enum: original | correction | supplement | replacement | reissue
  snapshotJson            text    canonical payload
  snapshotHash            char(64) sha256 over the shared canonical form (C1a hasher)
  domainRevisionRef       varchar(80) NULL   e.g. fieldTicketRevisions.documentRef when the domain froze its own copy
  templateRevisionId NULL, templateContentHash char(64) NULL, rendererVersion varchar(40) NULL   I-4
  renderedArtifactId      NULL → documentArtifacts
  frozenAt, frozenByUserId, freezeReason enum: signed | issued | sealed | imported | reference_registered
  supersedesRevisionId NULL, supersededAt NULL, supersededByRevisionId NULL
  reasonCode varchar(60), comment varchar(500)
  createdAt
```

A revision is written once. The only later write is the `supersededAt/By` pair, NULL → value exactly once. Whether the database refuses UPDATEs on frozen revisions with a trigger is the same question the compliance design raised for the vault ("DB immutability triggers", its C1b); this design recommends one trigger convention (`SIGNAL SQLSTATE '45000'`, the `manifests_seal_guard` form) applied to `documentRevisions`, `documentSequenceLedger` (state-only updates), `documentEvents` and `evidenceVersions` in the same checkpoint, so there is one immutability mechanism.

### 7.4 Origin and provenance

```
origin (documentRecords):
  leaseos_generated        LeaseOS template, LeaseOS number, tenant is issuer
  organization_template    tenant's own uploaded form; LeaseOS fill and number; tenant is issuer
  customer_template        a customer's required form; LeaseOS fill; issuer = tenant unless the customer assigns a number,
                           which is then an external reference
  external_form_rendered   an approved regulator/external form rendered by LeaseOS; LeaseOS does not own the form;
                           the form's own number, if any, is an external reference
  external_scanned         paper someone else issued, captured as a photo/scan
  external_digital_import  a PDF/CSV/API document someone else issued
  reference_document       SDS, policy, procedure, contract; publisher is the issuer
  system_rendered          a LeaseOS projection nobody authored (a job register, an HOS export)
```

From a record LeaseOS always answers **who issued it** (`issuerKind` + facility/org link + captured name), **whether LeaseOS generated it** (`origin ∈ {leaseos_generated, organization_template, customer_template, external_form_rendered, system_rendered}`), **whether LeaseOS merely archived it** (`external_scanned`, `external_digital_import`, `reference_document`), and **whose visual form it is** (`documentTemplateRevisions.source`, or none). I-11 is enforced at the write against `originPolicyJson.allowed`. `proposalFields.source` remains the provenance of **each field value**; `origin` is the provenance of **the document**. Different facts, different columns.

### 7.5 `documentLinks`

```
documentLinks
  id, orgRef, documentRecordId
  entityType (the shared evidenceRelationships enum), entityId int NULL, entityRef varchar(64) NULL, role varchar(60) NULL
  source enum: system | user | ocr_proposed | import
  confirmationStatus enum: proposed | confirmed | rejected
  linkedByUserId, linkedAt
  unique (documentRecordId, entityType, entityId, entityRef, role)
```

Targets resolve inside the caller's `orgRef` through the existing per-domain scope loaders (`jobInScope`, `unitInScope`, `fieldTicketInScope`, `coreRecordOwnership`, `entityScope`); an out-of-scope target is NOT_FOUND (I-16, T-21). The **job document register** (§19) is a query over links of the job and of its trips, loads, field tickets and disposal tickets, grouped by `origin` and `issuerKind`.

### 7.6 `documentExternalReferences`

```
documentExternalReferences
  id, orgRef, documentRecordId
  referenceType       enum: facility_ticket | scale_ticket | customer_po | afe | manifest_number | regulatory_id |
                            supplier_invoice | bol_reference | customer_job_number | licence_number | certificate_number |
                            permit_number | policy_number | statement_number | other
  value               varchar(120)  as written
  normalizedValue     varchar(120)  trimmed, upper-cased, internal spaces removed (documentFingerprint's TICKETNO rule); leading zeros kept
  issuerKind          enum (as documentRecords.issuerKind)
  issuerFacilityId NULL, issuerOrgRef NULL, issuerNameCaptured varchar(220)
  issuerScopeKey      varchar(100)  'facility:<id>' | 'org:<ref>' | 'name:<normalized captured name>' | 'unknown'
  source              enum: typed | photo_ocr | imported | portal | system   (proposalFields.source, narrowed)
  proposalFieldId     NULL → proposalFields
  confirmationStatus  enum: proposed | confirmed | rejected | conflict
  confirmedByUserId, confirmedAt, correctedFrom varchar(120) NULL
  confirmedKey        varchar(300) NULL  = orgRef|referenceType|issuerScopeKey|normalizedValue when confirmed, else NULL; UNIQUE
  createdAt
```

MariaDB has no partial unique index; `confirmedKey` (NULL until confirmed; NULLs never collide) gives uniqueness among *confirmed* references only, the same trick as `evidenceRecords.clientCaptureRef`. A second confirm of the same `(issuer scope, type, value)` lands as `conflict`, both documents show it, and `document.confirm` resolves it: one is corrected, or a reviewer records `issuer_reused_number` and the newer one confirms with `issuerScopeKey` suffixed `#2`. Two facilities issuing `12345` never collide (different scope keys). `issuerScopeKey='unknown'` cannot be confirmed: unknown is not a scope.

The domain columns are not removed. `disposalTickets.facilityTicketNumber`, `fieldTickets.afeNumber`, `loads.loadTicketNumber`, `manifests.scaleTickets` stay the domain's captured snapshot; a **read adapter** presents existing rows as references, new writes go through the reference table and are projected back by the domain's own procedure (so `facilityStatements.ts:25` matching and `documentFingerprint.ts` keys keep reading the column they read today). Retiring a column is a later decision with the credential-store prerequisites as the template (readers, replacement path, equivalence tests, migration, rollback).

### 7.7 `documentArtifacts`

```
documentArtifacts
  id, artifactRef, orgRef, documentRecordId
  revisionId NULL          (a rendering belongs to a revision; a scan derivative to the record)
  evidenceRecordId NULL    the original this derives from, or the vault record holding the rendering
  kind                     enum: rendered_pdf | rendered_receipt | thumbnail | ocr_text | searchable_pdf | perspective_corrected | enhanced | export
  derivedFromArtifactId NULL
  storageKey, mimeType, byteLength, contentHash char(64)
  rendererVersion NULL, ocrEngine NULL, ocrEngineVersion NULL
  generatedByUserId NULL, generatedAt
  unique (revisionId, kind) for rendered_pdf / rendered_receipt
```

Originals are never rows here; they are `evidenceRecords`. `fieldTicketDocuments` keeps working; the field-ticket adapter registers each of its rows as an artifact of the corresponding controlled revision so search and audit see one thing; the two tables are unified in the field-ticket slice (CP6).

### 7.8 `documentEvents`

```
documentEvents
  id, eventRef, orgRef
  subjectType enum: record | revision | ledger | allocation | external_reference | link | artifact | print | template | definition
  subjectId int, documentRecordId int NULL (denormalized for the timeline query)
  eventType varchar(60)     e.g. record.created, number.assigned, revision.frozen, signature.recorded, print.original,
                            reference.confirmed, ledger.void, allocation.issued, allocation.reconciled
  fromState varchar(40) NULL, toState varchar(40) NULL
  actorUserId NULL, actorSource enum: human | system | ai | integration | device (outbox vocabulary + device)
  fieldDeviceId NULL, externalIdentityId NULL
  reasonCode varchar(60) NULL, comment varchar(500) NULL
  hashesJson text NULL      { snapshotHash, artifactHash, templateContentHash, payloadHash }
  occurredAt (server), deviceClockAt NULL
  outboxEventId varchar(64) NULL   the domainEventOutbox row emitted from the same transaction
  createdAt
```

Append-only, per the convention and (recommended) trigger. No hash chain: `academyAuditEvents` shows the chain forks without a lock, and a per-row trigger plus the outbox gives the auditor the same guarantee without the race.

## 8. Number-series design

### 8.1 Numbering policy per definition

| Policy | Meaning | Examples | Ledger row |
|---|---|---|---|
| `leaseos_sequence_required` | cannot leave DRAFT without a number from a LeaseOS series | field ticket, BOL, LeaseOS disposal ticket, LeaseOS manifest, JSA, incident report | always |
| `leaseos_sequence_optional` | a series exists; org or per-record choice | organization-template forms, work orders the shop numbers | when taken |
| `archival_sequence_only` | LeaseOS never issues a business number; the org may assign an archival number from the `DOC` series | external disposal receipt, fuel receipt, scale ticket, supplier invoice | if D-02 |
| `external_sequence_only` | the document's only human number is the issuer's | driver licence, insurance certificate, permit, government inspection | never |
| `domain_managed_sequence` | another LeaseOS domain owns the number and rules | invoice (`INV` stays in `invoicingRouter`), HOS export, quote | never; `domainRecordId` carries it |
| `no_human_sequence` | internal identity only | SDS, policy, procedure, photo attachments | never |

This stops LeaseOS fabricating numbers for documents another authority numbered (I-3, I-11). `recordRef` exists in every case.

### 8.2 The series: `trackingSequences`, extended

The allocator the owner's example format needs already exists and already produces `FT-2026-004812`. This design **does not add a series table**; it adds four columns to `trackingSequences` and one rule:

```
trackingSequences (existing: sequenceType, branch, periodKey, nextNumber, prefix, separator, yearDigits, includeMonth,
                   sequenceDigits, resetPeriod never|yearly|monthly, updatedAt; SQL unique (sequenceType, branch, periodKey))
  + orgRef        varchar(64)  NULL = 'default' per orgScopeWhere; unique becomes (orgRef, sequenceType, branch, periodKey)
  + formatVersion int default 1   which formatter renders displayNumber; formatters are code, versioned, never edited
  + status        enum active | retired, default active
  + retiredAt     timestamp NULL
```

* **A reset is already a new row.** `periodKeyFor` yields a new `periodKey` per year/month and `INSERT IGNORE` seeds it at 1; the old period row is never rewound. Annual reset is therefore the existing `resetPeriod='yearly'`; D-01 decides the default per series.
* **The number is a stored rendering**: `formatTrackingNumber(format, at, sequence, branch)` runs once at allocation and the result is stored on the ledger row as `displayNumber`; a later `formatVersion` applies only to numbers allocated after it.
* **Branch**: `trackingSequences.branch` exists and no caller passes it; D-03 decides whether document series may be branch-scoped. Default: organization-wide, `branch=''`.
* **Tenant safety**: `orgRef` on the counter row and on every ledger row; the allocator receives the org from acting scope, never from input.
* **Existing minters keep working**: `FT`, `INV`, `DSP`, `DOC`… continue to call `nextTrackingNumber`; the only behavioural change for them is that a tenant's rows are scoped by `orgRef` (backfill: existing rows get `orgRef NULL` = default, per the convention).

### 8.3 `documentSequenceAllocations` and `documentSequenceLedger`

```
documentSequenceAllocations
  id, allocationRef, orgRef
  sequenceType varchar(24), branch varchar(12) default '', periodKey varchar(16)
  firstSequence, lastSequence            inclusive; cut from nextNumber under the row lock
  allocatedTo   enum: server_pool | device
  fieldDeviceId NULL → fieldDevices (required when device); deviceKeyFingerprint (the enrolled key at allocation)
  issuedAt, issuedByUserId, issuingProcess varchar(60)
  status        enum: active | exhausted | retired | device_lost | revoked
  reconciliationState enum: not_required | pending | reconciled | discrepancy; lastReconciledAt
  unique (orgRef, sequenceType, branch, periodKey, firstSequence)

documentSequenceLedger
  id, orgRef, sequenceType, branch, periodKey, sequence     unique (orgRef, sequenceType, branch, periodKey, sequence)   I-6
  displayNumber varchar(40)   unique (orgRef, displayNumber)
  allocationId → documentSequenceAllocations
  state enum (§8.4)
  documentRecordId NULL, unique when not NULL                                                                 I-2
  consumptionRef varchar(96) NULL unique   the device's idempotent claim id (the clientCaptureRef pattern)
  claimedByDeviceRef NULL, claimedAtDeviceClock NULL, claimedAtServer NULL
  stateReason varchar(60), stateComment varchar(500), stateChangedByUserId, stateChangedAt
  createdAt
```

**Eager ledger rows.** Allocating a block of N inserts N ledger rows in `allocated_device` (or `allocated_pool`) in the same transaction as the counter increment and the allocation row (the `sheetSerialAllocator` shape, plus rows). That is the answer to "what database invariant prevents overlap": an overlap needs two rows with one `(org, type, branch, period, sequence)`, and the unique index refuses it, so an overlapping allocation cannot commit even if application logic were wrong. Consumption is an UPDATE of an existing row guarded by `WHERE state='allocated_device' AND allocationId=? AND documentRecordId IS NULL`; `affectedRows=0` is a refusal, never a retry with another number.

**Online single numbers** do not create an allocation per number: one standing `server_pool` allocation per `(org, type, period)` is created lazily, and each online issue inserts one ledger row `state='used'` directly under the counter lock. Pool rows are therefore explainable too: a draft abandoned before completion moves its row to `cancelled` (I-10), not to nothing.

### 8.4 Ledger state machine

```
allocated_pool    ──online issue──────────────────────────────▶ used
allocated_device  ──device claim accepted at sync──────────────▶ used
allocated_device  ──device reports "blank, never used" at reconciliation──▶ unused_retired
allocated_device  ──device decommissioned / lost / stolen (fieldDevices revoked)──▶ device_lost
allocated_*       ──series period retired with unconsumed numbers──▶ unused_retired
allocated_* | used ──operator declares the paper stock bearing this number lost──▶ lost
used              ──void with reason (record void)──────────────▶ void
allocated_pool    ──draft abandoned before completion───────────▶ cancelled
```

Terminal: `used`, `void`, `unused_retired`, `device_lost`, `lost`, `cancelled`. Two things the prompt listed are deliberately **not** ledger states: `duplicate_attempt` is a `documentEvents` row on the allocation (someone else's failed claim does not change the number's state), and `damaged` is a **print outcome** (§13): a damaged printout of a used number is reprinted; the number is unaffected. The gap report (§19.3) lists every number whose state is not `used` with its reason. "No silent gaps" is then a query, not a promise.

## 9. Offline block allocation and reconciliation

Blocks go only to **enrolled devices** (`fieldDevices.status active`, key fingerprint recorded), through `document.sequence.allocate`, scoped by `resolveActingScope`; the body names the `sequenceType` and nothing else. The block size is series policy (D-04). The response carries `allocationRef`, the pre-rendered `displayNumber` list, `formatVersion`, and is included in the device's next signed sync manifest so a later report can be checked against what was issued.

**Device** (contracts only until the native shell exists, §20): claims the lowest unclaimed number in its active block for a capture, stores `consumptionRef` (its own id for the claim), and includes `{ allocationRef, sequence, consumptionRef, localId, capturedAt }` as a new `syncPackageItems` item kind. The device never computes a number from a formula; it copies one it was given.

**Server, per claim, inside the `syncPackages` receipt** (which this design requires to become transactional; `receivePackage` runs no transaction today, §1.9):
1. Load the allocation by `allocationRef` `FOR UPDATE`. Refuse (NOT_FOUND) if `orgRef` ≠ acting scope; refuse if `fieldDeviceId` ≠ the signing device or status ∉ {active, exhausted}. (I-7, I-8)
2. Refuse if `sequence ∉ [firstSequence, lastSequence]`; write `documentEvents(allocation, 'claim.out_of_block')`.
3. `UPDATE ledger SET state='used', documentRecordId=?, consumptionRef=?, claimedByDeviceRef=?, claimedAtDeviceClock=?, claimedAtServer=now() WHERE … AND allocationId=? AND state='allocated_device'`.
   * 1 row → consumed.
   * 0 rows and the stored `consumptionRef` equals the claim's → **replay**; idempotent success, same record id (T-8, T-9).
   * 0 rows, different `consumptionRef` → two local records claimed one number. The second is refused; its capture is still stored as evidence with `reviewState='pending_confirmation'` and `state='number_conflict'`, no number; an exception item.
4. Device clock is recorded, never used for ordering; server receipt time orders the ledger. Out-of-order packages are fine: each claim is independent.

**Reconciliation** (`document.sequence.reconcile`): the device reports, per number in its block, `used | void | unused`; the server compares with the ledger and writes `reconciliationState`. It never accepts a redefinition of the block, a `used` the ledger has no record for, or an `unused` for a number the ledger shows `used`; each disagreement is `discrepancy` and an exception. Revoking a device (`devices.revoke`) moves every `allocated_device` row of its active blocks to `device_lost` and the allocation to `device_lost`; numbers stay explainable and are never reissued (I-5, T-11). A reassigned tablet is a *new* enrolment; the old identity keeps its blocks.

**Stale policy while offline**: a device holding a block from a retired period (annual rollover happened offline) may still consume it; the ledger rows exist and the period is the block's. New blocks come from the new period row; a block is never cut across periods.

## 10. Document lifecycle and state machines

Three lifecycles, selected by `lifecycleKey`. Each transition names its permission (§15) and its event (§7.8).

### 10.1 `controlled_issue` (field ticket, BOL, LeaseOS disposal ticket, LeaseOS manifest, JSA, incident report, work order)

```
draft ─assign number─▶ number_assigned ─required fields present─▶ completed
completed ─confirm (a person; or an authoritative system where policy says so)─▶ confirmed
confirmed ─sign per signaturePolicy─▶ signed
signed ─issue─▶ issued                                       (D-05: whether sign auto-issues)
issued ─new revision─▶ issued (currentRevisionId moves; prior revision superseded)

pre-issue, any state:          cancelled   (ledger → cancelled)
confirmed | signed | issued:   void        (ledger → void; revision frozen as-is; reason required)
completed | confirmed:         rejected    (reviewer refuses; resuming is a NEW revision, not an edit)
```

The **freeze boundary** is `signaturePolicyJson.freezeOn`: `signed` for anything a counterparty signs; `issued` for documents with no counterparty (JSA, daily report). Crossing it writes the revision's `snapshotJson`/`snapshotHash`/`frozenAt`; afterwards the only writes are new revisions with `supersedesRevisionId`, a reason and an actor. `fieldTickets.status='amended_after_signature'` is this rule already applied to one domain.

### 10.2 `evidence_capture` (external disposal receipt, scale ticket, fuel receipt, external inspection report, scanned licence, third-party training certificate, scanned paper log)

```
captured ─proposal (OCR/model/none)─▶ proposed
captured ─no class recognised─▶ unclassified   (reviewState = pending_classification)        I-14
proposed | unclassified ─human confirms class, issuer, references, links─▶ confirmed
confirmed ─office review where the definition requires it─▶ reviewed
confirmed | reviewed ─a better original or a correction arrives─▶ superseded (new record, linked)
any ─reviewer refuses (not a document, another tenant's paper, duplicate)─▶ rejected (kept, hidden by default)
```

No "issued": LeaseOS did not issue it. No number unless `archival_sequence_only`. The revision is written at `confirmed` with `freezeReason='imported'`, holding the confirmed field set, the evidence hash and the extraction reference, so "what did we confirm about this receipt that day" survives later domain amendments.

### 10.3 `reference_version` (SDS, policy, procedure, contract, insurance certificate as a company document)

```
registered ─▶ current ─newer version registered─▶ superseded
current ─withdrawn by publisher or org─▶ withdrawn
```

This is `commercialDocuments.status` and `writtenProgramVersions` generalized. Publisher = `issuerKind` (manufacturer, regulator…); version label and revision date are external references (`referenceType='other'`, `role`); product/material links go through `documentLinks` (a `loadProfiles` entity type is added with the shared enum). Never a business sequence (§28.3).

### 10.4 Corrections versus reprints

A materially changed document is a new revision. A reprint is a new print event of an existing revision (§13). They live in different tables and cannot be confused by construction: a print event has no payload; a revision has no printer.

## 11. Template sources, versioning and the semantic field model

### 11.1 `documentTemplateRevisions` (Checkpoint 3)

```
documentTemplateRevisions
  id, templateRevisionRef
  orgRef            NULL for LeaseOS standard; the tenant for organization | customer | external_form
  templateKey       varchar(60)   leaseos.field_ticket | pridevac.disposal_ticket | customerX.field_ticket
  version           int           unique (orgRef, templateKey, version)
  definitionKey     which definition this renders
  source            enum: leaseos_standard | organization | customer | external_form
  sourceOwnerName   varchar(220)  the customer or regulator whose form it is, when not the tenant
  status            enum: draft | approved | active | superseded | retired
  layoutKind        enum: page | receipt
  pageSpecJson, layoutStorageKey (uploaded PDF/HTML/JSON layout or LeaseOS layout id), layoutContentHash char(64)
  fieldMappingJson  json  [{ semanticPath, placement: {page,x,y,w,h} | {acroField}, label, required, format }]
  mappingVersion    int   informative; a mapping change is a new template revision (below)
  signatureBlocksJson, qrPlacementJson, brandingJson
  regulatoryTextRefs json   references into the knowledge registry (knowledgeDocuments/Versions); never inline regulatory text
  rendererVersion   varchar(40)   the deterministic renderer this revision is proven against
  validationRulesJson
  approvedByUserId, approvedAt, activatedAt, supersededByRevisionId, retiredAt, createdByUserId, createdAt
```

**Is a mapping change a new template revision? Yes.** A ticket rendered under mapping v3 must reconstruct under mapping v3, and the only way to guarantee that with one identity is to make the mapping part of the immutable revision. A separate mapping-version table would let a mapping change silently re-point a released layout. So `fieldMappingJson` lives on the revision; "edit the mapping" is "draft the next revision". A released customer or regulatory template is never edited (I-4); it is superseded.

**Reconstruction proof** per rendered revision (§7.3): `templateRevisionId`, `templateContentHash`, `snapshotHash`, `rendererVersion`, `renderedArtifactId → contentHash`. Enough to re-render and compare, and enough to prove a PDF or printout corresponds to a revision without re-rendering. Storing only the template revision id is **not** sufficient: a retired template's bytes could be lost or migrated; the copied hash survives.

### 11.2 Template states and approval

`draft → approved → active → superseded | retired`. `customer` and `external_form` sources need a second person to approve (the `commercialApprovals` two-person convention); `organization` and `leaseos_standard` are single-person. One `active` revision per `(orgRef, templateKey)`; activating supersedes the previous in the same transaction. Records never follow the new revision.

### 11.3 Importing an existing company form: the minimum first phase

* **Phase 1 (CP3, safe):** administration uploads the PDF; it becomes a `draft` revision with `source='organization'` and the layout hash; an administrator maps fields **by hand** against the definition's semantic paths (draw or pick a placement); if the PDF has AcroForm fields, their names are offered as candidates (a read, not a guess); approve; activate. No automatic field detection.
* **Later (CP9):** OCR-assisted mapping proposals over the blank form (still confirmed by a person); bulk legacy-paper digitization.
* **Never mandatory:** arbitrary-PDF automatic mapping. A company whose form cannot be mapped keeps it on paper and scans the result; the scanner path (§12) gives them numbering, links, search and audit without a template.

### 11.4 Semantic field model

The catalogue is **code, not a table**, with one source: the slots of `FORMS` plus what `contextPack.ts` assembles. **No dotted semantic paths exist today** (survey §1.12); form keys are flat. This design proposes a `semanticFields.ts` registry keyed by dotted path, each entry naming the authoritative resolver and the provenance it yields:

```
organization.legalName / .operatingName / .address / .logoArtifactRef      ← financialEntities, organizations, commercialSetupProfiles
driver.fullName / .operatorId / .licenceClass (projection only, complianceDocuments)   ← operators + D-05 projection
unit.number / .plate / .vin ; trailer.number                                 ← units (trailers are units rows)
customer.name / .accountRef ; consultant.name ; contact.phone (no contact table yet: roadmap)   ← customerAccounts, signatoryAuthorities
job.code ; job.customerPo → external reference ; job.afe → external reference       ← jobs, billingBooks, customerPurchaseOrders
dispatch.postingRef ; lease.name / .surfaceLsd / .uwi                        ← dispatchPostings, locationIdentities (dls.ts vocabulary)
load.quantity / .quantityUnit / .material / .measurementMethod               ← loads
facility.name / .id ; document.controlledNumber / .revision / .qrRef / .issuedAt   ← facilities, Document Control
```

Exact paths are fixed at CP3 after a survey of `contextPack.ts` and `FORMS` names. The rule that matters now: a template maps *its* printed label to a semantic path; the path resolves through the domain's authority; the value lands in the revision snapshot with its `proposalFields.source`. A template can never introduce a fact; it can only place one. The `contextPack` gap (no company, customer, job, lease or driver in the pack) is closed by the same registry, so the AI Secretary and the renderer read one catalogue.

## 12. Scan and OCR provenance — without a template

### 12.1 Workflow

```
1. capture      LocalCapture (kind disposal_ticket | fuel_receipt | photo | …) → evidenceRecords on sync:
                original bytes, contentHash (computed server-side at upload — new; today only at seal), clientCaptureRef,
                capturedAt (device clock, kept), GPS, captureAuthorizationClaim (never upgraded)
2. record       documentRecords { origin: external_scanned, issuerKind: unknown, state: captured,
                reviewState: pending_classification, definitionId: unclassified_external@v1 }
                — same transaction as the evidence receipt: the document exists before anything looks at it     I-14
3. extraction   worker job through the outbox (never in the request): documentExtractions (engine, version, type,
                classification confidence/source) + assistantProposals/proposalFields per field
4. proposals    definition (class), issuer (facility match against facilities/organizationRecordLinks/merchantMemory),
                external refs, links (load/job/facility by GPS, time, dispatch) — each a proposalField with confidence
5. review       driver (field) or office (Review Queue) confirms/corrects; assistantQuestions carries what could not be auto-filed
6. commit       executeAssistantCommit with a new adapter target `document_record`: writes definition version, issuer*,
                confirmed references, confirmed links, the imported revision; the domain adapter (disposal_ticket) writes
                its own row with facilityTicketNumber projected — one transaction, one receipt
7. original     evidenceRecords sealed; derivatives are documentArtifacts with derivedFrom / evidenceRecordId          I-12
```

If step 3 fails, times out, or reports `documentType='unknown'`, steps 5–7 still run: the class list is offered with nothing pre-selected and the record stays `unclassified` until a person decides. Nothing is dropped or auto-rejected. `extractToProposal`'s current refusal for unmapped types ("file it as evidence, do not extract") becomes exactly this path rather than a dead end.

### 12.2 Proposal storage

No new proposal store. `documentExtractions` + `proposalFields` already carry engine, version, confidence, status, `correctedFrom`, `sourceUtterance`. Two extensions in CP4: `proposalFields.sourceRegionJson` (`{ page, x, y, w, h }`, NULL for voice) and per-field `confirmedByUserId`/`confirmedAt` (today the actor is only on the commit receipt, and `replaceProposalFields` deletes and re-inserts rows, losing history — `documentEvents` records each confirmation as well, so the field row is a convenience, not the only trail).

### 12.3 Which OCR

None is wired (§1.8). `documentExtractions.ocrEngine` is a string; `ocrEngine='none'` with `classificationSource='human'` is a valid extraction and the review path is identical. On-device OCR is native work (§20). Choosing a provider is not this design's decision; the contract is engine-neutral by design and stays so.

### 12.4 The HOS boundary

An HOS log is not a document a person fills from a template. `dutyRecords`, the HOS rule profiles/ledger and `hosAttestations` are the authority with their own identifiers and amendment-by-new-row history; `hos.ts` refuses to compute unverified limits. Document Control offers HOS exactly two things: (a) the scanned paper log, which `hosRouter.recordScannedLog` already stores as `complianceDocuments(hos_daily_log)` — Document Control catalogues that row as an `evidence_capture` record (`hos_paper_log`, `external_sequence_only`, issuer = the driver's carrier) so it appears in the job register and audit timeline, and HOS reads it as a proposal into its own record, never as the log; (b) when an export/render of RODS exists one day (it does not today), a `regulated_record` definition `hos_export` with `numberingPolicy='domain_managed_sequence'`, `origin='system_rendered'`, whose revision snapshot is the exported artifact's hash and the HOS-side identifiers. No generic sequence, template, edit or "remaining hours" projection touches HOS.

## 13. Printing and reprint audit (Checkpoint 5)

```
documentPrintEvents
  id, printRef (client-supplied, unique), orgRef
  documentRecordId, revisionId, artifactId                     exact revision, exact bytes
  displayNumber, snapshotHash, artifactHash, templateRevisionId   copied at print time
  copyKind          enum: original | copy | reprint
  reprintReason     varchar(60) NULL   (required when printPolicy.reprintReasonRequired)
  revisionWasCurrent boolean            was revisionId the record's currentRevisionId at print time
  printedByUserId, fieldDeviceId NULL, printerRef varchar(120) NULL
  printerKind       enum: platform | bluetooth | pdf_download | unknown
  requestedAt
  outcome           enum: requested | sent_to_printer | completed_reported | failed | unknown
  outcomeAt, failureReason varchar(300)
  createdAt
```

* `original` is allowed once per revision when `printPolicyJson.markOriginal`; a second print of the same revision is `copy`; a print of a superseded revision is `reprint` and carries "SUPERSEDED — see revision N" when the policy marks copies. The marking is an overlay recorded on the event, so one artifact hash serves original and copies; the artifact bytes are unchanged.
* `outcome` is honest: browser PDF download is `completed_reported` only if the platform reports it; Bluetooth and platform print are `sent_to_printer` unless the driver returns completion, `unknown` otherwise. Nothing claims paper exists because a command was sent.
* A stale print is any event whose `revisionWasCurrent` is false or whose revision is now superseded; the timeline shows both (§19).
* `commercialDocumentDeliveries(channel='print')` is not replaced; a delivery may reference a print event when the print *is* the delivery.
* `evidenceAccessEvents.action='printed'` and `restrictedAccessEvents.action='PRINT'` (enum values nothing writes today) are written by the same procedure when the printed artifact is an evidence record or a restricted record, so the existing access logs stop lying by omission.

## 14. Signatures and frozen revisions

* The freeze writes `snapshotJson` in the shared canonical form and `snapshotHash` (one hasher: the C1a canonical sha256; not a fifth `canonicalJson`).
* A signature binds to a **revision hash**: `fieldTicketSignatures.payloadHash` already does this and the server refuses a mismatch (`signatureDecision`). The `controlled_issue` lifecycle requires `payloadHash = snapshotHash` at sign time and refuses a signature whose hash does not match the current unfrozen payload (T-22, "signature after payload mutation" fails closed).
* Methods and device attestation are the existing columns (`drawn | device_auth | pin | paper_scan | portal_link`, `deviceRef`, `deviceKeyFingerprint`, `deviceSignatureBase64`, `deviceSignedAt`). D-08 decides whether `fieldTicketSignatures` is generalized (add `documentRevisionId`, keep the name or rename) or a sibling with identical columns is added; this design recommends generalizing. Two known gaps close in the same checkpoint: unique `(fieldTicketId, revision)` and a transaction around `recordSignature` (check-then-insert today, §1.6).
* After the freeze, "what did FT-2026-004812 contain when Dylan signed it at 18:42" is `documentRevisions.snapshotJson` for the revision whose `frozenAt` is 18:42, and nothing else is consulted (I-9). The portal's paper-scan option, currently dropped by the zod input and always recorded as `portal_link` (§1.12), is fixed in the same slice: `paper_scan` requires `paperScanEvidenceRecordId`, as `closeout.signatureRecord` already enforces.

## 15. Tenant and authorization model

* Tenant: every table above carries `orgRef` written from `resolveActingScope`; reads use `orgScopeWhere`; targets of links resolve through the per-domain `*InScope` loaders. Portal access goes through `externalProcedure` + `externalAccessLog`, never through a tenant user's permission.
* All procedures are `roleProcedure`; names follow the map's `domain.action[_qualifier]` and three-part sub-domain style. Proposed entries for `OPERATIONAL_PROCEDURE_PERMISSIONS`:

| Permission | Grants | Suggested roles (GRANTS) |
|---|---|---|
| `document.read` | list/search/view records, revisions, artifacts, links, references in scope | office, dispatcher, safety, management, auditor (read), bookkeeper (financial category) |
| `document.read_own` | a driver's own records (UNIVERSAL_PERMISSIONS, self-scoped) | universal |
| `document.create` | drafts and captures | driver, dispatcher, office, safety |
| `document.confirm` | confirm class, issuer, references, links; resolve reference conflicts | office, dispatcher, safety |
| `document.issue` | complete → confirmed → issued; sign as the tenant's signatory | office, dispatcher, management |
| `document.void` | void, cancel, reject (reason required; sensitive) | office, management |
| `document.correct` | new revision after freeze (sensitive) | office, management |
| `document.print` / `document.reprint` | print events; reprint separately grantable | driver (print own), office, dispatcher |
| `document.definition.manage` | org-scoped definition versions | management, safety (safety categories) |
| `document.template.manage` / `document.template.approve` | draft vs second-person approval | office / management |
| `document.series.manage` | series create/retire; format version (sensitive) | management |
| `document.sequence.allocate` | request a device block (self-scoped to the enrolled device) | driver, dispatcher |
| `document.sequence.reconcile` / `document.sequence.audit` | reconcile; gap, void and print reports | office / auditor, management |
| `document.private.read` | `sensitivity='private'` definitions (sensitive, fail-closed) | hr, legal, and the subject via `read_own` |

* Denials: `DENIALS` gets `auditor → document.create/issue/void/correct` and `driver → document.void/correct/series.manage` so an auditor's read grant can never widen.
* Anti-enumeration: NOT_FOUND via `entityScope.notFound` for any record, ledger row, allocation, template or link outside scope. The `FORBIDDEN` inconsistencies in `deviceRouter` are not copied.
* `sensitivity='private'` uses the existing sensitive fail-closed path (`SENSITIVE_PERMISSIONS`, audit-row-or-refuse), and search omits such hits silently, per the evidence-chain owner decision of 2026-09-19.

## 16. Offline and sync behaviour

* Captures, number claims, signatures and print events ride `syncPackages / syncPackageItems / syncReceipts`, the nonce and the P-256 package signature; the client `outbox.ts`/`syncEngine.ts` gain item kinds, not a second queue. The HS3 command ledger (`commandId`, `requestHash`, `COMMAND_ID_COLLISION`) is the idempotency vocabulary for offline document mutations when it lands; until then the per-column keys in §16.1 hold.
* What a device carries offline: its active allocations (numbers pre-rendered), the active template revisions its definitions need (with hashes: a stale template is detected by hash at sync and the record is flagged `rendered_with_superseded_template`, never silently re-rendered), the definitions' required-field lists. Never: another device's blocks, another tenant's anything, the counter.
* Offline observations remain evidence: `captureAuthorizationClaim` is recorded and never upgraded; a number claimed offline is `used` only when the server accepts the claim; until then the device shows `queued` and the paper shows the number — which is why the number is never recycled (I-5).
* `receivePackage` must become transactional for the claim step (§9); the design does not add a second receive path.

### 16.1 Idempotency keys

| Mutation | Key | Existing convention |
|---|---|---|
| upload scan | `evidenceRecords.clientCaptureRef` (add `orgRef` to the lookup; today unscoped) | v21.6 |
| consume number (device) | `documentSequenceLedger.consumptionRef` | new column, `clientCaptureRef` pattern |
| create record online | `documentRecords.clientRequestRef`, unique per org; replay returns the same `recordRef` | `packageRef` / `commandId` |
| confirm field | `proposalFields` transition idempotent by construction | `assistantCommitService` |
| freeze / sign / issue / void | guarded `WHERE state=<from>`; replay finds `<to>` and returns the row with `replayed: true` | `dispatchTransaction` |
| add external reference | upsert on `(documentRecordId, referenceType, issuerScopeKey, normalizedValue)` | — |
| print attempt | `printRef` client-supplied unique | `deliveryRef` |
| block allocation | one active allocation per `(fieldDeviceId, sequenceType, periodKey)` unless exhausted; repeat returns it | — |
| outbox emission | deterministic `EVT-sha256(document:<eventRef>)` | `enforcementOutbox` |

Double-tap on poor service yields one record, one number, one print event.

## 17. Transaction and locking strategy

**Online issue** (one transaction, fixed lock order: counter → ledger → record → events → outbox):

```
-- outside tx: INSERT IGNORE the period row (the sheetSerialAllocator deadlock note applies)
BEGIN
  UPDATE trackingSequences SET nextNumber = LAST_INSERT_ID(nextNumber)+1
    WHERE orgRef=? AND sequenceType=? AND branch=? AND periodKey=? AND status='active'     -- exclusive row lock; affected must be 1
  SELECT LAST_INSERT_ID()                                                                   -- same connection (tx guarantees it)
  INSERT documentSequenceLedger (…, sequence, displayNumber, allocationId=<pool>, state='used', documentRecordId)
  UPDATE documentRecords SET ledgerId=?, state='number_assigned' WHERE id=? AND orgRef=? AND state='draft'   -- affected must be 1
  INSERT documentEvents (…)
  INSERT domainEventOutbox (…)                                                              -- emitDomainEvent(tx)
COMMIT
```

* **Lock granularity**: one `trackingSequences` row. FT and DSP of one tenant never serialize each other; two tenants never touch each other's rows. `nextTrackingNumber` today opens its own transaction and takes `db`; CP1 adds a `tx`-accepting variant (`nextTrackingNumberIn(tx, …)`) so the number and the record commit together; existing callers are migrated one router at a time and the gap they leave today (mint, then fail) closes as they migrate.
* **Two online callers, one number**: impossible; the row lock orders them and the ledger unique index is the backstop.
* **Deadlock / lock wait**: `ER_LOCK_DEADLOCK` / `ER_LOCK_WAIT_TIMEOUT` retry the whole transaction with the same `clientRequestRef`; the ledger unique index makes a retry unable to double-allocate; the record's `WHERE state='draft'` makes it unable to double-assign.
* **Block allocation**: same transaction with `+blockSize`, one allocation row, N ledger rows. N ≤ series cap (D-04 default 100; hard cap 1000, below the sheet allocator's 5000 because these are business numbers on trucks, not blank sheets).
* **Range overlap**: MariaDB cannot express "no two ranges overlap"; the per-number unique index expresses exactly that at N rows per block.
* **Claim outside block / wrong tenant / wrong device**: the allocation `FOR UPDATE` plus its `orgRef`/`fieldDeviceId` check, then the ledger UPDATE's `WHERE allocationId=? AND state='allocated_device'`; zero affected rows is a refusal, never a fallback.
* **Series retirement** takes the same row lock and moves unconsumed pool rows to `unused_retired` in one statement; device blocks stay `active` until reconciled (their paper may exist).
* **Freeze / sign / void**: `documentRecords` row `FOR UPDATE`, `WHERE state=<from>` guards, revision INSERT, event INSERT — one transaction; a signature's `payloadHash` is compared inside the lock.
* **Unrelated series** never contend: each has its own counter row; there is no tenant-wide lock anywhere in this design.

## 18. Retention model

* Nothing in this design states a retention duration. `documentDefinitions.retentionPolicyKey` references `retentionPolicies.policyKey`; the policy's `statutorySourceStatus` (default `unverified`) and `retentionPolicy.computeEffectiveRetention` (company default, contract, verified statutory, hold → indefinite) remain the only authority. Company defaults stay labelled as company policy (`retentionPolicy.ts:40-41`).
* A controlled record's disposition state is `recordRetentionState`, keyed today by `evidenceRecordId`. Records without an evidence row (generated, never scanned) need the same state; the compliance design's C9 item ("holds on non-evidence records") is the same gap. This design proposes `recordRetentionState` and `legalHoldRecords` gain a nullable `documentRecordId` beside `evidenceRecordId` (one of the two required) in CP9, rather than a second retention table.
* Issued, signed or confirmed records are never physically deleted by application workflows (I-10). `records.retention.disposition` stays an eligibility query. If a destruction executor is ever built, it writes `dispositionedAt/ByUserId`, a `documentEvents(record, 'disposition.executed')` row and an outbox event, and refuses under `legalHold`. That executor is not in this design's scope.
* Legal hold on a record sets `documentRecords.legalHold` as a mirror; the hold itself is a `legalHolds` row. Void and correct are refused while held, as `documentWithdraw` already refuses (`commercialOfficeRouter.ts:604`).

## 19. Search and audit model

### 19.1 Search
`surfaces.search` (`searchEverything`) gains one hit source: `documentRecords` joined to ledger (`displayNumber`), confirmed external references (`normalizedValue`), links and definitions, scoped by `orgScopeWhere` and filtered per hit by `document.read`/`read_own`/`private.read`. Searchable identities: controlled number, archival number, `recordRef` (exact), external reference value (any issuer), driver, unit, trailer, job, load, customer, facility, invoice, definition/category, date range, template revision, state, printed/reprinted/void. The service-level tenant filter the survey found missing in `searchEverything` is added for document hits and flagged for the other sources.

### 19.2 Job document register
One query, one screen: every record linked (directly or through trips, loads, field tickets, disposal tickets) to a job, grouped as the owner asked:

```
JOB 26-00481
  LeaseOS-issued      FT-2026-004812  field ticket      rev 2 (rev 1 superseded)   signed, printed ORIGINAL + 1 reprint
                      JSA-2026-008811 JSA               rev 1                      issued
                      BOL-2026-000991 bill of lading    rev 1                      issued, on invoice INV-2026-000377
  Externally issued   FACILITY XYZ #773621   disposal receipt   scanned, confirmed, linked to load L-…   archival DOC-2026-001102
                      ScaleCo #557284        scale ticket       scanned, confirmed
                      Shell fuel receipt     fuel receipt       scanned, unclassified → confirmed by J. Smith 14:02
```

Origin and issuer are columns, not a footnote (I-11).

### 19.3 Audit views
* **Record timeline**: `documentEvents` for the record, its revisions, ledger row, references, links, artifacts and prints, in server time, with device clock shown beside it where present; each row names the hashes in play. The owner's example chain (block issued 08:04 → number consumed 10:21 → draft 10:22 → completed 10:27 → signed 10:28 → frozen 10:29 → rendered 10:30 → ORIGINAL printed 10:31 → facility ticket scanned 13:06 → OCR proposed 13:07 → external number confirmed 13:08 → linked 13:09 → office reviewed 17:15 → invoiced +2d) is that query with no mutable table consulted.
* **Gap / void report**: every ledger row of a series whose state ≠ `used`, with state, reason, actor, allocation and device. "What happened to DT-2026-001844?" is one row.
* **Print / reprint history**: `documentPrintEvents` per record, with `revisionWasCurrent` and outcome.
* **Reconciliation report**: allocations with `reconciliationState`, discrepancies listed per number.
* **Audit packages**: `auditPackage.assemble` gains a `job` and `document` gather that includes controlled revisions (their `snapshotHash`), rendered artifacts (their `contentHash`) and originals (their seal), so an exported package proves the chain with the hashes already stored.

## 20. Portal, mobile and native boundaries

| Concern | Server/database (can exist now) | Native (Capacitor, not installed) | Browser fallback today |
|---|---|---|---|
| Record, revision, ledger, allocation, links, references, events | yes (CP1–2) | — | — |
| Device block allocation + claim on sync | yes (CP2: procedures + package item kind) | consuming a claim offline needs the encrypted `LocalStore` | `adapters/memory.ts` in tests only |
| Rendering + print events | yes (CP3, CP5: PDF bytes, event rows, `pdf_download` outcome) | platform print / Bluetooth ESC-POS; completion reporting | download link (`CustomerPortal.tsx:83` pattern) with `outcome=unknown` unless reported |
| Scan capture | evidence upload, hash, extraction job, review, commit (CP4) | camera, document edge detection, on-device OCR | file input → `evidence.upload`; `QuickCapture.tsx` hand-off |
| Signature | payload-hash binding, attestation verification (exists) | biometric-gated device key (exists in contract) | `portal_link` / `drawn` (no pad exists yet) |
| QR | `verificationRef` + resolver (CP3) | barcode scanning | camera-less: paste/URL |
| Offline templates | hashes served (CP3) | encrypted vault carry (the comms-package carry pattern, `commsVault.ts`) | none |
| Portals | customer: view/download/verify/sign; facility/vendor: `portalSubmissions` may carry an evidence upload in CP6 | — | — |

No browser implementation is labelled native. The native column is roadmap item 7 ("Native Android runtime") and is CP7/CP8 here; everything in the first column is testable in CI against MariaDB today.

## 21. Failure and threat analysis

FC = fails closed (refused and recorded). FO = recorded, continues. Each names the invariant and test.

| Failure | Behaviour | Why | Ref |
|---|---|---|---|
| Sequence collision (two online issues, one number) | FC — impossible to commit | counter row lock + ledger unique | I-6, T-2 |
| Block overlap (two allocations, overlapping ranges) | FC | ranges are cut from one locked counter; N ledger rows unique | I-6, T-1 |
| Server race on freeze/sign/void | FC for the loser | `WHERE state=<from>`, record `FOR UPDATE` | I-9, T-13 |
| Duplicate sync / replay | FO — same result returned, `replayed: true` | `consumptionRef`, `clientCaptureRef`, `clientRequestRef`, nonce | T-8, T-9 |
| Lost / stolen device | FC for future claims; numbers → `device_lost` | `devices.revoke` cascades; blocks never reissued | I-5, T-11 |
| Restored database backup (server) | detectable: ledger rows missing for allocations devices hold | `migrationLedger` checksum drift refuses migrations; a device claim for a number with no ledger row is refused and reported; the operator re-derives the ledger from device reports as `discrepancy`, never as `used` | I-7 |
| Restored device backup / app reinstall | FC for stale claims | a re-claim of a number already `used` with a different `consumptionRef` is refused; reinstall = new enrolment, old blocks `device_lost` | T-27 |
| Number consumed, document never completed | FO — `cancelled` (pool) or `unused_retired`/reconciled (device); never recycled | I-5, gap report | T-12 |
| Document created without a number (policy requires one) | FC at `completed` | `numberingPolicy` check | T-10 |
| Print command failure / paper jam | FO — `outcome=failed|unknown`; reprint allowed, no new number | §13 | T-24 |
| Duplicate print | FO — second is `copy`/`reprint`, event recorded | §13 | T-24 |
| Scan attached to wrong record | FO then correctable: links have `confirmationStatus`; a confirmed wrong link is `rejected` by a new row (never deleted), original scan untouched | I-12, T-20 |
| OCR reads the wrong ticket number | FO — proposal; confirm corrects with `correctedFrom`; a conflicting confirmed value surfaces as `conflict` | I-13, T-19 |
| Facility reuses a ticket number | FO — `conflict` state, reviewer records `issuer_reused_number` | §7.6 | T-18 |
| Template updated after issue | no effect on history | revision stores template hash + renderer version | I-4, T-15, T-16 |
| Signature after payload mutation | FC | `payloadHash ≠ snapshotHash` refused inside the lock | T-22 |
| Cross-tenant record/link/scan reference | FC as NOT_FOUND | `orgScopeWhere`, `*InScope`, `entityScope.notFound` | I-15/16, T-5, T-21 |
| Device reassigned to another tenant | FC | enrolment binds `orgRef`; block `orgRef` ≠ acting scope → NOT_FOUND; old blocks `device_lost` | I-8, T-29 |
| Stale offline template | FO — flagged `rendered_with_superseded_template`, never re-rendered silently | §16 | — |
| Stale sequence policy (rollover while offline) | FO — old-period block still valid; new blocks from the new period | §9 | T-27 |
| Malicious request for another org's block | FC as NOT_FOUND; `authorizationDecisions` row written | body carries only `sequenceType`; org from scope | T-6, T-29 |
| Client claims a number outside its block | FC; `documentEvents(allocation,'claim.out_of_block')` | §9 step 2 | I-7, T-7 |
| Two local records, one number | FC for the second; capture kept as evidence, no number | §9 step 3 | T-27 |
| Corrupted local state / missing block | FC — claims without a known `allocationRef` refused; capture kept | §9 step 1 | T-28 |
| Series row deleted / tampered | FC — `status` check; ledger rows survive; trigger recommended | §17 | T-28 |
| OCR/model prompt injection via a scanned document | FO — `injection/guard.ts` fences untrusted text; a proposal never confirms itself | I-13 | — |
| Reviewer confirms a class the definition's origin policy forbids | FC | I-11 check at write | — |
| Legal hold + void request | FC | §18 | — |

## 22. Proposed API surfaces (tRPC, all `roleProcedure`; names follow the map's dotted style)

```
document.definition.list / get / draft / activate / retire            (definition.manage)
document.series.list / create / retire / formatVersionBump             (series.manage)
document.sequence.allocate { sequenceType }                            (sequence.allocate; device from enrolment, org from scope)
document.sequence.reconcile { allocationRef, report[] }                (sequence.reconcile)
document.sequence.gapReport { sequenceType, periodKey }                (sequence.audit)
document.record.create { definitionKey, origin, issuer, clientRequestRef, links?, externalRefs? }   (create)
document.record.get / list / search / timeline / register(jobId)       (read / read_own / private.read)
document.record.assignNumber { recordRef }                             (issue)      → online issue, §17
document.record.complete / confirm / issue / void / cancel / reject    (issue / void)
document.revision.freeze { recordRef, reason } / correct { recordRef, kind, reason }   (issue / correct)
document.signature.record { recordRef, revision, payloadHash, method, … }   (issue; portal: externalProcedure)
document.reference.propose / confirm / reject / resolveConflict         (confirm)
document.link.propose / confirm / reject                               (confirm)
document.artifact.get { artifactRef }  → signed URL minted per request  (read; hash re-verified before serving, the portal pattern)
document.render { recordRef, revision, templateRevisionRef? }          (issue)   CP3
document.print.record { printRef, recordRef, revision, artifactRef, copyKind, printerKind } / outcome   (print / reprint)   CP5
document.verify { verificationRef }                                    (read; portal variant)   CP3
document.template.list / upload / map / approve / activate / retire     (template.manage / approve)   CP3
sync.receivePackage: new item kind number_claim                        (sync.push_own)   CP2
assistant.commit: new adapter target document_record                   (existing)   CP4
integration: inboundEvents kind document_import → proposal              (integrationProcedure)   later
```

Every mutation carries an idempotency key from §16.1; every mutation writes `documentEvents` and emits to the outbox in its transaction.

## 23. UI surfaces (design only)

| Screen | Reads | Writes | Checkpoint |
|---|---|---|---|
| **Document Library** (office) | records by definition/state/origin; search §19.1 | none | 1 |
| **Job Document Register** (office, customer portal projection) | §19.2 | none | 1 (server), 6 (portal) |
| **Document Definitions** (admin) | definitions, versions, pack membership | draft/activate/retire org definitions | 1 |
| **Number Series** (admin) | `trackingSequences` by org; next number; allocations | create/retire; format version | 1 |
| **Device Allocations** (dispatcher/office) | blocks per device, consumption, reconciliation state | reconcile; retire | 2 |
| **Void / Gap Report** (auditor, management) | §19.3 | none | 2 |
| **Template Library** (admin) | template revisions by source/status | upload, map, approve, activate | 3 |
| **Imported Company Forms** (admin) | organization/customer templates with mapping status | the manual mapper | 3 |
| **Review Queue** (office) | `reviewState ∈ pending_*`, `assistantQuestions`, reference conflicts | confirm/correct/reject | 4 |
| **External / Scanned Documents** (office) | `origin ∈ external_*`, issuer, references | link, reference edits | 4 |
| **Print / Reprint History** (office, auditor) | `documentPrintEvents` | none | 5 |
| **Audit Timeline** (auditor) | §19.3 | none | 1 |
| **Driver Wallet** (driver, existing initiative) | records linked to the operator, `read_own`, validity from the D-05 projection — never from Document Control | capture | wallet branch |
| **Unit Portfolio** (mechanic, dispatcher) | records linked to the unit; status from `readinessComposer` | capture | fleet |

None are implemented in this checkpoint. Authoritative surfaces live under `client/src/pages/authoritative/`; showcase pages are not extended.

## 24. Test plan

DB-backed (`*.db.test.ts`, MariaDB via the gate, own user-id band per suite per `server/testIdBands.test.ts`), through `appRouter.createCaller`, tenants seeded via `organizations`/`organizationMemberships`/`userRoleAssignments`/`coreRecordOwnership` as the `tenantScope*.db.test.ts` suites do.

| T | Assertion | Invariant |
|---|---|---|
| T-1 | 8 concurrent `sequence.allocate` for one series → 8 disjoint contiguous blocks; ledger row count = Σ sizes; no duplicate `(org,type,branch,period,sequence)` | I-6 |
| T-2 | 25 concurrent online `assignNumber` on 25 drafts → 25 distinct numbers, counter advanced by 25 (extends `trackingNumbers.db.test.ts`) | I-6 |
| T-3 | FT and BOL series allocate concurrently without waiting on each other (timing + distinct counter rows) | §17 |
| T-4 | Two tenants, same `sequenceType`, same period → independent counters, independent ledgers | I-8 |
| T-5 | Tenant B `record.get` on tenant A's `recordRef` → NOT_FOUND with the standard message; `authorizationDecisions` row written | I-15/16 |
| T-6 | Tenant B `sequence.allocate` naming tenant A's series → NOT_FOUND; no allocation row | I-8 |
| T-7 | A claim with `sequence` outside the device's block → refused; event `claim.out_of_block`; ledger untouched | I-7 |
| T-8 | The same signed package received twice → one ledger consumption, one record, `replayed: true` | §16 |
| T-9 | A replayed online `record.create` with the same `clientRequestRef` → same `recordRef`, no second number | §16 |
| T-10 | `void` keeps `ledgerId`, ledger → `void` with reason; counter unchanged; the number never reappears from `assignNumber` | I-5, I-10 |
| T-11 | `devices.revoke` → all `allocated_device` rows of its blocks → `device_lost`; a later allocation starts after `lastSequence` | I-5 |
| T-12 | Gap report for a series lists every non-`used` number with state and reason; sum(used)+sum(other) = counter−1 | §19.3 |
| T-13 | `revision.freeze` then any write to the frozen revision's payload → refused (application) and, with the trigger, SQLSTATE 45000 | I-9 |
| T-14 | `revision.correct` → revision 2 with `supersedesRevisionId`; revision 1 bytes and hash unchanged; timeline shows both | I-9 |
| T-15 | Activating template v2 → an existing record's revision still names v1's id and hash | I-4 |
| T-16 | Re-rendering a v1 revision after v2 is active produces bytes whose hash equals the stored artifact hash | I-4 |
| T-17 | Adding a confirmed `facility_ticket` reference never changes `ledgerId` or `displayNumber` | I-3 |
| T-18 | Same value, two facilities → both confirmed; same value, same facility → second is `conflict`; `issuer_reused_number` resolution confirms with suffixed scope | §7.6 |
| T-19 | An extraction's fields are `proposed` until `confirm`; `record.confirm` with unconfirmed required fields → refused | I-13 |
| T-20 | After thumbnail/OCR-text artifacts exist, the original evidence record's `contentHash` and seal are unchanged; derivatives name `evidenceRecordId` | I-12 |
| T-21 | Linking tenant A's scan to tenant B's load → NOT_FOUND; no link row | I-16 |
| T-22 | `signature.record` with `payloadHash ≠ snapshotHash` → refused; with a matching hash → revision frozen with `freezeReason='signed'`, `frozenAt` = signature time | §14 |
| T-23 | `print.record` stores `revisionId`, `snapshotHash`, `artifactHash`, `templateRevisionId` equal to the revision's at print time | §13 |
| T-24 | Two prints of one revision → `original` then `copy`; `ledgerId` and `displayNumber` unchanged | §13 |
| T-25 | `revision.correct` after a print → the print event is unchanged and `revisionWasCurrent` reads false in the timeline; the new revision has no print event | §10.4 |
| T-26 | Stale-print query returns exactly the events whose revision is superseded | §19.3 |
| T-27 | Offline scenario: allocate block → device claims 3 (one twice with a new `consumptionRef`) → package received out of order → 3 `used`, 1 refused conflict, reconciliation `reconciled` with 97 `unused` → device retire → 97 `unused_retired` | §9 |
| T-28 | A claim naming an unknown `allocationRef`, or a block whose series row is `retired`, → refused; capture stored as evidence without a number | §9 |
| T-29 | An allocation's `orgRef` cannot be changed by any procedure; a device re-enrolled under another org cannot claim its old block | I-8 |
| T-30 | Build the owner's 14-step chain through procedures; `record.timeline` returns the events in server order with hashes; no field of it is read from a mutable table | I-17 |

Integration: **job → load → ticket → disposal → external facility ticket → billing → invoice** (§30 as a test: every hop leaves a link, every artifact a hash, the invoice's `billingSnapshots.payloadHash` names the ticket revision it was drafted from). **Offline device → controlled ticket → sync → reconciliation** (T-27 through `sync.receivePackage` with a real P-256 key, the `deviceSignature.attestation.test.ts` fixtures).

Pure-unit: state machines (§8.4, §10) as tables of allowed transitions; `normalizedValue`; `issuerScopeKey`; `displayNumber` for each `formatVersion`; the semantic field registry resolves every path named by every built-in definition (a `registerClaims.test.ts`-style existence test).

Gate: `scripts/ci-gate.sh` gates 0–8; `procedureAuthorization.test.ts` counts; `engineReachability.test.ts` — the new modules are **reached** from the mounted router in CP1, or, if D-00 holds, declared with a reason.

## 25. Migration impact

* **Reserved now: none** (§0.2). Each checkpoint takes the next free slot at its PR and records the scan.
* **CP1**: one additive migration: 9 new tables; `trackingSequences` + 4 columns and the unique index re-keyed with `orgRef` (backfill NULL); `evidenceRelationships.entityType` enum extended (an `ALTER … MODIFY` on an enum column; MariaDB rewrites the table — acceptable at current sizes; note in the PR); built-in definition seed rows (`orgRef NULL`, `builtIn=true`); `OPERATIONAL_PROCEDURE_PERMISSIONS` entries; `GRANTS`/`DENIALS`. Immutability triggers on `documentRevisions`, `documentEvents`, `documentSequenceLedger` (state-only) — same file, `DELIMITER` handled by `apply-migrations.sh`.
* **CP2**: no table; `syncPackageItems` gains the `number_claim` item kind (enum extension) and `receivePackage` becomes transactional for that step.
* **CP3**: `documentTemplateRevisions`; `documentRecords.verificationRef` populated for existing rows; `ticketPdf.ts` gains `RENDERER_VERSION` and takes the clock out of the rendered lines (`generatedAt` moves to the artifact row).
* **CP4**: `proposalFields.sourceRegionJson`, `confirmedByUserId`, `confirmedAt`; `evidence.upload` computes SHA-256 server-side at upload; `assistantCommitAdapters` target `document_record`.
* **CP5**: `documentPrintEvents`.
* **CP6**: `fieldTicketSignatures` generalization (D-08), unique `(fieldTicketId, revision)`, `recordSignature` transaction; `fieldTicketDocuments` rows registered as artifacts; portal paper-scan input fixed.
* **CP9**: `recordRetentionState`/`legalHoldRecords` nullable `documentRecordId`.
* Parity: `verify-parity.sh` table count updates with each; `LEASEOS_CURRENT_STATE.md` is regenerated by the gate, never edited.
* Nothing is dropped. `disposalTickets.facilityTicketNumber` and peers stay; `trackingReferences`, `formDefinitions`, `complianceArtifacts`, `signatureAudits` are not touched.

## 26. Phased implementation plan

Ordered by dependency as the tree shows it; each checkpoint is one PR with the full gate. "Engine?" is the moratorium classification for D-00.

| CP | Scope | Depends on | Engine? |
|---|---|---|---|
| **1. Core records + numbering** | definitions (+ built-in seeds), records, revisions, links, external references (+ read adapter over `facilityTicketNumber`), thin artifacts, `trackingSequences` extension + `tx` variant, allocations (pool only), ledger, events + outbox emitter, permissions, Library/Register/Definitions/Series/Timeline server surfaces | D-00 | **yes** |
| **2. Offline allocation + reconciliation** | device blocks, `number_claim` item kind, transactional receive step, reconcile, gap report, T-27 | CP1; benefits from HS3's command ledger but does not wait for it | yes (extends sync) |
| **3. Templates + rendering + QR** | `documentTemplateRevisions`, manual form mapper, `RENDERER_VERSION`, clock out of bytes, semantic field registry, `verificationRef` + `document.verify`, QR image at render (library to be chosen; none in tree) | CP1 | yes |
| **4. Scan/OCR evidence + confirmation** | upload-time hash, extraction worker job via outbox, `document_record` commit adapter, review queue, `unclassified_external`, `sourceRegionJson`; engine remains pluggable, `none` valid | CP1, worker boundary (the moratorium's pinned violation stays pinned) | yes |
| **5. Print / reprint audit** | `documentPrintEvents`, `pdf_download` outcome, existing access-log enum values finally written | CP3 | yes |
| **6. Disposal + field-ticket vertical slice** | field-ticket adapter (`closeoutRouter` path, not the unwired engine), `fieldTicketDocuments` → artifacts, signature generalization (D-08) + fixes, disposal adapter with `facilityTicketNumber` projection, `surfaces.search` hits, job register in the portal, facility-portal evidence upload, audit-package gather | CP1–5; SPINE item 2's `fieldTicket` duplication should be resolved first or in the same PR | yes, and it *is* SPINE work |
| **7. Native scanner + encrypted storage** | Capacitor install, camera/edge detection, encrypted `LocalStore`, offline number consumption, template carry | roadmap item 7; CP2, CP3 | native |
| **8. Native printing** | platform print, Bluetooth ESC-POS receipt layout, completion reporting | CP5, CP7 | native |
| **9. Template administration + bulk digitization + retention wiring** | OCR-assisted mapping proposals, legacy paper batches (the academy sheet print→scan-back pattern generalized), `documentRecordId` on retention/hold state, BOL/JSA/manifest definitions with verified pack sources | CP3, CP4 | yes |

Changes from the prompt's preferred order: none in sequence; two in content. CP6 is explicitly tied to the SPINE `fieldTicket` duplication (the design must not build a *third* field-ticket path), and CP4 is not blocked on choosing an OCR engine, because the confirmation path is the deliverable and `ocrEngine='none'` is valid.

## 27. Owner decisions

D-00 to D-03 were decided on 2026-09-24 (`D00_MORATORIUM_DECISION_BRIEF.md`). D-04 to D-09 remain open and are decided when their checkpoints start.

| ID | Decision | Option A | Option B | Recommendation and consequence |
|---|---|---|---|---|
| **D-00** | Moratorium: may Document Control CP1 start? | Hold: nothing until the spine is wired; this document waits | Carve out: CP1 permitted as the record layer the spine's own `fieldTicket`/`disposal` path needs; CP6 counted as SPINE item 2 work | **Decided 2026-09-24: B (carve out), bounded per the brief.** Reasoning kept: **B**, on the same reasoning the compliance D-01 used: the disposal and field-ticket path *is* the spine, and it has no record layer today. Consequence of A: the disposal receipt keeps living in one varchar column and the AI Secretary's `openTicketNumbers` keep pointing at a number with no ledger |
| **D-01** | Reset policy default for document series | `yearly` (`FT-2026-000123`, today's live format) | `never` (lifetime) | **Decided 2026-09-24: A (yearly).** **A**: it is what the tree does, what the owner's example shows, and `periodKey` keeps years apart in the ledger. Per-series override stays available |
| **D-02** | Do externally issued records get a human-readable archival number? | Yes: `DOC-YYYY-NNNNNN` from the existing `DOC` series (`commercialDocuments` already mints it) | No: `recordRef` + the issuer's number only | **Decided 2026-09-24: A, optional per class.** **A, optional per definition** (`archival_sequence_only`): the office needs one thing to say on the phone; it is visibly not a ticket number. Consequence of B: search and filing rely on the facility's number, which is not unique across facilities |
| **D-03** | Numbering scope | Company-wide (`branch=''`) | Branch-specific series allowed (`trackingSequences.branch`, format token `{branch}`) | **Decided 2026-09-24: A (company-wide).** **A at launch**; the column already exists, so B is a policy switch later, not a migration. Consequence of B now: two branches' paper can look alike and the register needs a branch filter everywhere |
| **D-04** | Default offline block size | 100, hard cap 1000 | 25 | **A**: a truck without service for a week issues tens of tickets, not thousands; the ledger cost is 100 rows. Consequence of B: more allocations per device and more "block exhausted" moments offline |
| **D-05** | Does a completed signature auto-issue? | Yes for definitions with a counterparty signer (`freezeOn='signed'` ⇒ `issued` in the same transition) | Issue stays a separate office action | **A for field/disposal/BOL** (the paper is in the customer's hand the moment it is signed), **B for incident reports and JSAs** (office review is the issuance). Encoded per definition in `signaturePolicyJson` |
| **D-06** | Which classes carry ORIGINAL / COPY / REPRINT markings? | All `controlled_issue` classes | Only classes a counterparty signs (field ticket, BOL, disposal ticket, manifest) | **B**: an internal JSA copy marked "COPY" answers a question nobody asks; a customer-signed ticket must. `printPolicyJson` per definition |
| **D-07** | Jurisdictions seeded at launch | `CORE` + `CA` + `CA-AB`, other provinces hosted unverified | `CORE` + `CA-AB` only | **A**, matching compliance D-07/D-08; every jurisdiction-dependent definition ships with `packKey` unverified until a person verifies its source. No US pack is seeded |
| **D-08** | Generic signature storage | Generalize `fieldTicketSignatures` (add `documentRevisionId`, nullable `fieldTicketId`) | Sibling `documentSignatures` with identical columns | **A**: two tables with one shape is the duplication the tree keeps paying for. Consequence: one migration touches a live table; the field-ticket slice is the right place |
| **D-09** | Facility-portal document upload | Extend `portalSubmissions` with an evidence upload so a facility can attach its own ticket image | Keep structured-only submissions; paper arrives via the driver's scan | **A in CP6**: it gives the reconciliation a second independent original. Consequence of B: every facility ticket enters through a driver's camera |

Decisions the repository already answers, and therefore **not** asked: primary-key style (int + `*Ref`), tenant key (`orgRef`), anti-enumeration (NOT_FOUND), permission style, hashing algorithm (SHA-256, canonical), where retention durations come from (`retentionPolicies`, unverified by default), whether trailers are units (they are), whether facilities are tenant-owned (shared registry), whether invoices get a Document Control number (`domain_managed_sequence`; `INV` stays in `invoicingRouter`).

## 28. Document catalog and jurisdiction packs

### 28.1 Catalog as seed rows, not tables
The owner's initial product catalog (safety/daily operations, incident/evidence, driver/personnel, vehicle/fleet, freight/field, oilfield, commercial/billing, company/regulatory/reference) becomes **built-in `documentDefinitions` seed rows**, one per class, grouped by `category`. Nothing in it creates a table. A company adds its own definition (`orgRef` set) or overrides a built-in without a migration. Representative seeds and their policies are the decision matrix in §31; the full seed list is a CP1 deliverable and lives beside the migration, not in this document.

Boundaries the catalog respects:
* **Driver / personnel**: a licence, training certificate, First Aid, H2S, TDG, WHMIS record is `credential_evidence`, `external_sequence_only`, `domainOwner='complianceDocument'` (or `academyQualification` for Academy-issued certificates, which the Academy already numbers and signs). Validity is the D-05 projection. Medical records are `sensitivity='private'` and only exist as definitions when the medical vault (`docs/knowledge/source/LEASEOS_DRIVER_MEDICAL_QUALIFICATION_VAULT.md`) is built.
* **Vehicle / fleet**: registration, insurance, CVIP/inspection, permit are `credential_evidence` on the unit (`complianceDocuments(ownerType='unit')`); work orders are `operational`, `leaseos_sequence_optional` (the shop numbers them today, client-typed); operational status stays `readinessComposer`.
* **Freight / field / oilfield**: field ticket, load ticket, BOL, POD, trip ticket, LeaseOS disposal ticket, LeaseOS manifest are `controlled_issue`; external disposal receipts, scale tickets, facility tickets are `evidence_capture`; a TDG shipping document is `regulated_record` whose *content* rules come from the compliance C5 model, not from a template; NORM and waste-tracking documents are hosted as definitions with `packKey` unverified.
* **Commercial / billing**: invoice, credit, PO are `domain_managed_sequence`; supplier invoices, receipts are `evidence_capture` (`archival_sequence_only`); rate confirmations and service agreements are `reference_version`.
* **Reference**: SDS, policy, procedure, contract, insurance certificate are `reference_version`, `no_human_sequence`, publisher as issuer, links to `loadProfiles`/units/organizations. The SDS library keyed by UN number is a roadmap item; these definitions are its document half.

### 28.2 Jurisdiction packs
No FMCSA, OSHA or EPA vocabulary enters core Document Control code. A pack is a `compliancePacks` row (`packKey`, existing) that lists definition keys, required-field additions, retention policy keys and label overrides for a jurisdiction; `companyPackActivations` turns it on for a tenant; `documentDefinitions.jurisdictionsJson`/`packKey` say where a definition applies. `CORE` holds the jurisdiction-free classes (field ticket, BOL, JSA, fuel receipt). `CA` and `CA-AB` hold the Canadian and Alberta classes with **unverified** sources until a person verifies them (`complianceRequirements.verificationStatus` is the model); a `US` pack is a folder that can exist later with the same shape. Terminology (e.g. "manifest" vs "waste tracking document") is a pack label override, not a code branch. **No regulatory requirement, required field, retention period or numbering rule is invented here.**

### 28.3 Reference documents (SDS) special boundary
An SDS record carries: publisher (`issuerKind='manufacturer'`, `issuerNameCaptured`), version/revision date (external reference, `referenceType='other'`, `role='revision_date'`), product/material links (`documentLinks(loadProfiles)`), `current | superseded | withdrawn`, attachments as artifacts. It never takes a business or archival sequence by default (`no_human_sequence`); a tenant may switch its own SDS definition to `archival_sequence_only` if its filing system wants a `DOC` number, which is a policy, not a fabrication.

## 29. AI Secretary boundary

* **"This job requires these forms"** = a pure function over `documentDefinitions` (active, in the tenant's activated packs, `jurisdictionsJson` matching the job's jurisdiction as the compliance applicability grammar resolves it) × the job's attributes (dispatch, customer requirements from `customerContractTerms`, facility `requiredDocuments`) → a required-document set with `missingInputs[]` when it cannot decide. It reads; it manufactures nothing. Where a pack is unverified the answer is UNKNOWN for that item, not "required" and not "not required".
* **Prepare them**: `assistant.draft` with the definition's `formKey`, fed by the semantic field registry (§11.4) instead of the narrower `contextPack` — company identity, logo artifact, base address, driver, unit, trailer, customer, consultant, job, lease/LSD, load, facility, PO/AFE, dispatch. Every value lands as a `proposalFields` row with `source ∈ {system_inferred, imported}` and `status='proposed'`.
* **What it must never do**: confirm, sign, issue, print, void, allocate a number, send. Those are `FORBIDDEN_CATEGORIES` today (commit, delete, payment, outbound_email, outbound_web) and this design adds `number_allocation`, `signature`, `issue`, `print` to the list. It must never supply a weight, a reading, a facility acceptance, a customer acceptance or a signature: those fields are `ALWAYS_HUMAN` in `documentExtraction.ts` and stay so; a definition's `signaturePolicyJson` cannot be satisfied by any proposal.
* **Before issue**: the `controlled_issue` lifecycle requires `document.confirm` and, where policy says, `document.issue` by a person, or by an authoritative system (a scale integration through `integrationProcedure`) — never by the AI actor (`actorSource='ai'` is refused on those transitions).
* **Sending to destinations**: the Secretary may *propose* a delivery (`commercialDocumentDeliveries` row in `queued`) to a customer portal or webhook subscriber; a person sends. Email and SMS transports do not exist in the tree; this design does not pretend they do.
* **Moratorium**: all of this is declared-unwired until D-00 and the AI worker boundary ruling; the definitions and registry are usable by people without the Secretary.

## 30. Disposal vertical slice (the acceptance example)

```
job 26-00481 (jobs.jobCode)  →  dispatchPosting  →  driver D / unit 114 / trailer T-22 (jobUnits)  →  trip  →  load L-…
  ├─ LeaseOS field ticket FT-2026-004812        origin leaseos_generated · issuer tenant · lifecycle controlled_issue
  │     number: FT series, online (dispatcher) or device block (driver offline) · revision 1 frozen at customer signature ·
  │     rendered PDF (artifact, RENDERER_VERSION) · ORIGINAL printed at site (print event) · links: job, trip, load, unit, operator
  ├─ arrival at XYZ Disposal (facilities, shared registry) · loadFacilityAssessments → destinationAcceptance (unchanged)
  ├─ facility hands over paper ticket #773621
  │     driver photographs it → evidenceRecords (hash, clientCaptureRef) + documentRecords { origin external_scanned,
  │     issuerKind unknown, state captured, definition unclassified_external } in one transaction
  │     worker extraction (or none) → proposals: class external_disposal_receipt, issuer facility:XYZ, ref facility_ticket 773621,
  │     link load L-…, weights → ALWAYS_HUMAN
  │     driver confirms class/issuer/number/link; office confirms weights → commit: document_record adapter + disposal_ticket adapter
  │     → disposalTickets row (DSP-… number from the DSP series, facilityTicketNumber='773621' projected, needs_review) ·
  │       documentExternalReferences confirmed (scope facility:XYZ) · archival DOC-2026-001102 if D-02 · revision (imported) ·
  │       links: load, job, facility, disposalTicket
  ├─ partial acceptance: manifestCustodyEvents / disposalTickets.verificationStatus / facilityStatementLines matching — unchanged;
  │     the receipt's revision and original are untouched by any later amendment (I-9, I-12)
  ├─ field ticket line (lineKind disposal, sourceTrackingNumber DSP-…) disposition accepted → billingBookEntries(disposalTicketId)
  ├─ invoice INV-2026-000377 drafted from the signed ticket (existing path) · billingSnapshots.payloadHash · rendered (artifact) ·
  │     domain_managed_sequence record with links: job, fieldTicket revision 1, disposalTicket, customer
  └─ audit package (job) gathers: FT revision hash, FT artifact hash, receipt original seal, receipt revision hash, DSP row,
        invoice snapshot hash, every documentEvents row in order
```

The company used **no LeaseOS disposal template**: the facility's paper was the document. That is the acceptance requirement, met.

## 31. Design decision matrix (representative classes)

| Class | Generated by LeaseOS? | LeaseOS template? | Custom template? | Scan/import? | LeaseOS sequence | External reference | Signature policy | Revision policy | Primary domain owner | Document Control role |
|---|---|---|---|---|---|---|---|---|---|---|
| Field ticket | yes | yes (`ticketLines` today) | org / customer | paper_scan of signed copy | `required` (FT) | PO, AFE, customer job no. | customer rep + driver; freeze on signed | immutable after freeze; correction = revision | `fieldTickets`/`closeoutRouter` | number, revisions, artifacts, prints, links, references |
| LeaseOS disposal ticket | yes | yes (later) | org | — | `required` (DSP) | facility ticket, scale ticket | driver; facility where portal-signed | immutable after freeze | `disposalTickets` | as above |
| External disposal receipt | **no** | none | none | **scan / import** | `archival_only` (D-02) | facility ticket (required), scale ticket | none (facility's paper) | evidence: confirm → reviewed; supersede by new record | `disposalTickets` (facts) / Document Control (artifact) | catalog, issuer, references, links, original |
| Bill of lading | yes | yes (CP9) | org / customer | scan of carrier copy | `required` (BOL) | shipper ref, customer PO | shipper, driver, consignee; freeze on signed | immutable after freeze | load/trip (facts) | number, revisions, prints, links |
| Proof of delivery | yes | yes | customer | scan | `optional` | customer job no. | consignee; freeze on signed | immutable after freeze | trip/load | as BOL |
| JSA / tailgate | yes | yes | org | scan of paper copy | `required` (JSA/SAF) | none | crew + supervisor; freeze on issued | amend by revision | safety (`tailgateMeetings`) | number, revisions, links |
| Incident report | yes | yes | org | scan (witness statements) | `required` (incident number today client-typed → series) | regulator file no. | reporter + reviewer; freeze on issued | amend by revision | `incidentReports` / restricted vault | number, revisions, restricted artifacts |
| Driver licence | **no** | none | none | scan | **none** (`external_only`) | licence number (government) | none | reference_version (new scan = new version) | `complianceDocuments` (D-05) | provenance, version, evidence; **never validity** |
| Training certificate (external) | no | none | none | scan | none | certificate number (issuer) | none | reference_version | `complianceDocuments` / `academyQualifications` | provenance |
| Insurance certificate | no | none | none | import/scan | none | policy number (insurer) | none | reference_version | `insuranceCertificates` | provenance |
| Vehicle inspection (CVIP) | no (external) / yes (pre-trip) | pre-trip yes | org | scan | pre-trip `optional`; CVIP none | inspection number (inspector) | inspector; driver | pre-trip immutable; CVIP reference | `inspections`, `complianceDocuments(unit)` | artifact + provenance; status stays readiness |
| Work order | yes | yes | org | scan of vendor WO | `optional` (shop numbers today) | vendor WO number | mechanic release (exists) | amend by revision | `workOrders`, `workOrderReleases` | number (optional), links, artifacts |
| Fuel receipt | no | none | none | scan | `archival_only` | vendor receipt no., card last 4 | none | evidence | `fuelTransactions` | catalog, references, original |
| SDS | no | none | none | import | **none** | product, revision date (manufacturer) | none | reference_version | reference (SDS library, planned) | publisher, version, product links |
| HOS export | system (future) | none | none | — | `domain_managed` | HOS-side ids | none | system_rendered snapshot | HOS | archive only; never edit |

## 32. Recommended first implementation checkpoint

**Checkpoint 1, exactly, and nothing else**, once D-00 is decided:

1. `documentDefinitions` + built-in seed rows for the 15 classes in §31 (behaviour only; no templates).
2. `documentRecords`, `documentRevisions` (with the field-ticket adapter *reading* `fieldTicketRevisions`, not replacing it).
3. `documentExternalReferences` + the read adapter over `disposalTickets.facilityTicketNumber` and `fieldTickets.afeNumber`.
4. `documentLinks` with the shared `entityType` constant.
5. `trackingSequences` + `orgRef`/`formatVersion`/`status`, the `tx` variant of `nextTrackingNumber`, `documentSequenceAllocations` (pool) and `documentSequenceLedger`; online issue per §17.
6. `documentArtifacts` (thin: rendered and evidence-backed kinds; no renderer change yet).
7. `documentEvents` + outbox emitter with deterministic event ids.
8. Permissions, `GRANTS`/`DENIALS`, procedures in §22 for CP1, NOT_FOUND scoping, `read_own`.
9. Immutability triggers on revisions, ledger and events.
10. Tests T-2 to T-6, T-9, T-10, T-12 to T-14, T-17 to T-19, T-21, T-30, plus the state-machine unit tables.

Explicitly deferred: device blocks (CP2), templates and rendering (CP3), scanning/OCR (CP4), print events (CP5), the disposal/field-ticket slice (CP6), native work (CP7/8), template administration and digitization (CP9). The repository's dependency order confirmed the owner's expectation: the prompt's checkpoint 1 is buildable first; the only re-ordering is that the disposal slice (CP6) waits on print (CP5) only for the ORIGINAL marking, and could ship before CP5 with prints as `pdf_download` if the owner prefers the slice sooner.

## 33. What the template-independent expansion changed in this design

Relative to a template-first reading of the original checkpoint:

1. **Templates became optional** — a controlled record requires a definition and an origin, never a template revision (I-11, §7.3 `templateRevisionId NULL`).
2. **`documentDefinitions` became the first-class registry** of behaviour (§7.2), separate from templates (§11) and from records (§7.3).
3. **Origin and issuer became mandatory columns** on the record (§7.4), with the manifest's "captured name beside canonical id" pattern.
4. **Numbering became a per-definition policy** with six values (§8.1), and the series became an extension of `trackingSequences` rather than a new table.
5. **External references became a table** with issuer scoping and confirmed-only uniqueness (§7.6); the domain columns stay as projections.
6. **Template sources and immutable mapping** (§11.1–11.3): four sources, mapping inside the revision, manual import first.
7. **Scanner-without-template** became a lifecycle (`evidence_capture`, §10.2) with `unclassified` as a legitimate state (I-14).
8. **Jurisdiction packs** reuse `compliancePacks` and the unverified-by-default rule (§28.2); no US terminology in core.
9. **AI Secretary boundary** is explicit (§29): read, propose, never confirm/sign/issue/print/send/allocate.
10. **The disposal slice** is the acceptance example with no LeaseOS disposal template (§30).
11. **The decision matrix** (§31) validates the model across fifteen classes, including the three special boundaries (HOS, SDS, credentials).
12. **The first checkpoint** is defined as the record layer only (§32).
