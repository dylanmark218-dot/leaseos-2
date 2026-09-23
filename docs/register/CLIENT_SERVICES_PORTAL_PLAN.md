# Client Services Portal + Secure Job Tracking Links + Open-Ticket Billing — survey and plan

Surveyed against `6f52b57` (branch `claude/client-portal-job-tracking-zqmejc`). CP1 deliverable: what exists, what
is reused, what is added, and the exact guards the additions must satisfy. No code was changed for this document.

The governing principle, restated: **the customer-facing system is a controlled projection of canonical
operational records, never a second copy of the job.** Dispatch operates the job; Field creates evidence;
Documents preserve it; Billing accumulates the commercial record; the portal and the one-time link expose
only the customer-authorized projection.

---

## 1. What exists (integration points)

| Concern | Canonical record | Where |
|---|---|---|
| Tenant | `jobs.orgRef` / `trips.orgRef` (NULL = historical single tenant); money through `financialEntities.orgRef`; units/operators/loads through `coreRecordOwnership` | `drizzle/schema.ts:18`, `server/db.ts:159-164` (`orgScopeWhere`), `server/_core/actingScope.ts` (`resolveActingScope`, `SINGLE_TENANT_ID`) |
| Client organization | `organizations` + `organizationMemberships` (`membershipType` includes `client`); a person links `jobs.customerOrgRef` and `customerAccounts.orgRef` (`organizationRecordLinks`) | `schema.ts:6864-6887`, `8373`; migrations 0086, 0134, 0136 |
| Customer account | `customerAccounts` (terms, PO/AFE rules, hold, contract-rule JSON) | `schema.ts:4805` |
| Job | `jobs` (status `dispatched\|in_transit\|loading\|on_site\|awaiting_docs\|complete`) | `schema.ts:15` |
| Dispatch | `dispatchPostings.planningState` (draft…dispatched, in_progress, completed, cancelled), `dispatchRoles` (slots), award transaction with `FOR UPDATE` + idempotency key | `schema.ts:1806`, `server/_core/dispatchTransaction.ts` |
| Trip / loads / disposal | `trips` (planned…complete), `loads` (`chainState` created…billed, many per job), `disposalTickets` (verification status, confidence), `disposalBatches` | `schema.ts:572, 1003, 1048` |
| Field ticket (operational evidence + commercial facts) | `fieldTickets` (+`customerAccountId`), `fieldTicketEvents` (clock, `customerBillable` yes/no/review), `fieldTicketLines` (facts; priced via `pricingDecisionRef`), `fieldTicketSignatures`, `fieldTicketRevisions` (R1 frozen snapshot + hash; kinds `site_signed\|post_site_supplement\|final\|amendment`), `fieldTicketDocuments` (PDF, content hash) | `schema.ts:1133-1297, 4949, 5066`; `server/closeoutRouter.ts`; `server/_core/siteCloseout.ts` |
| Pricing | `chargeDefinitions` (scope: customer, contract, project/site, job, branch, unit, effective window) → `rateResolution.resolveRate/priceQuantity` → `pricingDecisions`; `closeout.lineAdd` prices on record | `server/_core/rateResolution.ts`, `linePricing.ts` |
| Invoice | `invoices` (draft→approved(=finalized, snapshot hash)→sent→viewed/approved/disputed/paid/void), `invoiceLines`, `billingSnapshots.payloadHash`; corrections via `customerCredits` (approval ledger) / void+redraft | `server/invoicingRouter.ts`, `server/_core/invoiceDraft.ts` |
| Document numbering | `nextTrackingNumber(db, { sequenceType })` — row-locked, configured format (`FT`, `INV`, `DOC`, …) | `server/_core/trackingNumbers.ts` |
| Auth: internal | `roleProcedure(name)` — mapped at wiring time, every decision an `authorizationDecisions` row, sensitive permissions fail closed | `server/_core/trpc.ts:71` |
| Auth: external (customer portal) | `externalProcedure(name)` — bearer `x-portal-token` hashed, resolved to one `externalIdentities` row bound to a `customerAccountId`; kind decides permissions; request never names an account | `server/_core/trpc.ts:149`; `server/portalRouter.ts` (36 procedures, all external) |
| Audit | `authorizationDecisions` (every gate decision), `externalAccessLog` (portal reads/downloads/signatures), hash-chained pattern in `academyAuditEvents` (`previousHash`/`eventHash`), `manifestAmendments` | `schema.ts:3104, 5082, 7678` |
| Notifications | `queueCustomerAlert()` → `workflowNotifications` to `external:<identityRef>`, keyed once per identity/kind/subject, preference-filtered; 14 customer-safe kinds pinned by the `externalAlertPreferences.eventKind` enum | `server/customerAlertService.ts`, `server/_core/customerAlerts.ts` |
| Outbox | `domainEventOutbox` written inside the domain transaction (`enqueueEnforcementEvent` pattern), drained by the production worker | `server/_core/enforcementOutbox.ts`, `workflowRuntime.ts` |
| GPS | `tripBreadcrumbs` (trip-bound positions); no last-known table, no stale threshold, no customer projection | `schema.ts:888`, `server/_core/tripGps.ts`, `spatialRouter.lastPosition` |
| Customer projection | `operationalState()` from ticket events only; readiness/notice projections; `portal.jobBoard`, `chainOfCustody`, `jobTimeline`, documents, invoices, sign, line decide | `server/_core/customerProjections.ts`, `server/portalRouter.ts` |
| Client shell | `client/src/portal/external/CustomerPortal.tsx` at `/customer`, `portalClient.ts` (token in memory, `x-portal-token`), pure view-models tested in Node | `server/customerLiveView.test.ts` |
| QR | No QR library. `units.qrTag`, `scanAudits`, roadside `roadsidePanelGrants` ("a QR code carries a grant reference, not authority") | `server/_core/roadsidePanel.ts` |
| Contacts | No contacts table. People are `externalIdentities` (email, displayName) and `signatoryAuthorities` (name, role, authority flags) | `schema.ts:4871, 4927` |

