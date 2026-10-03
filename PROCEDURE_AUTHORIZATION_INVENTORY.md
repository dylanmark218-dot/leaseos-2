# Procedure Authorization Inventory

Committed to source so the API's authorization posture is a reviewable artifact
rather than something you learn by grepping. `procedureAuthorization.test.ts`
holds the counts; a bare `protectedProcedure` added later fails the build.

> **Rewritten at B20.7.** Earlier revisions carried narrative text describing the
> 57-procedure tranche as "next" alongside a table that already showed it done.
> That stale prose is removed — a future agent reading it could have repeated
> completed work. This document now states only the current position.

## Classification

| Class | Meaning |
|---|---|
| `PUBLIC` | Deliberately unauthenticated |
| `AUTHENTICATED_ONLY_JUSTIFIED` | Login is the whole requirement, and someone decided that |
| `ROLE_AUTHORIZED` | Domain role, permission, scope, audit |

`AUTHENTICATED_ONLY_UNREVIEWED` no longer exists as a class. Nothing is in it.

## Current position

| Surface | Class | Count |
|---|---|---|
| `server/routers.ts` | `ROLE_AUTHORIZED` | **85** |
| `server/recordsRouter.ts` | `ROLE_AUTHORIZED` | **23** |
| `server/payrollRouter.ts` | `ROLE_AUTHORIZED` | **43** |
| `server/payrollCompensationRouter.ts` | `ROLE_AUTHORIZED` | **11** |
| `server/portalFundingRouter.ts` | `ROLE_AUTHORIZED` | **10** |
| `server/purchasingRouter.ts` | `ROLE_AUTHORIZED` | **9** |
| `server/deviceRouter.ts` | `ROLE_AUTHORIZED` | **7** |
| `server/complianceRouter.ts` | `ROLE_AUTHORIZED` | **18** |
| `server/requirementRouter.ts` | `ROLE_AUTHORIZED` | **7** |
| `server/insuranceRouter.ts` | `ROLE_AUTHORIZED` | **12** |
| `server/surfacesRouter.ts` | `ROLE_AUTHORIZED` | **6** |
| `server/dispatchRouter.ts` | `ROLE_AUTHORIZED` | **13** |
| `server/customerCommercialRouter.ts` | `ROLE_AUTHORIZED` | **40** |
| `server/iftaRouter.ts` | `ROLE_AUTHORIZED` | **7** |
| `server/fuelOpsRouter.ts` | `ROLE_AUTHORIZED` | **7** |
| `server/periodRouter.ts` | `ROLE_AUTHORIZED` | **3** |
| `server/gstRouter.ts` | `ROLE_AUTHORIZED` | **5** |
| `server/cashRouter.ts` | `ROLE_AUTHORIZED` | **11** |
| `server/commercialRouter.ts` | `ROLE_AUTHORIZED` | **7** |
| `server/closeoutRouter.ts` | `ROLE_AUTHORIZED` | **20** |
| `server/shopRouter.ts` | `ROLE_AUTHORIZED` | **25** |
| `server/maintenanceRouter.ts` | `ROLE_AUTHORIZED` | **10** |
| `server/fleetPortfolioRouter.ts` | `ROLE_AUTHORIZED` | **9** |
| `server/assetRouter.ts` | `ROLE_AUTHORIZED` | **10** |
| `server/projectRouter.ts` | `ROLE_AUTHORIZED` | **9** |
| `server/integrationRouter.ts` | `ROLE_AUTHORIZED` (`integrationRouter`) / `INTEGRATION_CLIENT` (`inboundRouter`, `integrationProcedure`; the count is generated into `LEASEOS_CURRENT_STATE.md`) | **11** |
| `server/telematicsRouter.ts` | `ROLE_AUTHORIZED` | **7** |
| `server/workforceRouter.ts` | `ROLE_AUTHORIZED` | **16** |
| `server/auditRouter.ts` | `ROLE_AUTHORIZED` | **6** |
| `server/spatialRouter.ts` | `ROLE_AUTHORIZED` | **15** |
| `server/liveAssistRouter.ts` | `ROLE_AUTHORIZED` — LA-1a session spine only; every permission sensitive; no universal grant (`docs/live-assist/LA1A_OWNER_RULING.md`) | **8** |
| `server/documentControlRouter.ts` | `ROLE_AUTHORIZED` | **23** (DC-A: definitions list/get, catalog seed, overlay/create/retire, source artifacts; DC-B: intake, register rendered, confirm, issue, void, supersede, withdraw, amend, get, list; DC-C: series list, gap report, blocks, allocate/retire device block, void number) |
| `server/attestRouter.ts` | `ROLE_AUTHORIZED` — SA1 Sign & Attest (`docs/sign-attest/SA1_OWNER_RULING.md`); `attest.sign` and `attest.decline` are universal and self-scoped (the signer row must name `ctx.user.id`); every other write is sensitive | **14** |
| `server/portalRouter.ts` | `EXTERNAL_IDENTITY` (`externalProcedure`; the count is generated into `LEASEOS_CURRENT_STATE.md` and never written here) | **0** |
| `server/driverPortfolioRouter.ts` | `ROLE_AUTHORIZED` (0212; the three `portfolio.*_own` permissions are universal and self-scoped to the operator linked to the session) | **17** |
| `server/routers.ts` | `PUBLIC` | 2 (auth entry points) |
| `server/driverPortfolioRouter.ts` | `PUBLIC` | 1 (`shareRedeem`: one credential behind a 256-bit token, only its hash stored; re-read on every redemption; revocable; at most 7 days) |
| Anywhere | bare `protectedProcedure` | **0** |

