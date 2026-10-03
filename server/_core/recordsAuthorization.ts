/**
 * Domain authorization.
 *
 * Before B20.2, every operational procedure used `protectedProcedure`, which
 * asks only "is someone logged in". `users.role` is `('user','admin')` and
 * nothing else carried a permission, so a shop account and an office account
 * were the same account as far as the server was concerned.
 *
 * Three rules govern everything here:
 *
 *   Fail closed. Unrecognized role strings grant nothing. An unmapped
 *   permission is denied. A branch-scoped grant does not reach another branch.
 *
 *   Deny beats grant. Evaluated across every role held, so collecting a second
 *   role cannot launder a denial attached to the first.
 *
 *   Least privilege by category, not by exclusion. B20.2 gave the shop a broad
 *   `evidence.read_all` and then subtracted billing with an explicit denial.
 *   That works until someone adds a new sensitive category and forgets the
 *   subtraction — the failure mode is silent and permissive. Read access is now
 *   granted per category, so a new category reaches nobody until it is
 *   deliberately granted. The denials remain as defence in depth, not as the
 *   primary mechanism.
 */

export type DomainRole =
  | "driver"
  | "dispatcher"
  | "mechanic"
  | "shop_lead"
  | "safety"
  | "office"
  | "management"
  | "hr"
  | "legal"
  | "auditor"
  // B20.5 — finance and payroll functions. Added as roles rather than folded
  // into HR or management, so access follows the job rather than seniority.
  | "bookkeeper"
  | "payroll_admin"
  | "tax_preparer"
  | "controller"
  | "external_accountant";

export type Permission =
  // Evidence — write
  | "evidence.seal"
  | "evidence.send"
  | "evidence.delete_device_copy"
  | "evidence.amend"
  | "evidence.export"
  // Evidence — read, by category rather than one broad grant
  | "evidence.read_own"
  | "evidence.read_maintenance"
  | "evidence.read_job_operational"
  | "evidence.read_safety_summary"
  | "evidence.read_commercial"
  | "evidence.read_personnel"
  | "evidence.read_legal"
  // The file manager's gate. Opening the browser is not reading a record: each
  // record is still decided on its own category read (or evidence.read_own).
  | "evidence.browse"
  // Safety
  | "incident.create"
  | "incident.read_summary"
  | "incident.read_investigation"
  | "incident.review"
  // Maintenance
  | "maintenance.read_defect"
  | "maintenance.write_defect"
  | "maintenance.write_work_order"
  | "maintenance.record_release"
  | "maintenance.revoke_release"
  // Commercial / personnel
  | "billing.read"
  | "billing.write"
  // P7.1 — Commercial Office configuration: read, maintain counterparties, and set policy (types, ladders, numbering, accounting target).
  | "commercial.read"
  | "commercial.write"
  | "commercial.policy"
  // 0139 — disposal-facility directory: read pins and evidence, record evidence and assessments, review evidence and verify coordinates.
  | "facility.directory.read"
  | "facility.directory.write"
  | "facility.directory.review"
  | "facility.directory.report"
  | "payroll.read"
  // Payroll, split by what is actually being read. `payroll.read` stays the
  // legacy coarse grant and remains HR-only.
  | "payroll.read_own"
  | "payroll.read_employee"
  | "payroll.read_all"
  | "payroll.review"
  | "payroll.approve"
  | "payroll.run"
  | "payroll.adjust"
  | "payroll.rate.read"
  | "payroll.rate.write"
  | "payroll.export"
  // The most sensitive fields in the system. Deliberately not held by anyone
  // who merely administers payroll totals.
  | "payroll.bank.read"
  | "payroll.tax_identifier.read"
  // Tax and books
  | "tax.read_business"
  | "tax.read_personal_own"
  | "tax.expense.create"
  | "tax.expense.review"
  | "tax.asset.read"
  | "tax.asset.write"
  | "tax.salestax.read"
  | "tax.salestax.review"
  | "tax.year_end.read"
  | "tax.year_end.close"
  | "tax.adjust"
  | "tax.export"
  | "tax.rules.manage"
  | "banking.read"
  | "banking.reconcile"
  | "personnel.read"
  | "personnel.write"
  // Compliance documents
  | "compliance.read"
  | "compliance.write"
  | "compliance.review"
  | "compliance.sign"
  // Safety records
  | "safety.write"
  // Governance
  | "legal_hold.place"
  | "legal_hold.release"
  | "retention.dispose"
  | "roles.grant"
  // Field
  | "roadside.open"
  /* --- B20.6: the remaining operational surface --- */
  | "job.read" | "job.write"
  | "trip.read" | "trip.write"
  | "load.read" | "load.write"
  | "manifest.read" | "manifest.write"
  | "delivery.read" | "delivery.write"
  | "dispatch.read" | "dispatch.assign"
  | "transfer.acknowledge"
  | "fleet.read" | "fleet.write"
  | "reference.read" | "reference.write"
  | "inspection.read" | "inspection.write"
  | "hos.read" | "hos.write"
  | "gps.read" | "gps.submit" | "gps.confirm"
  | "route.read" | "route.write" | "route.decide"
  | "evidence.upload" | "evidence.verify"
  | "scan.read" | "scan.write"
  | "assistant.read" | "assistant.use" | "assistant.review" | "assistant.commit"
  /* --- B20.7: payroll, finance & tax API --- */
  // A worker submitting their own time and raising their own dispute are
  // distinct from any administrative payroll permission.
  | "payroll.time.submit_own"
  | "payroll.dispute.raise_own"
  | "payroll.profile.write"
  // Payroll P1 (0226) — compensation agreements and the earning-code catalogue, split by act (D4):
  // reading compensation, proposing it, approving it, and administering a book's earning codes are
  // four different authorities. None of them is held by dispatch, a driver, a mechanic or management.
  | "payroll.compensation.read"
  | "payroll.compensation.propose"
  | "payroll.compensation.approve"
  | "payroll.earning_code.manage"
  // Payroll P2 (0227) — the payroll calendar and the pay-period machine. Reading the calendar, configuring it,
  // finalizing a period and voiding one are separate authorities; approving a period reuses `payroll.approve`.
  | "payroll.schedule.read"
  | "payroll.schedule.manage"
  | "payroll.finalize"
  | "payroll.void"
  // Payroll P3 (0234) — payroll time and exceptions. Approving and rejecting time need the permission AND the D10
  // relationship (crew supervisor, else the book's payroll admin); earning approval leaves `payroll.review`.
  | "payroll.time.read_own"
  | "payroll.time.read_team"
  | "payroll.time.approve"
  | "payroll.time.reject"
  | "payroll.exception.read"
  | "payroll.exception.resolve"
  | "payroll.earning.approve"
  // Payroll P4 (0235) — employee expense claims. Submitting and reading one's own are the employee's; reading, approving
  // and rejecting others' are the payroll office's financial decision (never D10's crew supervisor).
  | "payroll.expense.submit_own"
  | "payroll.expense.read_own"
  | "payroll.expense.read"
  | "payroll.expense.approve"
  | "payroll.expense.reject"
  // Contractor settlement is its own ledger, never employee payroll.
  | "contractor.read" | "contractor.write" | "contractor.approve"
  | "finance.entity.write"
  /* --- B20.13: funding & incentives --- */
  // Reading the opportunity pipeline is broad; recording a claim against an
  // expense is a financial act; loading program knowledge is the act that
  // turns "worth investigating" into a figure and is held narrowly.
  | "funding.read"
  | "funding.manage"
  | "funding.claim"
  | "funding.programs.manage"
  | "portal.compose_own"
  // v20.19 — purchasing and Accounts Payable. Requesting, approving and
  // releasing payment are three grants because they are three people.
  | "roadside.report" | "roadside.manage"
  | "purchasing.request" | "purchasing.approve" | "purchasing.emergency_approve"
  | "vendor.create" | "vendor.bill.review" | "vendor.bill.approve" | "payment.release"
  | "recovery.propose" | "recovery.decide"
  // v20.20 — field devices. Enrolling and rotating your own device is
  // self-scoped in code; revoking one and resolving conflicts are not.
  | "device.enroll_own" | "device.rotate_own" | "device.manage"
  /* P1.2 — running the seal's third leg against the stored object. */
  | "device.verifySeal"
  | "sync.push_own" | "sync.resolve_conflict"
  // v20.21 — compliance master registry. Reading a passport is broad
  // verifying evidence, loading requirements and reading private credential
  // detail are not.
  | "compliance.passport.read" | "compliance.credential.record" | "compliance.credential.verify"
  | "compliance.private.read" | "compliance.consent.record" | "compliance.requirement.manage"
  | "compliance.program.publish" | "compliance.profile.review"
  // C1b-2b — requirement verification through the ledger. Proposing, verifying, second approval of a
  // dispatch-blocking rule, withdrawal and verification governance are separate acts, held separately.
  // Separation of duties is additionally enforced by person (proposer ≠ verifier ≠ second verifier),
  // so holding several of these does not let one person carry a requirement alone.
  | "compliance.requirement.propose" | "compliance.requirement.verify" | "compliance.requirement.second_approve"
  | "compliance.requirement.retire" | "compliance.verification.govern"
  // v20.22 — packs, work authorization, equipment authorization, calibration.
  | "compliance.pack.manage" | "compliance.work.evaluate"
  | "equipment.authorize" | "calibration.record" | "calibration.impact"
  // v20.23 — insurance. A driver sees proof for their unit; dispatch sees
  // "valid"; finance sees premiums; nobody sees claims reserves by accident.
  | "insurance.read_summary" | "insurance.read_policy" | "insurance.write_policy" | "insurance.verify_coverage"
  | "insurance.manage_requirements" | "insurance.certificate.issue"
  | "insurance.claim.read" | "insurance.claim.create" | "insurance.claim.financial"
  // v21.0 — universal surfaces. Exceptions and search are filtered per item
  // by the permission each item needs; these grants open the surface itself.
  | "surface.exceptions.read" | "surface.search" | "surface.timeline.read"
  | "inbox.read_own" | "myday.read_own"
  // v21.1 — the B12 gate, reachable. Evaluating and awarding is dispatch's
  // act; granting an override is a named authority's; an operator may read
  // their own readiness and nobody else's.
  | "dispatch.evaluate" | "dispatch.award" | "dispatch.override.request" | "dispatch.override.grant"
  // 0162 (P3.1): accepting a manifest reference-versus-print contradiction. Held by the same two
  // roles that hold dispatch.override.grant, because it is the same kind of act: a named person
  // taking responsibility for proceeding past a refusal.
  | "manifest.override.grant"
  /*
   * 0163 (P4.2): running a calibration sweep. Deliberately NOT given to the ordinary office role —
   * the sweep names which invoices may rest on a device later found bad, and that list is not
   * something everyone with a desk should be able to produce on a whim. Seeded to management and
   * to the compliance authority; a company may delegate it through the normal grant system.
   *
   * It confers nothing financial. Whoever runs it still cannot approve a credit.
   */
  | "loadsense.calibration.sweep"
  /* P8.2 — changing standing automation policy. Deliberately NOT implied by any operational
     permission: choosing that a machine may act unwatched is a different act from dispatching. */
  | "automation.policy.manage" | "automation.policy.read"
  /* P8.2 — a one-task or one-trip move toward MORE human involvement only. Held widely on purpose;
     it can never increase automation, so it cannot become a way around the permission above. */
  | "automation.override.operational"
  | "dispatch.readiness_own"
  // v21.2 — turning enforcement on or off changes what the company is bound by.
  | "dispatch.enforcement.manage"
  // v21.3 — IFTA. Recording distance is field work; verifying it and
  // classifying fuel is office work; preparing and finalizing the return is
  // finance's.
  | "ifta.distance.record" | "ifta.distance.verify" | "ifta.fuel.classify" | "ifta.read" | "ifta.prepare" | "ifta.finalize"
  // v21.4 — bulk fuel is yard work; statements are finance's; anomalies are read by both.
  | "fuel.tank.manage" | "fuel.dispense.record" | "fuel.reading.record" | "fuel.statement.import" | "fuel.review"
  // v21.5 — closing a period is a filing-grade act; reopening one more so.
  | "period.read" | "period.close" | "period.reopen"
  // v21.8 — GST/HST. Classifying a sale is bookkeeping; finalizing is a filing.
  | "gst.read" | "gst.classify" | "gst.prepare" | "gst.finalize"
  // v21.9 — cash. Importing a bank statement and applying payments is the
  // bookkeeper's; a credit and a write-off are decided by the controller; the
  // collector follows up.
  | "bank.import" | "bank.read" | "ar.payment.record" | "ar.payment.apply" | "ar.read"
  | "ar.credit.request" | "ar.credit.decide" | "ar.collect" | "ar.writeoff.request" | "ar.writeoff.decide"
  // v21.10 — commercial core (internal) and portal review.
  | "commercial.terms.manage" | "commercial.po.record" | "commercial.ratecard.manage" | "commercial.read"
  // v22.7 — Commercial Setup & Rate Resolution: a rate is proposed by one person and approved by another; a margin is management's to see.
  | "commercial.rates.propose" | "commercial.rates.approve" | "commercial.rates.read" | "commercial.pricing.decide" | "commercial.margin.view" | "commercial.setup.write"
  // v23.31 — Customer, Contract & Rate Management: the customer is a record, a contract has a lifecycle, a rate sheet is approved as a versioned unit, and a job freezes its commercial basis.
  | "commercial.customer.read" | "commercial.customer.write" | "commercial.customer.archive"
  | "commercial.contract.read" | "commercial.contract.write" | "commercial.contract.approve" | "commercial.contract.status"
  | "commercial.job.assign" | "commercial.job.snapshot" | "commercial.job.summary" | "commercial.billing.context"
  // v22.9 — an invoice is drafted by the office from a ticket's decisions and finalized by a second permission into a frozen snapshot.
  | "invoicing.draft" | "invoicing.finalize" | "invoicing.read" | "invoicing.render" | "invoicing.send" | "invoicing.void" | "invoicing.dispute.resolve"
  // v22.13 — the mapping foundation: importing open geospatial data, reading it, and verifying a coordinate from the imported grid.
  | "geo.import" | "geo.read" | "geo.locationVerifyFromGrid" | "geo.access.propose" | "geo.access.decide" | "geo.access.passage" | "geo.graph.build"
  // v22.15 — structures on a road, and an approved route that knows when it has gone stale.
  | "spatial.structure.record" | "spatial.structure.verify" | "spatial.route.approve"
  // v22.17 — communications on the route. A frequency is not a permission to transmit,
  // so knowing a channel and being authorized on it are separate grants.
  | "comms.read" | "comms.channel.manage" | "comms.channel.verify"
  | "comms.authorization.manage" | "comms.authorization.verify"
  | "comms.unit.capability" | "comms.assignment.record" | "comms.assignment.verify"
  | "comms.observation.record" | "comms.observation.decide" | "comms.plan.compute"
  // v22.18 — the company's own answer to whether communications stop a truck.
  | "comms.policy.manage" | "comms.policy.approve"
  // v22.20 — the out-of-service release policy, which decides who may release a truck.
  | "oos.policy.manage" | "oos.policy.approve"
  // v22.20 — the enforcement surface. Recording a stop and releasing a truck
  // from a government prohibition are different acts with different authority.
  | "enforcement.read" | "enforcement.capture" | "enforcement.confirm"
  | "enforcement.finding.record" | "enforcement.release" | "enforcement.latch"
  | "enforcement.panel.issue" | "enforcement.panel.view"
  // v22.20 — time off. Reading a schedule and reading a reason are different acts.
  | "timeOff.request" | "timeOff.decide" | "timeOff.schedulingRead"
  // v22.20 — open shifts. Posting work and wanting it are different acts.
  | "shifts.post" | "shifts.read" | "shifts.interest"
  // 0206 — declaring your own availability is a statement about yourself and nobody else.
  | "shifts.availability_own"
  // v22.20 — crews. Reading a forecast and changing who is on a crew differ.
  | "crews.read" | "crews.manage"
  // v22.20 — calendar. Your own is not the same act as somebody else's.
  | "calendar.own" | "calendar.scheduling"
  // v22.20 — readiness. Reading your own is not reading somebody else's.
  | "readiness.read"
  // v22.20 — the read-only assistant. Asking and loading differ.
  | "assistant.ask" | "assistant.curate"
  // v22.20 — the board. Creating a channel is not the same as posting in one.
  | "board.read" | "board.post" | "board.manage"
  // 0205 — publishing company-wide or emergency is not posting; reading a private conversation as
  // a moderator is neither reading nor managing, and every use of it is an event.
  | "board.publish" | "board.moderate"
  // v22.20 — the agent. Asking it to work, acting, and approving differ.
  | "agent.use" | "agent.act" | "agent.approve" | "agent.read"
  // LA-1a — Live Assist, the session spine only.
  | "live_assist.use" | "live_assist.administer" | "live_assist.review"
  // v22.20 — clearing a government data source for operational use.
  | "geo.source.review"
  // v22.19 — the package a truck carries when nothing can be fetched.
  | "comms.package.build" | "comms.package.fetch"
  // v22.20 — hours of service as versioned rules. A verified figure is what a
  // driver's legal driving time is computed from, so verifying is its own act.
  | "hos.read" | "hos.rule.manage" | "hos.rule.verify"
  /* P8.3 — stating a driver's hours for one duty day when the company runs paper logs. */
  | "hos.attest"
  /* P8.3 — putting a scanned log page on file. Retention, not a dispatch answer. */
  | "hos.recordScannedLog"
  // DC-A (0178) — Document Control. Reading the register, taking a document in, confirming
  // what a scan says, issuing a numbered record, voiding a number, and managing the catalog, the
  // series and the templates are each their own act: intake creates a row, confirmation creates a
  // fact, issue consumes a number, void explains a gap.
  | "document.read" | "document.intake" | "document.confirm" | "document.issue" | "document.void"
  | "document.catalog.manage" | "document.series.manage" | "document.template.manage"
  /* P8.5 — the vault. `restricted.read` is the permission the break-glass prompt sits behind; it is
     NOT implied by an administration role, which is the point of the whole subsystem. */
  | "vault.matter.manage" | "restricted.read" | "restricted.audit.read"
  | "portal.identity.manage" | "portal.submission.review"
  // v21.12 — render a frozen revision; propose payroll from a client bonus; record what a person saw.
  | "closeout.document.render" | "closeout.adjustment.payroll_propose" | "observation.record"
  // v21.15 — the shop. Moving stock and installing tires is the mechanic's; a count and a
  // recall verification are the shop lead's; a warranty claim is decided above the shop.
  | "shop.read" | "shop.parts.manage" | "shop.parts.move" | "shop.parts.count" | "shop.tires.manage"
  | "shop.tools.manage" | "shop.warranty.raise" | "shop.warranty.decide" | "shop.recall.record" | "shop.recall.verify"
  // v22.20 — the mechanic's release, which had no procedure until now.
  | "shop.release" | "shop.workorder.advance"
  // v21.16 — capital assets. Registering is bookkeeping; the capital review, the CCA class verification and the
  // schedule review are decisions above it.
  | "asset.read" | "asset.register" | "asset.capital.review" | "asset.cca.classify" | "asset.cca.verify" | "cca.prepare" | "cca.review"
  // v21.17 — commercial projects. Drafting is the office's; issuing a price and approving a budget are decisions.
  | "project.read" | "project.quote.manage" | "project.quote.issue" | "project.change.manage" | "project.rfi.manage" | "project.budget.manage" | "project.budget.approve"
  // v21.18 — the gateway. Registering a machine or a webhook is a door; both are sensitive.
  | "integration.read" | "integration.client.manage" | "integration.webhook.manage"
  // v21.19 — telematics. Reading telemetry is operational; acknowledging a fault is the mechanic's determination;
  // reviewing a driving event is safety's; viewing video identifies a person and is its own permission.
  | "telematics.read" | "telematics.fault.acknowledge" | "safety.event.review" | "safety.video.read"
  // v21.20 — workforce. Applicants are HR's; training is recorded by HR or safety and verified by another;
  // competency is a supervisor's signature; probation is recommended by a supervisor and decided by HR;
  // offboarding is HR's, and revoking access is its own permission.
  | "hr.applicant.manage" | "hr.applicant.read" | "hr.onboarding.manage" | "hr.training.record" | "hr.training.verify"
  | "hr.competency.signoff" | "hr.probation.recommend" | "hr.probation.decide" | "hr.offboarding.manage" | "hr.access.revoke"
  // v21.21 — audit packages. Preparing assembles what exists; releasing sends it out; both are sensitive.
  | "audit.package.prepare" | "audit.package.release" | "audit.package.read"
  // v22.0 — spatial foundation. Registering is the office's; verifying a coordinate, a vehicle profile or a road
  // restriction is a second person's and sensitive; evaluating a route is dispatch's and safety's.
  | "spatial.read" | "spatial.location.manage" | "spatial.location.verify" | "spatial.vehicle.manage" | "spatial.vehicle.verify"
  | "spatial.restriction.record" | "spatial.restriction.verify" | "spatial.route.evaluate"
  // v22.1 — contract terms decide billing answers; approving them is a commercial commitment.
  | "closeout.terms.record" | "closeout.terms.approve"
  // v21.11 — the site sign-off chain. The field records events and witnesses the
  // consultant's signature; the office resolves lines and prepares the supplement.
  | "closeout.ticket.write" | "closeout.event.record" | "closeout.delay.record" | "closeout.sign.witness"
  | "closeout.line.decide" | "closeout.supplement.prepare" | "closeout.authority.manage" | "closeout.read"
  // v22.21 — Training Academy. Learner permissions are universal but self-scoped in the router.
  | "academy.read_own" | "academy.progress_own" | "academy.assessment_own" | "academy.certificate.sign_own" | "academy.direct_supervision_attest_own"
  | "academy.assign" | "academy.manage" | "academy.evaluate" | "academy.source.review"
  | "academy.certificate.issue" | "academy.requirement.manage" | "academy.direct_supervision.manage"
  // 0212 — Driver Portfolio. The `_own` three are universal and self-scoped in the router: they read
  // the operator linked to ctx.user.id and take no operator id. Reading another driver's portfolio is
  // safety/HR/management's; managing requirements is safety's and management's. Verification reuses
  // compliance.credential.verify, and dispatch's view reuses dispatch.read.
  | "portfolio.read_own" | "portfolio.submit_own" | "portfolio.share_own"
  | "portfolio.read" | "portfolio.requirement.manage"
  // 0199 — fleet maintenance, checkpoint 1. Assigning a work order names who owns the repair; cancelling
  // one can leave a defect unrepaired, so it is sensitive.
  | "maintenance.workorder.assign" | "maintenance.workorder.cancel"
  // 0200 — the Fleet & Equipment Portfolio's foundation. Placing and releasing a hold decide whether a
  // unit may move, and verifying a meter reading makes it count; all three are sensitive. Which hold
  // TYPES a role may place or release is decided in `_core/fleetPortfolio.ts`, below the permission.
  | "fleet.hold.place" | "fleet.hold.release" | "fleet.meter.record" | "fleet.meter.verify"
  // 0221 — fleet maintenance, checkpoint 2. Triage decides a defect's severity (lowering a critical frees
  // a safety hold); return to service is the second person's verification that lifts a defect's hold.
  | "maintenance.defect.triage" | "maintenance.defect.send_to_shop" | "maintenance.task.write"
  | "maintenance.return_to_service.record"
  // SA1 — Sign & Attest (docs/sign-attest/SIGN_ATTEST_DESIGN.md §13). Opening a revision fixes a hash;
  // placing fields and assigning signers shape what is signed; signing is self-scoped; witnessing is
  // the one act that places another person's mark and says so; finalize, void, supersede and export
  // are evidence acts. All but the reads are SENSITIVE.
  | "attest.read" | "attest.document.open" | "attest.field.place" | "attest.signer.assign"
  | "attest.sign_own" | "attest.decline_own" | "attest.witness"
  | "attest.finalize" | "attest.void" | "attest.supersede" | "attest.export"
  // 0228 — Safety & Compliance Program Builder. read_own / acknowledge_own are universal and self-scoped
  // in the router (the caller's own policies, the caller's own signature); manage, approve and verify are
  // the acts that change what the company is taken to require, make a version binding, or close a loop.
  | "safety_program.read" | "safety_program.write" | "safety_program.manage" | "safety_program.approve" | "safety_program.verify"
  | "safety_program.read_own" | "safety_program.acknowledge_own";

