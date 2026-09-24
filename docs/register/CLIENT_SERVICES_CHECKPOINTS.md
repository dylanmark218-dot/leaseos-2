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

## CP3 — customer-safe tracking API, explicit DTO, leakage tests

**Files:** `server/_core/customerJobView.ts` (pure: status vocabulary, location projection with staleness, job DTO,
loads, open ticket), `server/customerJobProjection.ts` (loads canonical rows and builds the DTOs; shared with the
portal in CP7), `server/customerDocuments.ts` (resolves a release to catalogue bytes and verifies the hash),
`server/trackingRouter.ts` (+5), `server/clientServicesRouter.ts` (+3 release procedures), `server/_core/trackingLinks.ts`
(scope gains `unit` and `operator` identity flags).

**Migrations / tables:** none (CP2's model covers it).

**API added:** `tracking.{status, loads, documents, documentDownload, openTicket}` (link);
`clientServices.{documentRelease, documentWithdraw, documentReleases}` (roles). Release refs come from the `REL`
tracking sequence; a release carries the catalogue record's own number and never mints another.

**Status vocabulary:** Scheduled · Dispatched · En Route · On Location · In Progress · On Hold · Transporting ·
At Disposal · Returning · Attention · Completed · Cancelled · Unknown. Evidence order: open safety event → open ticket
event → signed site → `jobs.status` → `dispatchPostings.planningState`. Nothing new is stored; the projection reads.

**Location:** three modes on the link (`none | approximate | live`); approximate rounds to two decimals and drops
heading and speed; a fix older than 15 minutes is presented as stale with its age; live status, position and ETA end
under the link's completion rule while documents and the ticket remain.

**Tests added:** `server/customerJobView.test.ts` (10: vocabulary mapping, modes and staleness, loads, open ticket
estimate / finalized / invoiced distinction and hidden lines, the smuggled-private-data leakage test);
`server/trackingApi.db.test.ts` (3: through the gate — projection from canonical rows with a private-data sweep,
location by link mode, identity flags, stale fix, loads, unreleased → not found, release / download / hash check /
tamper refused / withdraw / re-release, scope refusals by name, open ticket with internal line hidden, ledger; live
window after completion). Guards: 645 operational, 6 tracking, 713 mounted paths.

**Test results:** 13/13 new; guards green; `tsc` and test-file typecheck clean.

**Decisions:** the DTO's input type has no field for private data, and the leakage test smuggles it in anyway to prove
the builder projects by name rather than by omission. The customer reference is the ticket's PO, else its AFE.

**Security implications:** a document is served only through a current release on the caller's own job, after a byte
hash check; every list, download and ticket view is on the ledger with the link and a hashed address.

**Unresolved risks:** `jobs.eta` is a free-text column today; the DTO passes it through only while live tracking is on.
Position comes from trip breadcrumbs only (no telematics last-known table exists).

## CP4 — tracking UI (`/t/:token`)

**Files:** `client/src/tracking/trackingClient.ts` (token from the path, in memory, sent as `x-tracking-token`),
`trackingViewModels.ts` (pure: tone, timeline rows, location line, load rows, ticket view with one labelled figure per
stage, refusal wording), `TrackingView.tsx` (presentational, phone-first), `TrackingPage.tsx` (container: resolves the
link and fetches only what it permits), `trackingFixtures.ts`; route `/t/:token` in `client/src/App.tsx`.

**Layout:** LeaseOS · Job #… · status chip with its basis · progress timeline · Driver/Unit · ETA/Location (stale
named in the headline) · Loads (n total / completed / active, each with ticket and destination) · Documents (download
buttons named by the record's own number) · Open Service Ticket (lines, then invoice / finalized / estimate figures,
each labelled; "Review ticket" only when the state allows it).

**Tests added:** `client/src/tracking/TrackingView.dom.test.tsx` (7: every state rendered; stale never shown as live;
estimate vs finalized vs invoice; identity flags hide the unit and operator; refusal wording never names a job;
download callback and failure alert; loading status), seven tracking surfaces in `client/src/a11y/a11y.dom.test.tsx`
(WCAG A/AA rules at three widths), `server/trackingViewModels.test.ts` (6). `server/a11yCoverage.test.ts` names the
container. No migration, no API change.

**Test results:** dom 7/7, axe 21/21 new cases, view-models 6/6, coverage / client-truth / cross-layer guards green;
`tsc` and test-file typecheck clean.

**Decisions:** the page decides nothing — every visibility choice arrives from the server in the DTO; the "Review
ticket" button is wired to a placeholder until CP6 lands the actions. No QR renderer is added (none exists in the
tree); the URL is the payload.