**524 role-authorized procedures across the surfaces listed above.** Zero on bare `protectedProcedure`.
The table lists the surfaces reviewed here, not every router; the system-wide count is generated into
`LEASEOS_CURRENT_STATE.md`. The numbers in this table are written by `node scripts/procedure-inventory.mjs`,
which reads them from the routers (CP1.5: nine rows had drifted below their routers and the total said 356).

Baseline in `procedureAuthorization.test.ts` is 0 and must never rise.

## Permission design rules

Applied throughout; worth stating because mechanical migration would have
missed them.

- **Reads and writes are separate permissions.** `rateCards.list` is
  `billing.read`; `rateCards.update` is `billing.write`.
- **Acts that create operational fact get their own sensitive permission.**
  `transfers.acknowledge` (custody handoff), `gps.confirmZoneEvent` (proposal
  becomes billable arrival), `routeDecisions.create`, `evidence.verify`,
  `assistant.commit`.
- **Running and approving are held by different roles.** `payroll_admin` runs a
  pay run; `controller` approves it; neither can do both.
- **Self-service takes no subject id.** Own-pay and own-tax procedures resolve
  the employee from the session. There is no field to spoof.
- **Sensitive permissions fail closed without an audit trail.** The count is in `LEASEOS_CURRENT_STATE.md`, generated from the array — it is no longer written here by hand. (v21.9.1 found nine actions missing from the set: dispatch award and override grant, enforcement changes, IFTA and GST finalization, period close and reopen, credit and write-off decisions. Added and test-pinned.)
- **Insurance is layered by what a role needs to know.** A driver reads a
  summary — status and policy ref, never a premium. Verifying coverage with
  the insurer, issuing a certificate, and recording claim money are three
  sensitive acts with three permissions.
- **The site signature freezes what was known and agreed at the lease.** (v21.11)
  A signature records the authorities it exercised and whether each was
  within the signatory's recorded authority; what is not is refused and
  recorded, never silently granted. The signed snapshot is revision R1 with
  its hash; a later change is a new revision, never an edit. Post-site travel
  and disposal are appended only under the billing basis the consultant
  signed; restocking, post-trip, washout, fuel and paperwork are the company's
  clock and stay off the customer's bill. A delay is billable only by a
  contract rule, and REVIEW REQUIRED until one exists.
- **A rate is resolved, never picked; four kinds of money are never one field.** (v22.7)
  One charge definition for every pricing method (per unit, flat, minimum
  charge, percentage and fixed markup, multiplier, formula) and every rate
  kind — sell, vendor payable, payroll reference, internal cost — in cents,
  thousandths and basis points; no new double. A definition is proposed by
  one person, the AI's extraction or an import, and approved by a different
  person; until then it prices nothing. Precedence is deterministic — job
  override, change order, PO/AFE, project/site, customer contract, rate card,
  branch, company — the most specific wins at a level, equal specificity is
  a CONFLICT, nothing is UNKNOWN, a unit mismatch is a CONVERSION REVIEW
  unless a sourced rule is supplied, and a measurement the contract does not
  accept is a MEASUREMENT REVIEW. A superseded definition still prices the
  work done in its window. Every priced line writes an immutable pricing
  decision naming quantity, unit, source, rate, definition, clause, minimum,
  increment, formula and inputs. Margin and internal cost are under their
  own permission; the customer view carries the sell price only unless the
  account is open-book; the vendor view its payable only. PO exposure names
  the overrun before work starts; readiness names exactly what is missing.
- **The first routing graph, built from imported road data.** (v22.16)
  Alberta's access-road layer is properly noded — measured on one township,
  440 endpoints meet another segment's endpoint exactly and one is a
  T-junction — so a graph joins segments at their endpoints with a snap
  tolerance for the near-misses, and a build is a recorded artefact naming
  the imports it stands on. A driveway, ferry or ford is never routable. The
  search is Dijkstra over a surface-weighted cost, where a kilometre of
  dry-weather road costs more than a kilometre of pavement. **The two routing
  questions stay separate**: what roads connect these points is answered
  here, and whether this truck may travel them is the evaluator's, so a
  computed path is handed straight to the four-axis evaluator and is never
  itself a permission. Honest outcomes throughout — no graph covers it,
  origin or destination too far from any road, the positions are in
  disconnected components, or a path with the snap distance stated because
  the last stretch to a lease is not part of the road network. **P0 is
  lifted for the areas a person has imported and built, and unchanged
  everywhere else.** Two procedures; one permission, sensitive.
