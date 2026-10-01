# LeaseOS Sign & Attest — Implementation plan

**Against:** `main` = `6f52b57` (`v23.25`, migration head `0174`). Companion to
`docs/sign-attest/SIGN_ATTEST_DESIGN.md`; section numbers below refer to it. No code in this checkpoint.

The order is chosen so that every checkpoint ends with an engine that is **reached from production**
(`server/engineReachability.test.ts`), a database that passes column parity, and a signature that is
better evidence than the one before it. The pad is deliberately last among the foundation items: a
beautiful drawing on top of a mutable row is the failure this plan exists to avoid.

---

## Checkpoint SA1 — the drawn signature exists, is bound to a hash, and cannot be edited

**Status: built 2026-10-01** on `main` `c3f088b` under the owner's SA1 ruling
(`docs/sign-attest/SA1_OWNER_RULING.md`); migrations `0214`–`0216` (not `0182`–`0184`: the slots moved, see
the register); record in `docs/sign-attest/checkpoints/SA_IMPLEMENTATION_RECORD.md`. Two details differ
from the plan below as written: the receipt lives on the artifact row as canonical JSON (storage is
unconfigured in the gate and the receipt is self-verifying by hash), and `attest.verify` is mapped to
`attest.read` rather than a permission of its own.

**Gate:** owner decision D-01 (moratorium). **Depends on nothing unmerged.**

### Migrations (re-scan the register at PR time; provisional numbers)

| File | Contents |
|---|---|
| `drizzle/0182_sign_attest_foundation.sql` | `attestDocumentRevisions` (incl. `orgScopeKey`, generated `finalizedKey` PERSISTENT + unique), `attestFields` (unique `(revisionId, fieldKey)`, unique `completedMarkId`), `attestSigners`, `attestSigningSessions` (unique `sessionRef`; unique `(fieldDeviceId, sessionRef)`), `attestMarks` (unique `markRef`), `attestArtifacts`; `ALTER TABLE fieldTicketSignatures ADD attestSessionRef varchar(120) NULL`; `ALTER TABLE evidenceRelationships MODIFY entityType enum(… + 'attestRevision','attestMark')` (restating the full list — the parity check compares against `schema.ts`) |
| `drizzle/0183_sign_attest_events.sql` | `attestEvents` (unique `(revisionId, sequence)`, unique `eventRef`, index `(revisionId, eventType)`) |
| `drizzle/0184_sign_attest_guards.sql` | trigger-only: `attestEvents_no_update`, `attestEvents_no_delete`, `attestDocumentRevisions_final_guard` (BEFORE UPDATE: when `OLD.state='finalized'` and any column other than `supersededByRevisionId` changes → `SIGNAL SQLSTATE '45000'`) |

Header comment of `0182` records the slot scan exactly as `0174` and DC `0178` do. `drizzle/schema.ts`
gains the tables in the same commit; `relations.ts` unchanged (the repository does not use it).

### Code

