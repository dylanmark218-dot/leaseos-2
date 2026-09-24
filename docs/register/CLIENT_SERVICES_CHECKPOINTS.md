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

## CP7 — authenticated client portal

**Files:** `server/portalRouter.ts` (+10 external procedures; one rule for "the account's jobs": assigned to it, or a
field ticket bills to it), `client/src/portal/client/{clientViewModels.ts, ClientPortalView.tsx, ClientPortal.tsx,
clientFixtures.ts}`, routes `/client` and `/client/:section`.

**API added (external, scoped by the identity's account binding):** `portal.clientDashboard`, `portal.clientJobs`
(active / scheduled / completed / all), `portal.clientJob`, `portal.clientJobLoads`, `portal.clientTickets`,
`portal.clientTicketAct` (acknowledge / approve by hash / comment, under `portal.customer.decide`),
`portal.clientTicketDispute` (`portal.customer.dispute`), `portal.clientDocuments`, `portal.clientDocumentDownload`
(`portal.customer.documents`), `portal.clientContacts`. Invoices use the existing `portal.invoices`. Job detail is the
same projection the tracking link serves, under the account's `locationSharing` setting; live status ends 7 days after
completion.

**Navigation:** Dashboard · Active Jobs · Scheduled Jobs · Completed Jobs · Job Tracking · Loads · Disposal Tickets ·
Documents · Invoices · Open Billing · Contacts. The dashboard shows Active, Scheduled, Awaiting Your Action, Open
Tickets, Completed, Outstanding Invoices, Recent Documents. Every list arrives scoped; the shell names no account.

**Tests added:** `server/clientPortal.db.test.ts` (1 walk, two accounts in one organization and a third organization:
each identity sees only its account's jobs, by assignment and by ticket; a foreign job reference is "no such job on this
account"; location per account setting; tickets with internal lines hidden; dashboard counts; approve as a portal
identity with the PO stored; dispute; documents listed / downloaded / withdrawn and "not found" for the other account;
contacts; the ledger names the identity; an unknown token reaches nothing). `ClientPortalView.dom.test.tsx` (8),
`server/clientPortalViewModels.test.ts` (4), nine client-portal surfaces in the axe suite. Guards: 46 external, 735
mounted paths.

**Test results:** 13/13 new plus 27 axe cases; guards green; `tsc` and test-file typecheck clean.

**Decisions:** the job ↔ account rule is one function (`accountJobs`) used by every portal read; the dashboard and the
job list read the same posting state so a staffed-but-undispatched job is "scheduled" in both. Sub-accounts and
project / location permissions are not architected around one-user-one-account: a job names an account, a ticket names
an account, and an identity binds to an account — a finer grant later narrows `accountJobs`, nothing else.

**Unresolved risks:** `accountJobs` caps at 200 jobs per read and the list projections are N+1 (the existing
`portal.jobBoard` has the same shape); the portal sign-in reuses the customer shell's token entry rather than a
dedicated invitation flow.

## CP8 — documents, ticket sequencing, notifications on the outbox, QR

**Files:** `server/_core/customerEvents.ts` (new: `CUSTOMER_EVENT_TYPES`, `enqueueCustomerEvent`), hooks in
`server/clientServicesRouter.ts` (link created / revoked, document released, ticket presented, ticket finalized),
`server/closeoutRouter.ts` (first `site_work` → on location; `sitePrepare` → ready for review; completion package →
job completed), `server/customerActionService.ts` (approved / disputed), `server/invoicingRouter.ts` (`send` →
invoice issued, with the `invoice_issued` in-app alert beside the existing `billing_update`).

**Migrations / tables:** none. The events ride the existing `domainEventOutbox` (aggregateType `customerJob`); the in-app
alerts ride `workflowNotifications` through `queueCustomerAlert` (the six new alert kinds landed in CP2).

**Events (14 types, `customer.*`):** tracking_link.created / revoked; job.dispatched / en_route / on_location /
completed; load.completed; disposal.completed; document.released; ticket.ready_for_review / approved / disputed /
finalized; invoice.issued. Each is appended inside the transaction that makes the domain write, under the job's
organization, with the customer account, the acting user (or `system` for a customer's own act), and a payload that
carries refs and hashes — never a token, never a rate, never a person's contact details. The event id is
sha256-derived from (type, subject, occurrence), so a retried commit finds its own row (`ER_DUP_ENTRY` is tolerated and
reported as `duplicate: true`). Delivery is the production outbox worker, the workflow rules and webhook
subscriptions — nothing in this module delivers, and an email / SMS channel joins by subscribing to these types.

**Documents:** released documents were wired in CP3/CP4 (`customerDocumentReleases` over the existing catalogue with the
record's own number preserved); CP8 adds the `customer.document.released` event beside the `document_ready` alert. A
re-release of the same source is idempotent and raises nothing.

**Ticket sequencing:** the billing lifecycle from CP5 is what the events follow: presented (`ticketPresent` and
`sitePrepare` both, once per hash), approved / disputed (link or portal), finalized, invoiced (`invoicing.send`),
completed (the completion package). A re-present under the same hash, an acknowledgement, a comment and an idempotent
re-render change no state and raise nothing.

**QR:** `qrPayload(baseUrl, token)` (CP2) returns the secure URL as the only payload, encoding `url`; the create
response carries it once beside the token. No QR image library is added: the client renders from the URL with any
standard encoder, and the payload is by construction the same secret as the link — nothing about the job is encoded.

**Tests added:** `server/customerEvents.db.test.ts` (2 walks): one job from on-location to completion package —
12 events in order, all under the organization, all on the job, actor recorded, payload refs and hashes match the
domain records, no token in any payload, the second organization's outbox empty, the identity on the account queued the
default-on alerts once per moment (two `ticket_ready_for_review`, one per hash); and idempotency — a retried enqueue
returns the first event id as `duplicate`, the first payload stands, a new occurrence is a new event.

**Test results:** 3/3 new; `serviceTicketBilling.db`, `customerActions.db`, `trackingLinks.db`, `trackingApi.db`,
`clientPortal.db`, `invoicing`, `siteCloseout`, `enforcementOutbox`, `b20WorkflowWiring` and the drift guards
(`engineReachability`, `tenantIsolation`, `procedureAuthorization`, `operationalApiAuthorization`,
`crossLayerIntegrity`, `documentationTruth`, `columnParity`, `clientTruth`, `a11yCoverage`): 201/201. `tsc` and the
test-file typecheck clean; `LEASEOS_CURRENT_STATE.md` regenerated (329 test files).

**Decisions:** the CP8 test found `sitePrepare` presenting the ticket with the alert but without the event — fixed in
the same transaction as the transition. `invoicing.send` keeps its existing `billing_update` alert and adds
`invoice_issued`, so nobody who relied on the old key loses it.

**Hook points without a production writer today (documented, not faked):** `customer.job.dispatched` and
`customer.job.en_route` — no production code writes `jobs.status` to dispatched or starts a trip (the posting state
changes only in `dispatchRoleService.ts` and reaches staffed / partially_staffed, never dispatched);
`customer.load.completed` and `customer.disposal.completed` — loads and disposal tickets are inserted by the field
sync, which has no per-load completion transition. The types exist and are default-off / opt-in alerts; the writer
that gains a state change calls `enqueueCustomerEvent` in its transaction. Nothing emits them speculatively.

**Unresolved risks:** `invoicing.send` writes the invoice update and the outbox event in two statements (the existing
procedure had no transaction); a crash between them loses the event, not the invoice — the retry-safe event id makes a
re-send harmless once `send` becomes transactional.

## CP9 — full gate

**Command:** `DATABASE_URL=… bash scripts/ci-gate.sh` (drops and recreates the database, applies every migration
including `0175_client_services_portal.sql`, then parity, typecheck, the test-file type pin, the bare-procedure
check, the full vitest run, the production build, the three procedure gates, and the current-state check).

**Result: PASS.**

| Gate | Result |
|---|---|
| Reserved migration slots 0016/0017 | untouched |
| Migrations from an empty database | all applied, Academy retention guard verified |
| Table parity (`schema.ts` vs migrations) | 415 / 415 |
| `tsc --noEmit` | clean |
| Test-file type errors | 0 (pinned ceiling 0) |
| Bare `protectedProcedure` | none |
| Full test suite | 346 files, 4885 passed, 3 skipped (pre-existing, `agentRuntimeApi.test.ts`), 0 failed |
| Production build (`vite build` + esbuild) | built |
| External gate | 46 externally-gated procedures (pinned) |
| Tracking gate (new, step 7d) | 11 tracking-gated procedures, only in `trackingRouter` (pinned) |
| Machine gate | 2 integration-gated procedures (pinned) |
| Current-state document | regenerated and matching |

**Against baseline:** before this branch the same gate reported 334 files / 4771 tests. The branch adds 12 test files
and 114 cases; nothing that passed before fails now.

**The one failure on the first run, and its fix:** `server/calendarFixtures.test.ts` (the calendar tripwire) named three
files with a fixture date inside three weeks and a real clock read: two of this branch's (`trackingLinks.db.test.ts`
— a custom live-until date of 2026-09-25 compared with an explicit `now`; `clientPortal.db.test.ts` — a posting
scheduled for 2026-09-26) and one untouched by the branch (`capitalAssets.test.ts`, whose 2026-10-15 schedule date
came within 21 days on 2026-09-24, the day of the run — it fails identically on `main` today; `git diff origin/main`
on that file and on the tripwire is empty). The two branch fixtures were made clock-relative. The untouched file was
reviewed the way the tripwire asks: its dates are an explicit `asOf` inside a fixed fiscal year and a disposal aged
against that `asOf`, its clock reads stamp a role grant and two refused registrations — recorded in `REVIEWED` as
`clock_independent` with that reason. Commit `1f1e9cf`.

**Commits on `claude/client-portal-job-tracking-zqmejc`:** `c4aa8c4` CP1 · `48ea7b5` CP2 · `7ad7e70` CP3 · `d8420f6`
CP4 · `33dd5f3` CP5 · `05973e6` CP6 · `2dc4b83` CP7 · `c9d9ad1` CP8 · `1f1e9cf` CP9 tripwire · (this commit) CP9
report. No pull request was opened.

**Security posture across the module, restated once:** every customer read goes through an explicit projection
(`projectCustomerJob`, `projectOpenTicket`, `projectLoads`, `releasedDocumentsFor`) — no internal row is ever
serialized; a tracking token is 32 random bytes stored only as a SHA-256 hash and shown once; every gate decision
fails closed (bad shape, unknown hash, revoked, superseded, expired, over the access limit, job out of the link's
organization, scope key missing → denied, and denied for a sensitive scope is recorded); tenant scoping is by the
job's `orgRef` on every table this module added; billing lines the office marks internal never leave the server;
customer actions are rows and hash-chained ledger entries, and a page view writes an access-log row, never an action;
finalized tickets are frozen revisions that amendments supersede rather than edit.

**Unresolved risks carried forward (from the checkpoint sections above):** no production writer exists yet for
"dispatched" / "en route" / load and disposal completion, so those customer moments are documented hook points with
their event types defined but nothing emitting them; `invoicing.send` is not transactional (pre-existing shape); the
portal list projections are N+1 like the existing `portal.jobBoard`; a QR image is rendered client-side from the URL
payload, no library added; `LEASEOS_PUBLIC_URL` must be set in production for the link URL and QR payload to be
absolute.