/** The read categories, so a coverage test can assert none is orphaned. */
export const EVIDENCE_READ_CATEGORIES: readonly Permission[] = [
  "evidence.read_maintenance",
  "evidence.read_job_operational",
  "evidence.read_safety_summary",
  "evidence.read_commercial",
  "evidence.read_personnel",
  "evidence.read_legal",
] as const;

/**
 * Grants written out per role rather than composed from inheritance. An
 * inheritance graph is where a permission ends up somewhere nobody intended and
 * nobody notices.
 */
const GRANTS: Record<DomainRole, readonly Permission[]> = {
  driver: [
    // P4 (0235) — one's own employee expense claims.
    "payroll.expense.submit_own",
    "payroll.expense.read_own",
    // SA1 — Sign & Attest
    "attest.read",
    "attest.document.open",
    "attest.field.place",
    "attest.witness",
    "commercial.job.summary",
    "live_assist.use",
    "document.read",
    "document.intake",
    "automation.override.operational",
    "facility.directory.report",
    "facility.directory.read",
    "assistant.ask",
    "board.read",
    "board.post",
    "readiness.read",
    "calendar.own",
    "crews.read",
    "shifts.read",
    "shifts.interest",
    "timeOff.request",
    "enforcement.panel.issue",
    "enforcement.panel.view",
    "enforcement.latch",
    "enforcement.read",
    "enforcement.capture",
    "comms.package.fetch",
    /* v22.17 — communications */
    "comms.read",
    "comms.observation.record",
    "evidence.seal",
    "evidence.send",
    "evidence.read_own",
    "evidence.browse",
    "evidence.delete_device_copy",
    "incident.create",
    "roadside.open",
    // Field acts a driver genuinely performs: signing off at a job, filing a
    // tailgate meeting, reporting a defect they observed.
    "compliance.sign",
    "safety.write",
    "maintenance.write_defect",
    // Their own pay, and their own personal tax organizer. Nobody else's.
    "payroll.read_own",
    "tax.expense.create",
    "job.read",
    "trip.read",
    "trip.write",
    "load.read",
    "load.write",
    "manifest.read",
    "manifest.write",
    "delivery.read",
    "delivery.write",
    "hos.read",
    "hos.write",
    "gps.submit",
    "gps.read",
    "inspection.read",
    "inspection.write",
    "fleet.read",
    "reference.read",
    "evidence.upload",
    "scan.write",
    "assistant.read",
    "assistant.use",
    "transfer.acknowledge",
    "payroll.time.submit_own",
    // P3 (0234) — one's own payroll time and candidates; and, gated again by the D10 crew-supervisor relationship,
    // the team view, approval and rejection. The role alone approves nothing.
    "payroll.time.read_own",
    "payroll.time.read_team",
    "payroll.time.approve",
    "payroll.time.reject",
    "payroll.dispute.raise_own",
    "roadside.report",
    "purchasing.request",
    "compliance.passport.read",
    "compliance.credential.record",
    "compliance.work.evaluate",
    "insurance.read_summary",
    "surface.exceptions.read",
    "surface.search",
    "surface.timeline.read",
    "ifta.distance.record",
    "fuel.dispense.record",
    "closeout.ticket.write",
    "closeout.event.record",
    "closeout.delay.record",
    "closeout.sign.witness",
    "closeout.read",
    "observation.record",
    "spatial.read",
    "geo.read",
    "geo.access.propose",
    "geo.access.passage",
    "spatial.structure.record",
  ],
  dispatcher: [
    // P4 (0235) — one's own employee expense claims.
    "payroll.expense.submit_own",
    "payroll.expense.read_own",
    // 0221 — opening a work order from a defect.
    "maintenance.defect.send_to_shop",
    // SA1 — Sign & Attest
    "attest.read",
    "attest.document.open",
    "attest.field.place",
    "attest.signer.assign",
    "board.publish",
    "live_assist.use",
    "document.read",
    "document.intake",
    "document.confirm",
    "hos.recordScannedLog",
    "hos.attest",
    "automation.policy.read",
    "automation.override.operational",
    "facility.directory.report",
    "facility.directory.write",
    "facility.directory.read",
    "academy.direct_supervision.manage",
    "assistant.ask",
    "agent.use",
    "agent.act",
    "agent.read",
    "board.read",
    "board.post",
    "board.manage",
    "readiness.read",
    "calendar.own",
    "calendar.scheduling",
    "crews.read",
    "crews.manage",
    "shifts.read",
    "shifts.post",
    "timeOff.request",
    "timeOff.schedulingRead",
    "enforcement.panel.issue",
    "enforcement.panel.view",
    "enforcement.latch",
    "enforcement.read",
    "hos.read",
    "comms.package.build",
    "comms.package.fetch",
    /* v22.17 — communications */
    "comms.read",
    "comms.plan.compute",
    "evidence.read_job_operational",
    "evidence.browse",
    "incident.create",
    // Summary only. A dispatcher must know a unit is unavailable; they do not
    // need the operator's injury details to reassign a job.
    "incident.read_summary",
    "maintenance.read_defect",
    // Needed to assign work: who is available, and is their paperwork current.
    "personnel.read",
    "compliance.read",
    "job.read",
    "job.write",
    "trip.read",
    "trip.write",
    "load.read",
    "manifest.read",
    "delivery.read",
    "delivery.write",
    "dispatch.read",
    "dispatch.assign",
    "fleet.read",
    "fleet.write",
    "reference.read",
    "reference.write",
    "inspection.read",
    "hos.read",
    "gps.read",
    "route.read",
    "route.write",
    "scan.read",
    "assistant.read",
    "assistant.use",
    "funding.read",
    "roadside.report",
    "roadside.manage",
    "purchasing.request",
    "compliance.passport.read",
    "compliance.work.evaluate",
    "insurance.read_summary",
    "surface.exceptions.read",
    "surface.search",
    "surface.timeline.read",
    "dispatch.evaluate",
    "dispatch.award",
    "dispatch.override.request",
    "dispatch.override.grant",
    "manifest.override.grant",
    "ifta.distance.record",
    "ifta.read",
    "fuel.review",
    "commercial.read",
    "commercial.customer.read",
    "commercial.contract.read",
    "commercial.job.assign",
    "commercial.job.snapshot",
    "commercial.job.summary",
    "commercial.rates.propose",
    "commercial.rates.read",
    "closeout.ticket.write",
    "closeout.event.record",
    "closeout.delay.record",
    "closeout.read",
    "observation.record",
    "shop.read",
    "project.read",
    "project.change.manage",
    "project.rfi.manage",
    "integration.read",
    "telematics.read",
    "hr.probation.recommend",
    "spatial.read",
    "spatial.location.manage",
    "spatial.restriction.record",
    "spatial.route.evaluate",
    "geo.read",
    "geo.access.propose",
    "geo.access.decide",
  "spatial.structure.verify",
  "spatial.route.approve",
    "geo.access.passage",
    "spatial.structure.record",
  ],
  mechanic: [
    // P4 (0235) — one's own employee expense claims.
    "payroll.expense.submit_own",
    "payroll.expense.read_own",
    "live_assist.use",
    "document.read",
    "document.intake",
    "assistant.ask",
    "board.read",
    "board.post",
    "readiness.read",
    "calendar.own",
    "crews.read",
    "shifts.read",
    "shifts.interest",
    "timeOff.request",
    "shop.workorder.advance",
    "shop.release",
    "enforcement.latch",
    "enforcement.read",
    "enforcement.finding.record",
    /* v22.17 — communications */
    "comms.read",
    // The shop reaches maintenance history and the operational context of the
    // job the unit was on. It is not granted commercial or personnel reads at
    // all, so nothing has to be subtracted later.
    "evidence.read_maintenance",
    "evidence.browse",
    "evidence.read_job_operational",
    "maintenance.read_defect",
    "maintenance.write_defect",
    "maintenance.write_work_order",
    "maintenance.record_release",
    "compliance.read",
    "incident.create",
    "incident.read_summary",
    "payroll.read_own",
    "tax.expense.create",
    "fleet.read",
    "inspection.read",
    "inspection.write",
    "reference.read",
    "job.read",
    "trip.read",
    "scan.read",
    "assistant.read",
    "assistant.use",
    "evidence.upload",
    "payroll.time.submit_own",
    // P3 (0234) — one's own payroll time and candidates; and, gated again by the D10 crew-supervisor relationship,
    // the team view, approval and rejection. The role alone approves nothing.
    "payroll.time.read_own",
    "payroll.time.read_team",
    "payroll.time.approve",
    "payroll.time.reject",
    "payroll.dispute.raise_own",
    "roadside.report",
    "purchasing.request",
    "compliance.passport.read",
    "compliance.credential.record",
    "compliance.work.evaluate",
    "calibration.record",
    "insurance.read_summary",
    "surface.exceptions.read",
    "surface.search",
    "surface.timeline.read",
    "fuel.dispense.record",
    "fuel.reading.record",
    "shop.read",
    "shop.parts.move",
    "shop.tires.manage",
    "shop.tools.manage",
    "shop.warranty.raise",
    "shop.recall.record",
    "telematics.read",
    "telematics.fault.acknowledge",
    "spatial.read",
    "spatial.vehicle.manage",
    // 0200 — Fleet & Equipment Portfolio foundation.
    "fleet.hold.place",
    "fleet.hold.release",
    "fleet.meter.record",
    // 0221 — fleet maintenance, checkpoint 2: triage, send to shop, the repair's tasks, return to service.
    "maintenance.defect.triage",
    "maintenance.defect.send_to_shop",
    "maintenance.task.write",
    "maintenance.return_to_service.record",
    "fleet.meter.verify",
  ],
  shop_lead: [
    // P4 (0235) — one's own employee expense claims.
    "payroll.expense.submit_own",
    "payroll.expense.read_own",
    "live_assist.use",
    "document.read",
    "document.intake",
    "document.confirm",
    "facility.directory.read",
    "academy.evaluate",
    "assistant.ask",
    "agent.read",
    "board.read",
    "board.post",
    "readiness.read",
    "calendar.own",
    "calendar.scheduling",
    "crews.read",
    "crews.manage",
    "shifts.read",
    "shifts.post",
    "timeOff.request",
    "timeOff.decide",
    "timeOff.schedulingRead",
    "shop.workorder.advance",
    "shop.release",
    "enforcement.latch",
    "enforcement.read",
    "enforcement.finding.record",
    /* v22.17 — communications */
    "comms.read",
    "comms.unit.capability",
    "evidence.read_maintenance",
    "evidence.browse",
    "evidence.read_job_operational",
    "maintenance.read_defect",
    "maintenance.write_defect",
    "maintenance.write_work_order",
    "maintenance.record_release",
    "maintenance.revoke_release",
    "compliance.read",
    "incident.create",
    "incident.read_summary",
    "payroll.read_own",
    "tax.expense.create",
    "fleet.read",
    "fleet.write",
    "inspection.read",
    "inspection.write",
    "reference.read",
    "job.read",
    "trip.read",
    "scan.read",
    "assistant.read",
    "assistant.use",
    "evidence.upload",
    "payroll.time.submit_own",
    // P3 (0234) — one's own payroll time and candidates; and, gated again by the D10 crew-supervisor relationship,
    // the team view, approval and rejection. The role alone approves nothing.
    "payroll.time.read_own",
    "payroll.time.read_team",
    "payroll.time.approve",
    "payroll.time.reject",
    "payroll.dispute.raise_own",
    "funding.read",
    "roadside.report",
    "roadside.manage",
    "purchasing.request",
    "purchasing.approve",
    "vendor.create",
    "compliance.passport.read",
    "compliance.credential.record",
    "compliance.credential.verify",
    "compliance.work.evaluate",
    "calibration.record",
    "calibration.impact",
    "surface.exceptions.read",
    "surface.search",
    "surface.timeline.read",
    "fuel.tank.manage",
    "fuel.dispense.record",
    "fuel.reading.record",
    "fuel.review",
    "shop.read",
    "shop.parts.manage",
    "shop.parts.move",
    "shop.parts.count",
    "shop.tires.manage",
    "shop.tools.manage",
    "shop.warranty.raise",
    "shop.recall.record",
    "shop.recall.verify",
    "asset.read",
    "telematics.read",
    "telematics.fault.acknowledge",
    "hr.competency.signoff",
    "hr.probation.recommend",
    "spatial.read",
    "spatial.vehicle.manage",
    "spatial.vehicle.verify",
    // 0199 — fleet maintenance, checkpoint 1.
    "maintenance.workorder.assign",
    "maintenance.workorder.cancel",
    // 0200 — Fleet & Equipment Portfolio foundation.
    "fleet.hold.place",
    "fleet.hold.release",
    "fleet.meter.record",
    // 0221 — fleet maintenance, checkpoint 2.
    "maintenance.defect.triage",
    "maintenance.defect.send_to_shop",
    "maintenance.task.write",
    "maintenance.return_to_service.record",
    "fleet.meter.verify",
  ],
  safety: [
    // P4 (0235) — one's own employee expense claims.
    "payroll.expense.submit_own",
    "payroll.expense.read_own",
    // P3 (0234) — the team view, approval and rejection of payroll time, gated again by the D10 crew-supervisor relationship.
    "payroll.time.read_team",
    "payroll.time.approve",
    "payroll.time.reject",
    "portfolio.read",
    "portfolio.requirement.manage",
    // SA1 — Sign & Attest
    "attest.read",
    "attest.document.open",
    "attest.field.place",
    "attest.signer.assign",
    "attest.witness",
    "attest.finalize",
    "board.publish",
    "board.moderate",
    "live_assist.review",
    "document.read",
    "document.intake",
    "document.confirm",
    "document.issue",
    /* C1b-2b — requirement verification */
    "compliance.requirement.propose",
    "compliance.requirement.verify",
    "safety_program.read",
    "safety_program.write",
    "safety_program.manage",
    "safety_program.approve",
    "safety_program.verify",
    "device.verifySeal",
    "vault.matter.manage",
    "hos.recordScannedLog",
    "hos.attest",
    "automation.policy.read",
    "facility.directory.report",
    "facility.directory.review",
    "facility.directory.write",
    "facility.directory.read",
    "academy.assign",
    "academy.manage",
    "academy.evaluate",
    "academy.source.review",
    "academy.certificate.issue",
    "academy.requirement.manage",
    "academy.direct_supervision.manage",
    "assistant.ask",
    "assistant.curate",
    "agent.read",
    "agent.approve",
    "board.read",
    "board.post",
    "board.manage",
    "readiness.read",
    "calendar.own",
    "calendar.scheduling",
    "crews.read",
    "shifts.read",
    "timeOff.request",
    "timeOff.schedulingRead",
    "enforcement.panel.issue",
    "enforcement.panel.view",
    "enforcement.latch",
    "enforcement.read",
    "enforcement.capture",
    "enforcement.confirm",
    "enforcement.finding.record",
    "enforcement.release",
    "oos.policy.manage",
    "hos.read",
    "comms.package.build",
    "comms.policy.manage",
    /* v22.17 — communications */
    "comms.read",
    "comms.assignment.record",
    "comms.assignment.verify",
    "comms.observation.decide",
    "comms.plan.compute",
    "evidence.read_safety_summary",
    "evidence.browse",
    "evidence.read_job_operational",
    "evidence.read_maintenance",
    "evidence.export",
    "incident.create",
    "incident.read_summary",
    "incident.read_investigation",
    "incident.review",
    "maintenance.read_defect",
    "safety.write",
    "compliance.read",
    "compliance.write",
    "compliance.review",
    "job.read",
    "trip.read",
    "load.read",
    "manifest.read",
    "fleet.read",
    "inspection.read",
    "inspection.write",
    "hos.read",
    "gps.read",
    "route.read",
    "reference.read",
    "scan.read",
    "assistant.read",
    "delivery.read",
    "funding.read",
    "device.manage",
    "compliance.passport.read",
    "compliance.credential.record",
    "compliance.credential.verify",
    "compliance.consent.record",
    "compliance.program.publish",
    "compliance.profile.review",
    "compliance.work.evaluate",
    "equipment.authorize",
    "calibration.impact",
    "insurance.read_summary",
    "insurance.read_policy",
    "insurance.claim.read",
    "insurance.claim.create",
    "surface.exceptions.read",
    "surface.search",
    "surface.timeline.read",
    "dispatch.evaluate",
    "closeout.delay.record",
    "closeout.read",
    "observation.record",
    "shop.read",
    "shop.recall.record",
    "shop.recall.verify",
    "telematics.read",
    "safety.event.review",
    "safety.video.read",
    "hr.onboarding.manage",
    "hr.training.record",
    "hr.training.verify",
    "hr.competency.signoff",
    "audit.package.prepare",
    "audit.package.read",
    "spatial.read",
    "spatial.location.verify",
    "spatial.restriction.record",
    "spatial.restriction.verify",
    "spatial.route.evaluate",
    "geo.read",
    "spatial.structure.record",
    "spatial.structure.verify",
      // 0163 (P4.2): the designated compliance authority named in the owner decision.
    "loadsense.calibration.sweep",
    // 0200 — Fleet & Equipment Portfolio foundation.
    "fleet.hold.place",
    "fleet.hold.release",
    // 0221 — the second person who returns a unit to service; a critical defect's safety hold is theirs to lift.
    "maintenance.return_to_service.record",
    // 0221 — and they decide severity: lowering a critical defect frees its safety hold, which safety may release.
    "maintenance.defect.triage",
  ],
  office: [
    // P4 (0235) — one's own employee expense claims.
    "payroll.expense.submit_own",
    "payroll.expense.read_own",
    // SA1 — Sign & Attest
    "attest.read",
    "attest.document.open",
    "attest.field.place",
    "attest.signer.assign",
    "attest.witness",
    "attest.finalize",
    "attest.void",
    "attest.supersede",
    "attest.export",
    "live_assist.use",
    "document.read",
    "document.intake",
    "document.confirm",
    "document.issue",
    "document.void",
    "document.template.manage",
    "safety_program.read",
    "device.verifySeal",
    "vault.matter.manage",
    "hos.recordScannedLog",
    "automation.policy.read",
    "facility.directory.report",
    "facility.directory.write",
    "facility.directory.read",
    "commercial.read",
    "commercial.customer.read",
    "commercial.customer.write",
    "commercial.contract.read",
    "commercial.contract.write",
    "commercial.job.assign",
    "commercial.job.snapshot",
    "commercial.job.summary",
    "commercial.billing.context",
    "commercial.write",
    "assistant.ask",
    "agent.use",
    "agent.act",
    "agent.read",
    "board.read",
    "board.post",
    "readiness.read",
    "calendar.own",
    "calendar.scheduling",
    "crews.read",
    "shifts.read",
    "timeOff.request",
    "timeOff.schedulingRead",
    "enforcement.latch",
    "enforcement.read",
    "hos.read",
    "comms.package.build",
    /* v22.17 — communications */
    "comms.read",
    "comms.plan.compute",
    "comms.assignment.record",
    "evidence.read_job_operational",
    "evidence.browse",
    "evidence.read_commercial",
    "evidence.read_safety_summary",
    "evidence.read_maintenance",
    "evidence.export",
    "evidence.amend",
    "incident.create",
    "incident.read_summary",
    "billing.read",
    "billing.write",
    "personnel.read",
    "personnel.write",
    "compliance.read",
    "compliance.write",
    "compliance.review",
    "compliance.sign",
    "maintenance.read_defect",
    "maintenance.write_defect",
    "maintenance.write_work_order",
    "job.read",
    "job.write",
    "trip.read",
    "trip.write",
    "load.read",
    "load.write",
    "manifest.read",
    "manifest.write",
    "delivery.read",
    "delivery.write",
    "dispatch.read",
    "fleet.read",
    "fleet.write",
    "reference.read",
    "reference.write",
    "inspection.read",
    "hos.read",
    "gps.read",
    "gps.confirm",
    "route.read",
    "route.write",
    "evidence.upload",
    "evidence.verify",
    "scan.read",
    "scan.write",
    "assistant.read",
    "assistant.use",
    "assistant.review",
    "assistant.commit",
    // HOS amendments and office review: a duty record must be correctable
    // by someone other than the driver who recorded it.
    "hos.write",
    "contractor.read",
    "contractor.write",
    "tax.expense.create",
    "funding.read",
    "funding.manage",
    "roadside.report",
    "roadside.manage",
    "purchasing.request",
    "vendor.create",
    "vendor.bill.review",
    "recovery.propose",
    "sync.resolve_conflict",
    "compliance.passport.read",
    "compliance.credential.record",
    "compliance.credential.verify",
    "compliance.consent.record",
    "compliance.work.evaluate",
    "calibration.impact",
    "insurance.read_summary",
    "insurance.read_policy",
    "insurance.write_policy",
    "insurance.verify_coverage",
    "insurance.manage_requirements",
    "insurance.certificate.issue",
    "insurance.claim.read",
    "insurance.claim.create",
    "surface.exceptions.read",
    "surface.search",
    "surface.timeline.read",
    "dispatch.evaluate",
    "dispatch.override.request",
    "ifta.distance.record",
    "ifta.distance.verify",
    "ifta.fuel.classify",
    "ifta.read",
    "fuel.reading.record",
    "fuel.review",
    "period.read",
    "gst.classify",
    "ar.payment.record",
    "ar.read",
    "ar.collect",
    "ar.credit.request",
    "commercial.po.record",
    "commercial.read",
    "commercial.rates.propose",
    "commercial.rates.read",
    "invoicing.draft",
    "invoicing.read",
    "invoicing.render",
    "invoicing.send",
    "commercial.pricing.decide",
    "portal.submission.review",
    "closeout.ticket.write",
    "closeout.event.record",
    "closeout.delay.record",
    "closeout.sign.witness",
    "closeout.line.decide",
    "closeout.supplement.prepare",
    "closeout.authority.manage",
    "closeout.read",
    "closeout.document.render",
    "observation.record",
    "project.read",
    "project.quote.manage",
    "project.change.manage",
    "project.rfi.manage",
    "project.budget.manage",
    "audit.package.prepare",
    "audit.package.read",
    "spatial.read",
    "spatial.location.manage",
    "spatial.restriction.record",
    "closeout.terms.record",
    "geo.read",
    "geo.access.propose",
    "geo.access.decide",
    "geo.access.passage",
    "spatial.structure.record",
    // 0200 — Fleet & Equipment Portfolio foundation.
    "fleet.meter.record",
    // 0221 — opening a work order from a defect.
    "maintenance.defect.send_to_shop",
  ],
  management: [
    // P4 (0235) — one's own employee expense claims.
    "payroll.expense.submit_own",
    "payroll.expense.read_own",
    // P3 (0234) — the team view, approval and rejection of payroll time, gated again by the D10 crew-supervisor relationship.
    "payroll.time.read_team",
    "payroll.time.approve",
    "payroll.time.reject",
    "portfolio.read",
    "portfolio.requirement.manage",
    // SA1 — Sign & Attest
    "attest.read",
    "attest.document.open",
    "attest.field.place",
    "attest.signer.assign",
    "attest.witness",
    "attest.finalize",
    "attest.void",
    "attest.supersede",
    "attest.export",
    "board.publish",
    "board.moderate",
    "live_assist.use",
    "live_assist.administer",
    "live_assist.review",
    "document.read",
    "document.intake",
    "document.confirm",
    "document.issue",
    "document.void",
    "document.catalog.manage",
    "document.series.manage",
    "document.template.manage",
    /* C1b-2b — requirement verification */
    "compliance.requirement.verify",
    "compliance.requirement.second_approve",
    "compliance.requirement.retire",
    "compliance.verification.govern",
    "safety_program.read",
    "safety_program.write",
    "safety_program.manage",
    "safety_program.approve",
    "safety_program.verify",
    "device.verifySeal",
    "vault.matter.manage",
    "restricted.read",
    "restricted.audit.read",
    "hos.recordScannedLog",
    "hos.attest",
    "automation.policy.read",
    "automation.policy.manage",
    "automation.override.operational",
    "facility.directory.report",
    "facility.directory.review",
    "facility.directory.write",
    "facility.directory.read",
    // P7.4/P7.5 — the approval ladder names management above the first tier for write-offs and payments too (credits and bills were already here).
    "ar.writeoff.decide",
    "payment.release",
    "commercial.read",
    "commercial.customer.read",
    "commercial.customer.write",
    "commercial.customer.archive",
    "commercial.contract.read",
    "commercial.contract.write",
    "commercial.contract.approve",
    "commercial.contract.status",
    "commercial.job.assign",
    "commercial.job.snapshot",
    "commercial.job.summary",
    "commercial.billing.context",
    "commercial.write",
    "commercial.policy",
    "academy.assign",
    "academy.manage",
    "academy.evaluate",
    "academy.source.review",
    "academy.certificate.issue",
    "academy.requirement.manage",
    "academy.direct_supervision.manage",
    "assistant.ask",
    "assistant.curate",
    "agent.use",
    "agent.act",
    "agent.read",
    "agent.approve",
    "board.read",
    "board.post",
    "board.manage",
    "readiness.read",
    "calendar.own",
    "calendar.scheduling",
    "crews.read",
    "crews.manage",
    "shifts.read",
    "shifts.post",
    "shifts.interest",
    "timeOff.request",
    "timeOff.decide",
    "timeOff.schedulingRead",
    "enforcement.panel.issue",
    "enforcement.panel.view",
    "shop.workorder.advance",
    "shop.release",
    "enforcement.latch",
    "enforcement.read",
    "enforcement.capture",
    "enforcement.confirm",
    "enforcement.finding.record",
    "enforcement.release",
    "oos.policy.manage",
    "oos.policy.approve",
    "geo.source.review",
    "hos.read",
    "hos.rule.manage",
    "hos.rule.verify",
    "comms.package.build",
    "comms.package.fetch",
    "comms.policy.manage",
    "comms.policy.approve",
    /* v22.17 — communications */
    "comms.read",
    "comms.channel.manage",
    "comms.channel.verify",
    "comms.authorization.manage",
    "comms.authorization.verify",
    "comms.unit.capability",
    "comms.assignment.record",
    "comms.assignment.verify",
    "comms.observation.record",
    "comms.observation.decide",
    "comms.plan.compute",
    "evidence.read_job_operational",
    "evidence.browse",
    "evidence.read_commercial",
    "evidence.read_safety_summary",
    "evidence.read_maintenance",
    "evidence.export",
    "evidence.amend",
    "incident.create",
    "incident.read_summary",
    "incident.read_investigation",
    "incident.review",
    "maintenance.read_defect",
    "maintenance.write_work_order",
    "maintenance.revoke_release",
    "billing.read",
    "billing.write",
    "personnel.read",
    "personnel.write",
    "compliance.read",
    "compliance.write",
    "compliance.review",
    "safety.write",
    "legal_hold.place",
    "retention.dispose",
    "roles.grant",
    "job.read",
    "job.write",
    "trip.read",
    "trip.write",
    "load.read",
    "load.write",
    "manifest.read",
    "manifest.write",
    "delivery.read",
    "delivery.write",
    "dispatch.read",
    "dispatch.assign",
    "transfer.acknowledge",
    "fleet.read",
    "fleet.write",
    "reference.read",
    "reference.write",
    "inspection.read",
    "hos.read",
    "gps.read",
    "gps.confirm",
    "route.read",
    "route.write",
    "route.decide",
    "evidence.upload",
    "evidence.verify",
    "scan.read",
    "scan.write",
    "assistant.read",
    "assistant.use",
    "assistant.review",
    "assistant.commit",
    // HOS amendments and office review: a duty record must be correctable
    // by someone other than the driver who recorded it.
    "hos.write",
    "contractor.read",
    "contractor.write",
    "contractor.approve",
    "finance.entity.write",
    "tax.expense.create",
    "funding.read",
    "funding.manage",
    "funding.claim",
    "roadside.report",
    "roadside.manage",
    "purchasing.request",
    "purchasing.approve",
    "purchasing.emergency_approve",
    "vendor.create",
    "vendor.bill.review",
    "vendor.bill.approve",
    "recovery.propose",
    "recovery.decide",
    "device.manage",
    "sync.resolve_conflict",
    "compliance.passport.read",
    "compliance.credential.verify",
    "compliance.program.publish",
    "compliance.profile.review",
    "compliance.pack.manage",
    "compliance.work.evaluate",
    "equipment.authorize",
    "calibration.impact",
    "insurance.read_summary",
    "insurance.read_policy",
    "insurance.write_policy",
    "insurance.verify_coverage",
    "insurance.manage_requirements",
    "insurance.certificate.issue",
    "insurance.claim.read",
    "insurance.claim.create",
    "insurance.claim.financial",
    "surface.exceptions.read",
    "surface.search",
    "surface.timeline.read",
    "dispatch.evaluate",
    "dispatch.award",
    "dispatch.override.request",
    "dispatch.override.grant",
    "manifest.override.grant",
    "loadsense.calibration.sweep",
    "dispatch.enforcement.manage",
    "ifta.read",
    "fuel.tank.manage",
    "fuel.review",
    "period.read",
    "gst.read",
    "bank.read",
    "ar.read",
    "ar.credit.decide",
    "commercial.terms.manage",
    "commercial.ratecard.manage",
    "commercial.read",
    "commercial.rates.propose",
    "commercial.rates.approve",
    "commercial.rates.read",
    "invoicing.draft",
    "invoicing.finalize",
    "invoicing.void",
  "geo.import",
  "geo.locationVerifyFromGrid",
  "geo.access.decide",
    "invoicing.dispute.resolve",
  "invoicing.void",
  "invoicing.dispute.resolve",
    "invoicing.read",
    "invoicing.render",
    "invoicing.send",
    "commercial.pricing.decide",
    "commercial.margin.view",
    "commercial.setup.write",
    "portal.identity.manage",
    "closeout.authority.manage",
    "closeout.read",
    "shop.read",
    "shop.warranty.decide",
    "asset.read",
    "asset.capital.review",
    "project.read",
    "project.quote.manage",
    "project.quote.issue",
    "project.change.manage",
    "project.rfi.manage",
    "project.budget.manage",
    "project.budget.approve",
    "integration.read",
    "integration.client.manage",
    "integration.webhook.manage",
    "telematics.read",
    "safety.event.review",
    "safety.video.read",
    "hr.applicant.read",
    "hr.competency.signoff",
    "hr.probation.recommend",
    "audit.package.release",
    "audit.package.read",
    "spatial.read",
    "spatial.location.verify",
    "spatial.restriction.verify",
    "spatial.route.evaluate",
    "geo.read",
    "closeout.terms.approve",
    "geo.access.propose",
    "geo.access.passage",
    "spatial.structure.record",
    "spatial.structure.verify",
    "spatial.route.approve",
    "geo.graph.build",
    // 0199 — fleet maintenance, checkpoint 1.
    "maintenance.workorder.assign",
    "maintenance.workorder.cancel",
    // 0200 — Fleet & Equipment Portfolio foundation.
    "fleet.hold.place",
    "fleet.hold.release",
    // 0221 — return to service (a safety hold is management's or safety's to lift).
    "maintenance.return_to_service.record",
    "fleet.meter.verify",
  ],
  hr: [
    // P4 (0235) — employee expense claims: one's own, and the payroll office's review and decision.
    "payroll.expense.submit_own",
    "payroll.expense.read_own",
    "payroll.expense.read",
    "payroll.expense.approve",
    "payroll.expense.reject",
    "portfolio.read",
    "document.read",
    "safety_program.read",
    "safety_program.write",
    "academy.assign",
    "academy.manage",
    "academy.evaluate",
    "academy.certificate.issue",
    "evidence.read_personnel",
    "evidence.browse",
    "incident.read_summary",
    "incident.read_investigation",
    "payroll.read",
    "payroll.read_own",
    "payroll.read_employee",
    "payroll.review",
    // P3 (0234) — reads payroll exceptions; keeps the earning approval it held through payroll.review.
    "payroll.exception.read",
    "payroll.earning.approve",
    "payroll.compensation.read",
    "payroll.compensation.propose",
    "payroll.schedule.read",
    "personnel.read",
    "personnel.write",
    "hos.read",
    "payroll.profile.write",
    "funding.read",
    "funding.manage",
    "compliance.passport.read",
    "compliance.credential.record",
    "compliance.credential.verify",
    "compliance.private.read",
    "compliance.consent.record",
    "surface.exceptions.read",
    "surface.search",
    "surface.timeline.read",
    "hr.applicant.manage",
    "hr.applicant.read",
    "hr.onboarding.manage",
    "hr.training.record",
    "hr.training.verify",
    "hr.probation.decide",
    "hr.offboarding.manage",
    "hr.access.revoke",
    "audit.package.read",
  ],
  legal: [
    "commercial.customer.read",
    "commercial.contract.read",
    "commercial.contract.write",
    "commercial.contract.approve",
    "document.read",
    /* C1b-2b — requirement verification */
    "compliance.requirement.propose",
    "compliance.requirement.verify",
    "compliance.requirement.second_approve",
    "compliance.verification.govern",
    "safety_program.read",
    "evidence.read_legal",
    "evidence.browse",
    "evidence.read_safety_summary",
    "evidence.read_job_operational",
    "evidence.export",
    "incident.read_summary",
    "incident.read_investigation",
    "legal_hold.place",
    // Releasing a hold is deliberately narrower than placing one.
    "legal_hold.release",
    "compliance.read",
    "job.read",
    "trip.read",
    "load.read",
    "manifest.read",
    "hos.read",
    "gps.read",
    "route.read",
    "surface.exceptions.read",
    "surface.search",
    "surface.timeline.read",
    "audit.package.prepare",
    "audit.package.release",
    "audit.package.read",
    "closeout.terms.record",
    "closeout.terms.approve",
  ],
  auditor: [
    // SA1 — Sign & Attest
    "attest.read",
    "attest.export",
    "document.read",
    "safety_program.read",
    "facility.directory.read",
    "evidence.read_job_operational",
    "evidence.browse",
    "evidence.read_safety_summary",
    "evidence.read_maintenance",
    "evidence.export",
    "incident.read_summary",
    "compliance.read",
    "tax.read_business",
    "tax.year_end.read",
    "job.read",
    "trip.read",
    "load.read",
    "manifest.read",
    "delivery.read",
    "fleet.read",
    "inspection.read",
    "hos.read",
    "gps.read",
    "route.read",
    "reference.read",
    "scan.read",
    "assistant.read",
    "dispatch.read",
    "funding.read",
    "compliance.passport.read",
    "insurance.read_summary",
    "insurance.read_policy",
    "insurance.claim.read",
    "surface.exceptions.read",
    "surface.search",
    "surface.timeline.read",
    "ifta.read",
    "fuel.review",
    "period.read",
    "gst.read",
    "bank.read",
    "ar.read",
    "commercial.read",
    "commercial.customer.read",
    "commercial.contract.read",
    "commercial.job.summary",
    "commercial.rates.read",
    "invoicing.read",
    "closeout.read",
    "shop.read",
    "asset.read",
    "project.read",
    "integration.read",
    "telematics.read",
    "hr.applicant.read",
    "audit.package.read",
    "spatial.read",
  ],

  /* ---- B20.5 finance and payroll functions ---- */

  bookkeeper: [
    // P4 (0235) — one's own employee expense claims.
    "payroll.expense.submit_own",
    "payroll.expense.read_own",
    "document.read",
    "document.intake",
    "facility.directory.read",
    "commercial.read",
    "commercial.customer.read",
    "commercial.customer.write",
    "commercial.contract.read",
    "commercial.job.summary",
    "commercial.billing.context",
    "commercial.write",
    "tax.read_business",
    "tax.expense.create",
    "tax.expense.review",
    "tax.salestax.read",
    "tax.year_end.read",
    "banking.read",
    "banking.reconcile",
    "billing.read",
    "compliance.read",
    "evidence.read_commercial",
    "evidence.browse",
    "evidence.read_job_operational",
    "contractor.read",
    "funding.read",
    "funding.manage",
    "funding.claim",
    "vendor.bill.review",
    "vendor.bill.approve",
    "recovery.propose",
    "calibration.impact",
    "insurance.read_summary",
    "insurance.read_policy",
    "insurance.claim.read",
    "insurance.claim.financial",
    "surface.exceptions.read",
    "surface.search",
    "surface.timeline.read",
    "ifta.distance.verify",
    "ifta.fuel.classify",
    "ifta.read",
    "ifta.prepare",
    "fuel.statement.import",
    "fuel.review",
    "period.read",
    "period.close",
    "gst.read",
    "gst.classify",
    "gst.prepare",
    "bank.import",
    "bank.read",
    "ar.payment.record",
    "ar.payment.apply",
    "ar.read",
    "ar.credit.request",
    "ar.collect",
    "ar.writeoff.request",
    "commercial.po.record",
    "commercial.read",
    "commercial.rates.read",
    "invoicing.draft",
    "invoicing.read",
    "invoicing.render",
    "invoicing.send",
    "commercial.pricing.decide",
    "portal.submission.review",
    "closeout.line.decide",
    "closeout.supplement.prepare",
    "closeout.read",
    "closeout.document.render",
    "shop.read",
    "asset.read",
    "asset.register",
    "asset.cca.classify",
    "cca.prepare",
    "project.read",
    "integration.read",
  ],

  payroll_admin: [
    // P4 (0235) — employee expense claims: one's own, and the payroll office's review and decision.
    "payroll.expense.submit_own",
    "payroll.expense.read_own",
    "payroll.expense.read",
    "payroll.expense.approve",
    "payroll.expense.reject",
    "payroll.read_own",
    "payroll.read_employee",
    "payroll.read_all",
    "payroll.review",
    // P3 (0234) — payroll time under D10 (the fallback approver), exceptions, and earning approval.
    "payroll.time.read_team",
    "payroll.time.approve",
    "payroll.time.reject",
    "payroll.exception.read",
    "payroll.exception.resolve",
    "payroll.earning.approve",
    "payroll.run",
    "payroll.adjust",
    "payroll.rate.read",
    "payroll.export",
    "evidence.read_personnel",
    "evidence.browse",
    "personnel.read",
    "payroll.profile.write",
    "payroll.compensation.read",
    "payroll.compensation.propose",
    "payroll.earning_code.manage",
    "payroll.schedule.read",
    "payroll.schedule.manage",
    "payroll.finalize",
    "contractor.read",
    "surface.exceptions.read",
    "surface.search",
    "surface.timeline.read",
    "closeout.adjustment.payroll_propose",
  ],

  tax_preparer: [
    "tax.read_business",
    "tax.expense.review",
    "tax.asset.read",
    "tax.salestax.read",
    "tax.salestax.review",
    "tax.year_end.read",
    "tax.adjust",
    "tax.export",
    "evidence.read_commercial",
    "evidence.browse",
    "evidence.export",
    "contractor.read",
    "funding.read",
    "surface.exceptions.read",
    "surface.search",
    "surface.timeline.read",
    "ifta.read",
    "ifta.prepare",
    "ifta.finalize",
    "period.read",
    "gst.read",
    "gst.prepare",
    "gst.finalize",
    "bank.read",
    "ar.read",
    "asset.read",
    "asset.cca.classify",
    "asset.cca.verify",
    "cca.prepare",
    "cca.review",
  ],

  controller: [
    // P4 (0235) — employee expense claims: one's own, and the payroll office's review and decision.
    "payroll.expense.submit_own",
    "payroll.expense.read_own",
    "payroll.expense.read",
    "payroll.expense.approve",
    "payroll.expense.reject",
    "document.read",
    "document.confirm",
    "document.issue",
    /* C1b-2b — requirement verification */
    "compliance.requirement.propose",
    "compliance.requirement.verify",
    "compliance.requirement.second_approve",
    "compliance.requirement.retire",
    "safety_program.read",
    "facility.directory.read",
    "enforcement.read",
    "oos.policy.manage",
    "oos.policy.approve",
    "geo.source.review",
    "hos.read",
    "hos.rule.manage",
    "hos.rule.verify",
    "comms.policy.manage",
    "comms.policy.approve",
    /* v22.17 — communications */
    "comms.read",
    "comms.channel.manage",
    "comms.channel.verify",
    "comms.authorization.manage",
    "comms.authorization.verify",
    "tax.read_business",
    "tax.expense.review",
    "tax.asset.read",
    "tax.asset.write",
    "tax.salestax.read",
    "tax.salestax.review",
    "tax.year_end.read",
    "tax.year_end.close",
    "tax.adjust",
    "tax.export",
    "banking.read",
    "banking.reconcile",
    "billing.read",
    "billing.write",
    "payroll.read_all",
    "payroll.approve",
    "payroll.rate.read",
    "payroll.rate.write",
    "payroll.compensation.read",
    "payroll.compensation.approve",
    "payroll.earning_code.manage",
    "payroll.schedule.read",
    "payroll.schedule.manage",
    "payroll.finalize",
    "payroll.void",
    // P3 (0234) — payroll exceptions. Earning approval stays with payroll_admin and hr, the holders P0 gave it.
    "payroll.exception.read",
    "payroll.exception.resolve",
    "evidence.read_commercial",
    "evidence.browse",
    "evidence.export",
    "finance.entity.write",
    "contractor.read",
    "contractor.approve",
    "tax.rules.manage",
    "funding.read",
    "funding.manage",
    "funding.claim",
    "funding.programs.manage",
    "purchasing.approve",
    "purchasing.emergency_approve",
    "vendor.create",
    "vendor.bill.review",
    "vendor.bill.approve",
    "payment.release",
    "recovery.propose",
    "recovery.decide",
    "device.manage",
    "compliance.passport.read",
    "compliance.requirement.manage",
    "compliance.pack.manage",
    "calibration.impact",
    "insurance.read_summary",
    "insurance.read_policy",
    "insurance.write_policy",
    "insurance.claim.read",
    "insurance.claim.financial",
    "surface.exceptions.read",
    "surface.search",
    "surface.timeline.read",
    "dispatch.enforcement.manage",
    "ifta.distance.verify",
    "ifta.fuel.classify",
    "ifta.read",
    "ifta.prepare",
    "ifta.finalize",
    "fuel.tank.manage",
    "fuel.statement.import",
    "fuel.review",
    "period.read",
    "period.close",
    "period.reopen",
    "gst.read",
    "gst.classify",
    "gst.prepare",
    "gst.finalize",
    "bank.import",
    "bank.read",
    "ar.payment.record",
    "ar.payment.apply",
    "ar.read",
    "ar.credit.request",
    "ar.credit.decide",
    "ar.collect",
    "ar.writeoff.request",
    "ar.writeoff.decide",
    "commercial.terms.manage",
    "commercial.po.record",
    "commercial.ratecard.manage",
    "commercial.read",
    "commercial.customer.read",
    "commercial.customer.write",
    "commercial.customer.archive",
    "commercial.contract.read",
    "commercial.contract.write",
    "commercial.contract.approve",
    "commercial.contract.status",
    "commercial.job.assign",
    "commercial.job.snapshot",
    "commercial.job.summary",
    "commercial.billing.context",
    "commercial.rates.propose",
    "commercial.rates.approve",
    "commercial.rates.read",
    "invoicing.draft",
    "invoicing.finalize",
    "invoicing.void",
    "invoicing.dispute.resolve",
    "invoicing.read",
    "invoicing.render",
    "invoicing.send",
    "commercial.pricing.decide",
    "commercial.margin.view",
    "commercial.setup.write",
    "portal.identity.manage",
    "portal.submission.review",
    "closeout.line.decide",
    "closeout.supplement.prepare",
    "closeout.authority.manage",
    "closeout.read",
    "closeout.document.render",
    "closeout.adjustment.payroll_propose",
    "shop.read",
    "shop.warranty.decide",
    "asset.read",
    "asset.register",
    "asset.capital.review",
    "asset.cca.classify",
    "asset.cca.verify",
    "cca.prepare",
    "cca.review",
    "project.read",
    "project.quote.issue",
    "project.budget.manage",
    "project.budget.approve",
    "integration.read",
    "integration.client.manage",
    "integration.webhook.manage",
    "audit.package.prepare",
    "audit.package.release",
    "audit.package.read",
    "closeout.terms.record",
    "closeout.terms.approve",
    "geo.read",
    "geo.import",
    "geo.locationVerifyFromGrid",
    "geo.access.propose",
    "geo.access.decide",
    "geo.access.passage",
    "spatial.structure.record",
    "spatial.structure.verify",
    "spatial.route.approve",
    "geo.graph.build",
  ],

  // Time-limited, read-mostly, and scoped to the books. Everything operational
  // is absent by construction rather than denied afterwards.
  external_accountant: [
    "tax.read_business",
    "tax.expense.review",
    "tax.asset.read",
    "tax.salestax.read",
    "tax.year_end.read",
    "tax.export",
    "banking.read",
    "billing.read",
    "evidence.read_commercial",
    "evidence.browse",
    "evidence.export",
    "contractor.read",
    "funding.read",
    "ifta.read",
    "fuel.review",
    "period.read",
    "gst.read",
    "bank.read",
    "ar.read",
    "commercial.read",
    "commercial.customer.read",
    "closeout.read",
    "asset.read",
    "asset.cca.classify",
    "asset.cca.verify",
    "cca.review",
  ],
};

