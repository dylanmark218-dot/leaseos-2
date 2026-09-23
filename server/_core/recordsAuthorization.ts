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
  /* 0170 — the ELD event ledger. A device appends its own events (self-scoped in code: the device
     must be enrolled to the session user); reading a device's chain is an office act. */
  | "eld.event.record_own" | "eld.read"
  // v20.21 — compliance master registry. Reading a passport is broad
  // verifying evidence, loading requirements and reading private credential
  // detail are not.
  | "compliance.passport.read" | "compliance.credential.record" | "compliance.credential.verify"
  | "compliance.private.read" | "compliance.consent.record" | "compliance.requirement.manage"
  | "compliance.program.publish" | "compliance.profile.review"
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
  // v22.20 — the agent. Asking it to work, acting, and approving differ.
  | "agent.use" | "agent.act" | "agent.approve" | "agent.read"
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
  | "academy.certificate.issue" | "academy.requirement.manage" | "academy.direct_supervision.manage";

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
    "eld.read",
    "hos.read",
    "comms.package.build",
    "comms.package.fetch",
    /* v22.17 — communications */
    "comms.read",
    "comms.plan.compute",
    "evidence.read_job_operational",
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
  ],
  shop_lead: [
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
  ],
  safety: [
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
    "eld.read",
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
  ],
  office: [
    "device.verifySeal",
    "vault.matter.manage",
    "hos.recordScannedLog",
    "automation.policy.read",
    "facility.directory.report",
    "facility.directory.write",
    "facility.directory.read",
    "commercial.read",
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
    "eld.read",
    "hos.read",
    "comms.package.build",
    /* v22.17 — communications */
    "comms.read",
    "comms.plan.compute",
    "comms.assignment.record",
    "evidence.read_job_operational",
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
  ],
  management: [
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
    "eld.read",
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
  ],
  hr: [
    "academy.assign",
    "academy.manage",
    "academy.evaluate",
    "academy.certificate.issue",
    "evidence.read_personnel",
    "incident.read_summary",
    "incident.read_investigation",
    "payroll.read",
    "payroll.read_own",
    "payroll.read_employee",
    "payroll.review",
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
    "evidence.read_legal",
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
    "facility.directory.read",
    "evidence.read_job_operational",
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
    "eld.read",
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
    "facility.directory.read",
    "commercial.read",
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
    "payroll.read_own",
    "payroll.read_employee",
    "payroll.read_all",
    "payroll.review",
    "payroll.run",
    "payroll.adjust",
    "payroll.rate.read",
    "payroll.export",
    "evidence.read_personnel",
    "personnel.read",
    "payroll.profile.write",
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
    "evidence.read_commercial",
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
  // 0170 — an ELD batch is admitted only for a device enrolled to `ctx.user.id`; the store re-checks it.
  "eld.event.record_own",
] as const;

export function isUniversalPermission(p: Permission): boolean {
  return UNIVERSAL_PERMISSIONS.includes(p);
}

/**
 * Defence in depth. With category grants these are mostly redundant — a
 * mechanic has no commercial read to begin with. They stay because a future
 * grant edit that widens a role should still not silently open these.
 */
const DENIALS: Partial<Record<DomainRole, readonly Permission[]>> = {
  mechanic: ["billing.read", "billing.write", "payroll.read", "personnel.write", "incident.read_investigation"],
  shop_lead: ["billing.read", "billing.write", "payroll.read", "personnel.write", "incident.read_investigation"],
  dispatcher: ["billing.read", "billing.write", "payroll.read", "personnel.write", "incident.read_investigation"],
  driver: ["billing.read", "billing.write", "payroll.read", "personnel.read", "personnel.write", "incident.read_investigation"],
  auditor: ["payroll.read", "billing.write", "personnel.write"],

  // The banking and tax-identifier reads are held by nobody in this model.
  // They exist so the permission has a name to be denied under, and so adding
  // a holder is a deliberate, reviewable act rather than a side effect of a
  // broad grant. Same reason `authority_certified` sits empty in the
  // measurement ladder.
  bookkeeper: ["payroll.bank.read", "payroll.tax_identifier.read", "payroll.read_all", "payroll.approve"],
  payroll_admin: ["payroll.bank.read", "payroll.tax_identifier.read", "payroll.approve", "billing.write"],
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

/** A grant as stored: a role, optionally confined to one branch. */
export type RoleGrant = { role: string; scopeRef?: string | null };

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
 */
export function authorize(args: {
  userId: number | null | undefined;
  roles?: readonly string[];
  grants?: readonly RoleGrant[];
  permission: Permission;
  resourceBranch?: string | null;
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

  const branchUnresolved = args.resourceBranch === undefined;
  const universal = (UNIVERSAL_PERMISSIONS as readonly string[]).includes(args.permission);
  const inScope = recognized.filter(
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
  "payroll.runApprove": "payroll.approve",
  "payroll.adjustmentRequest": "payroll.adjust",
  "payroll.adjustmentApprove": "payroll.approve",
  "payroll.export": "payroll.export",

  // Contractor settlement — a separate ledger from employee payroll.
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

  /* ---- 0170: the ELD event ledger ---- */
  "eld.eventsAppend": "eld.event.record_own",
  "eld.deviceIntegrity": "eld.read",

  /* ---- v20.21: compliance master registry ---- */
  "compliance.passport": "compliance.passport.read",
  "compliance.jobPassport": "compliance.passport.read",
  "compliance.medicalEligibility": "compliance.passport.read",
  "compliance.credentialRecord": "compliance.credential.record",
  "compliance.credentialVerify": "compliance.credential.verify",
  "compliance.consentRecord": "compliance.consent.record",
  "compliance.requirementLoad": "compliance.requirement.manage",
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
  "shifts.eligibility": "shifts.read",
  "shifts.expressInterest": "shifts.interest",
  "shifts.interests": "shifts.read",
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
  | "portal.facility.read" | "portal.facility.submit";

export const EXTERNAL_KIND_PERMISSIONS: Record<"customer" | "vendor" | "facility", readonly ExternalPermission[]> = {
  customer: ["portal.customer.commit", "portal.invitation.accept", "portal.credential.manage", "portal.customer.adjust", "portal.customer.documents", "portal.self", "portal.customer.read", "portal.customer.dispute", "portal.customer.sign", "portal.customer.decide"],
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
export const EXTERNAL_SENSITIVE_PERMISSIONS: readonly ExternalPermission[] = ["portal.customer.commit", "portal.credential.manage", "portal.invitation.accept", "portal.customer.adjust", "portal.customer.documents", "portal.customer.dispute", "portal.customer.sign", "portal.customer.decide", "portal.vendor.submit", "portal.facility.submit"];

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
