# LeaseOS Sign & Attest — Design (Checkpoint 0: survey and foundation design)

**Against:** `main` = `6f52b57` (release `v23.25`, migration head `0174`; `0170`/`0171`/`0174` on main, `0172`/`0173` held by an open branch).
**Branch:** `claude/leaseos-sign-attest-design-5993ar`. **No production code in this checkpoint.** Design and plan only.
**Companion:** `docs/sign-attest/SIGN_ATTEST_IMPLEMENTATION_PLAN.md` (phases, migrations, tests, first checkpoint).

Sign & Attest is the provisional internal name for LeaseOS's native electronic signature, initials,
acknowledgement and attestation capability. It is an extension of the document, evidence, audit,
tenant, offline-sync, billing, portfolio, job, disposal and template architecture that already
exists. It is not a separate application. Every section below names the file that proves a claim;
where the repository has nothing, it says "does not exist" rather than implying otherwise.

---

## 0. Binding constraints found in the tree (read first)

Three constraints shape everything else. None was in the request; all three are in the repository.

**0.1 The SPINE moratorium.** `docs/register/SPINE_WIRING_PLAN.md`: *"The moratorium stands: no new
engines until this path is wired."* `server/engineReachability.test.ts` pins 57 declared-unwired
`_core` engines and fails when a new `_core` module is neither reached from production nor declared.
Sign & Attest is a new engine by any reading. Section 20 (conflicts) states the options; the
recommended first checkpoint is written so that it is reached from production on day one (it
replaces the `drawn` label in the on-spine `fieldTicket` close, §1.3), and it is owner decision
**D-01** whether that satisfies the moratorium. This document does not assume it is lifted.

**0.2 Documents already have a design in flight.** Branch `claude/document-control-architecture-jlffzk`
(no PR yet; base `0cd4817`) carries `docs/document-control/document-control-design.md` and four
migrations `0178`–`0181` that build `documentDefinitions`, an origin-aware register (extending the
0144 `commercialDocuments` register), a numbering ledger with offline blocks (`numberBlocks`,
`numberAllocations`) and template families with **immutable released revisions**
(`documentTemplates`, `documentTemplateRevisions`, `documentTemplateArtifacts`). Its §1.3 already
surveys signatures and names the same defects this document names. Sign & Attest must sit on that
model, not beside it: **DocumentTemplate and DocumentInstance are Document Control's, and this
design adds only the signing layer.** Where Document Control has not merged, the first checkpoint
anchors fields to a document *revision hash* and a subject reference, which is valid whether the
revision is a 0144 register row, a field-ticket revision or a sealed evidence record.

**0.3 The migration numbers are contested and the register is human-maintained.**
`docs/architecture/MIGRATION_COLLISION_REGISTER.md` is refreshed in this checkpoint (§16). The first
number no branch holds is **`0182`**.

---

## 1. Current-state survey — what exists, with the file that proves it

### 1.1 Documents, scanning, printing, PDFs

| Need | What exists | Where | Verdict |
|---|---|---|---|
| Uploaded / scanned document bytes | `evidenceRecords` (storageKey, mimeType, capturedAt, `clientCaptureRef` unique for idempotent offline upload, `trackingNumber`, `sealState draft/sealed/amended/superseded`, `currentVersion`, `legalHold`) | `drizzle/schema.ts:48`; write path `evidence.upload` `server/routers.ts:403` (`storagePut`, 15 MB cap, idempotent on `clientCaptureRef`) | **Reuse.** A scanned page is an evidence record. |
| Versions and seals | `evidenceVersions` (contentHash, manifestHash, supersedesVersion, amendmentReason), `evidenceSeals` (canonicalManifest, contentHash, manifestHash, sha256, sealedBy, deviceId, `verificationResult pending/verified/hash_mismatch/manifest_mismatch/content_unavailable`) | `schema.ts:2756`, `:2772`; engine `server/_core/evidenceSeal.ts` (`sha256`, `canonicalManifest`, `sealEvidence`, `amendSealedEvidence`, `verifySealAgainstStored` — three-leg verification) | **Reuse** for every blob Sign & Attest stores (stroke files, rendered marks, finalized PDFs). |
| Relationships and access log | `evidenceRelationships` (`entityType` **mysqlEnum** of 24 values, `entityId`/`entityRef`, `role`), `evidenceAccessEvents` (`viewed/downloaded/exported/shared/printed/seal_verified`) | `schema.ts:2737`, `:3041` | **Reuse**; the enum needs two new values (§3.9). |
| Document register | `commercialDocuments` (documentRef, bookOrgRef, documentType, `version`, `supersedesDocumentId`/`supersededByDocumentId`, `contentHash`, `sourceSnapshotHash`, `storageKey`, `evidenceRecordId`, `fieldTicketDocumentId`, `status current/superseded/withdrawn`), `commercialDocumentLinks`, `commercialDocumentDeliveries` | `schema.ts:8633`; write path `commercialOffice.documentSupersede` `server/commercialOfficeRouter.ts:576` (only `current` may be superseded; reason required) | **Reuse as DocumentInstance / DocumentRevision** for rendered and scanned documents. Document Control's 0179 adds origin, issuer, `controlNumber`, `controlState`. |
| PDF rendering | `renderPdf(title, lines)` — hand-written PDF 1.4, Helvetica, text lines only, deterministic | `server/_core/ticketPdf.ts:18`; callers `closeoutRouter.ts`, `invoicingRouter.ts`, `auditRouter.ts`; outputs `fieldTicketDocuments` (`schema.ts:5066`, contentHash + sourceSnapshotHash) | **Extend, do not replace** (§7.4). No PDF library is in `package.json`; no image or vector drawing exists. |
| Templates | `formDefinitions` (`schema.ts:2172`, `fieldsJson`; **no server reader**), `dispatchTemplates` (no server usage); real capture forms are `FORMS` in `aiProposal.ts:112`. Document Control 0181 (branch) adds `documentTemplates` / `documentTemplateRevisions` (`layoutKind pdf_overlay|…`, `fieldMappingJson`, `fieldMappingHash`, released-immutable trigger) | `schema.ts`, branch `0181` | **Do not add a third template concept.** Signable-field layouts hang off a Document Control template revision (§12). |
| Scanning | `scanAudits` is **QR/NFC scanning** (`scanType qr/nfc`, `schema.ts:543`) — a name collision, not a document scanner. Document scanning = `evidence.upload` + `documentExtractions` (OCR engine record, `schema.ts:3686`) + `documentFingerprints` (`schema.ts:3734`, `documentFingerprint.ts` content + structured-key duplicate detection) | | **Reuse** upload, fingerprint. OCR is model-backed and under the moratorium; not required (§10). Naming: never call anything in Sign & Attest "scanAudit". |
| Multi-page scans | The sync engine uploads only `files[0]` of a capture (`client/src/runtime/syncEngine.ts:139`, noted by Document Control §8) | | **Pre-existing defect**; a multi-page signable scan depends on its fix (Document Control DC3 or earlier). |
| Printing | `commercialDocumentDeliveries.channel = 'print'` exists; nothing writes `evidenceAccessEvents.printed`. A stale, unrelated-history branch (`claude/mobile-hardware-scanner-mzp1e1-v2327`) holds an `0169_print_audit.sql` (`fieldPrinters`, copyKind original/reprint) that cannot merge as-is | | Print of a signed artifact is a delivery of a register row; out of scope here. |

### 1.2 Numbering

| Need | What exists | Where |
|---|---|---|
| Configured, gap-free sequences | `trackingSequences` (prefix, separator, period, width, reset) + `nextTrackingNumber` (row-locked `UPDATE … LAST_INSERT_ID`) | `schema.ts:934`, `server/_core/trackingNumbers.ts:60` |
| Who issued a number, on whose behalf | `trackingReferences` (issuedByUserId, onBehalfOfOperatorId, delegationReason, deviceId, sessionId) | `schema.ts:951` |
| Offline pre-allocation | `sheetSerialSequences` / `sheetSerialAllocations` (reserved → printed → voided) for academy sheets | `schema.ts:8233`, `sheetSerialAllocator.ts` |
| Offline blocks for documents | `numberBlocks` / `numberAllocations` — **branch only** (Document Control 0180) | branch `0180` |
| Everything else | `ref(prefix)` = `PREFIX-<time36>-<random>` in every router (`server/agentRouter.ts:54` and ~20 copies) — unique, not a sequence | |

**Verdict.** Sign & Attest mints nothing new for the document itself: the document keeps the number
its domain gave it (ticket number, register `documentRef`, evidence `trackingNumber`). Sign & Attest
refs (`revisionRef`, `sessionRef`, `markRef`, `eventRef`, `artifactRef`) are identity refs, not
business numbers, and follow the `ref()` shape server-side; **device-minted refs are device-relative**
(`${deviceRef}:${localId}`), the rule the field runtime already uses (`contracts.ts:36`) and that the
tenant-scope branch's `0173_offline_identity_scope.sql` enforces for `clientCaptureRef`/`packageRef`.

### 1.3 Signatures, approvals, acknowledgements — what already stores one

| Table | What is "signed" | How the mark is recorded | Where |
|---|---|---|---|
| `fieldTicketSignatures` | a field-ticket site snapshot (`snapshotHash`), per authority exercised | `signatureMethod drawn/device_auth/pin/paper_scan/portal_link`, `payloadHash`, `signedScopeStatement`, device attestation columns (0157), `capturedOffline`, `externalIdentityId` (0158). **`signatureStorageKey` is written only for `paper_scan`** (`evidence:<id>`). | `schema.ts:1226`; `recordSignature` `server/closeoutRouter.ts:51–97`; portal `portal.fieldTicketSign` `portalRouter.ts:583` |
| `fieldTicketRevisions` | the immutable snapshot the signature refers to (`snapshotJson`, `snapshotHash`, `supersedesRevisionId`, kind `site_signed/post_site_supplement/final/amendment`) | | `schema.ts:4949` |
| `fieldTicketLines.disposition` | per-line acceptance by the customer (`accepted/disputed`, both statements kept) | `decideLine` | `schema.ts:1178`, `closeoutRouter.ts:100+` |
| `signatoryAuthorities` + `signatureDecision` | whether the signer *may* sign what they are signing | | `schema.ts:4927`, `siteCloseout.ts:111` |
| `academyCertificateSignatures` | a training certificate, employer and employee parties | `signatureMethod drawn/electronic_ack/paper_scan`, `signatureEvidenceRecordId`, `payloadHash` computed with **non-cryptographic FNV `stableHash`** (`trainingAcademy.ts:36`), `capturedOffline`, `invalidatedAt` | `schema.ts:7579`; `trainingAcademyRouter.ts:534–563` |
| `commercialApprovalSignatures` | an internal commercial approval (sequence, rolesAtApproval, approved/refused) | no mark; a decision row | `schema.ts:8451` |
| `complianceConsents`, `programAcknowledgements`, `competencySignoffs`, `transferAcknowledgements` | consent, written-program acknowledgement, supervisor sign-off, delivery acknowledgement | `signatureEvidenceRecordId` + `payloadHash`, or a method enum, or a status | `schema.ts:4141`, `:4178`, `:5741`, `:755` |
| `hosAttestations` | a **statement** ("I checked his paper log") for one duty date, superseded not edited | text + attester + date | `schema.ts:8717`, `hosRouter.ts:123` |
| `signatureAudits` | legacy (jobId, signerName, authMethod, documentHash) | read by `db.ts`/`auditRouter.ts` only | `schema.ts:363` |