- **Structures, effective-dated restrictions, and route staleness.** (v22.15)
  A restriction has always carried an effective window and **nothing read
  it** — a spring ban that ended in June still blocked in September, and one
  starting in March applied in January. The evaluator now reads the window,
  and what a window excludes is reported by name rather than silently
  dropped. Where two restrictions are in force for one check, the **most
  restrictive governs** — taking the latest-recorded row could pick the more
  permissive of two limits, which is the wrong way to be wrong. A
  **structure** — bridge, culvert, overhead, cattle guard — is a record with
  posted limits, an authority, an effective window and a second person's
  verification; a **posted** limit is the limit, while a rated capacity with
  nothing posted is engineering data that leaves the check UNKNOWN, because
  what governs a driver is the sign. An **approved route carries a
  dependency fingerprint** over the unit's profile, the load, the permits,
  the restrictions in force, the structures and the imported road data:
  change any one and the approval is stale by arithmetic, with the change
  named in a dispatcher's words, rather than by somebody remembering to
  re-run it. A blocked route is never approved. Four procedures; three
  permissions, two sensitive.
- **Legal land both ways; the entrance is its own record.** (v22.14) The LSD
  parser reads every common spelling as one parcel — `13/24-54-18-W5`,
  `LSD 13 SEC 24 TWP 54 RGE 18 W5M`, `13 24 54 18 W5` — and refuses what
  cannot exist by naming the field: section 44 is outside 1–36. A canonical
  identity (`AB:M5:R18:T54:S24:L13`) makes two spellings one parcel. A GPS
  fix reads back as legal land against the imported grid, saying when the
  position is on a road allowance rather than the land it adjoins, and
  saying plainly when the grid there is not imported. An **entrance** is a
  record, not a pin: derived from the grid and the road fabric or recorded
  from the field, proposed by one person and confirmed by another, with
  **confidence counted from what has actually reached it** — a single
  passage is never "confirmed", a failure against successes is disputed for
  a person to settle, and a configuration fingerprint distinguishes "this
  exact rig has been through" from "some other truck has". An imported road
  enters the four-axis evaluator stating the surface Alberta states and
  **nothing else**, so weight, clearance, width and seasonal checks read
  UNKNOWN rather than pass — the map's silence is never a permission. Six
  procedures; three permissions, one sensitive.
- **The mapping foundation, from open data.** (v22.13) Two authoritative
  Alberta services, both already in the source registry as permitted and
  verified, now have importers: **ATS v4.1 Legal Subdivision with Road
  Allowance** polygons (Open Government Licence — Alberta) and **Base
  Features Access Road** lines, the province's authoritative rural road
  layer. Every row carries its source key, layer, import run and retrieval
  time; every run carries its endpoint, query, counts and whether the
  service truncated the page. An import is refused unless the source is
  registered, cleared for commercial use and verified. Road segments carry
  Alberta's own FEATURE_TYPE with its published label and a surface kind
  derived from it. The LSD locator finds the parcel, computes its centroid
  from the polygon, and finds where a truck reaches it — the nearest
  truck-suitable road, preferring one that touches the parcel; a driveway,
  ferry or ford is never offered, and no access point is a named outcome,
  never a guess. The centroid is the land and the access point is the road;
  they are never conflated. A lease location's coordinates can now be
  verified from the imported grid by a second person, writing the
  **`ats_v41`** source v22.0 defined and could not produce. Five procedures;
  three permissions, two sensitive.
- **The first-run setup wizard, as a screen.** (v22.12) A panel in the
  authoritative portal shell for office portals: company (select or create
  the financial entity), services and margin guardrails, rates — proposed
  here, approved by a different person, with the list showing each
  definition's status — customer-specific rates, vendor payables, internal
  cost per unit, billing terms (shown, recorded from the closeout), and
  go-live readiness. Every step calls the real procedure and shows the
  server's answer; the wizard opens at the first step the readiness
  projection says is not done, and claims nothing without a projection.
  Dollars typed become integers before they leave the screen. No new
  procedures.
- **Credits and voids through the invoice path; held lines re-drafted.**
  (v22.11) A line already on a live invoice is excluded from a draft with
  the invoice named; what remains is a supplemental invoice on the same
  billing book, whose entries are updated, never duplicated — so a line held
  for a dispute drafts once the dispute resolves in the company's favour. An
  invoice-level dispute is resolved as upheld, credited or partial, the
  credit bounded by the disputed amount and requested through AR where a
  second person approves it, the invoice returning to its delivery state. A
  void is recorded on the invoice — who, when, why — never by deleting it;
  refused where payments are allocated or approved credits stand (that is a
  credit), refused for a paid invoice; it keeps the snapshot and releases the
  book's entries so the lines draft again. Two procedures, two sensitive
  permissions.