/**
 * Permissions that belong to a person rather than to a job.
 *
 * The Personal Tax Organizer is scoped to the session user by construction —
 * holding this permission only ever returns the holder's own documents, and no
 * role anywhere grants access to somebody else's. Tying it to job role produced
 * an arbitrary split where a driver and an HR user could open their own T4 and
 * an office or controller user could not, despite being equally people with
 * equally their own tax slips.
 *
 * So it is not a role grant. Any authenticated user holding any recognized
 * domain role has it. External scoped parties technically hold it too and see
 * an empty organizer, because nothing in it is theirs.
 *
 * Deliberately a very short list. A permission belongs here only when it is
 * self-scoped in the code, not merely self-scoped by intention.
 */
export const UNIVERSAL_PERMISSIONS: readonly Permission[] = [
  "tax.read_personal_own",
  // Composing your own portal set from your own roles is self-scoped in code:
  // the procedure reads the roles the gate already loaded for the session and
  // nothing else. Nobody composes someone else's session.
  "portal.compose_own",
  // v20.20 — a device is enrolled to the session user, rotated by the session
  // user, and pushes as the session user. All three read `ctx.user.id` and
  // nothing the request could name.
  "device.enroll_own",
  "device.rotate_own",
  "sync.push_own",
  // v21.0 — your inbox and your day read `ctx.user.id` and the roles the gate
  // already loaded. Nobody reads someone else's.
  "inbox.read_own",
  "myday.read_own",
  // v21.1 — "what am I missing?" reads the caller's own operator record.
  "dispatch.readiness_own",
  "academy.read_own",
  "academy.progress_own",
  "academy.assessment_own",
  "academy.certificate.sign_own",
  "academy.direct_supervision_attest_own",
  // 0212 — the Driver Wallet: the caller's own operator record, never one the request names.
  "portfolio.read_own",
  "portfolio.submit_own",
  "portfolio.share_own",
  // SA1 — signing or declining your OWN assigned field: the service resolves the signer row to
  // `ctx.user.id` and refuses anything else (WRONG_SIGNER). Nobody signs for somebody else.
  "attest.sign_own",
  "attest.decline_own",
  // 0206 — a person's own availability reads and writes `ctx.user.id` and nothing the request could name.
  "shifts.availability_own",
  // 0228 — your own policies to acknowledge, your own signature. The router resolves the person from ctx.user.id.
  "safety_program.read_own",
  "safety_program.acknowledge_own",
] as const;

