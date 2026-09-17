/**
 * Exception Centre — the engine.
 *
 * People should not browse tables looking for problems. LeaseOS tells them:
 *
 *   CRITICAL   Unit 144 cannot dispatch — critical defect unresolved
 *   BILLING    Bill 48291 mismatched — billed 3 tires, authorized 2
 *   WORKFORCE  J. Smith's TDG expires in 14 days
 *   AI         3 proposed records await confirmation
 *
 * Two design decisions carry the whole thing.
 *
 * Exceptions are DERIVED, never stored. An expired credential IS an
 * exception until it is renewed; a mismatched bill IS an exception until it
 * is matched. There is no row to create when the problem appears and forget
 * to close when it goes away. Every exception is a pure function of the
 * current state of the record it points at, so the list is always right.
 * (Tasks and notifications — things assigned to someone — are the two
 * existing tables. This engine does not compete with them.)
 *
 * Every exception carries the permission needed to act on it, and the feed
 * a person sees is filtered to what they may act on. The exception centre is
 * not a place where a driver learns what the controller is worried about.
 */

import { authorize, type Permission, type RoleGrant } from "./recordsAuthorization";

export type ExceptionCategory =
  | "critical" | "dispatch" | "billing" | "purchasing" | "workforce" | "fleet"
  | "finance" | "ai" | "sync" | "devices" | "calibration" | "insurance" | "compliance";

export type ExceptionSeverity = "critical" | "high" | "medium" | "low";

export type DeepLink = { portal: string; route: string };

export type Exception = {
  /** Stable across evaluations for the same underlying record — the UI keys on it. */
  key: string;
  category: ExceptionCategory;
  severity: ExceptionSeverity;
  title: string;
  reason: string;
  subjectType: string;
  subjectId: number | string;
  /** The corrective action, not the record. */
  action: string;
  deepLink: DeepLink;
  requiredPermission: Permission;
  since: Date | null;
  dueAt: Date | null;
};

const SEVERITY_RANK: Record<ExceptionSeverity, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/* ------------------------------------------------------------------ */
/* Source snapshots — what the service hands the engine                 */
/* ------------------------------------------------------------------ */

export type ExceptionSources = {
  now: Date;
  criticalDefects: { id: number; unitId: number; unitNumber: string | null; title: string; reportedAt: Date; status: string }[];
  roadsideOpen: { id: number; eventRef: string; unitNumber: string | null; eventType: string; occurredAt: Date; vendorAssigned: boolean }[];
  vendorBills: { id: number; billRef: string; vendorName: string | null; total: number; status: string; matchOutcome: string; receivedAt: Date; dueAt: Date | null }[];
  purchaseRequests: { id: number; authorizationRef: string; estimatedAmount: number; emergency: boolean; requestedAt: Date; expiresAt: Date | null; status: string }[];
  credentials: { id: number; ownerType: string; ownerId: number; ownerLabel: string | null; docType: string; title: string; expiresAt: Date | null; verificationStatus: string }[];
  aiProposals: { proposalId: string; formKey: string; title: string; createdAt: Date; commitState: string }[];
  aiQuestions: { count: number; oldest: Date | null; askedToUserId: number | null }[];
  syncConflicts: { id: number; conflictRef: string; recordType: string; recordRef: string; material: boolean; detectedAt: Date }[];
  revokedDevicesWithQueue: { deviceRef: string; userId: number; queued: number; revokedAt: Date | null }[];
  measurementDevices: { deviceRef: string; deviceType: string; status: string; calibrationState: "current" | "due_soon" | "expired" | "failed" | "unknown"; daysRemaining: number | null }[];
  insurancePolicies: { policyRef: string; policyType: string; expiresAt: Date; status: string }[];
  carrierProfileReviews: { reviewRef: string; unmatchedExternalEvents: number; reviewedAt: Date | null; nextReviewDueAt: Date | null }[];
  /** v21.2 — advisory-mode assignments made without a check, or against a blocked/unknown one. */
  ungatedAssignments: { jobUnitId: number; jobId: number; unitId: number; operatorId: number | null; createdAt: Date; finding: string }[];
  /** v21.5 — the fuel line's findings. */
  statementsWithFindings: { statementRef: string; provider: string; unmatched: number; ambiguous: number; importedAt: Date }[];
  tanksOutOfTolerance: { tankRef: string; name: string; variancePct: number; varianceLitres: number; reason: string }[];
  /** s.6.7 inspector requests still open (0122): the fifteen-day clock, surfaced from five days out. */
  inspectorRequests: { requestRef: string; issuingAuthority: string; dueAt: Date; state: string; irrecoverable: boolean }[];
  /** 0131 security incidents: a required notification unsent, or personal information suspected with no privacy decision. */
  securityIncidents?: { incidentRef: string; title: string; severity: string; personalInformationSuspected: boolean; assessed: boolean; unsentNotifications: { recipientType: string; dueAt: Date | null }[] }[];
  periodsSoftClosed: { financialEntityId: number; period: string; reviewItems: number; since: Date }[];
};