- **An approved invoice reaches the customer.** (v22.10) Its document is
  rendered deterministically from the frozen snapshot — idempotent, one
  document, stored beside the ticket's own documents under the kind
  `invoice` so the portal lists and downloads it where it already lists the
  ticket's. Sending is its own permission: only a finalized, rendered
  invoice is sent, with its due date from the account's terms, and the
  account's portal identities are alerted. In the portal the customer lists
  the invoices issued to it, views one — which marks it viewed once and shows
  the frozen lines with the sell price and nothing of cost — and accepts it,
  recorded in the acceptance fields with the delivery status untouched; a
  disputed invoice is not accepted over its dispute; another account sees
  nothing. Two role procedures, three external procedures (36).
- **The invoice path exists.** (v22.9) Until now no application path
  created an invoice — AR, cash and the commercial check read rows that only
  tests wrote, and the billing book and snapshot tables had no writers. An
  invoice is drafted from a signed ticket's accepted lines and their pricing
  decisions — the decision's billable quantity, rate and amount, never
  re-priced — each invoice line naming the ticket line and the decision it
  came from; a disputed line is held under the customer's partial-acceptance
  configuration or blocks the draft; a line that named no service is a
  note; an unpriced line blocks with its outcome named. The job's billing
  book is opened and its entries written. Finalization is a second
  permission: refused until a person sets the GST/HST treatment, refused for
  a taxable invoice while the rate is an unverified rule (P9), permitted
  zero-rated or exempt; it freezes a snapshot of the source facts and the
  calculated lines under a canonical hash the invoice carries, marks the
  entries billed and the book invoiced. Three procedures; three
  permissions, one sensitive.
- **The paths that bill write the decision they reference.** (v22.8) A
  field-ticket line that names its service is priced as it is recorded —
  the line keeps the measured fact, the decision carries the billable
  quantity, rate, clause and reasons, and the line carries the decision's
  reference; an unknown rate is recorded as unknown and never stops the
  field; a unit outside the pricing vocabulary is skipped and said so, never
  converted. A vendor-bill line that names its service is priced against the
  vendor's agreed payable in the customer's context and carries the variance
  between what was billed per unit and what was agreed. Two queries: a
  ticket's pricing line by line with its blockers named, and the vendor lines
  that do not match their agreed rates.
- **Commercial Setup & Rate Resolution.** (v22.7) One charge definition for
  every pricing method — per unit, flat, minimum charge, percentage and fixed
  markup, multiplier, formula — and every rate kind: sell, vendor payable,
  payroll reference, internal cost, never one field. A definition is
  proposed by one person (or extracted by the AI, or imported) and approved
  by a different one; until approved it prices nothing. The resolver is
  deterministic — job override, change order, PO/AFE, project/site, customer
  contract, rate card, branch, company — the most specific definition wins
  at a level, equal specificity is a CONFLICT, nothing applicable is
  UNKNOWN, a proposal is not a rate, and a superseded definition still
  prices its own window so a December job reproduces December's rate. A
  pricing decision is written once: measured quantity and source, billable
  quantity after increment and minimum, rate, definition, clause, formula,
  inputs, amount, reasons. A unit that does not match is a CONVERSION REVIEW
  unless a sourced rule is supplied; a measurement the contract does not
  accept is a MEASUREMENT REVIEW. The customer sees the sell price, the
  vendor its payable, management the spread; the margin is under its own
  sensitive permission, with guardrails that are business policy and name
  who must approve. PO exposure names an overrun before work starts. Go-live
  readiness is a percentage with exactly what is missing. Thirteen
  procedures; six permissions, three sensitive.
- **The fuel ledger retired its doubles.** (v22.6) Amounts to cents, the
  per-unit price to thousandths; the GST/HST return, the asset twin's fuel
  cost, the statement-matching read and the bulk dispense moved to the
  integers; the assistant commit, the machine feed and the dispense write
  only them; four triggers dropped, five doubles dropped, the total NOT
  NULL. Thirty grandfathered doubles remain; the retirement test now covers
  both retired ledgers, and the trigger and rate proofs moved to ledgers
  that still carry doubles.