export function isUniversalPermission(p: Permission): boolean {
  return UNIVERSAL_PERMISSIONS.includes(p);
}

/**
 * Defence in depth. With category grants these are mostly redundant — a
 * mechanic has no commercial read to begin with. They stay because a future
 * grant edit that widens a role should still not silently open these.
 */
/**
 * Payroll P1 — every compensation authority, denied by name to the roles that work beside payroll but
 * must never see or set what a person is paid. Sharing a job, a dispatch or a truck grants none of it.
 */
const COMPENSATION_PERMISSIONS: readonly Permission[] = ["payroll.compensation.read", "payroll.compensation.propose", "payroll.compensation.approve", "payroll.earning_code.manage",
  // P2 — the payroll calendar and the period machine, denied to the same roles for the same reason.
  "payroll.schedule.read", "payroll.schedule.manage", "payroll.finalize", "payroll.void"];

/**
 * P3 — authority over other people's payroll time and over payroll exceptions. Dispatch sees the operation, never
 * decides pay: a dispatcher is denied the team view and time approval by name, so neither can ever arrive through a
 * second role or a broad grant. The bookkeeper and the auditor read books, not timesheets.
 */
const TIME_AUTHORITY_PERMISSIONS: readonly Permission[] = ["payroll.time.read_team", "payroll.time.approve", "payroll.time.reject", "payroll.exception.read", "payroll.exception.resolve", "payroll.earning.approve"];
/** P4 — the payroll office's authority over other people's expense claims. A crew supervisor gains none of it through D10. */
const EXPENSE_OFFICE_PERMISSIONS: readonly Permission[] = ["payroll.expense.read", "payroll.expense.approve", "payroll.expense.reject"];
/** Field roles approve their crew's time under D10; they do not read exceptions or approve earnings. */
const PAYROLL_OFFICE_PERMISSIONS: readonly Permission[] = ["payroll.exception.read", "payroll.exception.resolve", "payroll.earning.approve"];

const DENIALS: Partial<Record<DomainRole, readonly Permission[]>> = {
  mechanic: ["billing.read", "billing.write", "payroll.read", "personnel.write", "incident.read_investigation", ...COMPENSATION_PERMISSIONS, ...PAYROLL_OFFICE_PERMISSIONS, ...EXPENSE_OFFICE_PERMISSIONS],
  shop_lead: ["billing.read", "billing.write", "payroll.read", "personnel.write", "incident.read_investigation", ...COMPENSATION_PERMISSIONS, ...PAYROLL_OFFICE_PERMISSIONS, ...EXPENSE_OFFICE_PERMISSIONS],
  dispatcher: ["billing.read", "billing.write", "payroll.read", "personnel.write", "incident.read_investigation", ...COMPENSATION_PERMISSIONS, ...TIME_AUTHORITY_PERMISSIONS, ...EXPENSE_OFFICE_PERMISSIONS],
  driver: ["billing.read", "billing.write", "payroll.read", "personnel.read", "personnel.write", "incident.read_investigation", ...COMPENSATION_PERMISSIONS, ...PAYROLL_OFFICE_PERMISSIONS, ...EXPENSE_OFFICE_PERMISSIONS],
  auditor: ["payroll.read", "billing.write", "personnel.write", ...COMPENSATION_PERMISSIONS, ...TIME_AUTHORITY_PERMISSIONS, ...EXPENSE_OFFICE_PERMISSIONS],

  // The banking and tax-identifier reads are held by nobody in this model.
  // They exist so the permission has a name to be denied under, and so adding
  // a holder is a deliberate, reviewable act rather than a side effect of a
  // broad grant. Same reason `authority_certified` sits empty in the
  // measurement ladder.
  bookkeeper: ["payroll.bank.read", "payroll.tax_identifier.read", "payroll.read_all", "payroll.approve", ...COMPENSATION_PERMISSIONS, ...TIME_AUTHORITY_PERMISSIONS, ...EXPENSE_OFFICE_PERMISSIONS],
  // P1 — the administrator proposes compensation; approving it is the controller's (D4).
  payroll_admin: ["payroll.bank.read", "payroll.tax_identifier.read", "payroll.approve", "billing.write", "payroll.compensation.approve", "payroll.void"],
  tax_preparer: ["payroll.bank.read", "payroll.tax_identifier.read", "payroll.read_all", "billing.write", "banking.reconcile"],
  controller: ["payroll.bank.read", "payroll.tax_identifier.read"],
  external_accountant: [
    "payroll.bank.read",
    "payroll.tax_identifier.read",
    "payroll.read_all",
    "payroll.adjust",
    // An accountant reads the books. They do not run the fleet.
    "incident.read_investigation",
    "maintenance.record_release",
    "evidence.amend",
    "roles.grant",
    "legal_hold.release",
  ],
};

/**
 * Permissions whose authorization trail must exist before the action happens.
 * If the audit row cannot be written, these fail closed — an irreversible or
 * sensitive act with no record of who authorized it is worse than a refusal.
 */
export const SENSITIVE_PERMISSIONS: readonly Permission[] = [
  // 0212 — a submitted credential, a share of one, and the requirements dispatch reads.
  "portfolio.submit_own",
  "portfolio.share_own",
  "portfolio.requirement.manage",
  "live_assist.use",
  "live_assist.administer",
  "live_assist.review",
  // DC-A (0178) — Document Control. Each of these creates operational truth (a controlled record, a
  // confirmed extraction, a consumed number) or changes what every later record is judged by.
  "document.intake",
  "document.confirm",
  "document.issue",
  "document.void",
  "document.catalog.manage",
  "document.series.manage",
  "document.template.manage",
  "safety_program.manage",
  "safety_program.approve",
  "safety_program.verify",
  "safety_program.acknowledge_own",
  "academy.source.review",
  "academy.certificate.issue",
  "academy.certificate.sign_own",
  "academy.requirement.manage",
  "academy.direct_supervision_attest_own",
  // Carried forward from the v22.16 audit: these actions already existed in
  // the Permission union and production routers but were never placed in the
  // fail-closed set. Each creates or changes operational/commercial truth.
  "invoicing.void",
  "invoicing.dispute.resolve",
  "geo.import",
  "geo.locationVerifyFromGrid",
  "geo.access.decide",
  "spatial.structure.verify",
  "spatial.route.approve",
  "geo.graph.build",
  // v22.17 — each of these establishes a fact a driver will act on: that a channel
  // record matches the regulator, that the company may transmit, that a road carries
  // a channel, or that a photographed sign now governs over every dataset.
  "comms.channel.verify",
  "comms.authorization.verify",
  "comms.assignment.verify",
  "comms.observation.decide",
  // v22.18 — approving the policy decides whether a driver leaves the yard.
  "comms.policy.approve",
  // Approving this decides who may lift a government prohibition.
  "oos.policy.approve",
  // Confirming a stop creates prohibitions; releasing one lifts a government
  // order. Both establish facts a driver acts on.
  "enforcement.confirm",
  "enforcement.release",
  // Approving leave changes who is available to work.
  "timeOff.decide",
  // Posting work commits the company to needing somebody there.
  "shifts.post",
  // Who is on a crew decides who is sent to work.
  "crews.manage",
  // A channel decides who may read a conversation.
  "board.manage",
  // An emergency or company-wide bulletin demands acknowledgement from everyone it reaches.
  "board.publish",
  // Reading a private conversation as a moderator is an access nobody in it agreed to.
  "board.moderate",
  // What is loaded decides what every later answer can cite.
  "assistant.curate",
  // Approving an agent action is authorising a machine to affect the company.
  "agent.approve",
  // Signing a mechanic release is an accountability act attributed to a person.
  "shop.release",
  // Clearing a source decides whether the company may commercially use a
  // government dataset. That is a determination, not an edit.
  "geo.source.review",
  // v22.20 — a verified HOS figure becomes a legal determination about a person.
  "hos.rule.verify",
  // v22.1 — approved terms decide what a customer is billed.
  "closeout.terms.approve",
  // v22.0 — a verified coordinate, profile or restriction is a fact a route will be judged by.
  "spatial.location.verify",
  "spatial.vehicle.verify",
  "spatial.restriction.verify",
  // v21.21 — a package leaves the company.
  "audit.package.prepare",
  "audit.package.release",
  // v21.20 — a hire, a verified credential, a competency, a probation decision and a revoked door are all facts about a person.
  "hr.applicant.manage",
  "hr.training.verify",
  "hr.competency.signoff",
  "hr.probation.decide",
  "hr.offboarding.manage",
  "hr.access.revoke",
  // v21.19 — a fault acknowledged becomes a defect; a review is a decision about a person; video identifies one.
  "telematics.fault.acknowledge",
  "safety.event.review",
  "safety.video.read",
  // v21.18 — a machine's key and a webhook's secret are doors.
  "integration.client.manage",
  "integration.webhook.manage",
  // v21.17 — a price given to a customer and an approved budget are commitments.
  "project.quote.issue",
  "project.budget.approve",
  // v21.16 — capitalizing changes the books; a verified class and a reviewed schedule are tax facts.
  "asset.capital.review",
  "asset.cca.verify",
  "cca.review",
  // v21.15 — a count rewrites what the shop believes it holds; a warranty decision is money; a verified recall is a safety fact.
  "shop.parts.count",
  "shop.warranty.decide",
  "shop.recall.verify",
  // v21.12 — a client bonus reaching payroll is a payroll write.
  "closeout.adjustment.payroll_propose",
  // v21.11 — a witnessed signature freezes a ticket; a line decision is the customer's position; an authority is a door.
  "closeout.sign.witness",
  "closeout.line.decide",
  "closeout.authority.manage",
  // v21.10 — an external identity is a door; a rate card is a price; a hold is a refusal to bill.
  "portal.identity.manage",
  "commercial.ratecard.manage",
  "commercial.terms.manage",
  "commercial.rates.approve",
  "commercial.margin.view",
  "commercial.setup.write",
  // v23.31 — archiving a customer, approving a contract, suspending or terminating one: governance acts, recorded or refused.
  "commercial.customer.archive",
  "commercial.contract.approve",
  "commercial.contract.status",
  "invoicing.finalize",
  // v21.9.1 — nine actions that were role-authorized but never entered the
  // fail-closed set. Awarding dispatch, granting an override, changing
  // enforcement, finalizing a return, closing or reopening a period, deciding
  // a credit or a write-off: each is refused when its audit row cannot be
  // written. (Inserts in six earlier tranches anchored on comment lines that
  // had moved and silently did nothing; the counts were added, not read.)
  "dispatch.award",
  "dispatch.override.grant",
  "dispatch.enforcement.manage",
  "ifta.finalize",
  "period.close",
  "period.reopen",
  "gst.finalize",
  "ar.credit.decide",
  "ar.writeoff.decide",
  // v20.23
  "insurance.verify_coverage",
  "insurance.certificate.issue",
  "insurance.claim.financial",
  // v20.22
  "compliance.pack.manage",
  "equipment.authorize",
  // C1b-2b — each makes a regulatory requirement authoritative, retires one, or changes how it may be verified.
  "compliance.requirement.verify",
  "compliance.requirement.second_approve",
  "compliance.requirement.retire",
  "compliance.verification.govern",
  // v20.21
  "compliance.credential.verify",
  "compliance.private.read",
  "compliance.requirement.manage",
  "compliance.program.publish",
  // v20.20
  "device.manage",
  "sync.resolve_conflict",
  // v20.19
  "purchasing.approve",
  "purchasing.emergency_approve",
  "vendor.bill.approve",
  "payment.release",
  "recovery.decide",
  "roles.grant",
  "legal_hold.place",
  "legal_hold.release",
  "retention.dispose",
  "maintenance.record_release",
  "maintenance.revoke_release",
  "evidence.amend",
  "evidence.export",
  "billing.write",
  "personnel.write",
  "compliance.review",
  "payroll.approve",
  "payroll.run",
  "payroll.adjust",
  "payroll.rate.write",
  "payroll.export",
  "payroll.bank.read",
  "payroll.tax_identifier.read",
  "tax.year_end.close",
  "tax.adjust",
  "tax.rules.manage",
  "tax.export",
  "banking.reconcile",
  // B20.6 — operational acts that create fact rather than report it. A custody
  // handoff, a GPS proposal becoming a billable event, a routing decision and
  // an assistant commit all write operational truth that downstream systems
  // then rely on. They fail closed without an authorization trail.
  "transfer.acknowledge",
  "gps.confirm",
  "route.decide",
  "evidence.verify",
  "assistant.commit",
  // B20.7
  "payroll.profile.write",
  // P1 — proposing or approving compensation, and changing a book's earning codes, are refused when
  // their authorization row cannot be written.
  "payroll.compensation.propose",
  "payroll.compensation.approve",
  "payroll.earning_code.manage",
  // P2 — configuring the calendar, finalizing a period and voiding one.
  "payroll.schedule.manage",
  "payroll.finalize",
  "payroll.void",
  "payroll.time.approve",
  "payroll.time.reject",
  "payroll.exception.resolve",
  "payroll.earning.approve",
  "payroll.expense.approve",
  "payroll.expense.reject",
  "contractor.approve",
  "finance.entity.write",
  // B20.13 — a claim ties an expense to a program on the stacking ledger, and
  // program knowledge is what estimates are computed from.
  "funding.claim",
  "funding.programs.manage",
  // P8.5 — the vault. `restricted.read` reads like an ordinary read and is not one:
  // it gates break-glass grant creation, the revocation of somebody else's grant, and
  // the decision that opens an internal investigation. The fail-closed branch exists
  // for exactly this — "granting a role, releasing a legal hold or signing a mechanic
  // release with no record of who authorized it is worse than refusing". Minting a
  // self-service grant into the restricted sector with no row saying the glass was
  // broken is that category, and without this it proceeded when the audit insert failed.
  "restricted.read",
  // 0199 — a cancelled work order can leave a defect unrepaired. It may not happen unrecorded.
  "maintenance.workorder.cancel",
  // 0200 — a hold placed or released decides whether a unit may move; a verified meter reading counts.
  "fleet.hold.place",
  "fleet.hold.release",
  "fleet.meter.verify",
  // 0221 — triage can lower a critical defect, which frees a safety hold; return to service puts a unit back on the road.
  "maintenance.defect.triage",
  "maintenance.return_to_service.record",
  // SA1 — Sign & Attest: every act that creates or ends signing evidence fails closed when its
  // authorization row cannot be written. A mark with no record of who was allowed to place it is
  // the label this subsystem exists to end.
  "attest.document.open",
  "attest.field.place",
  "attest.signer.assign",
  "attest.sign_own",
  "attest.witness",
  "attest.finalize",
  "attest.void",
  "attest.supersede",
  "attest.export",
] as const;