| File | What |
|---|---|
| `shared/attest.ts` | `ATTEST_FIELD_TYPES`, `ATTEST_MARK_KINDS`, `ATTEST_INPUT_KINDS`, `ATTEST_AUTH_METHODS`, `ATTEST_EVENT_TYPES`, `ATTEST_REJECTION_CODES` (zod enums); `CONSENT_TEXT_V1` + `consentTextHash()`; `StrokeDocumentV1` zod schema + `serializeStrokeDocument()` (byte-stable) |
| `server/_core/attest/attestBinding.ts` | pure: `revisionHashFor(subject)` per subject type (given the loaded subject and the stored-bytes hash), `bindingVerdict({ session, revision })` → ok / `REVISION_MISMATCH` / `DOCUMENT_VOIDED` / `DOCUMENT_FINALIZED` |
| `server/_core/attest/attestState.ts` | pure: field / signer / revision transitions; `completionVerdict(fields, rule)`; `raceVerdicts` (the §6.5 table as code) |
| `server/_core/attest/attestPayload.ts` | pure: `markPayload()`, `sessionPayload()` (through `canonicalAttestPayload` exported from `deviceSignature.ts`), `eventHash(prev, event)`, `verifyChain(events)`, `receiptManifest()` (via `auditPackage.canonicalJson`) |
| `server/_core/deviceSignature.ts` | export `canonicalAttestPayload` (the private `canonical`); extend `BIOMETRIC_MATERIAL_PATTERNS` with `velocity`, `dynamics`, `biometricScore`, `template` |
| `server/_core/evidenceSeal.ts` | `EvidenceRecordType` + `signature_strokes`, `signature_render`, `signed_artifact`, `attest_receipt`; `EvidenceEntityType` + `attestRevision`, `attestMark` |
| `server/_core/attest/attestService.ts` | transactional: `openForSubject`, `placeFields`, `assignSigner`, `startSession`, `submitOnline`, `declineSession`, `finalize`, `void`, `supersede`, `verify`; every write appends `attestEvents` under `SELECT … FOR UPDATE` on the revision and calls `emitDomainEvent(tx, …)` for the §9.1 outbox events; every refusal is a row + code |
| `server/_core/attest/attestProof.ts` | `attestProofFor(db, { subjectType, subjectRef })` (§11.2) |
| `server/attestRouter.ts` | `roleProcedure` surface: `attest.open`, `attest.placeFields`, `attest.assignSigner`, `attest.start`, `attest.submit` (own), `attest.witness`, `attest.decline`, `attest.finalize`, `attest.void`, `attest.supersede`, `attest.read`, `attest.readEvents`, `attest.verify`, `attest.exportArtifact` (writes `evidenceAccessEvents.exported` then mints a signed URL), `attest.proof` |
| `server/portalRouter.ts` | `portal.attestRead`, `portal.attestSign` under `externalProcedure`; `EXTERNAL_PROCEDURE_PERMISSIONS` + `portal.attest.read`, `portal.attest.sign` (SENSITIVE) |
| `server/_core/recordsAuthorization.ts` | `attest.*` permissions (§13), roles, `SENSITIVE_PERMISSIONS`, `UNIVERSAL_PERMISSIONS` (`attest.sign_own`, `attest.decline_own`), `OPERATIONAL_PROCEDURE_PERMISSIONS` entries |
| `server/closeoutRouter.ts` | `recordSignature` becomes a producer inside its transaction (§11.1); writes `attestSessionRef`; for `paper_scan` the scan's evidence record is the mark's `renderedEvidenceRecordId` |
| `server/routers.ts` | mount `attestRouter` |
| `PROCEDURE_AUTHORIZATION_INVENTORY.md`, `server/procedureAuthorization.test.ts`, `scripts/ci-gate.sh` (pins), `LEASEOS_CURRENT_STATE.md` (regenerated by `scripts/current-state.sh`, never edited by hand) | counts |

Not in SA1: `attestStrokes.ts` beyond schema validation (rendering is SA2), any client code, PDF.

### Tests (SA1)

`server/_core/attest/attestBinding.test.ts`, `attestState.test.ts`, `attestPayload.test.ts`,
`server/attestService.db.test.ts`, `server/tenantScopeAttest.db.test.ts`, `server/attestApi.test.ts`
(router wiring, permission classes), additions to `deviceSignature.test.ts` (biometric patterns over
the new tables), `siteCloseout.test.ts` (producer writes the pointer; historical rows NULL),
`columnParity` and `reservedWordColumns` pass by construction. Rows of the §15 table covered:
isolation, cross-org, impersonation, wrong signer, revision mismatch, binding, immutability
(45000 on both tables), supersede, required/optional, multiple initials, multiple roles, artifact
verification (receipt only), export authorization, device attestation both directions, concurrent
finalize, idempotent finalize, producer integration, drift guards.

### Definition of done

`bash scripts/ci-gate.sh` green on a clean MariaDB 10.11; `engineReachability` count unchanged
(attest engines reached via `attestRouter` and `closeoutRouter`); inventory and current-state
regenerated; `docs/architecture/MIGRATION_COLLISION_REGISTER.md` refreshed with the final numbers.

---

## Checkpoint SA2 — the pad and the offline session

**Depends on:** SA1. **Does not depend on** the native shell (memory adapters prove it in Node, as
the rest of the field runtime is proven today).