**Unresolved risks:** no browser end-to-end run exists in this container (the register's standing gap); the axe
rules that need a renderer (contrast, target size) are reported as not evaluated, as for every other screen.

## CP5 — open-ticket billing lifecycle

**Files:** `server/_core/serviceTicketBilling.ts` (pure: the state machine, finalize check, line-write rule, version
check, derived totals, frozen snapshot + hash), `server/serviceTicketService.ts` (stored: row-locked transitions,
`beforeLineWrite` / `afterLineWrite`, frozen revisions), `server/clientServicesRouter.ts` (+7), hooks in
`server/closeoutRouter.ts` (lineAdd is now one transaction under the ticket lock with an optional
`expectedVersion`; eventRecord opens a draft; sitePrepare presents; recordSignature accepts or disputes and writes the
`sign` action; decideLine disputes / accepts), `server/invoicingRouter.ts` (draft → INVOICED with `invoice_generated`;
void → back to FINALIZED), `server/portalRouter.ts` (passes the identity as the actor), `server/customerJobProjection.ts`
(the hash the customer decides against is computed live, the way the office presented it).

**Lifecycle:** DRAFT → OPEN → AWAITING_CUSTOMER_REVIEW → CUSTOMER_ACCEPTED | DISPUTED → FINALIZED → INVOICED; VOID from
any state before INVOICED; INVOICED → FINALIZED when the invoice is voided. Every transition is under `FOR UPDATE`,
bumps `billingVersion`, and lands on the ledger with from / to / version. Lines may be written in DRAFT, OPEN,
AWAITING_CUSTOMER_REVIEW and DISPUTED; never once the customer accepted a hash or the ticket is frozen. Finalizing an
unaccepted ticket needs `withoutCustomerAcceptance` and a reason, carried by the revision and the ledger. FINALIZED
writes a `final` revision (the enum's never-used kind) with the lines, totals and the site / signature hashes; an
amendment is a new line beside the frozen ones plus an `amendment` revision superseding the final by reference. After
INVOICED, corrections are the existing credit path.

**API added:** `clientServices.{ticketPresent, ticketReopen, ticketFinalize, ticketVoid, ticketAmend, lineUpdate,
ticketBilling}`. `closeout.lineAdd` gains `customerVisible`, `loadId`, `disposalTicketId`, `unitId`, `periodStartAt`,
`periodEndAt`, `expectedVersion` and returns `billingVersion` / `billingState` (additive).

**Tests added:** `server/serviceTicketBilling.test.ts` (5: every transition and refusal, finalize by name, line-write
rule, version check, derived totals, frozen hash reproducibility); `server/serviceTicketBilling.db.test.ts` (4: the
whole life through the real routers with tenant B refused at each step and the ledger in order; eight concurrent
`lineAdd` calls serialized with versions 2..9 each exactly once and totals adding up; dispute / re-accept / finalize
refusals / void). Guards: 652 operational, 720 mounted paths.

**Test results:** 9/9 new; the existing closeout, invoicing, portal, pricing and contract-terms suites re-run green
with the hooks in place; guards green; `tsc` and test-file typecheck clean.

**Decisions:** the open ticket is the field ticket (no second ticket); amounts live in pricing decisions and totals are
derived on every read; the presented hash is computed live rather than stored, so a line added after presentation
changes what the customer must accept.

**Security implications:** an accepted or frozen ticket cannot be edited through any router; a stale version is refused
by name; every state change carries the actor (user, portal identity or tracking link).

**Unresolved risks:** `eventRecord` opens a draft ticket without a version bump (events are not lines); the finalized
snapshot does not yet carry post-site supplement hours (R2), which the existing supplement revision holds separately.

## CP6 — customer actions: acknowledge, approve, dispute, comment, sign

**Files:** `server/customerActionService.ts` (one entry point for the link and, in CP7, the portal: ownership by job
or by account, state checks from the same projection the customer reads, hash guard, one transaction for the action
row, the ledger entry and the billing transition; signature through `recordSignature` as `portal_link`),
`server/trackingRouter.ts` (+5), `client/src/tracking/TrackingPage.tsx` ("Review ticket" approves or disputes).

**API added:** `tracking.{acknowledge, approve, dispute, comment, sign}` under `tracking.act` (sensitive: refused
when the audit row cannot be written). Approve requires the representative's name and the hash reviewed; a changed
ticket is refused and re-reviewed. Dispute requires a statement. Sign carries authorities, extra-work cents and the
post-site basis; authority is the signatory's on file when the link names a known contact, else `unknown`.

**Recorded per action:** action kind, timestamp, job, ticket, organization, link (or identity), representative name and
title, PO/reference, comment, the snapshot hash shown, signature name and payload hash, hashed client address, user
agent — on `customerTicketActions` (append-only) and on the hash-chained ledger.

**Tests added:** `server/customerActions.db.test.ts` (3): a read writes no action; a link without `act` and a link on
another job are refused by name; acknowledge; approve refused before presentation, with a stale hash and with a blank
name, then accepted with the PO stored; dispute needs a statement and moves the state; comment; every row carries the
link, the representative, a hashed address and never the address; reopen / correct / re-present / sign from the link
through the canonical chain with `withinAuthority: unknown`; a second signature refused; ledger order and chain;
the link's own access log counts refusals; closed and voided tickets refuse actions; a revoked link cannot act.

**Test results:** 3/3 new; guards, tracking, billing and closeout suites green; `tsc` and test-file typecheck clean.

**Decisions:** approve and dispute are the billing transitions themselves (one ledger entry each, with the action ref),
so a customer decision can never be recorded without moving the ticket, nor move it without being recorded.

**Unresolved risks:** the tracking page collects the review through browser prompts; a proper form arrives with the
portal screens. Drawn-signature capture (an image) is not collected from the link — the signature is the named
representative's electronic acceptance under the hash, as `portal_link` already is for identities.