export function isSensitivePermission(p: Permission): boolean {
  return SENSITIVE_PERMISSIONS.includes(p);
}

/** B28 — the permissions one domain role carries, for the widget board's role-scoped actor. Universal permissions included. */
export function permissionsForDomainRole(role: DomainRole): readonly Permission[] {
  return Array.from(new Set([...(GRANTS[role] ?? []), ...UNIVERSAL_PERMISSIONS]));
}

export function isDomainRole(value: string): value is DomainRole {
  return Object.prototype.hasOwnProperty.call(GRANTS, value);
}

/**
 * B23.1 — how far a grant reaches.
 *
 * `global` is PLATFORM-WIDE: it reaches every organization in the deployment.
 * Before B23.1 it was the only value an ordinary business role could be
 * written with, because there was no organization scope to write — so every
 * driver grant ever issued claimed authority in every company. That is the
 * bug this enum exists to end, and `global` now means what its name says and
 * nothing else. The backfill assigns it to nobody; granting it is a deliberate
 * act, and `organizationScopedRoles.test.ts` pins that it crosses boundaries
 * by design rather than by accident.
 *
 * `organization` is the ordinary case: authority inside one company.
 *
 * `branch` is narrower still, and names its organization EXPLICITLY. There is
 * no `branches` table in this schema — `branchId` is a bare varchar on eight
 * tables with no organization ownership — so a branch cannot tell us which
 * company it belongs to. Deriving one would be exactly the ambiguous
 * relationship through which authority leaks, so a branch grant carries both.
 *
 * `unscoped_legacy` is what the backfill writes for a grant it could not
 * safely attribute: the holder already belonged to more than one organization
 * when organization scope arrived, so no organization can be inferred without
 * guessing whose authority to hand over. It authorizes nothing, anywhere,
 * until an administrator re-grants it explicitly. The row is preserved so the
 * history stays answerable.
 */
export type RoleScopeType = "global" | "organization" | "branch" | "unscoped_legacy";

/**
 * A grant as stored: a role, the organization that issued it, and how far it
 * reaches inside that organization.
 *
 * `scopeType` is optional in the TYPE only so the pure fixtures written before
 * B23.1 still compile; a grant with no `scopeType` is read as platform-global,
 * which is the honest reading of the pre-B23.1 data model. The production
 * reader always populates it — `db.listActiveUserRoles` selects the column and
 * `organizationScopedRoles.db.test.ts` pins that it never returns one without.
 */
export type RoleGrant = {
  role: string;
  /** The branch, when `scopeType` is `branch`. */
  scopeRef?: string | null;
  scopeType?: RoleScopeType;
  /** The organization that issued this grant. Null only for platform-global. */
  orgRef?: string | null;
};

/** Whether a grant is deliberate platform-wide authority rather than a company's. */
export function isPlatformGlobal(grant: RoleGrant): boolean {
  return (grant.scopeType ?? "global") === "global";
}

/**
 * The grants that authorize inside one organization.
 *
 * The whole B23.1 invariant, in one function, so that capability projection,
 * workspace composition and the procedure gate all ask the same question and
 * cannot answer it differently.
 *
 * Fails closed at every branch: an organization-confined grant naming no
 * organization reaches nothing, an unrecognized scope type reaches nothing,
 * and a quarantined legacy grant reaches nothing. Only a platform-global grant
 * survives without an organization match, and that is the point of it.
 */
export function grantsInOrganization(
  grants: readonly RoleGrant[],
  organization: string | null | undefined
): RoleGrant[] {
  return grants.filter(g => {
    const scope = g.scopeType ?? "global";
    if (scope === "global") return true;
    if (scope === "organization" || scope === "branch") {
      // A confined grant that names no organization is malformed, not broad.
      if (!g.orgRef) return false;
      // An unresolved organization cannot judge a confined grant, so it does
      // not apply — the same rule the branch axis below already runs on.
      if (!organization) return false;
      return g.orgRef === organization;
    }
    // `unscoped_legacy`, and anything a future migration adds before this
    // function learns about it.
    return false;
  });
}

export type AuthorizationOutcome =
  | "allowed"
  | "denied_no_role"
  | "denied_permission"
  | "denied_scope"
  | "denied_unauthenticated";

export type AuthorizationResult = {
  allowed: boolean;
  outcome: AuthorizationOutcome;
  /** Roles that were recognized AND in scope for this resource. */
  effectiveRoles: DomainRole[];
  detail?: string;
};

function normalizeGrants(args: {
  roles?: readonly string[];
  grants?: readonly RoleGrant[];
}): RoleGrant[] {
  const out: RoleGrant[] = [];
  for (const r of args.roles ?? []) out.push({ role: r, scopeRef: null });
  for (const g of args.grants ?? []) out.push(g);
  return out;
}

/**
 * The single decision function.
 *
 * `resourceBranch` must be loaded server-side. A branch-confined grant reaches
 * only its own branch; a global grant reaches everywhere.
 *
 * v21.9.1 — `undefined` and `null` mean different things. `undefined`: the
 * caller did not resolve a branch (the generic procedure gate never does), so
 * a branch-confined grant cannot be judged and does not apply — fail closed;
 * only a global grant passes. `null`: the caller loaded the record and found
 * it belongs to no branch, so confined grants apply — there is no other
 * branch to cross into. Before this, both were treated as `null`, nobody
 * outside this module ever supplied a branch, and every confined grant passed
 * every generic gate. Universal (self-scoped) permissions are unaffected.
 *
 * B23.1 — `organization` is the OUTER scope and is checked first, because the
 * branch axis cannot defend a boundary it knows nothing about: branch
 * identifiers are bare strings with no owner, so "BRANCH-A1" in one company
 * and "BRANCH-A1" in another are indistinguishable to the branch check. The
 * organization must therefore be settled before the branch is consulted at
 * all. It is resolved server-side from membership, exactly like the branch,
 * and is never read from a request.
 *
 * `organization` follows the same `undefined` rule: a caller that did not
 * resolve one cannot judge an organization-confined grant, so only
 * platform-global authority passes an unresolved gate. Universal
 * (self-scoped) permissions still ride past the SCOPE filter — your own pay
 * and your own inbox are yours in whichever company you are standing in — but
 * they are granted only after the denial sweep, exactly as before.
 */
export function authorize(args: {
  userId: number | null | undefined;
  roles?: readonly string[];
  grants?: readonly RoleGrant[];
  permission: Permission;
  resourceBranch?: string | null;
  /** The organization the request is acting for. Server-resolved, never client-supplied. */
  organization?: string | null;
}): AuthorizationResult {
  if (!args.userId) {
    return {
      allowed: false,
      outcome: "denied_unauthenticated",
      effectiveRoles: [],
      detail: "No authenticated user",
    };
  }

  const all = normalizeGrants(args);
  const recognized = all.filter(g => isDomainRole(g.role));

  if (recognized.length === 0) {
    return {
      allowed: false,
      outcome: "denied_no_role",
      effectiveRoles: [],
      detail:
        all.length > 0
          ? `No recognized domain role among: ${all.map(g => g.role).join(", ")}`
          : "User holds no domain role",
    };
  }

  // B23.1 — the organization boundary, before anything else.
  //
  // Universal (self-scoped) permissions ride past the BRANCH filter below but
  // NOT past this one. Holding a grant in another company does not make you
  // somebody here, and "your own inbox, in a company that has granted you
  // nothing" is a question with no good answer — so it is refused rather than
  // guessed.
  const inOrganization = grantsInOrganization(recognized, args.organization);
  if (inOrganization.length === 0) {
    return {
      allowed: false,
      outcome: "denied_scope",
      effectiveRoles: [],
      // Says what is wrong without naming which other company granted the
      // role: a refusal is not a directory of a person's other employers.
      detail:
        args.organization == null
          ? "Roles are confined to an organization and this operation did not resolve one — platform-wide authority is required here"
          : "No role granted by this organization authorizes this operation",
    };
  }

  const branchUnresolved = args.resourceBranch === undefined;
  const universal = (UNIVERSAL_PERMISSIONS as readonly string[]).includes(args.permission);
  const inScope = inOrganization.filter(
    g =>
      g.scopeRef == null ||
      universal ||
      (branchUnresolved ? false : args.resourceBranch === null || g.scopeRef === args.resourceBranch)
  );

  if (inScope.length === 0) {
    return {
      allowed: false,
      outcome: "denied_scope",
      effectiveRoles: [],
      detail: branchUnresolved
        ? "Roles are confined to a branch and this operation did not resolve the resource's branch — a global grant is required here"
        : `Roles are confined to another branch — resource is in ${args.resourceBranch}`,
    };
  }

  const effectiveRoles = Array.from(
    new Set(inScope.map(g => g.role as DomainRole))
  );

  // Deny beats grant, across every in-scope role held.
  for (const role of effectiveRoles) {
    if (DENIALS[role]?.includes(args.permission)) {
      return {
        allowed: false,
        outcome: "denied_permission",
        effectiveRoles,
        detail: `${role} is explicitly denied ${args.permission}`,
      };
    }
  }

  // Universals are granted after the denial sweep, so deny still beats grant.
  const granted =
    isUniversalPermission(args.permission) ||
    effectiveRoles.some(r => GRANTS[r].includes(args.permission));
  return granted
    ? { allowed: true, outcome: "allowed", effectiveRoles }
    : {
        allowed: false,
        outcome: "denied_permission",
        effectiveRoles,
        detail: `None of [${effectiveRoles.join(", ")}] grants ${args.permission}`,
      };
}

export function permissionsFor(roles: readonly string[]): Permission[] {
  const effective = roles.filter(isDomainRole);
  const denied = new Set<Permission>();
  for (const r of effective) for (const p of DENIALS[r] ?? []) denied.add(p);

  const out = new Set<Permission>();
  if (effective.length > 0) {
    for (const p of UNIVERSAL_PERMISSIONS) if (!denied.has(p)) out.add(p);
  }
  for (const r of effective) {
    for (const p of GRANTS[r]) if (!denied.has(p)) out.add(p);
  }
  return Array.from(out).sort();
}

/** Any category read. Used to decide whether scope narrowing applies. */
const BROAD_READS: readonly Permission[] = EVIDENCE_READ_CATEGORIES;

export type RecordScopeSubject = {
  ownerOperatorId?: number | null;
  ownerUserId?: number | null;
};

/**
 * Whether the caller may act on this particular record.
 *
 * Holding `evidence.read_own` is not a licence to read the fleet. Ownership
 * facts must come from the database — never from the request.
 */
export function authorizeRecordScope(args: {
  userId: number;
  operatorId?: number | null;
  roles?: readonly string[];
  grants?: readonly RoleGrant[];
  permission: Permission;
  subject: RecordScopeSubject;
  resourceBranch?: string | null;
  /**
   * B23.1A — forwarded to `authorize`, and callers must supply it.
   *
   * Omitting it is not "unscoped", it is "organization unresolved", which
   * makes every organization-confined grant inapplicable — i.e. every grant
   * 0170 leaves behind. This wrapper spreads `args` straight through, so the
   * axis was silently dropped at all three call sites until a fixture stopped
   * writing platform-global grants.
   */
  organization?: string | null;
}): AuthorizationResult {
  const base = authorize(args);
  if (!base.allowed) return base;

  const hasBroadRead = BROAD_READS.some(
    p => authorize({ ...args, permission: p }).allowed
  );
  if (hasBroadRead) return base;

  const ownsByOperator =
    args.subject.ownerOperatorId != null &&
    args.operatorId != null &&
    args.subject.ownerOperatorId === args.operatorId;
  const ownsByUser =
    args.subject.ownerUserId != null && args.subject.ownerUserId === args.userId;

  if (ownsByOperator || ownsByUser) return base;

  return {
    allowed: false,
    outcome: "denied_scope",
    effectiveRoles: base.effectiveRoles,
    detail: "Record belongs to another operator",
  };
}

/**
 * A release record names a technician, and the named technician must be the
 * caller. A shop lead cannot sign in someone else's name.
 */
export function authorizeMechanicRelease(args: {
  userId: number;
  roles?: readonly string[];
  grants?: readonly RoleGrant[];
  technicianUserId: number;
  resourceBranch?: string | null;
  /** B23.1A — see `authorizeRecordScope`. Forwarded to `authorize`. */
  organization?: string | null;
}): AuthorizationResult {
  const base = authorize({ ...args, permission: "maintenance.record_release" });
  if (!base.allowed) return base;

  if (args.technicianUserId !== args.userId) {
    return {
      allowed: false,
      outcome: "denied_scope",
      effectiveRoles: base.effectiveRoles,
      detail:
        "A release must be recorded by the technician performing it, not on their behalf",
    };
  }
  return base;
}

/**
 * Declarative permission per procedure, kept as data so authorization is
 * auditable by reading one table instead of grepping the router. A procedure
 * absent from this map is refused at wiring time rather than defaulting to
 * authenticated-only.
 */
export const RECORDS_PROCEDURE_PERMISSIONS = {
  "records.evidence.seal": "evidence.seal",
  "records.evidence.queueSend": "evidence.send",
  "records.evidence.requestDeviceDeletion": "evidence.delete_device_copy",
  "records.evidence.amend": "evidence.amend",
  "records.evidence.listForOperator": "evidence.read_own",
  "records.evidence.export": "evidence.export",
  // The Records & File Manager. The gate opens the browser; each record is then
  // decided on its own category read, and one out of reach is "not found".
  "records.files.list": "evidence.browse",
  "records.files.get": "evidence.browse",
  "records.files.download": "evidence.browse",
  "records.incident.capture": "incident.create",
  "records.incident.readInvestigation": "incident.read_investigation",
  "records.incident.review": "incident.review",
  "records.nearMiss.report": "incident.create",
  "records.maintenance.recordRelease": "maintenance.record_release",
  "records.maintenance.resolveDefect": "maintenance.record_release",
  "records.maintenance.revokeRelease": "maintenance.revoke_release",
  "records.legalHold.place": "legal_hold.place",
  "records.legalHold.release": "legal_hold.release",
  "records.retention.disposition": "retention.dispose",
  "records.roadside.open": "roadside.open",
  "records.roles.grant": "roles.grant",
  // B23.1 — taking a role away is the same authority as giving one, and is
  // held under the same permission. Before this there was no revoke procedure
  // at all: the only path that revoked anything was offboarding, which revoked
  // every grant the account held in every organization.
  "records.roles.revoke": "roles.grant",
  // B23.1A — resolving a grant 0170 quarantined is issuing one: same authority,
  // same permission, and the organization comes from the actor's scope either
  // way.
  "records.roles.resolveLegacy": "roles.grant",
} as const satisfies Record<string, Permission>;

export type RecordsProcedure = keyof typeof RECORDS_PROCEDURE_PERMISSIONS;

/**
 * The pre-existing operational API, migrated off `protectedProcedure` in
 * sensitivity order. Same discipline as the records map: a permission, decided
 * per procedure, rather than one role stamped across a whole router.
 */