Three facts follow, and they are the reason this subsystem is worth building as a foundation first:

1. **A `drawn` signature stores no drawing.** `recordSignature` writes `signatureStorageKey` only for
   `paper_scan`; for `drawn` it writes the method, the hash and the name. Nothing captured the stroke
   or an image, and no canvas or pad component exists anywhere under `client/src`
   (`grep -rn "<canvas\|pointerdown\|SignaturePad" client/src` returns nothing). The client runtime
   already lists `"signature"` as a `CaptureKind` (`contracts.ts:29`) and gives it top sync priority
   (`syncEngine.ts:41`), but nothing produces one. This is the exact "method is a label" defect
   migrations `0157` and `0158` fixed one layer down and one layer up.
2. **"Method" conflates input and authentication.** `drawn` (an input) sits in one enum with
   `device_auth` and `portal_link` (authentication). Sign & Attest separates `inputKind`
   (touch / pen / mouse / typed / none) from `authMethod` (§4.2) and keeps the existing enum values as
   the authentication vocabulary so no row is reinterpreted.
3. **Three signature stores, three hash schemes.** Closeout hashes the snapshot with SHA-256;
   academy hashes with FNV; approvals hash nothing. The evidence-chain duplication the SPINE plan
   names (item 2) has a signature-shaped instance. Sign & Attest is the one engine these become
   producers of (§3.11), without migrating their historical rows.

### 1.4 Hashing and fingerprints

| Helper | Semantics | Where |
|---|---|---|
| `sha256(string|Buffer)`, `isWellFormedHash` (64 lowercase hex) | canonical digest | `evidenceSeal.ts:90` |
| `canonicalManifest(SealInput)` | explicit ordered object → `JSON.stringify` | `evidenceSeal.ts:105` |
| `canonical(value)` (private): sorted keys, arrays in order, `JSON.stringify` scalars | what the **device signs** (`canonicalDevicePackage`, `canonicalSignaturePayload`) | `deviceSignature.ts:5–25`, `:102` |
| `canonicalJson` | sorted keys + `Date → ISO` (siteCloseout); sorted keys + drops `undefined` + `Date` (auditPackage); sorted keys only (client `crypto.ts:22`) | `siteCloseout.ts:48`, `auditPackage.ts:46`, `client/src/runtime/crypto.ts:22` |
| `contentHash(bytes)`, `buildFingerprint` (content + structured key) | duplicate detection | `documentFingerprint.ts:74/83` |
| Device signing | P-256 / SHA-256 / IEEE P1363, `fingerprintP256Spki`, `verifyP256PackageSignature`, `checkSignatureAttestation` (enrolled, active, fingerprint match, **≤10 min fresh**, verifies) | `deviceSignature.ts:27–180` |
| Biometric prohibition | `looksLikeBiometricMaterial` and `deviceSignature.test.ts` scan schema and signature paths for template-shaped columns | `deviceSignature.ts:182–204` |

**Verdict.** Four canonical-JSON helpers exist and differ on `undefined` and `Date`. Anything a
**device signs** must canonicalize exactly as the device does; the client uses sorted-key
`JSON.stringify` (`crypto.ts:22`) and the server's `deviceSignature.canonical` matches it for plain
JSON. Sign & Attest therefore signs **plain-JSON payloads only** (strings, numbers, booleans, null;
timestamps as ISO strings) through one exported `canonicalAttestPayload` in `deviceSignature.ts`, and
uses `evidenceSeal.sha256` for every digest. It does not add a fifth canonicalizer. The FNV
`stableHash` is never used for anything in this subsystem.

### 1.5 Tenant / organization scoping

* Tenant key: `orgRef varchar(64)` nullable on owned rows; **NULL = the historical single tenant**
  (0132 rule, restated in every migration since). `fieldDevices.orgRef` and `deviceSyncNonces.orgRef`
  are `varchar(40)`; `organizations.orgRef` is `varchar(40)`. New tables use `varchar(64)` (the 0171/0174
  spelling) and never read the org from input.
* Resolution: `resolveActingScope(db, userId)` (`server/_core/actingScope.ts:65`) — from active
  `organizationMemberships`; two live memberships **throw `AmbiguousOrganization`**; none → single
  tenant with `derivedFrom: "single_tenant_fallback"`.
* Ownership of legacy records: `coreRecordOwnership` for unit/operator/load/financial_entity
  (`coreRecordOwnership.ts:12`). Jobs carry `orgRef` directly (`schema.ts:15`).
* Test pattern: `server/tenantScope*.db.test.ts` — an org is a row in `organizations`, a member is a
  membership plus `userRoleAssignments`, and a cross-org read answers **NOT_FOUND, never FORBIDDEN**
  (`tenantScopeCloseout.db.test.ts:1–6`).
* Devices are org-bound: `sync.receivePackage` refuses a device not bound to the acting org
  (`deviceRouter.ts:189`).

### 1.6 Authentication and authorization

* `ctx.user` from `sdk.authenticateRequest` (`context.ts:17`). Procedure builders in
  `server/_core/trpc.ts`: `publicProcedure`, `protectedProcedure` (login only; the CI gate 5 fails on any
  bare use in a router), `adminProcedure`, **`roleProcedure(procedureName)`** (permission looked up at
  wiring time in `RECORDS_PROCEDURE_PERMISSIONS` / `OPERATIONAL_PROCEDURE_PERMISSIONS`; every decision
  is an audit row; **SENSITIVE permissions fail closed when the audit row cannot be written**),
  **`externalProcedure(name)`** (portal bearer token → exactly one `externalIdentities` row; permissions
  by identity kind; `portal.customer.sign` is SENSITIVE), `integrationProcedure`.
* Permissions are a string-literal union `Permission` in `server/_core/recordsAuthorization.ts:45`
  with `SENSITIVE_PERMISSIONS` (`:1737`) and `UNIVERSAL_PERMISSIONS` (`:1668`, self-scoped in the router,
  e.g. `academy.certificate.sign_own`). Counts are pinned by `server/procedureAuthorization.test.ts`
  and published in `PROCEDURE_AUTHORIZATION_INVENTORY.md`; `scripts/current-state.sh` regenerates
  `LEASEOS_CURRENT_STATE.md` from them and CI gate 8 fails if the committed copy differs.
* Existing signature permissions: `closeout.sign.witness` (SENSITIVE), `closeout.line.decide`,
  `closeout.authority.manage`, `academy.certificate.sign_own` (UNIVERSAL + SENSITIVE), `evidence.seal`,
  `evidence.export`, `portal.customer.sign`.

### 1.7 Device identity

`fieldDevices` (deviceRef, userId, orgRef, platform, `keyFingerprint`, `publicKeySpkiBase64`,
`keystoreAttestation hardware/software/unknown/failed`, status enrolled/active/suspended/revoked),
`deviceKeyEvents` (rotation history), `deviceSyncNonces` (unique (fieldDeviceId, nonce) — replay
refusal), `syncPackages.verificationMode exact_wire|reconstructed|unverified`, `deviceClockAt`,
`clockSkewMs` (`schema.ts:4035–4100`, `:2864`). The device signs the **exact bytes** it sends
(`signedPayloadJson`, `deviceRouter.ts:232–237`). A "device attestation" here means *proof that an
enrolled device key signed a payload* (`DeviceAttestation`, `deviceSignature.ts:114`). **Naming
collision:** "attestation" already means two things in the tree — device-key proof (0157) and an HOS
statement (0155). Sign & Attest uses `attest*` as its table prefix and the word *attestation* for a
person's act; it calls the device proof *device attestation* exactly as `deviceSignature.ts` does.

### 1.8 Audit and event ledgers

Two layers, both reused:

1. **Domain-owned append-only tables** — `dispatchRoleAssignmentEvents` (0171: "every transition
   writes exactly one row, nothing updates or deletes one"), `documentControlEvents` (branch 0179:
   `(documentId, sequence)` unique), `driverPortfolioEvents` (branch 0176: `no_update` / `no_delete`
   triggers), `enforcementEvents`, `academyAuditEvents`, `restrictedAccessEvents` ("written BEFORE
   content is served; if this write fails, access fails"). Trigger guards live in migrations that
   contain **trigger DDL and nothing else** because `scripts/apply-migrations.sh:18–32` wraps a file in
   `DELIMITER $$` when it sees `^BEGIN$` (`0130_manifest_seal_guard.sql`, `0121`, branch `0176`, `0181`).
2. **The domain-event outbox** — `domainEventOutbox` (`schema.ts:2316`) written by
   `emitDomainEvent(tx, …)` **inside the caller's transaction** (`eventEmitter.ts:115`); event types are
   `domain.past_tense` (`safety.incident_sealed`, `records.legal_hold_placed`, `unit.mechanic_released`
   — `domainEmitters.ts`); drained by `drainWorker.ts` with `FOR UPDATE SKIP LOCKED`, idempotent
   consequences, dead-lettering.

Authorization decisions are their own rows (`recordAuthorizationDecision`, `db.ts:1377`). Audit
packages (`auditPackage.ts`) assemble canonical-JSON manifests over rows and stored hashes with
per-kind redaction; `auditRouter.ts:153` already includes `fieldTicketSignatures` rows as items.

### 1.9 Offline persistence, synchronization, outbox, retry

* Client: `client/src/runtime/` — `contracts.ts` (`LocalCapture` with `files[]` in an encrypted vault,
  `captureAuthorizationClaim`, `syncState saved_locally→queued→syncing→synchronized|failed|conflict`,
  `LocalPackage`; adapter interfaces `LocalStore`, `FileVault`, `Keystore`, `Transport`,
  `Connectivity`, `Clock`; `NotOnDeviceError`), `outbox.ts` (durable, nothing deleted),
  `syncEngine.ts` (upload → seal → signed package; revoked device stops), `crypto.ts`
  (`canonicalJson`, AES envelope). Adapters: `memory.ts` (browser/test), `capacitor.ts` (native,
  throws — the native shell is **not implemented**, `LEASEOS_CURRENT_STATE.md:178`).
* Server: `sync.receivePackage` (`deviceRouter.ts:161–360`): admission → nonce → exact-wire signature →
  three-way hash verification against the seal (server recomputes from **stored bytes**) →
  `syncPackageItems`/`syncReceipts` rows → `recordUpdates` conflict detection. Refusals are rows.
  `handleSyncRefusal` (`deviceSignature.ts:235`) turns a **code** into retry / stop-and-prompt /
  stop-and-escalate.
* **Missing primitive:** `recordUpdates` conflict detection reads an in-memory `SERVER_VERSIONS` map
  (`deviceRouter.ts:441–448`): *"per-type version lookups are wired as each type gains a version
  column."* No record type has one. Sign & Attest cannot rely on it and supplies its own revision
  binding (§6).
* `offlineCapability.ts` classifies capabilities `local_safe / local_capture / local_prepare /
  server_authoritative`; `envelopeFor` refuses to package a server-authoritative act as done. It is
  declared unwired ("the seam HS1 covers", `docs/hybrid-seam/HS_CONTRACTS.md`).
* `preDepartureCache.ts` — what must be on the device before it leaves coverage (`CacheItemKind`,
  `required_to_depart`); declared unwired.

### 1.10 Billing, field tickets, disposal tickets, jobs, portfolio

* Field tickets: `fieldTickets` (status `draft/presented/closed/amended_after_signature`,
  `signatureStatus`), lines (`disposition`), events, signatures, revisions, documents — the
  v21.11 site sign-off chain (`LEASEOS_B21_11_SITE_SIGNOFF_CHAIN.md`). `amended_after_signature` blocks
  invoicing (register row P3.4). Invoicing reads `fieldTicketRevisions.snapshotHash` and the signature
  (`invoicingRouter.ts`).
* Disposal tickets: `disposalTickets` (facilityTicketNumber, net kg, `verificationStatus`,
  `evidenceRefs`), `disposalBatches`; reconciliation engine `disposalReconciliation.ts`; the
  Document Control design's §17 is the disposal vertical slice.
* Jobs: `jobs` (`orgRef`, `jobCode`), `jobUnits`, `jobChargeLines`; job → trip → load chain walked by
  `evidenceChainWalk.ts`.
* Driver portfolio / wallet: **branch only** (PR #16, `0175`/`0176`): no credential table — a driver's
  documents are `complianceDocuments` rows; `driverRequirementBindings`; `driverPortfolioEvents`
  append-only. Ownership model: the operator owns the document row; requirements bind to the
  organization's work.

---

## 2. Reuse matrix

| Concern | Canonical LeaseOS component | Sign & Attest does |
|---|---|---|
| Bytes (strokes, rendered marks, page images, finalized PDFs, receipts) | `storagePut` / `storageRead` / `storageGetSignedUrl` + `evidenceRecords` + `evidenceSeals` | stores through the vault; never a second blob table; never a durable URL |
| Document identity and revision | `commercialDocuments` version chain (0144 → DC 0179); `fieldTicketRevisions`; sealed `evidenceRecords` | binds to a **revision hash** plus a typed subject reference; adds no document table |
| Template | Document Control `documentTemplateRevisions` (branch 0181) | adds a signable-field layout keyed by `templateRevisionRef` (Phase 3) |
| Numbering | domain numbers; `trackingReferences` for delegation | mints no business numbers |
| Hashing | `evidenceSeal.sha256`; `deviceSignature.canonical` (to be exported as `canonicalAttestPayload`) | one digest, one canonicalizer |
| Device proof | `fieldDevices`, `deviceKeyEvents`, `deviceSyncNonces`, `checkSignatureAttestation`, `signatureFreshness` | device-signs the mark payload at capture and the envelope at send (§8.3) |
| Tenant | `resolveActingScope`, `orgRef` NULL rule, NOT_FOUND across the boundary | every table carries `orgRef`; every read is scoped |
| Authorization | `roleProcedure`, `externalProcedure`, `Permission` union, SENSITIVE fail-closed, inventory + count pins | adds `attest.*` and `portal.attest.*` permissions (§13) |
| Audit | domain append-only table + `emitDomainEvent(tx)` | `attestEvents` (hash-chained, triggered) + `attest.*` outbox events (§9) |
| Offline | `LocalCapture` kind `"signature"`, `Outbox`, `SyncEngine`, `sync.receivePackage`, `handleSyncRefusal` codes | marks ride the evidence pipeline; the session envelope is a second signed submission (§6) |
| Pre-departure | `preDepartureCache.manifestFor` | adds `CacheItemKind = "signable_document"` (Phase 2) |
| Billing proof | `fieldTicketLines.disposition`, `fieldTicketRevisions.snapshotHash`, invoicing's blockers | exposes a read-only proof contract; never writes billing tables (§11) |
| Portfolio | `evidenceRelationships` / `complianceDocuments` / PR #16 `driverPortfolioEvents` | references only (§11.4) |
| PDF | `ticketPdf.renderPdf` | extends it with vector-path and JPEG-XObject operators (§7.4, owner decision D-02) |
| Audit package | `auditPackage.assemble` | the audit receipt is the same canonical-manifest shape |

---

## 3. Entities and tables

Naming: the request's vocabulary → the repository's. Prefix `attest` (avoids `signature*`, `scan*`,
`hos*`). All ids `int autoincrement`; all refs `varchar(64)` unique; `orgRef varchar(64)` NULL = single
tenant; timestamps as everywhere. Enumerations that must grow **without a destructive migration** are
`varchar` columns validated by a zod enum in one shared module (`shared/attest.ts`), following
`fieldTicketEvents.eventType varchar(60)` and `documentControlEvents.eventType varchar(60)`; state
machines that must not grow are `mysqlEnum`.

| Request | Repository | Table |
|---|---|---|
| DocumentTemplate | Document Control template revision | `documentTemplateRevisions` (branch) + **`attestFieldLayouts`** (Phase 3) |
| DocumentInstance | the subject chain (register `documentRef` lineage, ticket number, evidence tracking number) | `attestDocumentRevisions.instanceRef` |
| DocumentRevision | **`attestDocumentRevisions`** | new |
| DocumentField | **`attestFields`** | new |
| Signer | **`attestSigners`** | new |
| SigningSession | **`attestSigningSessions`** | new |
| SignerMark | **`attestMarks`** (+ two sealed evidence records) | new |
| SigningEvent | **`attestEvents`** (append-only, hash-chained) + outbox events | new |
| SignedArtifact | **`attestArtifacts`** (+ a 0144 register row) | new |
| AuditReceipt | `attestArtifacts.kind = 'audit_receipt'` + `attestDocumentRevisions.receiptHash` | no separate table |
| saved signature / initials | **`attestSavedMarks`** | Phase 4 |

### 3.1 `attestDocumentRevisions` — the binding target

One row per document revision that has been *opened for signing*. It does not copy the document; it
names it and fixes its hash.

| Column | Type | Meaning |
|---|---|---|
| `revisionRef` | varchar(64) unique | `ATR-…` |
| `orgRef` | varchar(64) NULL | acting organization at open, from `resolveActingScope`, never input |
| `instanceRef` | varchar(120) | stable across revisions: register root `documentRef`, `ticketNumber`, evidence `trackingNumber` |
| `revision` | int | 1, 2, … per `instanceRef` (unique `(orgScopeKey, instanceRef, revision)`; `orgScopeKey = COALESCE(orgRef,'default')` maintained by the write path, the DC 0178/0179 pattern) |
| `subjectType` | varchar(40) | `commercial_document` · `field_ticket_revision` · `evidence_record` · `academy_certificate` · `written_program_version` · `work_order` … (zod enum; extensible) |
| `subjectRef` | varchar(120) | the subject's own ref (`documentRef`, `fieldTicketRevisions.documentRef`, `trackingNumber`) |
| `subjectId` | int NULL | the subject's row id where one exists |
| `revisionHash` | char(64) | **the fingerprint before signing**: `commercialDocuments.contentHash`, `fieldTicketRevisions.snapshotHash`, or the evidence seal's `contentHash` — recomputed by the server from stored bytes at open (§8.1), never accepted from input |
| `pageCount` | int | pages of the visual representation |
| `pageGeometryJson` | text | per page `{ widthPt, heightPt, rotation, sourceEvidenceRecordId }` — the frame every field coordinate is relative to |
| `state` | mysqlEnum | `open · completed · finalized · voided · superseded` |
| `completionRule` | varchar(40) | `all_required_fields` (default) · `all_required_fields_in_order` |
| `finalizedAt`, `finalizedByUserId` | | |
| `artifactId` | int NULL | the finalized artifact (`attestArtifacts`) |
| `receiptHash` | char(64) NULL | hash of the audit receipt at finalization |
| `eventChainHead` | char(64) NULL | `attestEvents.eventHash` of the last event at finalization |
| `finalizedKey` | varchar(160) generated PERSISTENT | `CONCAT(orgScopeKey,'|',instanceRef)` when `state='finalized'` else NULL; **unique** — the database's own refusal of two finalized revisions of one instance (the `0021` `activeGrantKey` precedent) |
| `supersedesRevisionId`, `supersededByRevisionId` | int NULL | the chain |
| `voidedAt`, `voidedByUserId`, `voidReason` | | reason ≥ 10 chars (0144 supersede precedent) |
| `openedByUserId`, `openedAt`, `createdAt` | | |

### 3.2 `attestFields` — where a mark belongs

| Column | Type | Meaning |
|---|---|---|
| `fieldRef` | varchar(64) unique | |
| `revisionId` | int | FK → `attestDocumentRevisions` |
| `fieldKey` | varchar(80) | unique per revision; stable across revisions when it comes from a layout |
| `fieldType` | varchar(32) | `signature · initials · date_signed · printed_name · checkbox · approval · comment` (zod enum `ATTEST_FIELD_TYPES`; later types add a value, not a column) |
| `page` | int | 1-based |
| `x`, `y`, `width`, `height` | double | **fractions of the page's width/height (0–1)** from the top-left of the unrotated page; with `pageGeometryJson` they map to PDF points on any renderer and survive a rescaled scan. Stored as fractions rather than points so a field placed on a 2,480-px camera image and one placed on a 612-pt PDF are the same field |
| `signerRole` | varchar(60) | `consultant · driver · supervisor · customer_representative · employee · employer_representative · witness · …` (varchar; roles are tenant vocabulary) |
| `assignedSignerId` | int NULL | FK → `attestSigners`; NULL until assigned; **a session may complete a field only when it is assigned to that session's signer** |
| `required` | boolean | |
| `signingOrder` | int NULL | NULL = any order |
| `subjectLineRef` | varchar(120) NULL | the billing anchor: `fieldTicketLines.id`, a load ref, a work-order line — what this initial acknowledges |
| `groupKey` | varchar(80) NULL | "initial every line of section B"; completion rules can address a group |
| `layoutRef` | varchar(64) NULL | the `attestFieldLayouts` row it came from (Phase 3), NULL for fields placed on an instance |
| `state` | mysqlEnum | `pending · completed · declined · voided` |
| `completedMarkId` | int NULL | the mark that completed it; **unique** → the database refuses a second completion (§6.5 race 3) |
| `createdByUserId`, `createdAt` | | |

### 3.3 `attestSigners` — who is expected to sign

| Column | Meaning |
|---|---|
| `signerRef`, `revisionId`, `orgRef` | |
| `partyKind` mysqlEnum | `internal_user` (has `userId`) · `external_identity` (has `externalIdentityId`, a portal identity) · `named_witnessed` (no account: `displayName` + the witnessing user; the paper/in-person case) |
| `userId`, `externalIdentityId`, `displayName`, `company` (varchar 180 or `counterpartyOrgRef`) | exactly one identity column is set, enforced by the write path and a check in tests |
| `signerRole` | must match the fields it is assigned |
| `requiredAuth` varchar(40) | the minimum `authMethod` acceptable for this signer: `session_login · device_auth · portal_link · witnessed` |
| `signingOrder` int NULL | sequential signing when set |
| `state` mysqlEnum | `invited · active · completed · declined · revoked` |
| `invitedByUserId`, `invitedAt`, `completedAt` | |

### 3.4 `attestSigningSessions` — the evidence of one act of signing

| Column | Meaning |
|---|---|
| `sessionRef` varchar(120) unique | server-minted `ATS-…`, or **device-relative** `${deviceRef}:${localId}` for offline sessions (unique with `fieldDeviceId`) |
| `revisionId`, `signerId`, `orgRef` | |
| `revisionHashAtStart` char(64) | copied from the revision when the device/browser opened it; **must equal `attestDocumentRevisions.revisionHash` at submit** (§6.5 race 1) |
| `authMethod` mysqlEnum | `session_login · device_auth · portal_link · witnessed · paper_scan` — the existing vocabulary (`signatureMethod` minus `drawn`, plus the login case) |
| `actorUserId`, `actorExternalIdentityId`, `witnessedByUserId` | who was authenticated; for `named_witnessed` signers the witness is the authenticated actor and the signer is the named person |
| `deviceRef`, `fieldDeviceId`, `keyFingerprint`, `deviceSignatureBase64`, `deviceSignedAt` | 0157 shape, verbatim |
| `capturedOffline` boolean, `deviceClockAt`, `clockSkewMs`, `receivedAt` | 0142 shape |
| `consentTextHash` char(64), `consentVersion` varchar(20) | the e-sign consent statement the signer accepted (the repository's own sentence, versioned in `shared/attest.ts`) |
| `capturedLatitude`, `capturedLongitude` | as `fieldTicketSignatures` |
| `state` mysqlEnum | `started · completed · declined · abandoned · rejected` — rejected sessions are **rows** (refusals are rows, `deviceRouter.ts:200`) with `rejectionCode` |
| `rejectionCode` varchar(40) | `REVISION_MISMATCH · DOCUMENT_VOIDED · DOCUMENT_FINALIZED · FIELD_ALREADY_COMPLETED · WRONG_SIGNER · SIGNER_NOT_AUTHENTICATED · DEVICE_NOT_ENROLLED · DEVICE_NOT_ACTIVE · SIGNATURE_INVALID · REPLAY · CLOCK_SKEW_TOO_LARGE · MALFORMED` (reuses `SyncRefusalCode` where the meaning is the same) |
| `syncPackageId` int NULL | when the marks arrived in a package |
| `startedAt` (device clock), `completedAt`, `createdAt` (server) | |

### 3.5 `attestMarks` — the mark itself

| Column | Meaning |
|---|---|
| `markRef`, `sessionId`, `fieldId`, `orgRef` | |
| `markKind` varchar(32) | `drawn · typed_name · checkbox · approval · comment · date · adopted_saved` |
| `inputKind` varchar(16) | `touch · pen · mouse · keyboard · none` — from `PointerEvent.pointerType`, recorded not inferred; **Apple Pencil and other styli report `pen`** |
| `strokeEvidenceRecordId` int NULL, `strokeHash` char(64) NULL | the canonical stroke document (§7.1) as a **sealed evidence record** (`recordType = 'signature_strokes'`) |
| `renderedEvidenceRecordId` int NULL, `renderedHash` char(64) NULL | the rendered mark (SVG; PNG optional) as a sealed evidence record (`recordType = 'signature_render'`) |
| `canvasWidthPx`, `canvasHeightPx`, `devicePixelRatio`, `orientation` (portrait/landscape), `pointCount`, `strokeCount`, `durationMs`, `pressureAvailable` boolean | rendering and scaling facts (no biometrics: no velocity profiles, no per-point timing beyond what rendering needs — §7.2) |
| `valueText` varchar(500) NULL | printed name, comment, date string, `approved`/`rejected` |
| `payloadHash` char(64) | hash of the canonical mark payload (§8.2) |
| `savedMarkId` int NULL | when adopted from `attestSavedMarks` (Phase 4) |
| `completedAt` (device clock), `createdAt` (server) | |

Unique `(fieldId)` **among completed marks** is implemented as `attestFields.completedMarkId` unique,
not as a partial index; a mark row can exist for a rejected session (evidence of the attempt) without
completing the field.

### 3.6 `attestEvents` — append-only, hash-chained

| Column | Meaning |
|---|---|
| `eventRef` unique, `revisionId`, `orgRef` | |
| `sequence` int | unique `(revisionId, sequence)` — the DC 0179 shape; assigned under `SELECT … FOR UPDATE` on the revision row |
| `eventType` varchar(60) | §9 vocabulary |
| `sessionId`, `fieldId`, `markId`, `artifactId` | NULLable pointers |
| `actorSource` mysqlEnum | `human · system · external · integration` (the DC 0179 set; the outbox's set plus `external`) |
| `actorUserId`, `actorExternalIdentityId`, `deviceRef` | |
| `previousState`, `newState` varchar(40) | |
| `detailJson` text | |
| `prevEventHash` char(64) NULL, `eventHash` char(64) | `eventHash = sha256(prevEventHash ∥ canonical(row minus hashes))` |
| `occurredAt` (device or server clock, stated by `clockSource`), `recordedAt` (server) | |

Guarded by `attestEvents_no_update` / `attestEvents_no_delete` triggers (`SIGNAL SQLSTATE '45000'`),
in a trigger-only migration (§16).

### 3.7 `attestArtifacts` — what finalization produced

| Column | Meaning |
|---|---|
| `artifactRef`, `revisionId`, `orgRef` | |
| `kind` mysqlEnum | `finalized_pdf · audit_receipt · page_render` |
| `storageKey`, `mimeType`, `byteLength`, `contentHash` | server-computed from the bytes it stored |
| `sourceRevisionHash` char(64) | the document hash this artifact certifies |
| `eventChainHead` char(64) | the event hash it was generated after |
| `rendererKey`, `rendererVersion` | `ticketPdf@1.4-vector`, … (the DC 0181 idea: an artifact says what rendered it) |
| `evidenceRecordId` int | the sealed evidence record holding the same bytes |
| `registerDocumentId` int NULL | the `commercialDocuments` row registered for delivery/search (`documentType = 'signed_artifact'`, `sourceSnapshotHash = sourceRevisionHash`) |
| `generatedByUserId`, `generatedAt` | |

### 3.8 `attestFieldLayouts` (Phase 3) — fields on a template

`layoutRef`, `orgRef`, `templateRevisionRef varchar(64)` (Document Control `revisionRef`, **string
reference, no FK**, so the checkpoint compiles before DC merges), `fieldsJson` (the same field
shape as `attestFields` minus instance columns), `fieldsHash`, `status draft/released/retired`,
released-immutable trigger (the DC 0181 rule). Opening a revision from a template copies the layout
into `attestFields` rows with `layoutRef` set.

### 3.9 Changes to existing tables

* `evidenceRelationships.entityType` (mysqlEnum) gains `attestRevision` and `attestMark` so a stroke
  file, a rendered mark and a finalized PDF are filed against the revision **and** against the domain
  entity (job, fieldTicket, disposalTicket, operator) through the vault's own relationship table.
  `EvidenceRecordType` (TypeScript union, `evidenceSeal.ts:18`; the column is `varchar(60)`) gains
  `signature_strokes`, `signature_render`, `signed_artifact`, `attest_receipt` — no migration.
* `fieldTicketSignatures` gains `attestSessionRef varchar(120) NULL` so the on-spine signature row
  can point at the session that holds its mark (Phase 1; §11.1). No existing column changes meaning.
* Nothing in `commercialDocuments` changes; Sign & Attest registers artifacts through the existing
  insert path and, once DC 0179 merges, sets `originKind = 'system_rendered'`.

### 3.10 What is deliberately not a table

* No `signers` directory: identity is `users` or `externalIdentities`; a named witnessed signer is a
  string on the signer row, exactly as `fieldTicketSignatures.signerName` is today.
* No per-point stroke rows: strokes are one canonical document in the vault, hashed once.
* No copy of billing lines: `subjectLineRef` points at the domain's line.

### 3.11 Existing signature stores — relationship

`fieldTicketSignatures`, `academyCertificateSignatures`, `complianceConsents`,
`programAcknowledgements`, `competencySignoffs`, `commercialApprovalSignatures` keep their rows and
their write paths. Each becomes a **producer**: its write path opens a revision, creates one signer
and one field, runs one session, and stores the domain row with a pointer to the session (as §3.9 does
for field tickets). Historical rows are not migrated; a NULL pointer reads "signed before Sign &
Attest", the same rule as NULL `originKind` in DC 0179.

---

## 4. Signature capture and authentication — the two axes

### 4.1 Input (how the mark was made)

Finger, touchscreen stylus, Apple Pencil, mouse/trackpad all arrive through **Pointer Events**
(`pointerdown/move/up`, `pointerType ∈ touch|pen|mouse`, `pressure`, `tiltX/Y`, `width/height`,
coalesced events for high-rate pens). One pad component consumes them; `inputKind` is recorded from
`pointerType`. Typed name, checkbox, approval, comment and date fields are not drawn.

### 4.2 Authentication (who the server believes made it)

| `authMethod` | Proof | Existing precedent |
|---|---|---|
| `session_login` | `ctx.user` of a `roleProcedure`; the signer row's `userId` must equal `ctx.user.id` | `academy.certificate.sign_own` self-scoping |
| `device_auth` | 0157 device attestation over the mark payload, enrolled key, org-bound device; biometric unlocks the key **on the device** and never travels | `checkSignatureAttestation`, `recordSignature` P1.4 block |
| `portal_link` | `externalProcedure`; the signer row's `externalIdentityId` must equal the resolved identity | `portal.fieldTicketSign`, 0158 |
| `witnessed` | the authenticated actor is the **witness** (`closeout.sign.witness` / `attest.witness`), the signer is `named_witnessed`; the artifact shows both names and the word *witnessed* | `witnessedByOperatorId` |
| `paper_scan` | a sealed scan of the paper signature in the vault; the actor files it | `paper_scan` + `evidence:<id>` |

A `device_auth` claim without an attestation is refused, and an attestation under another method is
refused — both directions, exactly as `closeoutRouter.ts:72–83` does today. **No administrator path
applies a mark for another authenticated person.** The only way an office user places a mark that is
not theirs is `witnessed` or `paper_scan`, and both say so on the row, the receipt and the PDF.

---

## 5. Service and module boundaries

```
server/_core/attest/
  attestTypes.ts        field/mark/event vocabularies (re-exports shared/attest.ts zod enums)
  attestBinding.ts      PURE: revisionHash resolution rules per subjectType; session/revision binding checks
  attestState.ts        PURE: field/signer/revision state machines; completion rule; race-condition verdicts
  attestPayload.ts      PURE: canonical mark/session payloads; event hash chain; receipt manifest
  attestStrokes.ts      PURE: stroke document validation, normalisation, SVG rendering, PDF path ops
  attestService.ts      DB: open / assign / start / submit / decline / finalize / void / supersede in transactions
  attestProof.ts        READ CONTRACT for billing, portfolio, audit packages (§11)
server/attestRouter.ts  roleProcedure surface;  portal procedures added to portalRouter.ts under externalProcedure
shared/attest.ts        zod enums, consent text versions, stroke document schema (client + server)
client/src/attest/      SignaturePad (Phase 2), field placement, signing screen; runtime capture builder
```

Pure modules are tested without a database (the repository's rule: engines are pure, routers are
thin). `attestService` is the only writer of `attest*` tables; the router never touches them directly.
Producers (closeout, academy, portal) call `attestService` inside **their own transaction** so the
domain row and the session commit together (the `emitDomainEvent` rule).

---

## 6. Offline synchronization model

### 6.1 What must be on the device

`preDepartureCache.manifestFor` gains `CacheItemKind = "signable_document"` with necessity
`required_on_site`: for each open revision assigned to the driver (or to a signer the driver will
witness), the device holds `{ revisionRef, revisionHash, instanceRef, fields[], signers[],
pageGeometry, page images (vault refs, JPEG) }` — the **`LocalSignableRevision`**, a new `LocalStore`
record type. A revision the device never downloaded cannot be signed offline; the UI says so rather
than letting a session start against nothing.

### 6.2 Signing offline

1. The signer opens the local revision; the client compares the stored `revisionHash` with the
   page images' hashes it holds (integrity of the local copy).
2. Each mark becomes a `LocalCapture` of kind `"signature"` with `files = [strokes.json,
   render.svg]` in the encrypted vault, `fields = { markPayload }`, `jobId` set, and
   `captureAuthorizationClaim` from the device's own view of whether the signer was authenticated
   (device biometric unlock → `authorized`; otherwise `unknown`).
3. The session is a **`LocalAttestSession`**: `{ sessionRef: deviceRef:localId, revisionRef,
   revisionHashAtStart, signerRef, authMethod, marks: [markRef…], consentTextHash, startedAt,
   completedAt, deviceSignatureOverSession }` — signed by the device key **at completion time**
   (capture-time binding).
4. The outbox queues the mark captures first (priority 10, already the rule) and the session
   envelope after them.

### 6.3 Synchronizing

1. Mark files: upload → seal → `sync.receivePackage` — unchanged pipeline; the server recomputes each
   hash from stored bytes and writes `syncReceipts`.
2. Session: a new procedure `attest.submitSession` (Phase 2) receives the **exact bytes** of the
   session envelope, device-signed **at send time** with a fresh nonce (`deviceSyncNonces`), wrapping
   the capture-time-signed session. Two signatures, two clocks:
   * the envelope must be fresh (`signatureFreshness`, `deviceClockAt`, skew recorded — the 0142 rule);
   * the inner session signature may be hours old; its age is recorded (`deviceClockAt`,
     `clockSkewMs`) and is **not** subject to the 10-minute `SIGNATURE_STALE` rule, which exists for
     online acts (§20, conflict 4).
3. Server order, fail-closed at every step, every refusal a row with a code:
   admission (device enrolled, active, org-bound) → nonce → envelope signature → inner signature over
   the canonical session payload → `revisionRef` exists and belongs to the acting org → revision
   `state = open` → `revisionHashAtStart == revisionHash` → signer belongs to this revision and
   resolves to the authenticated actor (or the actor may witness) → every referenced mark's evidence
   record is **sealed and verified** (`evidenceSeals.verificationResult = 'verified'`) and its
   `contentHash` equals the payload's `strokeHash` → each field is assigned to this signer and
   `pending` → transaction: insert session, marks, set `completedMarkId`, append events, emit outbox
   events → completion check → response with per-mark verdicts (the `itemVerdicts` shape).
4. Response codes map onto `handleSyncRefusal`: `REPLAY` → retry/move on; `REVISION_MISMATCH`,
   `DOCUMENT_VOIDED`, `DOCUMENT_FINALIZED`, `FIELD_ALREADY_COMPLETED`, `WRONG_SIGNER` →
   `stop_and_escalate` with the reason (retrying cannot change a superseded document); device/clock
   codes → as today.

### 6.4 Idempotency

* `sessionRef` unique per device (`(fieldDeviceId, sessionRef)`), `markRef` unique per device,
  `clientCaptureRef` per the existing rule. A resubmission returns `{ alreadyRecorded: true,
  sessionRef, state }` and the original verdicts — the `uploadEvidence.alreadyUploaded` shape.
* The finalize procedure is idempotent on `(revisionId)`: a second call returns the existing artifact.
* Event `sequence` is assigned under row lock; an idempotent replay appends **no** event.

### 6.5 Race conditions, explicitly

| # | Situation | Outcome | Mechanism |
|---|---|---|---|
| 1 | Document changed after the offline copy was downloaded (a new register version, an amended ticket) | session **rejected** `REVISION_MISMATCH`; marks kept as sealed evidence of the attempt; event `signing_rejected` on the *new* head revision's chain with the stale hash in `detailJson` | `revisionHashAtStart` vs `revisionHash`; a changed document is always a new `attestDocumentRevisions` row (§14) |
| 2 | Document voided while another device was offline | rejected `DOCUMENT_VOIDED`; same retention | `state` check inside the transaction |
| 3 | Same field signed independently on two devices | first committed session completes the field; second rejected `FIELD_ALREADY_COMPLETED`; both marks retained; the office sees both (no automatic merge of signatures) | `attestFields.completedMarkId` unique + `SELECT … FOR UPDATE` on the field rows |
| 4 | Two revisions of one instance finalized concurrently | one succeeds; the other fails on the unique `finalizedKey` and reports `DOCUMENT_FINALIZED`; nothing partial because the artifact insert and the state change are one transaction | generated persistent column, unique index |
| 5 | Duplicate event retransmission | `REPLAY`: nonce already used → the existing result is returned; no second session, mark or event | `deviceSyncNonces`, `sessionRef` unique |
| 6 | Outbox retry after server success (device never saw the ack) | same as 5; device marks the capture synchronized from the returned verdicts | idempotent response |
| 7 | Signer revoked (portal identity revoked, employee offboarded) between capture and sync | rejected `SIGNER_NOT_AUTHENTICATED`; the office may re-request | signer/identity status checked at submit, not at capture |
| 8 | Device revoked between capture and sync | rejected `DEVICE_NOT_ACTIVE` — "revocation takes effect for signatures too" (`deviceSignature.ts:156`) | existing admission |
| 9 | Clock wrong on the device | envelope refused `CLOCK_SKEW_TOO_LARGE` (stop and prompt); inner `capturedAt` is recorded as claimed with the skew beside it | 0142 rules |

The device never resolves any of these; "the device is the source of truth for what it observed,
not the source of authority for what that observation permits" (`offlineCapability.ts:8`).

---

## 7. Signature / initial capture format

### 7.1 The stroke document (canonical, versioned, in `shared/attest.ts`)

```jsonc
{
  "format": "leaseos-strokes/1",
  "canvas": { "widthPx": 1200, "heightPx": 400, "devicePixelRatio": 2, "orientation": "landscape" },
  "field":  { "fieldRef": "ATF-…", "widthFrac": 0.28, "heightFrac": 0.06 },
  "inputKind": "pen",
  "pressureAvailable": true,
  "strokes": [
    { "points": [ [x, y, t, p], [x, y, t, p], … ] }      // x,y in canvas px (float), t ms from stroke start (int), p pressure 0–1 or null
  ],
  "startedAt": "2026-09-24T15:02:11.120Z",
  "durationMs": 1830
}
```

* Coordinates are **canvas pixels, floats, unrounded**, plus canvas size and DPR, so the mark can be
  re-rendered at any scale; the field fraction records the box it was drawn for.
* `t` is kept only as needed to render pressure- and speed-shaped strokes faithfully (variable-width
  rendering); no derived timing features are stored, and **behavioural biometrics and handwriting
  identification are out of scope by design** (`deviceSignature.test.ts` already scans for
  template-shaped columns; this document adds `velocityProfile`, `dynamics`, `biometricScore` to its
  `BIOMETRIC_MATERIAL_PATTERNS`).
* Serialization for hashing: the document is plain JSON with fixed key order as written by
  `shared/attest.ts` (`serializeStrokeDocument`), and `strokeHash = sha256(bytes)`. Client and server
  produce byte-identical output for the same document (test: finger/stylus serialization round-trip).
* Size guard: ≤ 20,000 points, ≤ 512 KB; the pad coalesces points closer than 0.5 px.

### 7.2 The rendered mark

* **SVG** generated deterministically from the stroke document by `attestStrokes.renderSvg`
  (Catmull-Rom → cubic Béziers, width from pressure when available, else constant) — pure, no
  rasterizer, identical on client and server, hashed and sealed as `signature_render`.
* PNG is a client-side preview only (canvas `toBlob`) and is not evidence; if a producer needs a
  raster it is derived from the SVG on demand.

### 7.3 Non-drawn marks

`typed_name`, `date`, `comment`, `checkbox`, `approval` carry `valueText`; the mark payload hash
covers the value, the field, the revision hash and the signer (§8.2). A `date_signed` field is filled
by the server from `completedAt` (device clock, skew recorded), never typed.

### 7.4 Placing a mark into a PDF (owner decision D-02)

`ticketPdf.renderPdf` writes PDF 1.4 by hand and today draws text only. Two additions keep it
dependency-free and deterministic:

1. **Vector paths**: strokes → PDF path operators (`m`, `c`, `l`, `S`, with `w` for width). Sharp at
   any zoom, no rasterization, no image codec — this is the recommended primary rendering of a mark.
2. **JPEG page images** as `XObject /DCTDecode` (raw bytes embedded, no decoding) so a scanned page
   captured as JPEG can be the page under the marks.

What it cannot do without a library: draw onto an **existing PDF** (customer-supplied forms,
imported PDFs) or embed PNG (needs zlib/PNG decoding). Options: (a) restrict finalized PDFs to
LeaseOS-rendered pages and JPEG scans in Phases 1–3; (b) add `pdf-lib` (pure JS, no native deps) for
overlay onto imported PDFs in Phase 3, aligned with Document Control's DC2 "PDF library". Recommended:
(a) now, (b) when DC2 lands, decided once for both subsystems.

---

## 8. Hashing and tamper-evidence strategy

### 8.1 Fingerprint before signing

`revisionHash` is computed by the **server** at `attest.open` from the subject:

| `subjectType` | `revisionHash` | Recomputed from |
|---|---|---|
| `commercial_document` | `commercialDocuments.contentHash`, re-derived by `storageRead(storageKey)` + `sha256` | stored bytes |
| `field_ticket_revision` | `fieldTicketRevisions.snapshotHash`, re-derived as `sha256(canonicalJson(snapshotJson))` | stored snapshot |
| `evidence_record` (a scan) | the current `evidenceSeals.contentHash` with `verificationResult = 'verified'`; an unverified seal refuses to open (`verifySealAgainstStored` first) | stored bytes |
| `academy_certificate` … | the domain's own hash column, re-derived | |

If the recomputed hash differs from the stored one the open is refused and `records.evidence_integrity_failed`
is emitted (`domainEmitters.ts:383`) — a mismatch is an alert, never a silent overwrite.

### 8.2 The mark payload (what the signer's device signs)

```
canonicalAttestPayload({
  v: 1, revisionRef, revisionHash, instanceRef, fieldRef, fieldKey, fieldType,
  signerRef, signerIdentity: "user:123" | "ext:456" | "named:<hash of displayName>",
  markKind, strokeHash | valueText, renderedHash | null,
  consentTextHash, completedAt (ISO), nonce
})
```

`payloadHash = sha256(bytes)`. Under `device_auth` the device signs these bytes (P-256); under other
methods the hash is still stored so the mark is bound to the revision hash regardless of method. The
session payload is the ordered list of mark payload hashes plus session facts; the device signs it at
completion (§6.2 step 3).

### 8.3 The event chain

Every state change of a revision is one `attestEvents` row with `eventHash = sha256(prevEventHash ∥
canonical(event))`. The chain head is copied to the revision at finalization; `attest.verify` walks the
chain and recomputes it. Triggers refuse update/delete; an append-only table with a broken chain is
therefore detectable even by a reader with no application code.

### 8.4 Fingerprint after signing

`attest.finalize` (in one transaction): assemble the receipt manifest (§9.4) → `receiptHash` → render
the finalized PDF from the revision's page images/snapshot plus every completed mark → `sha256` of the
bytes → `storagePut` → `evidenceRecords` + `evidenceSeals` (sealed by the finalizing user, verified by
the same server read) → `attestArtifacts` rows (pdf, receipt) → `commercialDocuments` register row →
revision `state = finalized`, `artifactId`, `receiptHash`, `eventChainHead` → event `document_finalized`
→ outbox `attest.document_finalized`. The `finalizedKey` unique index refuses a second finalized
revision for the instance. A trigger `attestDocumentRevisions_final_guard` refuses any update to a
finalized row except `supersededByRevisionId` (the 0181 released-immutable pattern).

### 8.5 Verification

`attest.verify(revisionRef)` returns three legs per artifact — declared hash, stored-bytes hash,
receipt hash — plus the event chain result and every mark's stroke/render seal verification, using
`verifySealAgainstStored`. Verification writes `evidenceAccessEvents.seal_verified`.

---

## 9. Audit-event model

### 9.1 Vocabulary (`attestEvents.eventType`; all lower snake_case, past tense where the outbox needs it)

| Event | When | Outbox (`domainEventOutbox`) |
|---|---|---|
| `document_created` | revision opened for signing | `attest.document_opened` |
| `document_scanned` | a scan became a revision (subject `evidence_record`) | — |
| `document_opened` | a signer viewed the revision (server read path, or device-recorded offline) | — |
| `fields_placed` | fields added/changed while `open` and no field completed | — |
| `signer_assigned` / `signer_revoked` | | `attest.signing_requested` (per signer) |
| `signing_requested` | request sent (portal invitation, task) | `attest.signing_requested` |
| `signing_started` | session started | — |
| `field_initialed` / `field_signed` / `field_acknowledged` / `field_approved` / `field_rejected` / `field_commented` / `field_dated` / `field_named` | mark committed | `attest.field_completed` (billing consumers listen here) |
| `mark_adopted` | a saved mark was applied under fresh authentication (Phase 4) | — |
| `signing_completed` | all fields of a signer complete | `attest.signing_completed` |
| `signing_declined` | signer declined (reason required) | `attest.signing_declined` |
| `signing_rejected` | a submission refused (code in detail) | `attest.signing_rejected` |
| `document_completed` | completion rule satisfied | — |
| `document_finalized` | artifacts generated, state final | `attest.document_finalized` |
| `artifact_generated` | each artifact | — |
| `document_voided` / `document_superseded` | §14 | `attest.document_voided` / `attest.document_superseded` |
| `artifact_viewed` / `artifact_exported` | read path; also `evidenceAccessEvents` | — |
| `sync_pending` / `sync_completed` | recorded by the device in the session envelope and replayed into the chain on receipt with `clockSource = device` | — |
| `verification_run` | `attest.verify` | `records.evidence_integrity_failed` on failure |

### 9.2 Actor and source

`actorSource human|system|external|integration`; `actorUserId` for staff, `actorExternalIdentityId`
for portal signers, `deviceRef` when the act happened on a device. Authorization decisions remain in
their own table (`recordAuthorizationDecision`), not duplicated here.

### 9.3 Consequences

Outbox consumers (Phase 3): `attest.signing_requested` → a notification/task (`drainWorker`
consequences, dedupe key `attest:<revisionRef>:<signerRef>`); `attest.document_finalized` → the
producer domain (closeout, disposal, academy) files the artifact; `attest.field_completed` with a
`subjectLineRef` → closeout's own `decideLine` path sets `disposition = accepted` **in closeout's
code**, not here.

### 9.4 The audit receipt

`{ format: "leaseos-attest-receipt/1", revision: {…hashes…}, instanceRef, subject, fields: [{fieldRef,
fieldType, page, box, signerRef, state, markRef, payloadHash, strokeHash, renderedHash}], signers:
[{signerRef, partyKind, identityHash, role, authMethod, state}], sessions: [{sessionRef, authMethod,
deviceRef, keyFingerprint, deviceSignatureBase64, capturedOffline, clockSkewMs, startedAt,
completedAt, state, rejectionCode}], events: [{sequence, eventType, eventHash}], chainHead,
artifacts: [{kind, contentHash}], generatedAt }` — canonical JSON (`auditPackage.canonicalJson`),
hashed, stored as an artifact. It names nothing biometric and no bearer token; portal identities
appear as `identityRef`, never email.

---

## 10. Scanner integration

Path: paper disposal ticket → photo/scan (`evidence.upload`, JPEG preferred; multi-page is one
capture with `files[]` once the `files[0]` defect is fixed) → seal → `attest.openFromEvidence`
(subject `evidence_record`, `revisionHash` = verified seal content hash, `pageGeometryJson` from the
image dimensions) → the driver/admin places fields on the page image (fractions) → assign signer
(consultant portal identity, or `named_witnessed` for in-person) → session → finalize → artifact
registered → `evidenceRelationships` rows link revision and artifact to `disposalTicket`, `load`,
`job`, `facility` → billing reads the proof (§11).

* No OCR is required. When Document Control merges, the same evidence record is also a register row
  at `controlState = captured`, and the disposal ticket number typed by the driver becomes a
  `documentExternalReferences` row; Sign & Attest does not duplicate that.
* Field discovery on a scan is a later, model-backed proposal (`assistantProposals` shape:
  proposed → human confirms → `fields_placed`); the data model needs nothing new for it because a
  proposed field is an `attestFields` row created by the confirm adapter.
* `scanAudits` (QR/NFC) is unrelated and untouched.

---

## 11. Billing, field-ticket, disposal, job, wallet integration — contracts, not logic

### 11.1 Field tickets (the first producer)

`recordSignature` (`closeoutRouter.ts:51`) becomes a producer: within its existing transaction it
opens `attestDocumentRevisions` for `field_ticket_revision` R1 (hash = `snapshotHash`), creates one
signer (the consultant) and one `signature` field (plus one `initials` field per line when the ticket
is presented line-by-line, `subjectLineRef = fieldTicketLines.id`), runs the session with the
consultant's mark, and writes `fieldTicketSignatures.attestSessionRef`. Everything the row records
today it still records; what it gains is the drawing, the stroke evidence and the chain. Line
acceptance stays in `decideLine` (closeout owns `disposition`).

### 11.2 The proof contract (`attestProof.ts`)

```ts
type AttestProof = {
  instanceRef: string; revisionRef: string; revision: number; revisionHash: string;
  state: "open" | "completed" | "finalized" | "voided" | "superseded";
  acknowledgedLines: { subjectLineRef: string; fieldRef: string; fieldType: string; signerRef: string;
                       signerIdentity: string; markRef: string; payloadHash: string; completedAt: Date; eventSequence: number }[];
  signatures: { fieldRef: string; signerRef: string; authMethod: string; completedAt: Date }[];
  artifact: { artifactRef: string; contentHash: string; registerDocumentRef: string | null } | null;
  receiptHash: string | null;
};
attestProofFor(db, { subjectType, subjectRef }): Promise<AttestProof | null>
```

Billing's sentence — "these 7 billable lines were acknowledged by this person on this immutable
document revision" — is `acknowledgedLines` filtered to a `finalized` revision. Invoicing's existing
blocker list (`invoiceDraft.ts`) can add `ticket_lines_not_acknowledged` from it; that change is
invoicing's, in a later checkpoint.

### 11.3 Disposal tickets, jobs, work orders, inspections, safety forms

Each is a `subjectType` plus `evidenceRelationships` rows; none needs a column in Sign & Attest.
The subject's owning domain decides when a finalized artifact changes its own state (e.g. a disposal
ticket becomes `verified` only through `disposalReconciliation`, never because a signature exists).

### 11.4 Driver / employee wallet

PR #16's model: the operator owns `complianceDocuments`; history is `driverPortfolioEvents`. A signed
employee document is an `attestArtifacts` row whose register document is linked to the operator through
`evidenceRelationships(entityType='operator')` and, when PR #16 merges, a `driverPortfolioEvents` row
of kind `document_signed` written by **the portfolio's** service on the `attest.document_finalized`
outbox event. Sign & Attest never writes portfolio tables and does not define ownership.

---

## 12. Document-template integration

* A template is Document Control's `documentTemplates` / `documentTemplateRevisions` (released
  revisions immutable). Sign & Attest adds `attestFieldLayouts` keyed by `templateRevisionRef` (§3.8):
  fixed signable fields for a form family (a JSA has "supervisor signature" and "each attendee initials").
* Rendering a document from a template revision (DC2) produces a register row with `contentHash`;
  `attest.open` then copies the layout's fields into `attestFields` with `layoutRef`. A layout may
  also be applied to a scan of the same form (`layoutKind = pdf_overlay` in DC) — the fractions model
  makes that a page-geometry mapping, not a redesign.
* Until DC merges: layouts are Phase 3; Phases 1–2 place fields on instances only. `formDefinitions`
  and `dispatchTemplates` are **not** used (unread today; using them would revive a third template
  concept the DC design retires).

---

## 13. Authorization model

New permissions in `recordsAuthorization.ts` (`attest.*`), mapped from procedure names in
`OPERATIONAL_PROCEDURE_PERMISSIONS`, inventory and count pins updated in the same PR:

| Permission | Class | Roles (initial) | Rule |
|---|---|---|---|
| `attest.read` | read; evidence read categories apply | office, dispatcher, safety, management, auditor, driver (own) | cross-org → NOT_FOUND |
| `attest.template.manage` | SENSITIVE | management, office | Phase 3 |
| `attest.document.open` | SENSITIVE | office, dispatcher, safety, driver (for own job's scans) | the act that fixes a hash |
| `attest.field.place` | SENSITIVE | same as open; only while `open` and no field completed | |
| `attest.signer.assign` | SENSITIVE | office, dispatcher, safety | |
| `attest.sign_own` | UNIVERSAL, self-scoped, SENSITIVE | every authenticated user | signer row must resolve to `ctx.user.id` |
| `attest.witness` | SENSITIVE | driver, office, safety | for `named_witnessed` signers only |
| `attest.decline_own` | UNIVERSAL | | |
| `attest.finalize` | SENSITIVE | office, safety, management | idempotent |
| `attest.void`, `attest.supersede` | SENSITIVE | management, office; **not the same role that finalized in the same session** (two-person rule, the audit-package release precedent) | reason ≥ 10 chars |
| `attest.export` | SENSITIVE | office, management, auditor | writes `evidenceAccessEvents.exported` before serving |
| `attest.verify` | read | auditor, management, safety | |
| `attest.saved_mark.manage_own` | UNIVERSAL, SENSITIVE | Phase 4 | |
| `portal.attest.read`, `portal.attest.sign` | external; sign SENSITIVE | customer (and facility) identities | binding decides scope; the request never says whose document |

Fail-closed checks in `attestService`, in order: org scope → revision state → signer resolution
(**signing another person's assigned field is `FORBIDDEN` with `WRONG_SIGNER`**, a rejected-session
row and an event) → field assignment → auth method vs `requiredAuth` → device attestation when
claimed → evidence seals verified. Reads of artifacts resolve the object to its revision, then the
revision to its org, then mint a signed URL (`storageGetSignedUrl`), never the reverse.

---

## 14. Finalization, revision, void, supersede

```
open ──(fields_placed, signers assigned)──▶ open ──(sessions)──▶ completed ──finalize──▶ finalized
  │                                            │                                          │
  └──── void (reason) ─────────────────────────┴─── void (reason) ────▶ voided             │
                                                                                          ▼
                                            supersede (reason) ──▶ superseded ──▶ new revision n+1 (open)
```

* **Open**: fields and signers may change until the first mark; afterwards field geometry is frozen
  (a change is a new revision).
* **Completed**: every `required` field completed (and in order when `completionRule` says so).
  Optional fields may stay `pending`; the receipt lists them as `not_completed_optional`.
* **Finalized**: §8.4; immutable by trigger; the only later writes are `supersededByRevisionId` and
  read/export events.
* **Void**: allowed from `open` and `completed`; **not** from `finalized` (a finalized document is
  superseded or amended, never voided — the invoice-void precedent keeps the number and the record).
  Voided revisions keep every mark and event.
* **Supersede**: creates revision n+1 for the same `instanceRef` with a new `revisionHash` (the
  corrected document), `supersedesRevisionId` set, fields copied as `pending` (marks are **never**
  carried forward — a signature is of a hash), event `document_superseded` on the old chain and
  `document_created` on the new one. When the subject is a register row, the domain's own supersede
  (`commercialOffice.documentSupersede`, `fieldTicketRevisions` amendment) is what produces the new
  hash; Sign & Attest observes it. A ticket amended after signature already sets
  `amended_after_signature`; the new R2 revision is the only place a new signature may go.
* **Amendment vs replacement** are the domain's words (DC §6.6 `amend_with_reason` /
  `immutable_supersede`); in Sign & Attest both are a superseding revision, and the reason travels in
  `detailJson`.

---

## 15. Test plan (proposed; names follow the repository's suites)

Pure (`server/_core/attest/*.test.ts`): binding rules per subject type; state machines; completion
rule (required/optional, ordered, groups); stroke document validation and byte-identical serialization
for touch / pen / mouse samples; SVG and PDF-path rendering determinism; payload canonicalization
equals the client's `canonicalJson` for the same object; event-chain build and verify; receipt
manifest determinism; biometric-pattern scan extended.

Database (`server/attest*.db.test.ts`, `server/tenantScopeAttest.db.test.ts`):

| Requirement | Test |
|---|---|
| tenant isolation / cross-org refusal | org A opens; org B reads revision, fields, sessions, artifacts, events, verify → NOT_FOUND; B's device cannot submit against A's revision |
| signer impersonation refusal | office user calls `sign_own` for a field assigned to another user → FORBIDDEN `WRONG_SIGNER`, rejected-session row, event |
| wrong-signer refusal (portal) | identity X signs a field assigned to identity Y on the same account → NOT_FOUND/FORBIDDEN, no mark |
| document-revision mismatch | session with stale `revisionHashAtStart` → `REVISION_MISMATCH`; marks retained as evidence; no field completed |
| signature bound to correct revision | payload hash recomputed from the row equals stored; changing the register row's bytes makes `verify` fail |
| immutable finalized artifact | direct `UPDATE attestDocumentRevisions … WHERE state='finalized'` → SQLSTATE 45000; `UPDATE/DELETE attestEvents` → 45000 |
| superseding instead of editing | supersede creates n+1, old row unchanged byte-for-byte (hash of row), marks not carried |
| offline signing | session envelope built with the memory adapters, signed with a test P-256 key, submitted → accepted; `capturedOffline = true`, skew recorded |
| offline synchronization | marks via `receivePackage` then `submitSession`; unsealed mark → refused |
| duplicate synchronization / idempotency | same envelope twice → `alreadyRecorded`, one session, one event set |
| conflicting offline signatures | two devices, same field → first wins, second `FIELD_ALREADY_COMPLETED`, both marks retained |
| voided document refusal | void then submit → `DOCUMENT_VOIDED` |
| required-field enforcement | finalize with a pending required field → PRECONDITION_FAILED naming the field |
| optional-field behaviour | finalize with pending optional fields → succeeds; receipt lists them |
| multiple initials on one document | seven line fields, one signer, one session; proof lists seven `acknowledgedLines` |
| different signer roles on one document | driver + consultant + supervisor; each may complete only their fields; completion requires all |
| finger/stylus signature serialization | pointerType touch and pen fixtures → same schema, `inputKind` recorded, byte-identical hash on client and server |
| signed-artifact fingerprint verification | finalize; tamper stored bytes in a test bucket → `verify` reports `hash_mismatch` and emits `records.evidence_integrity_failed` |
| authorization for viewing/exporting | export without `attest.export` → FORBIDDEN and an audit decision row; with it → `evidenceAccessEvents.exported` written **before** the URL is minted |
| device attestation | `device_auth` without attestation → BAD_REQUEST; attestation under `session_login` → BAD_REQUEST; revoked device → `DEVICE_NOT_ACTIVE` |
| concurrent finalize | two callers → exactly one finalized (award-concurrency pattern) |
| producer integration | `closeout.sign.witness` writes `attestSessionRef`; historical rows NULL |
| drift guards | procedure count pins, inventory, `engineReachability` (attest modules reached from `attestRouter`), column parity, reserved-word audit, `current-state.sh` regenerated |

---

## 16. Migration sequencing (refreshed scan, 2026-09-24)

Scan (the register's command over every remote branch with a merge base): main head `0174`; claims
`0170` (auth-workspace, work-calendar), `0172`–`0175` (training-academy), `0175`–`0177`
(driver-portfolio ×2, PR #16), `0178`–`0181` (document-control-architecture, no PR), `0179`
(eld-compliance-intelligence, no PR; **and** PR #17 `0179_trip_stop_provenance` — a new three-way
collision on `0179`). Two branches with **unrelated history** (`claude/mobile-hardware-scanner-mzp1e1-v2327`,
`feature/tenant-scope-foundation`) hold `0168`/`0169`/`0171`–`0173` files on a different lineage; the
register's command cannot see them (`no merge base`) and they cannot merge without renumbering.
Register updated in `docs/architecture/MIGRATION_COLLISION_REGISTER.md`.

**Sign & Attest provisionally claims `0182`–`0184`** (first numbers no branch holds), to be re-scanned
at each PR:

| Slot | Content | Notes |
|---|---|---|
| `0182_sign_attest_foundation.sql` | `attestDocumentRevisions` (with generated `finalizedKey`), `attestFields`, `attestSigners`, `attestSigningSessions`, `attestMarks`, `attestArtifacts`; `fieldTicketSignatures.attestSessionRef`; `evidenceRelationships.entityType` + `attestRevision`, `attestMark` | plain DDL; MariaDB `PERSISTENT` for the generated column (0021 precedent) |
| `0183_sign_attest_events.sql` | `attestEvents` table | plain DDL |
| `0184_sign_attest_guards.sql` | `attestEvents_no_update`, `attestEvents_no_delete`, `attestDocumentRevisions_final_guard` | **trigger DDL and nothing else** (apply-migrations DELIMITER rule) |
| later | `attestFieldLayouts` (+ released guard), `attestSavedMarks` | Phase 3/4, numbered at their PR |

Reserved `0016`/`0017` untouched; `0157` (used twice historically) not reused.

---

## 17. Phased implementation plan (summary; detail in the companion plan)

| Phase | Name | Delivers | Depends on |
|---|---|---|---|
| **1** | Foundation on the spine | `0182`–`0184`; pure engines; `attestService` open/assign/start/submit(online)/finalize/void/supersede; `attestRouter` (staff) + portal read; `recordSignature` as producer; proof contract; tests | D-01 |
| **2** | The pad and the offline session | `SignaturePad` (pointer events, pressure, DPR), stroke document, SVG render, `LocalSignableRevision`, `LocalAttestSession`, `attest.submitSession`, pre-departure item, device-attested marks | 1; native shell status unchanged (memory adapters prove it in Node) |
| **3** | Templates, layouts, PDF | `attestFieldLayouts` over DC template revisions; vector marks in `ticketPdf`; JPEG page XObjects; overlay onto imported PDFs (D-02); outbox consequences; portal signing UI | 2; Document Control DC1/DC2 |
| **4** | Adoption and reach | saved marks with re-authentication (`mark_adopted`); academy/consents/approvals as producers; invoicing blocker from proof; portfolio event on finalize; field-discovery proposals (post-moratorium, model-backed) | 3; PR #16 |

---

## 18. Missing primitives

1. **A drawn mark store** — none (§1.3). Supplied by `attestMarks` + vault records.
2. **A pointer-event signature pad** — none under `client/src`. Phase 2.
3. **Image or vector drawing in the PDF renderer** — none; `renderPdf` is text-only. Phase 3, D-02.
4. **Per-record server versions for sync conflict detection** — stubbed (`SERVER_VERSIONS`). Sign &
   Attest binds by hash instead and does not use `recordUpdates`.
5. **Multi-page capture upload** — `files[0]` only. Needed for multi-page signable scans (DC3 or earlier).
6. **A pre-departure manifest reached from a router** — `preDepartureCache` is declared unwired;
   `signable_document` items need the HS1 seam.
7. **An exported canonicalizer for device-signed payloads** — `deviceSignature.canonical` is private;
   export it as `canonicalAttestPayload` rather than adding a fifth `canonicalJson`.
8. **A native shell** — not implemented (`capacitor.ts` throws). Offline signing is proven with the
   memory adapters in Node, as the rest of the field runtime is today.

---

## 19. Owner decisions

| # | Decision | Recommended default |
|---|---|---|
| D-01 | Does Phase 1 proceed under the SPINE moratorium? It is a new engine that is reached on day one by the on-spine `fieldTicket` close (it replaces the `drawn` label) | Proceed with Phase 1 only, scoped as in the companion plan; Phases 2+ wait for the spine plan's item 1–2 or an explicit lift |
| D-02 | PDF: extend the hand renderer (vector marks + JPEG pages, no dependency) now; add `pdf-lib` for overlay onto imported PDFs later, decided jointly with Document Control DC2 | Yes / later |
| D-03 | Field coordinates as page fractions (recommended) vs PDF points | Fractions |
| D-04 | Consent statement text and versioning: one LeaseOS sentence in `shared/attest.ts`, tenant-overridable later | LeaseOS sentence v1 |
| D-05 | `named_witnessed` signers allowed in Phase 1 (paper/in-person consultants without a portal identity) | Yes, with witness permission and visible marking |
| D-06 | Saved signatures/initials at all (Phase 4) | Defer; design ready |
| D-07 | Whether `attest.void`/`attest.supersede` require a different user than the one who finalized | Yes (two-person) |
| D-08 | Whether the closeout producer creates one `initials` field per presented line in Phase 1 or only the whole-ticket signature | Whole-ticket signature in Phase 1; per-line initials when the closeout UI presents lines |

---

## 20. Contradictions between the request and existing invariants (stated, not worked around)

1. **"Add a subsystem" vs the SPINE moratorium** ("no new engines until this path is wired"). Not
   silently satisfiable. D-01.
2. **"DocumentTemplate / DocumentInstance as Sign & Attest entities" vs Document Control owning them**
   on an unmerged branch. Resolved by not defining them here and anchoring to a revision hash; the
   template layer is a string reference until DC merges.
3. **"Fields defined on templates" vs `formDefinitions` / `dispatchTemplates` existing unused.** Using
   them would be the third template concept the DC design retires. Not used.
4. **The 10-minute device-signature freshness rule** (`checkSignatureAttestation`, `SIGNATURE_STALE`)
   vs offline signing hours before sync. Resolved with two signatures (capture-time binding, fresh
   send-time envelope) — the same split `sync.receivePackage` already makes for evidence.
5. **`signatureMethod = drawn`** conflates input with authentication and, today, stores no drawing.
   Kept as historical vocabulary; new rows use `inputKind` + `authMethod`; `fieldTicketSignatures`
   rows written by the producer will carry `drawn` **and** a session pointer, so the method finally
   means what it says.
6. **"Offline sync via the existing outbox"** — the existing `recordUpdates` conflict path is a stub
   with an in-memory registry. The design does not depend on it; it states so instead of appearing to
   reuse it.
7. **Academy's FNV `stableHash`** is not a fingerprint. When academy becomes a producer (Phase 4) its
   `payloadHash` stays FNV for its own row and the SHA-256 chain lives in Sign & Attest; no historical
   row is rehashed.
8. **"Tenant isolation" vs `orgRef` NULL = single tenant.** New tables follow the NULL rule; the tests
   prove isolation for two real orgs and the single-tenant fallback, as `tenantScope*.db.test.ts` do.
   The roadmap item "prove tenant isolation" (`ROADMAP_2026-09-21.md` #3) remains open repository-wide.
9. **Four `canonicalJson` implementations.** Pre-existing duplication; Sign & Attest adds none and
   uses the device-compatible one for anything signed.
10. **Migration numbers**: `0179` is now claimed three ways (DC branch, ELD branch, PR #17); this
    branch claims `0182`–`0184` and records it. Two unrelated-history branches hold colliding low
    numbers the register cannot scan.

---

## 21. Recommended first implementation checkpoint (SA1)

**"The drawn signature exists, is bound to a hash, and cannot be edited."** One PR, reviewable alone:

1. `0182`–`0184` as in §16.
2. `shared/attest.ts` (vocabularies, stroke document schema v1, consent text v1) and the pure engines
   `attestBinding`, `attestState`, `attestPayload` (no strokes rendering yet beyond validation).
3. `attestService`: `openForSubject(field_ticket_revision | evidence_record)`, `placeFields`,
   `assignSigner`, `submitOnline` (session_login / portal_link / witnessed / paper_scan; `device_auth`
   accepted with an attestation over the mark payload — no client change needed to test it),
   `finalize` (receipt + register row; PDF deferred: `finalized_pdf` artifact kind exists, Phase 3
   fills it), `void`, `supersede`, `verify`, `attestProofFor`.
4. `attestRouter` under `roleProcedure`; `portal.attestRead` / `portal.attestSign` under
   `externalProcedure`; permissions, inventory, count pins.
5. `recordSignature` becomes the first producer (§11.1) — the on-spine wiring that keeps
   `engineReachability` honest.
6. `evidenceRelationships` enum extension; `EvidenceRecordType` additions; biometric pattern additions.
7. Tests from §15 except the pad/offline rows, which belong to SA2.

Out of SA1: the pad UI, offline envelope, templates/layouts, PDF marks, saved marks, outbox consumers,
academy/consent producers, invoicing blockers, portfolio events. Each is named in the companion plan
with its dependency.