- **Authorization says who may act; the boundary says what an act may establish.** (v22.5.1)
  Found by audit of the legacy monolith. Seventeen trust-bearing inputs on
  its create and capture procedures are now REFUSED at the schema — a
  present value fails, it is not dropped: evidence and document status,
  TDG classification and its verification time, defect and incident status,
  manifest status, signature status, method and hash, scan access role,
  unit inspection and maintenance state, route-context verification and
  confidence, route-decision source and confidence, breadcrumb unit. Each
  create writes the honest state (needs_review, needs_verification, open,
  draft, pending, due/review) and the transition services establish the
  rest. A scan's role is the caller's; a duty record is the signed-in
  driver's unless dispatch, HR or management amends it and the amendment is
  marked; a breadcrumb binds to the operator's active trip, never a trip the
  request names; a route decision is a manual choice labelled with the
  unloaded routing source. On the client, the eight demonstration pages live
  under /showcase behind a link that refuses every mutation while they are
  mounted; /map, /jobs, /evidence and /safety are authoritative surfaces; a
  source guard keeps demonstration identifiers out of production client code.
- **The first ledger retired its doubles.** (v22.5) Vendor bills and their
  lines: every reader moved to the integer columns (the vendor statement,
  the inbox surface, the three-way match, the recovery proposal, the cash
  ledger, the warranty credit), every writer writes only them, the triggers
  that referenced the doubles were dropped, then the doubles, and the totals
  are NOT NULL as the doubles were. The grandfathered list is thirty-five,
  and a test keeps the retired ledger retired.
- **Every double money column now has an integer shadow.** (v22.4) All
  forty: amounts in cents, per-unit rates — a fuel unit price, a pay rate, a
  rate applied — in thousandths, because a rate is not an amount. Backfilled,
  trigger-guaranteed on insert and update, reconciled to the cent (or the
  thousandth) every run; the reconciliation asserts a shadow exists for every
  grandfathered double. The GST/HST return reads the shadows, the double as
  fallback only.
- **Double money is grandfathered, never new; the ledgers grow integer shadows.** (v22.3)
  Forty older columns still hold money as double. They are enumerated from
  the live schema and pinned by test: a new double money column fails the
  gate; a grandfathered one that disappears must be removed from the list on
  purpose. Vendor bills, their lines and fuel transactions carry integer
  shadows now — backfilled by migration, dual-written by every application
  writer through one helper, and guaranteed by database triggers for any
  write that bypasses the application, on insert and on update. Every row
  reconciles to the cent, or the gate fails.
- **Terms complete the closeout; COR and insurance packages join the builder.** (v22.2)
  A minimum-hours term raises what is billed — the raise named with its
  clause — and never what was worked. Where the signatory wrote "per
  contract" for return travel, the approved terms answer on the supplement;
  where no contract answers, REVIEW. COR packages gather approved program
  versions (their own hash), acknowledgements, tailgates, inspections,
  verified training and incidents — a period with no incidents is a
  statement, not a blank; insurance packages gather policies with coverage
  verification, claims, incidents and escalated driving events, with
  premiums and identities withheld and listed.
- **A contract term decides what the closeout could only review, and cites its clause.** (v22.1)
  Terms per customer account are recorded by one person and approved by a
  controller, management or legal — never the recorder — against the
  contract document. An approved term in effect on the event's date decides
  standby, holds, disposal time and return travel, and is cited on the event
  (`billingRuleRef`); grace minutes reduce `billableMinutes`, never the
  clock. Without terms the answer is REVIEW, as before; a signed ticket's
  answers stand. Webhook dispatch moved into a service the drain worker
  calls for the event it processed, with the retry sweep on its heartbeat.
- **A coordinate says where it came from, and no routing source is loaded.** (v22.0)
  An LSD and a UWI are validated; a location registered without a verified
  coordinate sits on the THEORETICAL survey grid, labelled so, low
  confidence, not navigable, until safety or management verifies it from
  ATS v4.1 (with its dataset version) or a field fix, with evidence. A
  vehicle profile is the shop's measurement or a spec sheet, verified by a
  second person; an operator-stated one is not verified. A road restriction
  is a rule row with a source, unverified until a second person verifies it
  against its document; nothing is seeded. The four-axis evaluation runs
  over caller-named segments with the unit's profile — a verified row over
  an unverified one per check — and persists its evidence against the
  profile. A route against the network is UNKNOWN: no routing source is
  loaded (P0), and a provider named in the environment is not a loaded one.
  Google Maps Platform is kept out of the server tree by test.
- **A package asserts nothing new.** (v21.21) An audit package is a manifest
  over records the chain already holds — each item with its source, its
  reference and its content hash (a stored document's own hash carried, not
  recomputed) — hashed as canonical JSON; the package is that hash. The
  kind's redaction policy removes fields and withholds items and LISTS every
  removal; the kind's completeness rule NAMES what is missing. Prepared by
  safety, office, controller or legal; released only by controller,
  management or legal, never by the preparer, and an incomplete package only
  with each gap named in the release note. Released packages do not change;
  a re-preparation supersedes. Every view, release and download is a row.