export const OPERATIONAL_PROCEDURE_PERMISSIONS = {
  // A. Personnel
  "operators.list": "personnel.read",
  "operators.create": "personnel.write",

  // B. Billing, rate data and vendors
  "rateCards.list": "billing.read",
  "rateCards.create": "billing.write",
  "rateCards.update": "billing.write",
  "lines.list": "billing.read",
  "lines.create": "billing.write",
  "vendors.list": "billing.read",
  "vendors.create": "billing.write",
  "vendors.update": "billing.write",

  // C. Compliance documents
  "documents.list": "compliance.read",
  "documents.create": "compliance.write",
  "documents.review": "compliance.review",
  "artifacts.list": "compliance.read",
  "artifacts.create": "compliance.write",
  "compliance.sign": "compliance.sign",

  // D. Safety records
  "safety.list": "incident.read_summary",
  "safety.create": "safety.write",
  "tailgates.list": "incident.read_summary",
  "tailgates.create": "safety.write",
  "unitSafety.list": "incident.read_summary",
  "unitSafety.create": "safety.write",
  "unitSafety.update": "safety.write",

  // E. Maintenance
  "maintenance.list": "maintenance.read_defect",
  "maintenance.create": "maintenance.write_defect",
  "workOrders.list": "maintenance.read_defect",
  "workOrders.create": "maintenance.write_work_order",
  "workOrders.update": "maintenance.write_work_order",

  /* ---- B20.6: the remaining 57 ---- */

  // Work records. Reading a job is not creating one.
  "jobs.list": "job.read",
  "jobs.byCode": "job.read",
  "jobs.create": "job.write",
  "trips.list": "trip.read",
  "trips.create": "trip.write",
  "trips.update": "trip.write",
  "tripStops.list": "trip.read",
  "tripStops.create": "trip.write",
  "tripStops.update": "trip.write",
  "loads.list": "load.read",
  "loads.create": "load.write",
  "manifests.list": "manifest.read",
  "manifests.create": "manifest.write",
  /* ---- v22.24 P3.1 (0129/0130): the manifest as a chain of custody ---- */
  "manifestCustody.bind": "manifest.write",
  "manifestCustody.custodyRecord": "manifest.write",
  "manifestCustody.evidenceAttach": "manifest.write",
  "manifestCustody.amend": "manifest.write",
  // 0162 (P3.1): accepting a reference-versus-print contradiction is a compliance act, so it does
  // not ride on manifest.write — the people who write manifests are the people it constrains.
  "requirement.calibrationSweep": "loadsense.calibration.sweep",
  "manifestCustody.reconciliationOverride": "manifest.override.grant",
  "manifestCustody.close": "manifest.write",
  "manifestCustody.evidenceProfileSet": "manifest.write",
  "manifestCustody.evidenceProfileApprove": "manifest.write",
  "manifestCustody.chain": "manifest.read",
  /* ---- v22.24 P4.6 (0131): security incidents and privacy breach assessments ---- */
  "facilityDirectory.hoursSet": "facility.directory.write",
  "facilityDirectory.callAheadRecord": "facility.directory.report",
  "facilityDirectory.waitReport": "facility.directory.report",
  "facilityDirectory.nearby": "facility.directory.read",
  "facilityDirectory.driverView": "facility.directory.read",
  "facilityDirectory.licencesList": "facility.directory.read",
  "facilityDirectory.vocabularyList": "facility.directory.read",
  "facilityDirectory.vocabularyVerify": "facility.directory.review",
  "facilityDirectory.seedLeads": "facility.directory.review",
  "facilityDirectory.seedBrief": "facility.directory.review",
  "facilityDirectory.arcgisPresets": "facility.directory.read",
  "facilityDirectory.arcgisInspect": "facility.directory.review",
  "facilityDirectory.arcgisImportFeatures": "facility.directory.review",
  "facilityDirectory.arcgisImportFromLayer": "facility.directory.review",
  "facilityDirectory.arcgisRuns": "facility.directory.read",
  "facilityDirectory.lsdFind": "facility.directory.read",
  "facilityDirectory.hydrovacImport": "facility.directory.review",
  "facilityDirectory.duplicates": "facility.directory.review",
  "facilityDirectory.features": "facility.directory.read",
  "facilityDirectory.get": "facility.directory.read",
  "facilityDirectory.evidenceRecord": "facility.directory.write",
  "facilityDirectory.evidenceReview": "facility.directory.review",
  "facilityDirectory.coordinateVerify": "facility.directory.review",
  "facilityDirectory.capabilitySet": "facility.directory.review",
  "facilityDirectory.assessLoad": "facility.directory.write",
  "facilityDirectory.assessments": "facility.directory.read",
  "facilityDirectory.exportCsv": "facility.directory.read",
  "facilityDirectory.exportGeoJson": "facility.directory.read",
  "commercialOffice.organizationCreate": "commercial.write",
  "commercialOffice.organizationsList": "commercial.read",
  "commercialOffice.facilityStatementsList": "commercial.read",
  "commercialOffice.documentRegister": "commercial.write",
  "commercialOffice.documentSupersede": "commercial.write",
  "commercialOffice.documentWithdraw": "commercial.policy",
  "commercialOffice.documentLink": "commercial.write",
  "commercialOffice.documentRetentionAssign": "commercial.policy",
  "commercialOffice.documentDeliveryRecord": "commercial.write",
  "commercialOffice.documentDeliveryUpdate": "commercial.write",
  "commercialOffice.documentGet": "commercial.read",
  "commercialOffice.documentsList": "commercial.read",
  // DC-A (0178) — Document Control, Checkpoint A: the definition registry and the catalog.
  "documentControl.definitionsList": "document.read",
  "documentControl.definitionGet": "document.read",
  "documentControl.catalogSeed": "document.catalog.manage",
  "documentControl.definitionOverlay": "document.catalog.manage",
  "documentControl.definitionCreate": "document.catalog.manage",
  "documentControl.definitionRetire": "document.catalog.manage",
  "documentControl.sourceArtifactsList": "document.read",
  // DC-B (0195) — the register: intake creates a row, confirmation creates a fact, issue consumes a number.
  "documentControl.documentIntake": "document.intake",
  "documentControl.documentRegisterRendered": "document.issue",
  "documentControl.documentConfirm": "document.confirm",
  "documentControl.documentIssue": "document.issue",
  "documentControl.documentVoid": "document.void",
  "documentControl.documentSupersede": "document.issue",
  "documentControl.documentWithdraw": "document.void",
  "documentControl.documentAmend": "document.confirm",
  "documentControl.documentGet": "document.read",
  "documentControl.documentsList": "document.read",
  // DC-C (0196) — the series ledger. Reading what was handed out is a read; cutting blocks and voiding numbers is series management.
  "documentControl.seriesList": "document.read",
  "documentControl.seriesGapReport": "document.read",
  "documentControl.seriesBlocks": "document.read",
  "documentControl.seriesAllocateDeviceBlock": "document.series.manage",
  "documentControl.seriesRetireDeviceBlock": "document.series.manage",
  "documentControl.seriesVoidNumber": "document.series.manage",
  "commercialOffice.glAccountSet": "commercial.policy",
  "commercialOffice.glMappingSet": "commercial.policy",
  "commercialOffice.glList": "commercial.read",
  "commercialOffice.glExportReadiness": "commercial.read",
  "commercialOffice.profitabilityByDimension": "commercial.read",
  "commercialOffice.apAgingByOrganization": "commercial.read",
  "commercialOffice.arAgingByOrganization": "commercial.read",
  "commercialOffice.approvalLedger": "commercial.read",
  "commercialOffice.facilityStatementImport": "commercial.write",
  "commercialOffice.facilityStatementLines": "commercial.read",
  "commercialOffice.facilityStatementLineResolve": "commercial.write",
  "commercialOffice.facilityStatementClose": "commercial.write",
  "commercialOffice.linkSet": "commercial.write",
  "commercialOffice.linkEnd": "commercial.write",
  "commercialOffice.linksList": "commercial.read",
  "commercialOffice.linkCandidates": "commercial.read",
  "commercialOffice.roleTypesList": "commercial.read",
  "commercialOffice.roleTypeCreate": "commercial.policy",
  "commercialOffice.roleAssign": "commercial.write",
  "commercialOffice.roleEnd": "commercial.write",
  "commercialOffice.rolesList": "commercial.read",
  "commercialOffice.settingsGet": "commercial.read",
  "commercialOffice.settingsSet": "commercial.policy",
  "commercialOffice.numberingList": "commercial.read",
  "commercialOffice.numberingSet": "commercial.policy",
  "commercialOffice.approvalPoliciesList": "commercial.read",
  "commercialOffice.approvalPolicySet": "commercial.policy",
  "commercialOffice.approvalPolicyRetire": "commercial.policy",
  "commercialOffice.approvalRequirement": "commercial.read",
  "commercialOffice.categoriesList": "commercial.read",
  "commercialOffice.categoryCreate": "commercial.write",
  "securityIncidents.open": "incident.create",
  "securityIncidents.timelineAppend": "incident.create",
  "securityIncidents.organizationAffect": "incident.review",
  "securityIncidents.breachAssess": "incident.review",
  "securityIncidents.obligationCreate": "incident.review",
  "securityIncidents.obligationSent": "incident.review",
  "securityIncidents.close": "incident.review",
  "securityIncidents.view": "incident.read_investigation",
  "securityIncidents.list": "incident.read_summary",
  "deliveries.list": "delivery.read",
  "deliveries.create": "delivery.write",

  // Dispatch and custody. `transfers.acknowledge` is a custody handoff and is
  // registered sensitive — it is not the same act as listing transfers.
  "jobUnits.list": "dispatch.read",
  "jobUnits.create": "dispatch.assign",
  "transfers.list": "dispatch.read",
  "transfers.create": "dispatch.assign",
  "transfers.acknowledge": "transfer.acknowledge",

  // Fleet and reference data
  "units.list": "fleet.read",
  "units.create": "fleet.write",
  "facilities.list": "reference.read",
  "facilities.create": "reference.write",
  "locations.list": "reference.read",
  "locations.create": "reference.write",
  "operatingZones.list": "reference.read",
  "operatingZones.create": "reference.write",
  "inspections.list": "inspection.read",
  "inspections.create": "inspection.write",

  // Duty records feed both compliance and payroll.
  "dutyRecords.list": "hos.read",
  "dutyRecords.create": "hos.write",

  // Position. Submitting a breadcrumb is a device act; confirming a zone event
  // turns a proposal into operational fact that billing relies on, so it is a
  // separate, sensitive permission.
  "gps.submitBreadcrumb": "gps.submit",
  "gps.breadcrumbs": "gps.read",
  "gps.pendingZoneEvents": "gps.read",
  "gps.zoneEvents": "gps.read",
  "gps.confirmZoneEvent": "gps.confirm",

  // Routing. Recording context is not deciding a route.
  "routeContext.list": "route.read",
  "routeContext.create": "route.write",
  "routeDecisions.list": "route.read",
  "routeDecisions.create": "route.decide",

  // Evidence capture. Verification is a separate, sensitive act from upload.
  "evidence.list": "evidence.read_job_operational",
  "evidence.upload": "evidence.upload",
  "evidence.add": "evidence.upload",
  "evidence.verify": "evidence.verify",
  "scans.list": "scan.read",
  "scans.create": "scan.write",

  // Assistant lifecycle. Drafting and answering are capture; committing writes
  // operational truth and is sensitive; reviewing is an office act.
  "assistant.forms": "assistant.read",
  "assistant.get": "assistant.read",
  "assistant.pending": "assistant.read",
  "assistant.draft": "assistant.use",
  "assistant.answer": "assistant.use",
  "assistant.readBack": "assistant.use",
  "assistant.setStatus": "assistant.review",
  "assistant.acknowledge": "assistant.review",
  "assistant.reject": "assistant.review",
  "assistant.commit": "assistant.commit",

  /* ---- B20.7: payroll, finance & tax ---- */

  // Own pay. The employee profile is resolved from the session, never supplied.
  "payroll.myPay": "payroll.read_own",
  "payroll.myTimeEntries": "payroll.read_own",
  "payroll.myStatements": "payroll.read_own",
  "payroll.submitTime": "payroll.time.submit_own",
  "payroll.raiseDispute": "payroll.dispute.raise_own",

  // Administration
  "payroll.profilesList": "payroll.read_employee",
  "payroll.profileUpsert": "payroll.profile.write",
  "payroll.ratesList": "payroll.rate.read",
  "payroll.rateCreate": "payroll.rate.write",
  "payroll.periodsList": "payroll.read_employee",
  "payroll.periodOpen": "payroll.run",
  "payroll.earningsList": "payroll.read_employee",
  "payroll.earningPropose": "payroll.run",
  "payroll.reconcileDay": "payroll.review",
  "payroll.disputesList": "payroll.review",
  "payroll.disputeResolve": "payroll.review",

  // Running a pay run and approving one are different acts held by different
  // roles. Neither role can do both.
  "payroll.runsList": "payroll.read_all",
  "payroll.runCreate": "payroll.run",
  // P0.4 / P0.5 — collecting approved earnings into lines and submitting the run for review are the
  // payroll administrator's acts; approving it stays the controller's (below). Approving ONE earning is
  // the reviewer's act (payroll_admin, hr): the human door between a proposed earning and a payable line.
  "payroll.runCollect": "payroll.run",
  "payroll.runSubmit": "payroll.run",
  // P3 — earning approval leaves the interim `payroll.review` for its own sensitive permission.
  "payroll.earningApprove": "payroll.earning.approve",
  "payroll.runApprove": "payroll.approve",
  "payroll.adjustmentRequest": "payroll.adjust",
  "payroll.adjustmentApprove": "payroll.approve",
  "payroll.export": "payroll.export",

  // Contractor settlement — a separate ledger from employee payroll.
  // Payroll P1 (0226) — compensation agreements and the earning-code catalogue.
  "payrollCompensation.earningCodesList": "payroll.compensation.read",
  "payrollCompensation.earningCodeCreate": "payroll.earning_code.manage",
  "payrollCompensation.earningCodeRetire": "payroll.earning_code.manage",
  "payrollCompensation.profileClassification": "payroll.compensation.read",
  "payrollCompensation.agreementsList": "payroll.compensation.read",
  "payrollCompensation.agreementGet": "payroll.compensation.read",
  "payrollCompensation.agreementCreate": "payroll.compensation.propose",
  "payrollCompensation.versionPropose": "payroll.compensation.propose",
  "payrollCompensation.versionApprove": "payroll.compensation.approve",
  "payrollCompensation.versionReject": "payroll.compensation.approve",
  "payrollCompensation.versionInForce": "payroll.compensation.read",

  // Payroll P2 (0227) — pay schedules and the pay-period machine.
  "payrollSchedule.schedulesList": "payroll.schedule.read",
  "payrollSchedule.scheduleCreate": "payroll.schedule.manage",
  "payrollSchedule.scheduleRetire": "payroll.schedule.manage",
  "payrollSchedule.periodsGenerate": "payroll.schedule.manage",
  "payrollSchedule.periodsList": "payroll.schedule.read",
  "payrollSchedule.periodGet": "payroll.schedule.read",
  "payrollSchedule.periodSubmit": "payroll.run",
  "payrollSchedule.periodApprove": "payroll.approve",
  "payrollSchedule.periodReopen": "payroll.approve",
  "payrollSchedule.periodProcess": "payroll.run",
  "payrollSchedule.periodFinalize": "payroll.finalize",
  "payrollSchedule.periodVoid": "payroll.void",
  "payrollSchedule.payGroupsList": "payroll.schedule.read",
  "payrollSchedule.payGroupSave": "payroll.schedule.manage",
  "payrollSchedule.profileAssignPayGroup": "payroll.schedule.manage",
  // Payroll P3 (0234) — payroll time. Own procedures resolve the profile from the session; team ones add D10.
  "payrollTime.myCandidates": "payroll.time.read_own",
  "payrollTime.myEntries": "payroll.time.read_own",
  "payrollTime.myEntryCreate": "payroll.time.submit_own",
  "payrollTime.myEntryUpdate": "payroll.time.submit_own",
  "payrollTime.myEntrySubmit": "payroll.time.submit_own",
  "payrollTime.myCandidateSubmit": "payroll.time.submit_own",
  "payrollTime.myEntryCorrect": "payroll.time.submit_own",
  "payrollTime.myEntryWithdraw": "payroll.time.submit_own",
  "payrollTime.teamEntries": "payroll.time.read_team",
  "payrollTime.entryApprove": "payroll.time.approve",
  "payrollTime.entryReject": "payroll.time.reject",
  "payrollTime.earningGenerate": "payroll.run",
  "payrollTime.exceptionsList": "payroll.exception.read",
  "payrollTime.exceptionsScan": "payroll.exception.resolve",
  "payrollTime.exceptionResolve": "payroll.exception.resolve",
  // Payroll P4 (0235) — employee expense claims. Own procedures resolve the claimant from the session.
  "payrollExpense.myExpensesList": "payroll.expense.read_own",
  "payrollExpense.myExpenseGet": "payroll.expense.read_own",
  "payrollExpense.myExpenseSubmit": "payroll.expense.submit_own",
  "payrollExpense.myExpenseClaimDraft": "payroll.expense.submit_own",
  "payrollExpense.myExpenseWithdraw": "payroll.expense.submit_own",
  "payrollExpense.pendingList": "payroll.expense.read",
  "payrollExpense.expenseGet": "payroll.expense.read",
  "payrollExpense.duplicates": "payroll.expense.read",
  "payrollExpense.approve": "payroll.expense.approve",
  "payrollExpense.reject": "payroll.expense.reject",
  "payrollExpense.returnForCorrection": "payroll.expense.approve",

  "contractors.settlementsList": "contractor.read",
  "contractors.settlementCreate": "contractor.write",
  "contractors.settlementApprove": "contractor.approve",

  // Finance and tax
  "finance.entitiesList": "tax.read_business",
  "finance.entityCreate": "finance.entity.write",
  "finance.registrationsList": "tax.read_business",
  "finance.expensesList": "tax.read_business",
  "finance.expenseCreate": "tax.expense.create",
  "finance.expenseAssess": "tax.expense.create",
  "finance.expenseSetTreatment": "tax.expense.review",
  "finance.expenseDuplicates": "tax.expense.review",
  "finance.taxRulesList": "tax.read_business",
  "finance.taxRuleLoad": "tax.rules.manage",
  "finance.filingProfile": "tax.read_business",
  "finance.thresholdCheck": "tax.read_business",

  // Private personal organizer — scoped to the caller by construction.
  "finance.myTaxDocs": "tax.read_personal_own",
  "finance.myTaxDocAdd": "tax.read_personal_own",
  "finance.myTaxDocShare": "tax.read_personal_own",

  /* ---- v20.14: portals and the funding knowledge panel ---- */
  "portals.mine": "portal.compose_own",
  "portals.panelsFor": "portal.compose_own",
  "funding.programsList": "funding.read",
  "funding.match": "funding.read",
  "funding.purchaseAdvisory": "funding.read",
  "funding.stackingCheck": "funding.read",
  "funding.opportunitiesList": "funding.read",
  "funding.opportunityAdvance": "funding.manage",
  "funding.claimRecord": "funding.claim",
  "funding.programLoad": "funding.programs.manage",

  /* ---- v20.19: roadside, purchasing, Accounts Payable ---- */
  "roadside.open": "roadside.report",
  "roadside.assignVendor": "roadside.manage",
  "purchasing.request": "purchasing.request",
  "purchasing.approve": "purchasing.approve",
  "vendor.billRecord": "vendor.bill.review",
  "vendor.billMatch": "vendor.bill.review",
  "vendor.billApprove": "vendor.bill.approve",
  "vendor.paymentRelease": "payment.release",
  "recovery.propose": "recovery.propose",

  /* ---- v20.20: secure field runtime ---- */
  "device.enroll": "device.enroll_own",
  "device.activate": "device.enroll_own",
  "device.rotateKey": "device.rotate_own",
  "device.revoke": "device.manage",
  "sync.receivePackage": "sync.push_own",
  "sync.resolveConflict": "sync.resolve_conflict",

  /* ---- v20.21: compliance master registry ---- */
  "compliance.passport": "compliance.passport.read",
  "compliance.jobPassport": "compliance.passport.read",
  "compliance.medicalEligibility": "compliance.passport.read",
  "compliance.credentialRecord": "compliance.credential.record",
  "compliance.credentialVerify": "compliance.credential.verify",
  "compliance.consentRecord": "compliance.consent.record",
  // C1b-2b: requirementLoad creates a proposal and nothing more.
  "compliance.requirementLoad": "compliance.requirement.propose",
  "compliance.requirementVerify": "compliance.requirement.verify",
  "compliance.requirementSecondApprove": "compliance.requirement.second_approve",
  "compliance.requirementWithdraw": "compliance.requirement.retire",
  "compliance.verificationPolicySet": "compliance.verification.govern",
  "compliance.requirementProvenance": "compliance.passport.read",
  "compliance.programPublish": "compliance.program.publish",
  "compliance.profileReviewRecord": "compliance.profile.review",
  "compliance.knowledgeCatalog": "compliance.passport.read",
  "compliance.dangerousGoodsAssist": "compliance.work.evaluate",
  "compliance.securementAssist": "compliance.work.evaluate",
  "compliance.driverQualification": "compliance.work.evaluate",

  /* ---- v20.22: requirement engine, packs, equipment, calibration ---- */
  "compliance.packActivate": "compliance.pack.manage",
  "compliance.workAuthorization": "compliance.work.evaluate",
  "equipment.authorize": "equipment.authorize",
  "calibration.deviceRegister": "calibration.record",
  "calibration.eventRecord": "calibration.record",
  "calibration.impact": "calibration.impact",

  /* ---- v20.23: insurance & risk ---- */
  "insurance.policyRecord": "insurance.write_policy",
  "insurance.coverageAssign": "insurance.write_policy",
  "insurance.coverageVerify": "insurance.verify_coverage",
  "insurance.coverageForEntity": "insurance.read_summary",
  "insurance.requirementSet": "insurance.manage_requirements",
  "insurance.requirementMatch": "insurance.read_policy",
  "insurance.certificateIssue": "insurance.certificate.issue",
  "insurance.renewalCalendar": "insurance.read_policy",
  "insurance.claimOpen": "insurance.claim.create",
  "insurance.claimCostRecord": "insurance.claim.financial",
  "insurance.claimRecoveryRecord": "insurance.claim.financial",
  "insurance.claimFinancials": "insurance.claim.financial",

  /* ---- v21.0: universal surfaces ---- */
  "surfaces.exceptions": "surface.exceptions.read",
  "surfaces.inbox": "inbox.read_own",
  "surfaces.myDay": "myday.read_own",
  /* ---- v22.23 B28 widget board: a surface over the caller's own board (same permission as My Day) ---- */
  "widgets.offerable": "myday.read_own",
  "widgets.boardResolve": "myday.read_own",
  "widgets.layoutSave": "myday.read_own",
  "surfaces.search": "surface.search",
  // P3.6: no permission of its own — every hop is gated by the permission of the record it is,
  // and a caller with none of them gets an empty chain and the same notice everybody gets.
  "surfaces.chain": "surface.timeline.read",
  "surfaces.timeline": "surface.timeline.read",

  /* ---- v21.1: dispatch gate ---- */
  "restrictedVault.matterOpen": "vault.matter.manage",
  "restrictedVault.mattersForIncident": "vault.matter.manage",
  "restrictedVault.investigationPropose": "vault.matter.manage",
  "restrictedVault.investigationDecide": "restricted.read",
  "restrictedVault.breakGlass": "restricted.read",
  "restrictedVault.restrictedIndex": "restricted.read",
  "restrictedVault.restrictedRead": "restricted.read",
  "restrictedVault.grantRevoke": "restricted.read",
  "restrictedVault.accessHistory": "restricted.audit.read",
  "hos.attestHours": "hos.attest",
  "hos.recordScannedLog": "hos.recordScannedLog",
  "device.verifySeal": "device.verifySeal",
  "dispatch.evaluate": "dispatch.evaluate",
  // P8.2 — the policy surface. manage is management-only by grant; read is wider; the operational
  // override is held widely precisely because it can only move toward more human involvement.
  "automationPolicy.resolve": "automation.policy.read",
  "automationPolicy.history": "automation.policy.read",
  "automationPolicy.snapshotFor": "automation.policy.read",
  "automationPolicy.set": "automation.policy.manage",
  "automationPolicy.setEntitlement": "automation.policy.manage",
  "automationPolicy.operationalOverride": "automation.override.operational",
  "dispatch.award": "dispatch.award",
  "dispatch.overrideRequest": "dispatch.override.request",
  "dispatch.overrideGrant": "dispatch.override.grant",
  "dispatch.whatAmIMissing": "dispatch.readiness_own",
  "dispatch.readiness": "dispatch.read",
  // The canonical slot model's door. Creating a posting or a slot is planning, so it sits under the
  // permission that already means "decide who works this job" — never under dispatch.award.
  "dispatch.createPosting": "dispatch.assign",
  "dispatch.addRole": "dispatch.assign",
  "dispatch.listRoles": "dispatch.read",
  // Binding a slot is assignment, never award. dispatch.award stays a separate permission so the
  // two can be separated by grant later without touching this code.
  "dispatch.setRoleAssignment": "dispatch.assign",
  "dispatch.clearRoleAssignment": "dispatch.assign",
  /* ---- v21.2: enforcement ---- */
  "dispatch.enforcementSet": "dispatch.enforcement.manage",
  "dispatch.enforcementGet": "dispatch.read",

  /* ---- post-recovery: contractor / owner-operator operations (procedure names, not permission names) ---- */
  "contractorOperations.profileUpsert": "contractor.write",
  "contractorOperations.relationshipCreate": "contractor.write",
  "contractorOperations.relationships": "contractor.read",
  "contractorOperations.relationshipAccept": "contractor.approve",
  "contractorOperations.workerAdd": "contractor.write",
  "contractorOperations.crewAssign": "dispatch.assign",
  "contractorOperations.jobChainCreate": "contractor.write",
  "contractorOperations.rateSet": "contractor.approve",
  "contractorOperations.ratesMine": "contractor.read",
  "contractorOperations.loadLink": "contractor.write",
  "contractorOperations.payablePrepare": "contractor.write",
  "contractorOperations.payablesMine": "contractor.read",
  "contractorOperations.payableSubmitReview": "contractor.write",
  "contractorOperations.payableApprove": "contractor.approve",

  /* ---- v21.3: IFTA ---- */
  "ifta.distanceRecord": "ifta.distance.record",
  "ifta.tripSplit": "ifta.distance.record",
  "ifta.distanceVerify": "ifta.distance.verify",
  "ifta.fuelJurisdictionSet": "ifta.fuel.classify",
  "ifta.quarter": "ifta.read",
  "ifta.quarterPrepare": "ifta.prepare",
  "ifta.quarterFinalize": "ifta.finalize",

  /* ---- v21.4: bulk fuel, statements, anomalies ---- */
  "fuel.tankRegister": "fuel.tank.manage",
  "fuel.dispenseRecord": "fuel.dispense.record",
  "fuel.readingRecord": "fuel.reading.record",
  "fuel.tankReconcile": "fuel.review",
  "fuel.statementImport": "fuel.statement.import",
  "fuel.statementLineResolve": "fuel.statement.import",
  "fuel.anomalies": "fuel.review",

  /* ---- v21.5: period close ---- */
  "period.readiness": "period.read",
  "period.close": "period.close",
  "period.reopen": "period.reopen",

  /* ---- v21.8: GST/HST ---- */
  "gst.treatmentSet": "gst.classify",
  "gst.adjustmentRecord": "gst.prepare",
  "gst.return": "gst.read",
  "gst.returnPrepare": "gst.prepare",
  "gst.returnFinalize": "gst.finalize",

  /* ---- v21.9: bank and receivables ---- */
  "bank.accountRegister": "bank.import",
  "bank.statementImport": "bank.import",
  "bank.reconciliation": "bank.read",
  "ar.paymentRecord": "ar.payment.record",
  "ar.paymentAllocate": "ar.payment.apply",
  "ar.creditRequest": "ar.credit.request",
  "ar.creditDecide": "ar.credit.decide",
  "ar.collectionEvent": "ar.collect",
  "ar.writeOffRequest": "ar.writeoff.request",
  "ar.writeOffDecide": "ar.writeoff.decide",
  "ar.aging": "ar.read",

  /* ---- v21.10: commercial core, portal review ---- */
  "commercial.termsSet": "commercial.terms.manage",
  "commercial.poRecord": "commercial.po.record",
  "commercial.rateCardCreate": "commercial.ratecard.manage",
  "commercial.billingCheck": "commercial.read",
  /* ---- v22.7: commercial setup & rate resolution ---- */
  "commercialSetup.profileSet": "commercial.setup.write",
  "commercialSetup.profileGet": "commercial.rates.read",
  "commercialSetup.definitionPropose": "commercial.rates.propose",
  "commercialSetup.definitionApprove": "commercial.rates.approve",
  "commercialSetup.definitionReject": "commercial.rates.approve",
  "commercialSetup.definitionList": "commercial.rates.read",
  "commercialSetup.rateResolve": "commercial.rates.read",
  "commercialSetup.sheetGaps": "commercial.rates.read",
  "commercialSetup.pricingDecide": "commercial.pricing.decide",
  "commercialSetup.decisionGet": "commercial.rates.read",
  "commercialSetup.marginSimulate": "commercial.margin.view",
  "commercialSetup.poExposure": "commercial.read",
  "commercialSetup.goLiveReadiness": "commercial.rates.read",
  "commercialSetup.ticketPricing": "commercial.rates.read",
  "commercialSetup.vendorRateVariances": "commercial.rates.read",
  // v23.31 — Customer, Contract & Rate Management (customerCommercialRouter).
  "customerCommercial.customerCreate": "commercial.customer.write",
  "customerCommercial.customerUpdate": "commercial.customer.write",
  "customerCommercial.customerHoldSet": "commercial.customer.write",
  "customerCommercial.customerArchive": "commercial.customer.archive",
  "customerCommercial.customerReactivate": "commercial.customer.archive",
  "customerCommercial.customersList": "commercial.customer.read",
  "customerCommercial.customerGet": "commercial.customer.read",
  "customerCommercial.customerHistory": "commercial.customer.read",
  "customerCommercial.contactCreate": "commercial.customer.write",
  "customerCommercial.contactUpdate": "commercial.customer.write",
  "customerCommercial.contactRoleSet": "commercial.customer.write",
  "customerCommercial.contactRoleEnd": "commercial.customer.write",
  "customerCommercial.contractCreate": "commercial.contract.write",
  "customerCommercial.contractUpdate": "commercial.contract.write",
  "customerCommercial.contractSubmit": "commercial.contract.write",
  "customerCommercial.contractApprove": "commercial.contract.approve",
  "customerCommercial.contractStatusSet": "commercial.contract.status",
  "customerCommercial.contractSupersede": "commercial.contract.write",
  "customerCommercial.contractsList": "commercial.contract.read",
  "customerCommercial.contractGet": "commercial.contract.read",
  "customerCommercial.rateSheetCreate": "commercial.rates.propose",
  "customerCommercial.rateSheetVersionCreate": "commercial.rates.propose",
  "customerCommercial.rateLineAdd": "commercial.rates.propose",
  "customerCommercial.rateLineUpdate": "commercial.rates.propose",
  "customerCommercial.rateLineRemove": "commercial.rates.propose",
  "customerCommercial.rateSheetVersionSubmit": "commercial.rates.propose",
  "customerCommercial.rateSheetVersionDecide": "commercial.rates.approve",
  "customerCommercial.rateSheetsList": "commercial.rates.read",
  "customerCommercial.rateSheetGet": "commercial.rates.read",
  "customerCommercial.jobContextSet": "commercial.job.assign",
  "customerCommercial.jobReferenceAdd": "commercial.job.assign",
  "customerCommercial.jobReferenceEnd": "commercial.job.assign",
  "customerCommercial.jobPartySet": "commercial.job.assign",
  "customerCommercial.jobReferenceWaive": "commercial.job.snapshot",
  "customerCommercial.jobSnapshotCapture": "commercial.job.snapshot",
  "customerCommercial.jobCommercialGet": "commercial.contract.read",
  "customerCommercial.jobFieldSummary": "commercial.job.summary",
  "customerCommercial.billableContext": "commercial.billing.context",
  "customerCommercial.jobRateResolve": "commercial.rates.read",
  "customerCommercial.expirySweep": "commercial.contract.status",
  /* ---- v22.9: the invoice path ---- */
  "invoicing.draftFromTicket": "invoicing.draft",
  "invoicing.get": "invoicing.read",
  "invoicing.finalize": "invoicing.finalize",
  "invoicing.render": "invoicing.render",
  "invoicing.send": "invoicing.send",
  "invoicing.void": "invoicing.void",
  "invoicing.disputeResolve": "invoicing.dispute.resolve",
  /* ---- v22.13: the mapping foundation ---- */
  "geo.atsImportTownship": "geo.import",
  "geo.accessRoadsImport": "geo.import",
  "geo.lsdLocate": "geo.read",
  "geo.coverage": "geo.read",
  "geo.locationVerifyFromGrid": "geo.locationVerifyFromGrid",
  "geo.positionToLsd": "geo.read",
  "geo.accessPropose": "geo.access.propose",
  "geo.accessDecide": "geo.access.decide",
  "geo.accessConfirmPassage": "geo.access.passage",
  "geo.accessForLsd": "geo.read",
  "geo.corridorEvaluate": "geo.read",
  "geo.graphBuild": "geo.graph.build",
  "geo.routeCompute": "geo.read",
  "geo.sourceReview": "geo.source.review",
  "geo.transportFeeds": "geo.source.review",

  /* ---- v22.17: communications on the route ---- */
  "comms.channelSeed": "comms.channel.manage",
  "comms.channelList": "comms.read",
  "comms.channelVerify": "comms.channel.verify",
  "comms.authorizationRecord": "comms.authorization.manage",
  "comms.authorizationVerify": "comms.authorization.verify",
  "comms.unitCapabilitySet": "comms.unit.capability",
  "comms.assignmentRecord": "comms.assignment.record",
  "comms.assignmentVerify": "comms.assignment.verify",
  "comms.assignmentsForSegments": "comms.read",
  "comms.signObserve": "comms.observation.record",
  "comms.signDecide": "comms.observation.decide",
  "comms.signQueue": "comms.read",
  "comms.coverageRecord": "comms.assignment.record",
  "comms.transmitCheck": "comms.read",
  "comms.planForPath": "comms.plan.compute",
  "comms.planGet": "comms.read",
  "comms.policyPropose": "comms.policy.manage",
  "comms.policyApprove": "comms.policy.approve",
  "comms.policyCurrent": "comms.read",
  "comms.oosPolicyPropose": "oos.policy.manage",
  "comms.oosPolicyApprove": "oos.policy.approve",
  "enforcement.extractionRecord": "enforcement.capture",
  "enforcement.eventConfirm": "enforcement.confirm",
  "enforcement.findingRecord": "enforcement.finding.record",
  "enforcement.orderRelease": "enforcement.release",
  "enforcement.activeOrders": "enforcement.read",
  "enforcement.eventGet": "enforcement.read",
  "enforcement.latchReport": "enforcement.latch",
  "enforcement.latchStates": "enforcement.latch",
  "enforcement.panelGrantIssue": "enforcement.panel.issue",
  "enforcement.panelGrantRevoke": "enforcement.panel.issue",
  "enforcement.panelView": "enforcement.panel.view",
  "timeOff.request": "timeOff.request",
  "timeOff.callOff": "timeOff.request",
  "timeOff.mine": "timeOff.request",
  "timeOff.decide": "timeOff.decide",
  "timeOff.schedulingRead": "timeOff.schedulingRead",
  "shifts.post": "shifts.post",
  "shifts.list": "shifts.read",
  "shifts.get": "shifts.read",
  "shifts.eligibility": "shifts.read",
  "shifts.candidates": "shifts.read",
  "shifts.expressInterest": "shifts.interest",
  "shifts.respond": "shifts.interest",
  "shifts.offerRespond": "shifts.interest",
  "shifts.interests": "shifts.read",
  // 0206 — the post's lifecycle and its offers are the poster's acts; linking a post to a slot is
  // an assignment act and carries the binding's own permission.
  "shifts.publish": "shifts.post",
  "shifts.close": "shifts.post",
  "shifts.cancel": "shifts.post",
  "shifts.offer": "shifts.post",
  "shifts.offerWithdraw": "shifts.post",
  "shifts.link": "dispatch.assign",
  "shifts.award": "dispatch.assign",
  "shifts.availabilitySet": "shifts.availability_own",
  "shifts.availabilityMine": "shifts.availability_own",
  "shifts.availabilityFor": "shifts.read",
  "crews.create": "crews.manage",
  "crews.addMember": "crews.manage",
  "crews.removeMember": "crews.manage",
  "crews.forecast": "crews.read",
  "calendar.mine": "calendar.own",
  "calendar.forScheduling": "calendar.scheduling",
  "calendar.exceptions": "calendar.scheduling",
  "readiness.forShift": "readiness.read",
  "readiness.forTime": "readiness.read",
  "assistant.ask": "assistant.ask",
  "assistant.askHistory": "assistant.ask",
  "assistant.addPassage": "assistant.curate",
  "assistant.supersedePassage": "assistant.curate",
  "assistant.addProbe": "assistant.curate",
  "assistant.addProbeFromAsk": "assistant.curate",
  "assistant.passageList": "assistant.curate",
  "assistant.measureRetrieval": "assistant.ask",
  "board.createChannel": "board.manage",
  "board.direct": "board.post",
  // Membership of a channel is changed by `board.manage`, or by a moderator or manager OF THAT
  // CHANNEL — a channel role, decided inside the procedure. The gate is the posting permission so a
  // group's own moderator can reach it; the procedure refuses anybody who is neither.
  "board.memberAdd": "board.post",
  "board.memberRemove": "board.post",
  "board.members": "board.read",
  "board.mine": "board.read",
  "board.moderateRead": "board.moderate",
  "board.moderateWithdraw": "board.moderate",
  "board.post": "board.post",
  "board.read": "board.read",
  "board.open": "board.read",
  "board.acknowledge": "board.read",
  "board.acknowledgements": "board.read",
  "agent.start": "agent.use",
  "agent.requestAction": "agent.act",
  "agent.decideApproval": "agent.approve",
  "agent.awaitEvent": "agent.act",
  "agent.get": "agent.read",
  // LA-1a — Live Assist session spine.
  "liveAssist.start": "live_assist.use",
  "liveAssist.heartbeat": "live_assist.use",
  "liveAssist.pause": "live_assist.use",
  "liveAssist.resume": "live_assist.use",
  "liveAssist.end": "live_assist.use",
  "liveAssist.policyGet": "live_assist.use",
  "liveAssist.policySet": "live_assist.administer",
  "liveAssist.lifecycleList": "live_assist.review",
  "board.history": "board.read",
  "board.edit": "board.post",
  "board.withdraw": "board.post",
  "hos.profileSeed": "hos.rule.manage",
  "hos.profileList": "hos.read",
  "hos.limitVerify": "hos.rule.verify",
  /** 0093 (recovered): the cited path. Same permission, materially stronger evidence. */
  "hos.limitPromote": "hos.rule.verify",
  "hos.profileVerify": "hos.rule.verify",
  "hos.profileFor": "hos.read",
  "hos.status": "hos.read",
  "hos.tripFeasibility": "hos.read",
  "comms.channelRetire": "comms.channel.verify",
  "comms.packageBuild": "comms.package.build",
  "comms.packageFetch": "comms.package.fetch",
  "comms.packageAcknowledge": "comms.package.fetch",
  "comms.packageStatus": "comms.read",
  "portalAdmin.identityInvite": "portal.identity.manage",
  "portalAdmin.submissionReview": "portal.submission.review",

  /* ---- v21.11: site sign-off chain ---- */
  "closeout.ticketOpen": "closeout.ticket.write",
  "closeout.lineAdd": "closeout.ticket.write",
  "closeout.eventRecord": "closeout.event.record",
  "closeout.eventClose": "closeout.event.record",
  "closeout.delayRecord": "closeout.delay.record",
  "closeout.authoritySet": "closeout.authority.manage",
  "closeout.sitePrepare": "closeout.ticket.write",
  "closeout.siteSign": "closeout.sign.witness",
  "closeout.lineDecide": "closeout.line.decide",
  "closeout.supplementPrepare": "closeout.supplement.prepare",
  "closeout.state": "closeout.read",
  "closeout.whyTheseHours": "closeout.read",

  /* ---- v21.12 ---- */
  "portalAdmin.identityRevoke": "portal.identity.manage",
  "closeout.documentRender": "closeout.document.render",
  "closeout.adjustmentPayrollPropose": "closeout.adjustment.payroll_propose",
  "closeout.weatherObserve": "observation.record",
  "closeout.roadHazardReport": "observation.record",
  "closeout.completionPackageRender": "closeout.document.render",

  /* ---- v21.15: fleet shop ---- */
  "shop.partCreate": "shop.parts.manage",
  "shop.partReceive": "shop.parts.move",
  "shop.partIssue": "shop.parts.move",
  "shop.partReturn": "shop.parts.move",
  "shop.coreReturn": "shop.parts.move",
  "shop.partCount": "shop.parts.count",
  "shop.stock": "shop.read",
  "shop.tireRegister": "shop.tires.manage",
  "shop.tireInstall": "shop.tires.manage",
  "shop.tireRemove": "shop.tires.manage",
  "shop.tireMeasure": "shop.tires.manage",
  "shop.tireHistory": "shop.read",
  "shop.warrantyPolicyRecord": "shop.warranty.raise",
  "shop.warrantyClaimRaise": "shop.warranty.raise",
  "shop.warrantyClaimDecide": "shop.warranty.decide",
  "shop.toolRegister": "shop.tools.manage",
  "shop.toolCheckout": "shop.tools.manage",
  "shop.toolReturn": "shop.tools.manage",
  "shop.recallRecord": "shop.recall.record",
  "shop.workOrderAdvance": "shop.workorder.advance",
  "shop.workOrderRelease": "shop.release",
  "shop.recallVerify": "shop.recall.verify",
  "shop.recallUnitDecide": "shop.recall.record",
  "shop.workOrderCost": "shop.read",
  "shop.unitCost": "shop.read",

  /* ---- v21.16: capital assets and CCA ---- */
  "asset.register": "asset.register",
  "asset.capitalReview": "asset.capital.review",
  "asset.ccaClassSet": "asset.cca.classify",
  "asset.ccaClassVerify": "asset.cca.verify",
  "asset.dispose": "asset.register",
  "asset.list": "asset.read",
  "asset.twin": "asset.read",
  "cca.schedule": "asset.read",
  "cca.schedulePrepare": "cca.prepare",
  "cca.scheduleReview": "cca.review",

  /* ---- v21.17: commercial projects ---- */
  "project.quoteCreate": "project.quote.manage",
  "project.quoteIssue": "project.quote.issue",
  "project.quoteRevise": "project.quote.manage",
  "project.changeOrderPropose": "project.change.manage",
  "project.rfiAsk": "project.rfi.manage",
  "project.budgetCreate": "project.budget.manage",
  "project.budgetApprove": "project.budget.approve",
  "project.percentCompleteState": "project.budget.manage",
  "project.forecast": "project.read",

  /* ---- v21.18: integration gateway ---- */
  "integration.clientRegister": "integration.client.manage",
  /* post-recovery (ChatGPT tip) procedures, previously wired under clientRegister's / inboundList's names — same permissions, own names */
  "integration.ownershipAssign": "integration.client.manage",
  "integration.ownershipList": "integration.read",
  "integration.loadSenseBindGateway": "integration.client.manage",
  "integration.loadSenseCalibrate": "integration.client.manage",
  "integration.clientRevoke": "integration.client.manage",
  "integration.inboundList": "integration.read",
  "integration.webhookSubscribe": "integration.webhook.manage",
  "integration.webhookSetStatus": "integration.webhook.manage",
  "integration.webhookDispatch": "integration.webhook.manage",
  "integration.deliveries": "integration.read",

  /* ---- v21.19: telematics and video safety ---- */
  "telematics.unit": "telematics.read",
  "telematics.faults": "telematics.read",
  "telematics.faultAcknowledge": "telematics.fault.acknowledge",
  "telematics.faultClear": "telematics.fault.acknowledge",
  "telematics.reviewQueue": "telematics.read",
  "telematics.eventReview": "safety.event.review",
  "telematics.videoView": "safety.video.read",

  /* ---- v22.21/v22.22: Training Academy ---- */
  // 0182 — Safety & Compliance Program Builder
  "safetyProgram.catalog": "safety_program.read",
  "safetyProgram.templateDetail": "safety_program.read",
  "safetyProgram.syncCatalog": "safety_program.manage",
  "safetyProgram.syncContent": "safety_program.manage",
  "safetyProgram.obligations": "safety_program.read",
  "safetyProgram.programGet": "safety_program.read",
  "safetyProgram.programSet": "safety_program.manage",
  "safetyProgram.assemble": "safety_program.read",
  "safetyProgram.policyCreate": "safety_program.write",
  "safetyProgram.policyList": "safety_program.read",
  "safetyProgram.policyDetail": "safety_program.read",
  "safetyProgram.versionDraft": "safety_program.write",
  "safetyProgram.versionDraftFromTemplate": "safety_program.write",
  "safetyProgram.versionEdit": "safety_program.write",
  "safetyProgram.versionApprove": "safety_program.approve",
  "safetyProgram.versionWithdraw": "safety_program.approve",
  "safetyProgram.policyRetire": "safety_program.approve",
  "safetyProgram.myPolicies": "safety_program.read_own",
  "safetyProgram.acknowledge": "safety_program.acknowledge_own",
  "safetyProgram.acknowledgementStatus": "safety_program.read",
  "safetyProgram.overlaySet": "safety_program.write",
  "safetyProgram.overlayList": "safety_program.read",
  "safetyProgram.reviewSchedule": "safety_program.write",
  "safetyProgram.reviewComplete": "safety_program.approve",
  "safetyProgram.referenceList": "safety_program.read",
  "safetyProgram.referenceUpsert": "safety_program.manage",
  "safetyProgram.referenceVerify": "safety_program.verify",
  "safetyProgram.trainingRequirementList": "safety_program.read",
  "safetyProgram.trainingRequirementUpsert": "safety_program.manage",
  "safetyProgram.trainingMatrixCompute": "safety_program.write",
  "safetyProgram.trainingMatrix": "safety_program.read",
  "safetyProgram.correctiveActionOpen": "safety_program.write",
  "safetyProgram.correctiveActionProgress": "safety_program.write",
  "safetyProgram.correctiveActionVerify": "safety_program.verify",
  "safetyProgram.correctiveActionList": "safety_program.read",
  "safetyProgram.corReadiness": "safety_program.read",
  "safetyProgram.vendorPackageManifest": "safety_program.read",
  "safetyProgram.events": "safety_program.read",

  "academy.catalog": "academy.read_own",
  "academy.myTraining": "academy.read_own",
  "academy.assignmentDetail": "academy.read_own",
  "academy.ticketPortfolio": "academy.read_own",
  "academy.moduleComplete": "academy.progress_own",
  "academy.assessmentOpen": "academy.assessment_own",
  "academy.assessmentSubmit": "academy.assessment_own",
  "academy.syncCatalog": "academy.manage",
  "academy.assign": "academy.assign",
  "academy.practicalSignoff": "academy.evaluate",
  "academy.sourceReview": "academy.source.review",
  "academy.certificateIssue": "academy.certificate.issue",
  "academy.certificateSignOwn": "academy.certificate.sign_own",
  "academy.statementOfExperienceCreate": "academy.certificate.issue",
  "academy.foreignTdgRoadRecognize": "compliance.credential.verify",
  "academy.requirementList": "academy.read_own",
  "academy.requirementUpsert": "academy.requirement.manage",
  "academy.directSupervisionCreate": "academy.direct_supervision.manage",
  "academy.directSupervisionAttest": "academy.direct_supervision_attest_own",
  "academy.dispatchCheck": "dispatch.evaluate",
  /* ---- v22.22 (0122/0123): TDG topic coverage and inspector requests ---- */
  "academy.tdgCoverageSet": "academy.manage",
  "academy.tdgCoverageApprove": "academy.source.review",
  "academy.tdgCoverageStatus": "academy.read_own",
  "academy.inspectorRequestCreate": "academy.certificate.issue",
  "academy.inspectorRequestAssemble": "academy.certificate.issue",
  "academy.inspectorRequestList": "academy.certificate.issue",
  "academy.sheetPrintRun": "academy.manage",
  "academy.sheetScanFile": "academy.evaluate",

  /* ---- v21.20: workforce lifecycle ---- */
  "workforce.applicantCreate": "hr.applicant.manage",
  "workforce.screeningRecord": "hr.applicant.manage",
  "workforce.applicantDecide": "hr.applicant.manage",
  "workforce.applicantList": "hr.applicant.read",
  "workforce.onboardingStatus": "hr.onboarding.manage",
  "workforce.taskComplete": "hr.onboarding.manage",
  "workforce.taskVerify": "hr.training.verify",
  "workforce.trainingRecord": "hr.training.record",
  "workforce.trainingVerify": "hr.training.verify",
  "workforce.competencySignoff": "hr.competency.signoff",
  "workforce.probationRecommend": "hr.probation.recommend",
  "workforce.probationDecide": "hr.probation.decide",
  "workforce.offboardingOpen": "hr.offboarding.manage",
  "workforce.offboardingRevokeAccess": "hr.access.revoke",

  /* B23.2 — People & Access.
   *
   * Every one of these maps to `roles.grant`, which `authorize()` gives to
   * `management` alone and which is already in SENSITIVE_PERMISSIONS, so the
   * audit row is written before the act and a failure to write it refuses.
   *
   * No new permission was introduced, deliberately. `personnel.read` would
   * have been the obvious home for the read surfaces, but it reaches
   * dispatcher, office, HR and payroll_admin — and "who holds what access" is
   * an access-administration question rather than an HR-record one. Starting
   * narrow leaves the decision to widen it with an owner; starting wide is not
   * reversible in practice. */
  "people.roleCatalogue": "roles.grant",
  "people.list": "roles.grant",
  "people.detail": "roles.grant",
  "people.setRoles": "roles.grant",
  "people.setDefaultWorkspace": "roles.grant",
  "people.removeFromOrganization": "roles.grant",
  "people.invitations.list": "roles.grant",
  "people.invitations.create": "roles.grant",
  "people.invitations.cancel": "roles.grant",
  "people.accessResolution.list": "roles.grant",
  "workforce.offboardingStatus": "hr.offboarding.manage",
  "workforce.offboardingClose": "hr.offboarding.manage",

  /* ---- v21.21: audit packages ---- */
  "audit.packagePrepare": "audit.package.prepare",
  "audit.packageRelease": "audit.package.release",
  "audit.packageWithdraw": "audit.package.release",
  "audit.packageGet": "audit.package.read",
  "audit.packageDownload": "audit.package.read",
  "audit.packageList": "audit.package.read",

  /* ---- v22.0: spatial foundation ---- */
  "spatial.locationRegister": "spatial.location.manage",
  "spatial.locationVerify": "spatial.location.verify",
  "spatial.locationGet": "spatial.read",
  "spatial.vehicleProfileSet": "spatial.vehicle.manage",
  "spatial.vehicleProfileVerify": "spatial.vehicle.verify",
  "spatial.restrictionRecord": "spatial.restriction.record",
  "spatial.restrictionVerify": "spatial.restriction.verify",
  "spatial.routeEvaluateSegments": "spatial.route.evaluate",
  "spatial.routeRequest": "spatial.route.evaluate",
  "spatial.structureRecord": "spatial.structure.record",
  "spatial.structureVerify": "spatial.structure.verify",
  "spatial.routeApprove": "spatial.route.approve",
  "spatial.routeApprovalCheck": "spatial.read",
  "spatial.routingSourceStatus": "spatial.read",
  "spatial.lastPosition": "spatial.read",

  /* ---- v22.1: contract terms ---- */
  "closeout.termsRecord": "closeout.terms.record",
  "closeout.termsApprove": "closeout.terms.approve",
  "closeout.termsApply": "closeout.terms.record",

  /* ---- 0212: Driver Portfolio API ---- */
  "driverPortfolio.myWallet": "portfolio.read_own",
  "driverPortfolio.myCredentialHistory": "portfolio.read_own",
  "driverPortfolio.myShares": "portfolio.read_own",
  "driverPortfolio.submitCredential": "portfolio.submit_own",
  "driverPortfolio.shareIssue": "portfolio.share_own",
  "driverPortfolio.shareRevoke": "portfolio.share_own",
  "driverPortfolio.operatorReadiness": "dispatch.read",
  "driverPortfolio.portfolio": "portfolio.read",
  "driverPortfolio.auditHistory": "portfolio.read",
  "driverPortfolio.expiryDashboard": "portfolio.read",
  "driverPortfolio.verificationQueue": "portfolio.read",
  "driverPortfolio.credentialVerify": "compliance.credential.verify",
  "driverPortfolio.requirementList": "portfolio.read",
  "driverPortfolio.requirementGet": "portfolio.read",
  "driverPortfolio.requirementCreate": "portfolio.requirement.manage",
  "driverPortfolio.requirementUpdate": "portfolio.requirement.manage",
  "driverPortfolio.requirementRetire": "portfolio.requirement.manage",
  /* ---- 0199: fleet maintenance, checkpoint 1 ---- */
  "maintenance.workOrderAssignment": "maintenance.read_defect",
  "maintenance.workOrderAssign": "maintenance.workorder.assign",
  "maintenance.workOrderCancel": "maintenance.workorder.cancel",

  /* ---- 0200: Fleet & Equipment Portfolio foundation ---- */
  "fleet.unitState": "fleet.read",
  "fleet.holdList": "fleet.read",
  "fleet.holdPlace": "fleet.hold.place",
  "fleet.holdRelease": "fleet.hold.release",
  "fleet.meterReadings": "fleet.read",
  "fleet.meterProgress": "fleet.read",
  "fleet.meterRecord": "fleet.meter.record",
  "fleet.meterDecide": "fleet.meter.verify",
  "fleet.history": "fleet.read",

  /* ---- 0221: fleet maintenance, checkpoint 2 — defect to return to service ---- */
  "maintenance.defectReport": "maintenance.write_defect",
  "maintenance.defectTriage": "maintenance.defect.triage",
  "maintenance.defectSendToShop": "maintenance.defect.send_to_shop",
  "maintenance.taskAdd": "maintenance.task.write",
  "maintenance.taskSetStatus": "maintenance.task.write",
  "maintenance.returnToService": "maintenance.return_to_service.record",
  "maintenance.defectHistory": "maintenance.read_defect",

  /* ---- the page scanner: guidance and review, both read-only ----
   * Both answer "what does this paperwork need"; neither writes, links or
   * confirms anything, so both sit on the ordinary compliance read rather
   * than on a permission of their own. A worker who may not read the
   * company's compliance material may not read its paperwork guidance
   * either — that is the same question, and it already has an answer. */
  "paperwork.guidance": "compliance.read",
  "paperwork.reviewScan": "compliance.read",

  /* ---- SA1: Sign & Attest (server/attestRouter.ts) ---- */
  "attest.open": "attest.document.open",
  "attest.placeFields": "attest.field.place",
  "attest.assignSigner": "attest.signer.assign",
  "attest.sign": "attest.sign_own",
  "attest.witness": "attest.witness",
  "attest.decline": "attest.decline_own",
  "attest.finalize": "attest.finalize",
  "attest.void": "attest.void",
  "attest.supersede": "attest.supersede",
  "attest.view": "attest.read",
  "attest.list": "attest.read",
  "attest.verify": "attest.read",
  "attest.proof": "attest.read",
  "attest.exportReceipt": "attest.export",
} as const satisfies Record<string, Permission>;