## 2. Reuse decisions

1. **Job ↔ customer.** The canonical binding today is `fieldTickets.customerAccountId`; jobs carry only a free-text
   `customer` and the person-linked `customerOrgRef`. Added: `jobs.customerAccountId` (nullable, additive, a person or
   dispatcher sets it). A customer account may see a job when `jobs.customerAccountId` = account **or** a field ticket on
   the job bills to the account. One function decides it (`customerJobsWhere`), used by the portal and by the link resolver.
2. **Open ticket = the field ticket's commercial lifecycle, not a new ticket.** `fieldTickets` already accumulate lines and
   events while work happens, are presented (snapshot hash), signed (R1), supplemented (R2), and invoiced. Added: an explicit
   stored `billingState` (DRAFT → OPEN → AWAITING_CUSTOMER_REVIEW → CUSTOMER_ACCEPTED | DISPUTED → FINALIZED → INVOICED, VOID)
   with a `billingVersion` row version, a `final` revision written at finalization (the `final` kind exists and was never
   written), and `customerVisible` on lines. Amounts stay in `pricingDecisions`; the accrued amount is derived, never stored.
   Corrections after FINALIZED are `amendment` revisions plus audit; after INVOICED they are the existing credit path.
3. **Signature = the existing signature chain.** A customer signing from a link calls `recordSignature(method: "portal_link")`
   against the presented snapshot hash; authority is `unknown` when the link is not bound to a signatory. Nothing new records
   a signature.
4. **Documents = the existing catalogues.** A *release* is a pointer to a `fieldTicketDocuments`, `evidenceRecords` or
   `commercialDocuments` row, carrying that row's own number; no second document number is minted.
5. **Numbers.** Link refs use the existing `nextTrackingNumber` allocator (`TL`), so a link has a human-readable, configured,
   row-locked number for the office; the URL carries only the token.
6. **Notifications.** New customer-safe kinds are added to the one enum and templated in `alertText`; the hooks call
   `queueCustomerAlert` where the events already happen. A `domainEventOutbox` row is written for link/ticket events so
   delivery (email/SMS later) stays decoupled from the transaction.
7. **Audit.** One append-only, hash-chained `customerAuditEvents` table in the `academyAuditEvents` shape, with the chain tail
   read under `FOR UPDATE` so concurrent appends cannot fork it. `authorizationDecisions` and `externalAccessLog` keep doing
   what they do.
8. **GPS.** Read from `tripBreadcrumbs` of the job's trips; three modes (`none | approximate | live`) on the link and on the
   account; a fix older than 15 minutes is presented as stale.

## 3. What is added