- **A person's file is HR's, and every step of it is two people or evidence.** (v21.20)
  Applicants and screenings are `hr.applicant.manage`, and the list carries no
  contact detail. A pass needs its evidence; a hire is refused while a
  required screening is pending or failed, by name. A credential task is
  completed with evidence and verified by someone else into
  `complianceDocuments` — the registry dispatch reads. Training is recorded
  by one person and verified by another; an unmapped course is training
  only. Competency is a supervisor's signature, never self-declared, and
  senior follows competent. Probation is recommended by a supervisor and
  decided by HR, who may differ. Offboarding revokes role grants and field
  devices in one act with the offboarding as the reason, and closes only
  when every door — roles, devices, tools, final pay — is named shut.
- **A fault is an observation; a review is a person's; video is its own permission.** (v21.19)
  Telemetry is append-only evidence, and the truck's odometer is reconciled
  against trips and the shop, not trusted over them. A fault code counts and
  spans; its severity is a rule with no verified source, so an active fault
  is UNKNOWN on dispatch — overridable by a manager, never clear, never
  blocking — until a mechanic acknowledges it into a defect with the severity
  the mechanic determined; an acknowledged critical fault blocks and does not
  clear until the defect resolves. A driving event is coached, dismissed or
  escalated once, with a note, after the video is viewed; the queue is by
  unit and sums nothing per driver. Viewing video is `safety.video.read`,
  sensitive, with a stated purpose and a logged row.
- **A machine is an identity, and what it sends is a proposal.** (v21.18)
  `integrationProcedure` is the third gate, built like `externalProcedure`
  and no weaker: a hashed key resolving to one active client with scopes,
  every decision audited, ingestion refused when its audit row cannot be
  written. Inbound events are idempotent by the client's key and hashed; a
  fuel transaction lands as `needs_review`, a position as evidence only, a
  duty record with its source. Webhooks out are signed over the outbox with
  a secret stored encrypted and shown once, retried on a schedule, dead after
  six attempts with every attempt kept.
- **A price to a customer is frozen, and a commitment is recorded as the authority it was made under.** (v21.17)
  A quote is priced from the customer's card, hashed at issue — only
  management or the controller issue — and accepted by hash by a signatory
  who holds quote authority; a revision supersedes. A change order is
  authorized within, above, or without authority and recorded as such; the
  office is alerted to confirm one authorized above. An RFI's answer is kept
  and never replaced. A budget is approved by someone other than its author.
  The forecast says UNKNOWN about completion until a person states it.
- **A truck is one identity, and a CCA claim needs a verified rate.** (v21.16)
  A capital asset links to the unit the shop maintains; a second asset on the
  same unit is refused. Capitalizing is decided by someone other than the
  recorder. The CCA class is a candidate with a source; only an accountant-
  sourced class is verified. The pool is computed from facts; the claim and
  the closing UCC are UNKNOWN until a person verifies the class rate, and an
  unknown schedule cannot be reviewed as a tax fact or carry balances
  forward. The schedule is prepared by one person and reviewed by another.
- **A hold is typed, its release is a second person's, and a meter is read where it lives.** (0200,
  Fleet & Equipment Portfolio foundation) Placing and releasing a hold are sensitive
  (`fleet.hold.place`, `fleet.hold.release`); below the permission, the hold's TYPE decides who may
  act — a mechanic places and releases maintenance holds only, a safety hold is placed and released
  by safety or management, and the placer never releases their own. A safety hold is out of service
  and blocks dispatch with no override. Recording a ledger meter reading is an observation
  (`fleet.meter.record`, mechanic, shop lead, office — not the driver yet); verifying or rejecting
  one is a second person's and sensitive (`fleet.meter.verify`). Every read is `fleet.read`, and
  another organization's unit, hold or reading answers NOT_FOUND worded as for one that does not exist.
- **A defect is returned to service by a second person.** (0221, fleet maintenance
  checkpoint 2) Reporting keeps the reporter's words and proposed severity apart from
  the decision (`maintenance.write_defect`); triage decides it (`maintenance.defect.triage`:
  mechanic, shop lead, safety — sensitive), and lowering a critical defect frees its
  safety hold, which only safety or management may release, never its placer. Sending
  to the shop (`maintenance.defect.send_to_shop`) opens the work order and its first
  task together; tasks are `maintenance.task.write`. `shop.workOrderRelease` is the one
  door a release comes through (`records.maintenance.recordRelease` is closed) and waits
  for every task. `maintenance.returnToService` (sensitive) is refused to the technician
  who signed the release and applies the portfolio's hold rule to every hold it lifts;
  both it and triage are human-authorization permissions an agent never exercises.
- **A work order is owned by a person, and cancelling it repairs nothing.** (0199, fleet
  maintenance checkpoint 1) Assigning, reassigning and unassigning a work order is
  history, not an edit: the assignee is a user holding a shop role in the unit's
  organization, and the assigner is the caller. Assigning is the shop lead's and
  management's. Cancelling is theirs too and sensitive: a cancelled work order
  never evidences a release, and the defect it was opened for stays open. Reading
  who owns a work order uses `maintenance.read_defect`. The legacy
  `workOrders.update` no longer sets a status at all; `shop.workOrderAdvance`
  moves a work order and `maintenance.workOrderCancel` ends one. Telematics
  procedures now answer NOT_FOUND for another organization's unit.