/**
 * Every procedure name the two maps declare, as a type.
 *
 * `roleProcedure` took a bare string, so `roleProcedure("comms.read")` — a
 * permission where a procedure name belongs — compiled fine and failed at
 * wiring time. That mistake has now been made twice in four checkpoints, in
 * both directions, because the two vocabularies look alike and live in the same
 * file. A union closes the category: a permission is not a ProcedureName, and
 * TypeScript says so at the call site instead of the server saying so at boot.
 */
export type ProcedureName =
  | keyof typeof RECORDS_PROCEDURE_PERMISSIONS
  | keyof typeof OPERATIONAL_PROCEDURE_PERMISSIONS;

export function permissionForProcedure(name: string): Permission | null {
  return (
    (RECORDS_PROCEDURE_PERMISSIONS as Record<string, Permission>)[name] ??
    (OPERATIONAL_PROCEDURE_PERMISSIONS as Record<string, Permission>)[name] ??
    null
  );
}

/* ==================================================================
 * v23.26 — The session surface.
 *
 * Three procedures, and it is a closed list on purpose. `sessionProcedure`
 * requires authentication but no domain role, which is the only gate in this
 * system that a person holding nothing can pass — so the set of things it may
 * be used for is declared here rather than left to whoever writes the next
 * router. `procedureAuthorization.test.ts` pins it.
 *
 * All three carry `portal.compose_own`: the existing universal permission for
 * "assemble MY session from MY roles". They read `ctx.user.id`, the grants the
 * gate already loaded, and the memberships those imply. Nobody composes
 * somebody else's session, which is what makes the permission universal in the
 * first place.
 * ================================================================== */