/* ------------------------------------------------------------------ */
/* Derivation                                                           */
/* ------------------------------------------------------------------ */

const daysUntil = (d: Date | null, now: Date) => (d ? Math.floor((d.getTime() - now.getTime()) / 86_400_000) : null);

const DAY = 86_400_000;

export function deriveExceptions(s: ExceptionSources): Exception[] {
  const out: Exception[] = [];
  const now = s.now;

  for (const d of s.criticalDefects) {
    const unit = d.unitNumber ?? `#${d.unitId}`;
    out.push({
      key: `defect:${d.id}`, category: "critical", severity: "critical",
      title: `Unit ${unit} cannot dispatch`, reason: `Critical defect unresolved: ${d.title}`,
      subjectType: "unit", subjectId: d.unitId, action: "Open the defect; repair, test and obtain mechanic release",
      deepLink: { portal: "fleet_maintenance", route: `/defects/${d.id}` }, requiredPermission: "maintenance.read_defect",
      since: d.reportedAt, dueAt: null,
    });
  }

  for (const r of s.roadsideOpen) {
    out.push({
      key: `roadside:${r.id}`, category: "critical", severity: r.vendorAssigned ? "high" : "critical",
      title: `Roadside event ${r.eventRef}${r.unitNumber ? ` — Unit ${r.unitNumber}` : ""}`,
      reason: r.vendorAssigned ? `${r.eventType.replace(/_/g, " ")}; vendor assigned, repair in progress` : `${r.eventType.replace(/_/g, " ")}; no vendor assigned`,
      subjectType: "roadsideEvent", subjectId: r.id, action: r.vendorAssigned ? "Track repair and return-to-service" : "Assign an approved roadside vendor",
      deepLink: { portal: "dispatch_operations", route: `/roadside/${r.eventRef}` }, requiredPermission: "roadside.manage",
      since: r.occurredAt, dueAt: null,
    });
  }

  for (const b of s.vendorBills) {
    const attention: Record<string, { sev: ExceptionSeverity; reason: string; action: string }> = {
      mismatch: { sev: "high", reason: "Four-way match variances unresolved", action: "Resolve the variances before approval" },
      missing_receipt: { sev: "medium", reason: "No receipt or photo evidence attached", action: "Attach the receipt or vendor work order" },
      duplicate_suspected: { sev: "high", reason: "A bill with this vendor and invoice number may already exist", action: "Confirm this is not a duplicate" },
      needs_approval: { sev: "medium", reason: "Matched; awaiting coding approval", action: "Code and approve" },
      needs_coding: { sev: "low", reason: "Received; not yet coded", action: "Match and code" },
    };
    const a = attention[b.status];
    if (!a) continue;
    const overdue = daysUntil(b.dueAt, now);
    out.push({
      key: `bill:${b.id}`, category: "billing", severity: overdue !== null && overdue < 0 ? "high" : a.sev,
      title: `Bill ${b.billRef}${b.vendorName ? ` — ${b.vendorName}` : ""} $${b.total.toFixed(2)}`,
      reason: overdue !== null && overdue < 0 ? `${a.reason}; ${-overdue} day(s) past due` : a.reason,
      subjectType: "vendorBill", subjectId: b.id, action: a.action,
      deepLink: { portal: "finance_billing", route: `/ap/bills/${b.billRef}` }, requiredPermission: "vendor.bill.review",
      since: b.receivedAt, dueAt: b.dueAt,
    });
  }

  for (const p of s.purchaseRequests) {
    if (p.status !== "requested") continue;
    const expired = p.expiresAt && p.expiresAt <= now;
    out.push({
      key: `pa:${p.id}`, category: "purchasing", severity: p.emergency ? "critical" : "medium",
      title: `${p.emergency ? "Emergency purchase" : "Purchase"} ${p.authorizationRef} — $${p.estimatedAmount.toFixed(2)}`,
      reason: expired ? "Request expired unapproved" : p.emergency ? "Awaiting emergency approval — a unit may be disabled" : "Awaiting approval",
      subjectType: "purchaseAuthorization", subjectId: p.id, action: expired ? "Re-request or cancel" : "Approve, approve up to a limit, or reject",
      deepLink: { portal: "management", route: `/purchasing/${p.authorizationRef}` }, requiredPermission: "purchasing.approve",
      since: p.requestedAt, dueAt: p.expiresAt,
    });
  }

  // Credential exceptions are gated on the permission to VERIFY a credential —
  // the people who chase renewals — not on the broad permission to read a
  // passport, which every driver holds. A driver's own expiring documents reach
  // them through their passport and My Day, not through a company-wide list of
  // everyone else's.
  for (const c of s.credentials) {
    const days = daysUntil(c.expiresAt, now);
    const isWorker = c.ownerType === "operator" || c.ownerType === "user";
    const label = c.ownerLabel ?? `${c.ownerType} #${c.ownerId}`;
    if (c.verificationStatus === "needs_review") {
      out.push({
        key: `cred:${c.id}:review`, category: isWorker ? "workforce" : "fleet", severity: "low",
        title: `${label}: ${c.title} awaiting verification`, reason: "Recorded, not yet verified",
        subjectType: c.ownerType, subjectId: c.ownerId, action: "Verify or reject the document",
        deepLink: { portal: isWorker ? "hr_workforce" : "fleet_maintenance", route: `/credentials/${c.id}` }, requiredPermission: "compliance.credential.verify",
        since: null, dueAt: c.expiresAt,
      });
    }
    if (days === null) continue;
    if (days < 0) {
      out.push({
        key: `cred:${c.id}:expired`, category: isWorker ? "workforce" : "fleet", severity: "high",
        title: `${label}: ${c.title} expired`, reason: `Expired ${-days} day(s) ago`,
        subjectType: c.ownerType, subjectId: c.ownerId, action: "Renew and record the new document",
        deepLink: { portal: isWorker ? "hr_workforce" : "fleet_maintenance", route: `/credentials/${c.id}` }, requiredPermission: "compliance.credential.verify",
        since: c.expiresAt, dueAt: c.expiresAt,
      });
    } else if (days <= 30) {
      out.push({
        key: `cred:${c.id}:expiring`, category: isWorker ? "workforce" : "fleet", severity: days <= 7 ? "high" : "medium",
        title: `${label}: ${c.title} expires in ${days} day(s)`, reason: "Renewal window",
        subjectType: c.ownerType, subjectId: c.ownerId, action: "Schedule renewal",
        deepLink: { portal: isWorker ? "hr_workforce" : "fleet_maintenance", route: `/credentials/${c.id}` }, requiredPermission: "compliance.credential.verify",
        since: null, dueAt: c.expiresAt,
      });
    }
  }

  for (const p of s.aiProposals) {
    if (p.commitState !== "awaiting_readback") continue;
    out.push({
      key: `proposal:${p.proposalId}`, category: "ai", severity: "low",
      title: `Proposed ${p.formKey.replace(/_/g, " ")}: ${p.title}`, reason: "AI-proposed record awaits confirmation",
      subjectType: "assistantProposal", subjectId: p.proposalId, action: "Review the read-back and confirm, edit or reject",
      deepLink: { portal: "office_administration", route: `/assistant/proposals/${p.proposalId}` }, requiredPermission: "assistant.review",
      since: p.createdAt, dueAt: null,
    });
  }
  for (const q of s.aiQuestions) {
    if (q.count === 0) continue;
    out.push({
      key: `questions:${q.askedToUserId ?? "unassigned"}`, category: "ai", severity: "low",
      title: `${q.count} unanswered question(s)`, reason: "Extraction needs a person's answer to proceed",
      subjectType: "assistantQuestion", subjectId: q.askedToUserId ?? 0, action: "Answer the queue",
      deepLink: { portal: "field_workforce", route: `/assistant/questions` }, requiredPermission: "assistant.review",
      since: q.oldest, dueAt: null,
    });
  }

  for (const c of s.syncConflicts) {
    out.push({
      key: `conflict:${c.id}`, category: "sync", severity: c.material ? "high" : "medium",
      title: `Sync conflict on ${c.recordType} ${c.recordRef}`, reason: c.material ? "Device and server changed a material field differently" : "Device and server changed the same field",
      subjectType: c.recordType, subjectId: c.recordRef, action: "Choose the device's version, the server's, or a merge — both are retained",
      deepLink: { portal: "office_administration", route: `/sync/conflicts/${c.conflictRef}` }, requiredPermission: "sync.resolve_conflict",
      since: c.detectedAt, dueAt: null,
    });
  }

  for (const d of s.revokedDevicesWithQueue) {
    out.push({
      key: `device:${d.deviceRef}`, category: "devices", severity: "high",
      title: `Revoked device ${d.deviceRef} has ${d.queued} unsynced package(s)`, reason: "Evidence captured on a revoked device will be refused on arrival",
      subjectType: "fieldDevice", subjectId: d.deviceRef, action: "Recapture the evidence on an enrolled device",
      deepLink: { portal: "safety_compliance", route: `/devices/${d.deviceRef}` }, requiredPermission: "device.manage",
      since: d.revokedAt, dueAt: null,
    });
  }

  for (const m of s.measurementDevices) {
    if (m.calibrationState === "current") continue;
    const sev: ExceptionSeverity = m.calibrationState === "failed" ? "critical" : m.calibrationState === "expired" ? "high" : m.calibrationState === "unknown" ? "medium" : "low";
    out.push({
      key: `calibration:${m.deviceRef}`, category: "calibration", severity: sev,
      title: `${m.deviceType.replace(/_/g, " ")} ${m.deviceRef}: calibration ${m.calibrationState.replace(/_/g, " ")}`,
      reason: m.calibrationState === "failed" ? "Found out of tolerance — billing on hold, weight cannot be certified; run the impact analysis" : m.calibrationState === "expired" ? "Billing measurements on hold until recalibrated" : m.daysRemaining !== null ? `Due in ${m.daysRemaining} day(s)` : "No calibration on record",
      subjectType: "measurementDevice", subjectId: m.deviceRef, action: m.calibrationState === "failed" ? "Run impact analysis; recalibrate; return to service" : "Recalibrate",
      deepLink: { portal: "fleet_maintenance", route: `/calibration/${m.deviceRef}` }, requiredPermission: "calibration.impact",
      since: null, dueAt: null,
    });
  }

  for (const p of s.insurancePolicies) {
    if (p.status === "cancelled" || p.status === "quoted") continue;
    const days = daysUntil(p.expiresAt, now)!;
    if (days > 90) continue;
    out.push({
      key: `policy:${p.policyRef}`, category: "insurance", severity: days < 0 ? "critical" : days <= 7 ? "high" : days <= 30 ? "medium" : "low",
      title: `${p.policyType.replace(/_/g, " ")} policy ${p.policyRef} ${days < 0 ? "expired" : `expires in ${days} day(s)`}`,
      reason: days < 0 ? "Coverage expired — every covered unit is not dispatchable" : days <= 14 ? "Binder or renewal certificate needed" : days <= 60 ? "Broker submission window" : "Renewal preparation",
      subjectType: "insurancePolicy", subjectId: p.policyRef, action: days < 0 ? "Bind renewal immediately" : "Work the renewal calendar",
      deepLink: { portal: "finance_billing", route: `/insurance/policies/${p.policyRef}` }, requiredPermission: "insurance.read_summary",
      since: null, dueAt: p.expiresAt,
    });
  }

  for (const r of s.carrierProfileReviews) {
    if (r.unmatchedExternalEvents > 0) {
      out.push({
        key: `profile:${r.reviewRef}`, category: "compliance", severity: "high",
        title: `${r.unmatchedExternalEvents} external compliance event(s) unmatched`, reason: "The regulator's profile shows events LeaseOS does not know about",
        subjectType: "carrierProfileReview", subjectId: r.reviewRef, action: "Investigate and reconcile each event",
        deepLink: { portal: "safety_compliance", route: `/carrier-profile/${r.reviewRef}` }, requiredPermission: "compliance.profile.review",
        since: r.reviewedAt, dueAt: null,
      });
    }
    if (r.nextReviewDueAt && r.nextReviewDueAt <= now) {
      out.push({
        key: `profile-due:${r.reviewRef}`, category: "compliance", severity: "medium",
        title: "Carrier Profile review overdue", reason: `Due ${r.nextReviewDueAt.toISOString().slice(0, 10)}`,
        subjectType: "carrierProfileReview", subjectId: r.reviewRef, action: "Obtain the current profile and record a review",
        deepLink: { portal: "safety_compliance", route: `/carrier-profile` }, requiredPermission: "compliance.profile.review",
        since: r.nextReviewDueAt, dueAt: r.nextReviewDueAt,
      });
    }
  }

  for (const st of s.statementsWithFindings) {
    if (st.unmatched + st.ambiguous === 0) continue;
    out.push({
      key: `statement:${st.statementRef}`, category: "finance", severity: st.unmatched > 0 ? "high" : "medium",
      title: `${st.provider} statement ${st.statementRef}: ${st.unmatched} purchase(s) without a receipt${st.ambiguous ? `, ${st.ambiguous} ambiguous` : ""}`,
      reason: "A card purchase nobody scanned, or a line that could be more than one receipt", subjectType: "fuelStatement", subjectId: st.statementRef,
      action: "Find and scan the receipts; resolve each line", deepLink: { portal: "finance_billing", route: `/fuel/statements/${st.statementRef}` }, requiredPermission: "fuel.statement.import",
      since: st.importedAt, dueAt: null,
    });
  }
  for (const t of s.tanksOutOfTolerance) {
    out.push({
      key: `tank:${t.tankRef}`, category: "finance", severity: "high",
      title: `Tank ${t.name}: ${t.varianceLitres} L (${t.variancePct}%) unexplained`, reason: t.reason, subjectType: "bulkFuelTank", subjectId: t.tankRef,
      action: "Explain the variance and record it — unrecorded fill, leak or theft", deepLink: { portal: "fleet_maintenance", route: `/fuel/tanks/${t.tankRef}` }, requiredPermission: "fuel.review",
      since: null, dueAt: null,
    });
  }
  for (const si of s.securityIncidents ?? []) {
    for (const n of si.unsentNotifications) {
      const overdue = n.dueAt ? n.dueAt.getTime() < now.getTime() : false;
      out.push({
        key: `security-notify:${si.incidentRef}:${n.recipientType}`, category: "compliance", severity: overdue || si.severity === "critical" ? "critical" : "high",
        title: `${si.incidentRef}: notification to ${n.recipientType} is required and unsent${overdue ? " — overdue" : ""}`,
        reason: `${si.title}. The privacy reviewer decided notification is required${n.dueAt ? `, due ${n.dueAt.toISOString().slice(0, 10)}` : " (no due date set)"}.`,
        subjectType: "security_incident", subjectId: si.incidentRef, action: "Send the notification and record it with its evidence",
        deepLink: { portal: "office", route: `/security/incidents/${si.incidentRef}` }, requiredPermission: "incident.review", since: null, dueAt: n.dueAt,
      });
    }
    if (si.personalInformationSuspected && !si.assessed) {
      out.push({
        key: `security-assess:${si.incidentRef}`, category: "compliance", severity: "high",
        title: `${si.incidentRef}: personal information suspected, no privacy decision`,
        reason: `${si.title}. A privacy breach assessment decides whether notification is required; nothing decides it automatically.`,
        subjectType: "security_incident", subjectId: si.incidentRef, action: "Complete the privacy breach assessment (uncertain is an answer; pending is not)",
        deepLink: { portal: "office", route: `/security/incidents/${si.incidentRef}` }, requiredPermission: "incident.review", since: null, dueAt: null,
      });
    }
  }

  for (const r of s.inspectorRequests ?? []) {   // older fixtures omit the field
    const daysLeft = Math.floor((r.dueAt.getTime() - now.getTime()) / DAY);
    if (daysLeft > 5) continue;                       // five days out and closer; overdue is negative
    const overdue = daysLeft < 0;
    out.push({
      key: `inspector:${r.requestRef}`, category: "compliance", severity: overdue ? "critical" : "high",
      title: overdue ? `Inspector request ${r.requestRef} is ${-daysLeft} day(s) overdue` : `Inspector request ${r.requestRef} due in ${daysLeft} day(s)`,
      reason: `${r.issuingAuthority} requested training records under TDG s.6.7; the response is due ${r.dueAt.toISOString().slice(0, 10)}${r.irrecoverable ? " and part of the evidence is irrecoverable" : ""}`,
      subjectType: "inspector_request", subjectId: r.requestRef,
      action: r.state === "incomplete" ? "Assemble what can be produced and state what cannot" : "Assemble and produce the package",
      deepLink: { portal: "training_academy", route: `/academy/inspector-requests/${r.requestRef}` }, requiredPermission: "academy.certificate.issue",
      since: null, dueAt: r.dueAt,
    });
  }
  for (const p of s.periodsSoftClosed) {
    out.push({
      key: `period:${p.financialEntityId}:${p.period}`, category: "finance", severity: "medium",
      title: `Period ${p.period} soft-closed with ${p.reviewItems} review item(s)`, reason: "Under review; not yet closed", subjectType: "period", subjectId: p.period,
      action: "Clear the review items and close, or reopen", deepLink: { portal: "finance_billing", route: `/periods/${p.period}` }, requiredPermission: "period.close",
      since: p.since, dueAt: null,
    });
  }

  for (const a of s.ungatedAssignments) {
    out.push({
      key: `ungated:${a.jobUnitId}`, category: "dispatch", severity: a.finding.includes("blocked") ? "high" : "medium",
      title: `Job ${a.jobId}, Unit ${a.unitId}: ${a.finding}`, reason: "Enforcement is advisory — this would have been refused if enforced",
      subjectType: "job", subjectId: a.jobId, action: "Evaluate readiness now; resolve or override what it names",
      deepLink: { portal: "dispatch_operations", route: `/jobs/${a.jobId}` }, requiredPermission: "dispatch.evaluate",
      since: a.createdAt, dueAt: null,
    });
  }

  return sortExceptions(dedupe(out));
}