- **Stock is a derivation; a count is a movement.** (v21.15) On-hand is the
  signed sum of an append-only movement ledger; a physical count adjusts the
  record and keeps the variance; an issue beyond on-hand is refused by the
  shortfall. Counting is the shop lead's and sensitive. A tire is in one
  place; its kilometres and cost per kilometre exist only with both
  odometers. A warranty claim is eligible only under a verified policy and is
  decided by someone other than its raiser, above the shop. A recall is
  recorded unverified and verified by someone other than its recorder before
  any unit is cleared of it.
- **A customer is told by template, once, on the existing queue.** (v21.14)
  Alerts travel on `workflowNotifications` to `external:<identityRef>`,
  keyed once per identity per kind per subject, on customer-safe kinds only —
  nothing private has a kind to subscribe to — and honour the identity's
  preferences. Chain of custody, the approval queue and the job timeline are
  projections of canonical records scoped by the binding; a quantity is never
  shown without its method and evidence is never stated past its ticket.
- **What a customer sees live is a projection.** (v21.13) An operational
  state comes only from ticket events and signatures — never from speed — and
  is UNKNOWN when nothing establishes it; readiness is a verdict and a
  category derived from a blocker's code through a fixed dictionary, never a
  label or a record; a notice is a template by kind and severity, never the
  incident's title, detail, names or findings. Each is scoped by the binding
  and logged.
- **An external identity is invited, accepts once, expires, rotates, locks and may require MFA.** (v21.12)
  The invitation token is hashed and expires; accepting it through the same
  external gate issues the bearer token, itself hashed and expiring; a
  rotated token keeps its predecessor for a grace window; five failures
  lock the identity; MFA is a TOTP secret stored encrypted under a server
  key and required on every sensitive external write once confirmed. Every
  external view, download, signature, decision and authorization is logged.
- **A client adjustment is billing value, never worked time.** (v21.12) A
  tip, bonus, percentage or hour-equivalent changes what is billed and no
  clock; one meant for workers is PROPOSED to payroll for an authorized
  person to decide. Idempotent by content.
- **An external identity is not a domain-role user.** (v21.10) The portal is
  gated by `externalProcedure`: a bearer token hashed and resolved to exactly
  one active identity, whose kind decides its permissions and whose binding
  decides its scope — the request never names an account. Every decision is
  an audit row; a write from outside is refused when its audit row cannot be
  written. A submission becomes a LeaseOS record only when a person inside
  accepts it. The portal router mounts no role procedure and no internal
  router mounts an external one; both are test-pinned.
- **A branch-confined grant does not pass the generic gate.** (v21.9.1) The
  procedure middleware resolves no resource branch, so a grant confined to a
  branch cannot be judged there and fails closed; only a global grant passes,
  and confined grants apply where a procedure loads the record and resolves
  its branch. Before this, "unknown" and "none" were the same and every
  confined grant passed every gate.
- **Cash never crosses entities.** (v21.9.1) A customer is an account within an
  entity, resolved server-side; an allocation requires the same entity and the
  same account, never a name. Allocation runs in one locked transaction.
- **The collector follows up; the controller authorizes.** A write-off is
  requested by one person and decided by another — only the controller —
  and approval becomes a credit on the invoice. A credit is likewise
  requested and decided by different people. Cash application never crosses
  customers and never exceeds a balance. A bank statement line is evidence of
  a movement, never a movement; unknown lines are findings that block the
  close.
- **A GST/HST return is prepared by one person and finalized by another,**
  who acknowledges every review item by code on the record. Input tax
  credits are claimed only on evidenced purchases and only when registered;
  the rate is a check on collected tax, never a figure, and is unverified
  until a person verifies it. Classifying a sale in a closed period is refused.
- **A closed period refuses writes dated in it.** Bill approval, dispenses,
  statement imports, distance records and trip splits all call
  `assertPeriodOpen` against the record's own date. Closing is the bookkeeper's
  or controller's; reopening is the controller's alone, with a reason. Payroll
  keeps its own lock in `payPeriods`. The AI Secretary's commits are not hooked:
  a receipt for a closed month enters as a draft and surfaces as a late arrival.
- **A statement line is evidence of a transaction, never a transaction.**
  Importing a statement links lines to receipts on the ledger and leaves
  unmatched lines as findings; nothing here creates an expense from a line.
  Yard work — dispensing, reading a tank — is field roles; importing is the
  bookkeeper's and controller's.
- **IFTA separates recording, verifying and filing.** A driver records
  distance and splits trips; they hold no verify permission. Whoever recorded
  a distance may not verify it. The preparer may not finalize their own
  return, and finalizing is sensitive: it is a filing.
