# Client services portal — checkpoint reports

Companion to `CLIENT_SERVICES_PORTAL_PLAN.md`. One section per checkpoint, written when the checkpoint's commit was
made. Counts are read from the tree at that commit; test results are from a run against MariaDB 10.11 in the build
container. Commit SHAs are filled in after each commit.

## CP1 — survey and plan

Files: `docs/register/CLIENT_SERVICES_PORTAL_PLAN.md`. No code. Commit `c4aa8c4`.

## CP2 — data model, tracking-token gate, tenant isolation

**Migration:** `drizzle/0175_client_services_portal.sql` (next free number on `main` and on every open branch;
registered in `docs/architecture/MIGRATION_COLLISION_REGISTER.md`). Additive only.

**Columns added to existing tables:** `jobs.customerAccountId`; `customerAccounts.locationSharing`;
`fieldTickets.{billingState, billingVersion, customerPoNumber, finalizedAt, finalizedByUserId, finalRevisionId,
voidedAt, voidedByUserId, voidReason}`; `fieldTicketLines.{customerVisible, loadId, disposalTicketId, unitId,
periodStartAt, periodEndAt, addedByUserId, amendsLineId}`; `externalAlertPreferences.eventKind` enum extended with six
customer-safe kinds.

**Tables added (5):** `jobTrackingLinks`, `jobTrackingLinkAccess`, `customerDocumentReleases`,
`customerTicketActions`, `customerAuditEvents`. Tables 410 → 415; parity 415/415.

**Gate:** `trackingProcedure(name)` in `server/_core/trpc.ts` — `x-tracking-token` → SHA-256 → one link → status /
expiry / access-limit check → the job must still be in the link's organization (fail closed) → the link's scope must
hold the permission → `authorizationDecisions` row + `jobTrackingLinkAccess` row (address stored only as a keyed hash)
→ `ctx.tracking`. Sensitive tracking permissions (`tracking.act`, `tracking.documents`) refuse when the audit row
cannot be written. Tokens of the wrong shape are refused before hashing. Refusals never say whether a job exists.

**Permissions:** `client_services.read`, `client_services.link.manage` (sensitive), `client_services.document.release`
(sensitive), `client_services.ticket.manage` (sensitive). Granted: dispatcher (read, links, releases), office /
management / controller (all), bookkeeper (read, tickets), auditor (read). Tracking universe: `tracking.read`,
`tracking.loads`, `tracking.documents`, `tracking.billing`, `tracking.act`, keyed to the link's scope.

**API added:** `clientServices.{jobCustomerAssign, trackingLinkCreate, trackingLinkRevoke, trackingLinkRegenerate,
trackingLinkConfigure, trackingLinks, auditTrail, auditVerify}` (roles); `tracking.resolve` (link). Link refs come
from the `TL` tracking sequence. The token and the QR payload (the URL) are returned once, at create and regenerate;
only the hash is stored, so no procedure can return them later.

**Audit:** `server/_core/customerAudit.ts` — append-only, hash-chained per organization, chain tail read under
`FOR UPDATE` inside the caller's transaction; `verifyCustomerAuditChain` re-walks it and names the first break.

**Tests added:** `server/trackingLinks.db.test.ts` (10 cases): token shape and hashing; every refusal reason; live
window under each rule; strict scope parsing and QR payload; audit hash sensitivity; and, through the gate across two
organizations: mint / resolve / count / log, forged / absent / malformed tokens, access limit, disabled, expired,
cross-tenant list / configure / revoke / regenerate refused as not-found, regenerate supersedes, revoke fails closed,
ledger order and verification, tamper detection, job moved out of tenant fails closed, customer assignment scoped and
audited, role denial recorded. Guards updated: `procedureAuthorization.test.ts` (new router in the census, 642
operational, tracking block), `operationalApiAuthorization.test.ts` (642), `crossLayerIntegrity.test.ts` (705 paths),
`_core/env.test.ts` fixture; gate step 7d; `current-state.sh` tracking row; inventory rows.

**Test results:** new suite 10/10; guard suites re-run green (procedureAuthorization, operationalApiAuthorization,
crossLayerIntegrity, tenantIsolation, columnParity, documentationTruth, engineReachability, commercialPortal,
customerTransaction, recordsAuthorization, reservedWordColumns, migrationLedger, roleIsolation, authArchitecture,
registerClaims, spineWiringPlan); `tsc` clean; test-file type errors 0.

**Decisions:** the billing lifecycle lives on `fieldTickets` (no second ticket); the QR payload is the URL and is
issued only with the token; link tenancy is explicit (`orgRef`) and re-checked per request rather than inferred.

**Security implications:** a link can never reach a second job (there is no job parameter); a job that leaves the
organization makes its links dead; access limits are enforced atomically; refusals are logged against the link.

**Unresolved risks:** rate limiting of token guessing relies on 256-bit tokens and the decision log, not on a counter
per address; email/SMS delivery of the `tracking_link_created` alert is still in-app only (the queue's other channels
exist).