function dedupe(xs: Exception[]): Exception[] {
  const seen = new Set<string>();
  return xs.filter(x => (seen.has(x.key) ? false : (seen.add(x.key), true)));
}

export function sortExceptions(xs: Exception[]): Exception[] {
  return [...xs].sort((a, b) =>
    SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] ||
    (a.dueAt?.getTime() ?? Infinity) - (b.dueAt?.getTime() ?? Infinity) ||
    (a.since?.getTime() ?? 0) - (b.since?.getTime() ?? 0)
  );
}

/* ------------------------------------------------------------------ */
/* Permission gate                                                      */
/* ------------------------------------------------------------------ */

/**
 * Only what the caller may act on. An exception with a permission the caller
 * does not hold is not "shown greyed out" — it is not shown. The centre is a
 * to-do list, not a window into other people's worries.
 */
export function visibleTo(args: { exceptions: readonly Exception[]; userId: number; grants: readonly RoleGrant[] }): Exception[] {
  const cache = new Map<Permission, boolean>();
  const may = (p: Permission) => {
    if (!cache.has(p)) cache.set(p, authorize({ userId: args.userId, grants: args.grants, permission: p }).allowed);
    return cache.get(p)!;
  };
  return args.exceptions.filter(x => may(x.requiredPermission));
}

export function summarize(xs: readonly Exception[]): { total: number; bySeverity: Record<ExceptionSeverity, number>; byCategory: Partial<Record<ExceptionCategory, number>>; headline: string } {
  const bySeverity: Record<ExceptionSeverity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  const byCategory: Partial<Record<ExceptionCategory, number>> = {};
  for (const x of xs) { bySeverity[x.severity]++; byCategory[x.category] = (byCategory[x.category] ?? 0) + 1; }
  const headline = xs.length === 0 ? "Nothing needs your attention" : bySeverity.critical > 0 ? `${bySeverity.critical} critical` : bySeverity.high > 0 ? `${bySeverity.high} high priority` : `${xs.length} item(s)`;
  return { total: xs.length, bySeverity, byCategory, headline };
}