- **Dispatch is gated, and the gate is reachable.** `dispatch.award` binds an
  assignment to a recorded eligibility check whose facts are recomputed
  server-side at award time; a changed fact or an aged check refuses.
  Overrides answer a recorded request, never by the requester, never for a
  blocker that is overridable by no one. The legacy `jobUnits.create` path
  runs under the enforcement setting (v21.2): off as always, advisory records
  findings as exceptions, enforced refuses without a valid check. (`transfers.create`
  was mislabelled an assignment path in v21.1; it records document delivery
  acknowledgements and was never one.)
- **The universal surfaces filter per item.** The exception centre, search
  and timeline each carry, on every item, the permission needed to act on or
  read it, and the router filters the feed to the caller's grants. A driver's
  exception centre is empty not because they lack access but because nothing
  in it is theirs to fix. Inbox and My Day are self-scoped universals.
- **Packs and equipment authorization are sensitive.** Activating a pack
  changes what the law is taken to require of a company; authorizing an
  operator on equipment is the employer's act. Management and controller
  activate packs; safety and management authorize operators.
- **Compliance privacy is a projection.** `compliance.private.read` is HR only.
  Dispatch reads a passport and learns "eligible: yes | no | unknown"; the
  credential row never leaves HR. Loading a requirement as verified is
  controller-only and requires a verified source — the same rule as tax rules.
- **Universal permissions are self-scoped in code** — the tax organizer,
  portal composition, a device's own enrol, rotate and push, one's own inbox
  and day, one's own dispatch readiness. None can name another person or
  another person's device. Their count is generated into
  `LEASEOS_CURRENT_STATE.md` and never written here.
- **Segregated duties in purchasing.** Requesting, approving and releasing
  payment are three grants. The requester never approves their own request;
  the approver of a bill's coding never releases its payment. Both enforced in
  code, both tested.
- HISTORY (B20.13): at that checkpoint two universal permissions existed. The
  current set and count are generated into `LEASEOS_CURRENT_STATE.md`.

## Resolved at B20.9 — universal permissions (HISTORY — the count as of that checkpoint)

`tax.read_personal_own` is no longer a role grant. At B20.9 it was the sole member of
`UNIVERSAL_PERMISSIONS`: held by any authenticated user with any recognized
domain role, because the procedure resolves the owner from the session and can
only ever return the holder's own documents.

The rule: **any authenticated person may open their own Personal Tax Organizer;
no operational or employer role grants access to anyone else's.**

The previous split — driver and HR yes, office and controller no — was arbitrary
and tied a person's own records to what job they happen to hold.

A permission belongs in `UNIVERSAL_PERMISSIONS` only when it is self-scoped **in
code**, not merely self-scoped by intention. The list is deliberately one entry
long and a test holds it there. Denials still override universals, and a user
holding no recognized role still gets nothing.

## 0205/0206 — Company Board + Open Work (design: `docs/product/COMPANY_BOARD_OPEN_WORK_DESIGN.md`)

Twenty-one procedures added, all `ROLE_AUTHORIZED`; the live counts are generated into
`LEASEOS_CURRENT_STATE.md` and pinned in `procedureAuthorization.test.ts`.

| Procedure | Permission | Note |
|---|---|---|
| `board.direct` | `board.post` | the one direct channel two people share |
| `board.members` | `board.read` | members of an explicit channel |
| `board.memberAdd`, `board.memberRemove` | `board.post` | refused inside unless the caller holds `board.manage` or is a moderator/manager of that channel; a person may remove themselves |
| `board.mine` | `board.read` | the caller's inbox |
| `board.moderateRead`, `board.moderateWithdraw` | `board.moderate` (**sensitive**, new) | the one way into a conversation the caller is not in; every use writes a `messageChannelEvents` row |
| `board.post` (existing) | `board.post`, and **`board.publish`** (sensitive, new) for an `emergency` priority or an `announcement`/`emergency` channel | decided inside from the derived rule `requiresPublishAuthority` |
| `shifts.get`, `shifts.candidates` | `shifts.read` | |
| `shifts.respond`, `shifts.offerRespond` | `shifts.interest` | a person's own answer |
| `shifts.publish`, `shifts.close`, `shifts.cancel`, `shifts.offer`, `shifts.offerWithdraw` | `shifts.post` (sensitive) | the poster's acts |
| `shifts.link` | `dispatch.assign` | naming the slot a post fills is an assignment act |
| `shifts.award` (Checkpoint 3) | `dispatch.assign` | binds the slot through the canonical binding behind the dispatcher's stored check; not `dispatch.award` |
| `shifts.availabilitySet`, `shifts.availabilityMine` | `shifts.availability_own` (universal, new) | reads and writes `ctx.user.id` only |
| `shifts.availabilityFor` | `shifts.read` | another person's declarations, in the caller's organization only |

Grants: `board.publish` to dispatcher, safety, management; `board.moderate` to safety, management.