| Area | Work |
|---|---|
| `client/src/attest/SignaturePad.tsx` | Pointer Events (`pointerdown/move/up/cancel`, `getCoalescedEvents`), `pointerType` → `inputKind`, pressure/tilt when present, DPR-aware canvas, orientation, clear/undo, accessibility (keyboard fallback to `typed_name` for `printed_name`; the pad itself is drawn-only), emits `StrokeDocumentV1` + SVG via `attestStrokes.renderSvg` |
| `server/_core/attest/attestStrokes.ts` + `shared` | `validate`, `normalise` (coalesce < 0.5 px), `renderSvg` (deterministic), `toPdfPathOps` (used in SA3) |
| `client/src/runtime/contracts.ts` | `LocalSignableRevision`, `LocalAttestSession` record types on `LocalStore`; `Transport.submitAttestSession` |
| `client/src/runtime/syncEngine.ts` | marks as `LocalCapture` kind `"signature"` with two files; session envelope after its marks; fix `files[0]` to `files[]` for this kind (or take the general fix if DC3 has landed) |
| `server/deviceRouter.ts` (or `attestRouter`) | `attest.submitSession` — exact-wire envelope, nonce, two-signature verification, §6.3 order, per-mark verdicts, `handleSyncRefusal`-compatible codes |
| `server/_core/preDepartureCache.ts` | `CacheItemKind = "signable_document"`, `required_on_site` (engine stays declared-unwired until HS1 wires it; the manifest builder gains the item) |
| Screens | field placement on a page image (fractions), signing screen (pad per field, consent, decline), staff review of a revision's events |
| Tests | offline signing, offline synchronization, duplicate sync, conflicting offline signatures, voided-while-offline, device revoked/clock wrong between capture and sync, finger/stylus/mouse serialization (client fixtures hashed identically on the server), pad `.dom.test.tsx` with synthetic pointer events |

---

## Checkpoint SA3 — templates, layouts, PDF

**Depends on:** SA2; Document Control DC1/DC2 for template revisions; owner decision D-02.

| Area | Work |
|---|---|
| `018x_sign_attest_layouts.sql` | `attestFieldLayouts` + released-immutable trigger (trigger-only file) |
| `attest.open` from a template | copy layout fields with `layoutRef`; `templateRevisionRef` string reference to DC `documentTemplateRevisions.revisionRef` |
| `server/_core/ticketPdf.ts` | vector path operators for marks; `/DCTDecode` JPEG XObjects for scanned pages; renderer key/version stamped on artifacts; deterministic bytes test |
| Overlay onto imported PDFs | `pdf-lib` if D-02 says yes (one decision with DC2), else refused with a named reason |
| `attest.finalize` | fills the `finalized_pdf` artifact; register row delivered through `commercialDocumentDeliveries` |
| Outbox consequences | `attest.signing_requested` → notification/task (dedupe key), `attest.document_finalized` → producer filing |
| Portal | signing UI for external identities; `portal.attest.*` reaches parity with `portal.fieldTicketSign` |
| Tests | signed-artifact fingerprint verification with tampered bytes; PDF determinism; layout immutability; template-anchored field mapping onto a rescaled scan |

---

## Checkpoint SA4 — adoption and reach

**Depends on:** SA3; PR #16 (portfolio) for the wallet event; moratorium status for model-backed field discovery.

* `attestSavedMarks` (owner `userId`, sealed stroke record, `status`), `attest.saved_mark.manage_own`,
  adoption = a fresh session + `mark_adopted` under the signer's own authentication; never applied by
  another user.
* Producers: `academyCertificateSignatures`, `complianceConsents`, `programAcknowledgements`,
  `competencySignoffs`, `commercialApprovalSignatures` (decision as `approval` field).
* Invoicing: `ticket_lines_not_acknowledged` blocker from `attestProofFor` (invoicing's change).
* Portfolio: `driverPortfolioEvents.document_signed` written by the portfolio service on
  `attest.document_finalized`.
* Field discovery on scans as `assistantProposals` (post-moratorium).
* Print of signed artifacts as a `print` delivery with `evidenceAccessEvents.printed` (aligns with the
  stale scanner branch's intent, renumbered).

---

## Cross-cutting rules for every checkpoint

1. The acting organization comes from `resolveActingScope`; input never names it; cross-org reads
   answer NOT_FOUND.
2. Every hash is `evidenceSeal.sha256`; every signed payload goes through `canonicalAttestPayload`.
3. Every state change is one `attestEvents` row and, where another domain must react, one
   `emitDomainEvent` in the same transaction.
4. Refusals are rows with codes; prose is for people.
5. No biometric material, no bearer URLs, no email addresses in receipts.
6. Migration numbers are claimed against a fresh scan and recorded in the register at PR time; never
   assumed from this document.
7. `LEASEOS_CURRENT_STATE.md` is regenerated, not edited; `docs/REMAINING_BUILD_REGISTER.md` rows
   claiming SA work name the migration and the commit (its claims are checked by
   `server/registerClaims.test.ts`).