export const SESSION_PROCEDURE_PERMISSIONS = {
  "session.context": "portal.compose_own",
  "session.selectOrganization": "portal.compose_own",
  "session.selectWorkspace": "portal.compose_own",
  /*
   * B23.2 — accepting an invitation is the one People & Access act that CANNOT
   * be a `roleProcedure`: the person accepting holds nothing in the
   * organization they are joining, which is the entire point. That is the case
   * `sessionProcedure` was built for in B23.0 — "the one gate an account
   * holding nothing can pass" — so it belongs here, on a list that is closed in
   * code and pinned by the census rather than open by default.
   *
   * It is not a hole: the gate still requires an authenticated identity, and
   * the invitation token is verified against a stored digest inside the
   * transaction that creates the membership.
   */
  "session.acceptInvitation": "portal.compose_own",
} as const satisfies Record<string, Permission>;

export type SessionProcedureName = keyof typeof SESSION_PROCEDURE_PERMISSIONS;

/* ==================================================================
 * v21.10 — External identities
 *
 * A customer, vendor or facility identity is not a domain-role user. It
 * holds exactly the permissions of its kind, and every one of them is scoped
 * by the account the identity is bound to. The map is consulted at wiring
 * time; an unmapped external procedure refuses to mount.
 * ================================================================== */

export type ExternalPermission =
  | "portal.customer.commit"
  | "portal.invitation.accept" | "portal.credential.manage"
  | "portal.customer.adjust" | "portal.customer.documents"
  | "portal.self" | "portal.customer.read" | "portal.customer.dispute" | "portal.customer.sign" | "portal.customer.decide"
  | "portal.vendor.read" | "portal.vendor.submit"
  | "portal.facility.read" | "portal.facility.submit"
  // SA1 — a customer identity reads the signing revisions that name it and signs its own fields.
  | "portal.attest.read" | "portal.attest.sign";

export const EXTERNAL_KIND_PERMISSIONS: Record<"customer" | "vendor" | "facility", readonly ExternalPermission[]> = {
  customer: ["portal.customer.commit", "portal.invitation.accept", "portal.credential.manage", "portal.customer.adjust", "portal.customer.documents", "portal.self", "portal.customer.read", "portal.customer.dispute", "portal.customer.sign", "portal.customer.decide", "portal.attest.read", "portal.attest.sign"],
  vendor: ["portal.invitation.accept", "portal.credential.manage", "portal.self", "portal.vendor.read", "portal.vendor.submit"],
  facility: ["portal.invitation.accept", "portal.credential.manage", "portal.self", "portal.facility.read", "portal.facility.submit"],
};

export const EXTERNAL_PROCEDURE_PERMISSIONS = {
  // v21.12 — identity lifecycle (through the same gate), adjustments, documents, reports.
  "portal.invitationAccept": "portal.invitation.accept",
  "portal.mfaEnroll": "portal.credential.manage",
  "portal.mfaConfirm": "portal.credential.manage",
  "portal.tokenRotate": "portal.credential.manage",
  "portal.adjustmentAuthorize": "portal.customer.adjust",
  "portal.documents": "portal.customer.documents",
  "portal.documentDownload": "portal.customer.documents",
  "portal.dailyReport": "portal.customer.read",
  "portal.observations": "portal.customer.read",
  // v21.13 — the customer's live view: state from ticket events, readiness as a projection, notices as templates.
  // v21.17 — commercial commitments from the customer: accept a quote, authorize a change order, answer an RFI.
  "portal.quotes": "portal.customer.read",
  "portal.quoteAccept": "portal.customer.commit",
  "portal.changeOrderAuthorize": "portal.customer.commit",
  "portal.rfiAnswer": "portal.customer.commit",
  "portal.jobBoard": "portal.customer.read",
  "portal.preClearance": "portal.customer.read",
  "portal.notices": "portal.customer.read",
  // v21.14 — chain of custody, the approval queue, the timeline, alerts and their preferences.
  "portal.chainOfCustody": "portal.customer.read",
  "portal.approvalQueue": "portal.customer.read",
  "portal.jobTimeline": "portal.customer.read",
  "portal.alerts": "portal.customer.read",
  "portal.alertAcknowledge": "portal.customer.read",
  "portal.alertPreferences": "portal.customer.read",
  "portal.alertPreferencesSet": "portal.credential.manage",
  "portal.me": "portal.self",
  "portal.customerStatement": "portal.customer.read",
  "portal.invoiceDispute": "portal.customer.dispute",
  "portal.invoices": "portal.customer.read",
  "portal.invoiceView": "portal.customer.read",
  "portal.invoiceAccept": "portal.customer.decide",
  "portal.fieldTicketView": "portal.customer.read",
  "portal.fieldTicketSign": "portal.customer.sign",
  /* ---- SA1: Sign & Attest through the portal ---- */
  "portal.attestList": "portal.attest.read",
  "portal.attestView": "portal.attest.read",
  "portal.attestSign": "portal.attest.sign",
  "portal.attestDecline": "portal.attest.sign",
  "portal.fieldTicketLineDecide": "portal.customer.decide",
  "portal.vendorStatement": "portal.vendor.read",
  "portal.vendorBillSubmit": "portal.vendor.submit",
  "portal.facilityStatement": "portal.facility.read",
  "portal.disposalTicketSubmit": "portal.facility.submit",
} as const satisfies Record<string, ExternalPermission>;

/** Writes from outside are refused when their audit row cannot be written. */
// `portal.invitation.accept` is here because accepting an invitation activates an
// external identity and mints a 90-day bearer token. That is the most consequential
// thing the portal gate does, and it was the one credential operation outside this
// set: `portal.credential.manage`, which governs the lesser `tokenRotate`, was already
// in it. Without it, a token could be issued in the one circumstance where nothing
// recorded that it had been.
export const EXTERNAL_SENSITIVE_PERMISSIONS: readonly ExternalPermission[] = ["portal.customer.commit", "portal.credential.manage", "portal.invitation.accept", "portal.customer.adjust", "portal.customer.documents", "portal.customer.dispute", "portal.customer.sign", "portal.customer.decide", "portal.vendor.submit", "portal.facility.submit", "portal.attest.sign"];

export function externalPermissionForProcedure(name: string): ExternalPermission | null {
  return (EXTERNAL_PROCEDURE_PERMISSIONS as Record<string, ExternalPermission>)[name] ?? null;
}

/* ==================================================================
 * v21.18 — Integration clients
 *
 * A machine is not a person and not a customer. It holds exactly the feeds
 * it was scoped for. The map is consulted at wiring time; an unmapped
 * inbound procedure refuses to mount.
 * ================================================================== */

export type IntegrationPermission = "inbound.self" | "inbound.ingest";

export const INTEGRATION_PROCEDURE_PERMISSIONS = {
  "inbound.me": "inbound.self",
  "inbound.ingest": "inbound.ingest",
} as const satisfies Record<string, IntegrationPermission>;

/** Ingestion writes; it is refused when its audit row cannot be written. */
export const INTEGRATION_SENSITIVE_PERMISSIONS: readonly IntegrationPermission[] = ["inbound.ingest"];

export function integrationPermissionForProcedure(name: string): IntegrationPermission | null {
  return (INTEGRATION_PROCEDURE_PERMISSIONS as Record<string, IntegrationPermission>)[name] ?? null;
}