**Migration `0175_client_services_portal.sql`** (next free number on `main` and every open branch; register row added):
- `jobs.customerAccountId`, `customerAccounts.locationSharing`, `fieldTickets.{billingState, billingVersion, customerPoNumber,
  finalizedAt, finalizedByUserId, finalRevisionId, voidedAt, voidedByUserId, voidReason}`, `fieldTicketLines.{customerVisible,
  loadId, disposalTicketId, unitId, periodStartAt, periodEndAt, addedByUserId, amendsLineId}`, alert-kind enum extension.
- New tables: `jobTrackingLinks`, `jobTrackingLinkAccess`, `customerDocumentReleases`, `customerTicketActions`, `customerAuditEvents`.

**Gates.** `trackingProcedure(name)` — a third gate beside role/external/integration: `x-tracking-token` → SHA-256 → one
`jobTrackingLinks` row → status/expiry/access-count/scope checks → the job must still be in the link's tenant (fail closed)
→ audit row → `ctx.tracking`. All tracking procedures live in `server/trackingRouter.ts`; the guard tests pin that the
router mounts only `trackingProcedure`, that every call site is mapped, and that no other router mounts one.

**Routers.** `server/trackingRouter.ts` (public token: resolve, status, loads, documents, download, open ticket, act);
`server/clientServicesRouter.ts` (internal: links create/revoke/regenerate/configure/list/qr, document release/withdraw,
job customer assign, ticket present/finalize/void/amend, line update, billing state, audit trail); `server/portalRouter.ts`
(+ authenticated client: dashboard, jobs, job, loads, tickets, ticket, act, documents, download, contacts).

**Pure modules (wired, so not "engines").** `_core/trackingLinks.ts` (token, checks, live window, scope),
`_core/customerJobView.ts` (status vocabulary, explicit DTO, location projection, open-ticket projection),
`_core/serviceTicketBilling.ts` (state machine, totals, edit rules), `_core/customerAudit.ts` (chained append).

**Client.** `/t/:token` tracking page (`client/src/tracking/`), `/client` portal (`client/src/portal/client/`), view-models
tested in Node, presentational views run through the axe suite.

## 4. Guards that must move with the change (read from the tree)

`procedureAuthorization.test.ts` (OPERATIONAL_SOURCES list, 634 operational, 36 external, new tracking block),
`operationalApiAuthorization.test.ts` (634), `crossLayerIntegrity.test.ts` (696 mounted paths), `tenantIsolation.test.ts`
(no `tenantId:` column on new tables — `orgRef` is used; no tenant literals), `columnParity.test.ts` (nullability),
`scripts/verify-parity.sh` (table count), `a11yCoverage.test.ts` (every new `.tsx` is rendered by the axe suite or named),
`engineReachability.test.ts` (new `_core` modules are imported by routers), `documentationTruth.test.ts` and
`scripts/current-state.sh` (+ tracking-gated row), `scripts/ci-gate.sh` (+ step 7d for the tracking gate),
`PROCEDURE_AUTHORIZATION_INVENTORY.md`, `docs/architecture/MIGRATION_COLLISION_REGISTER.md`.

## 5. Checkpoints

CP2 data model + gate + tenant tests · CP3 customer-safe API + DTO + leakage tests · CP4 tracking UI · CP5 open-ticket
billing · CP6 customer actions · CP7 client portal · CP8 documents/notifications/QR · CP9 full gate. Each checkpoint is a
commit on this branch; the report per checkpoint is in `CLIENT_SERVICES_CHECKPOINTS.md` beside this file.

## 6. Known constraints and risks named up front

- **SPINE moratorium** (`SPINE_WIRING_PLAN.md`): "no new engines until this path is wired". Everything added here is wired
  from a router in the same checkpoint; nothing joins the declared-unwired list.
- **Portal tenancy** (`PORTAL_ORG_SCOPE_DEFERRED.md`): portal identities are scoped by account binding, not by acting
  organization. The tracking link carries the tenant explicitly (`orgRef`) and re-checks the job against it on every request.
- **No QR library.** The link exposes its URL as the QR payload; rendering the code is a client concern deferred until a
  renderer is chosen. The payload never carries job data.
- **Rates.** Nothing here prices; `closeout.lineAdd` continues to price through `chargeDefinitions`. The rate-card engine
  is the next feature.
