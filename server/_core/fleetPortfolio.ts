/**
 * Fleet & Equipment Portfolio — a unit's operational state, and who may place or release a hold.
 *
 * Pure. The caller reads the facts; this decides nothing it was not shown. Reached from
 * `server/fleetPortfolioRouter.ts` through `server/fleetPortfolioService.ts` in the same change, so the
 * unwired-engine census does not rise (portfolio design C-1).
 *
 * The state is derived on every read and stored nowhere (design B.1, B.3). Its five values are the
 * owner's (2026-09-25), in order of consequence:
 *
 *     out_of_service  >  maintenance_hold  >  indeterminate  >  warning  >  available
 *
 * `indeterminate` outranks `warning` and `available` because a source that could not be read, or a
 * safety input nobody has judged, is not evidence that the unit is fine. It does not outrank a hold: a
 * unit with one known stop is stopped, whatever else is uncertain.
 *
 * The readiness composer remains the one authority on dispatch (D-06). This projection reads the same
 * records with the same rules; checkpoint work that follows makes the composer's unit side and this
 * projection one reading.
 */
import { createHash } from "node:crypto";
import { currentReleaseEvidenceFor, releaseIsPositiveEvidence, type StoredRelease } from "./mechanicRelease";
import { faultDispatchEffect } from "./telematics";
import { UNTRUSTED_METER_SEQUENCE, type MeterSequence } from "./fleetMeters";

/* ------------------------------------------------------------------ */
/* Holds: the three effects, and who may do what                      */
/* ------------------------------------------------------------------ */

export type HoldType = "safety" | "maintenance" | "inspection" | "compliance" | "damage" | "administrative";
export type HoldEffect = "warn" | "block" | "out_of_service";
export const HOLD_TYPES: readonly HoldType[] = ["safety", "maintenance", "inspection", "compliance", "damage", "administrative"];

/**
 * Which roles may PLACE which hold types (design B.7): a mechanic places maintenance holds only.
 * Roles not listed may place nothing, whatever permission they hold.
 */
const PLACE: Record<string, readonly HoldType[]> = {
  mechanic: ["maintenance"],
  shop_lead: ["maintenance", "inspection", "damage", "administrative"],
  safety: ["safety", "inspection", "compliance"],
  management: ["safety", "maintenance", "inspection", "compliance", "damage", "administrative"],
};
/** Which roles may RELEASE which hold types (design B.7). Never the driver, never the dispatcher. */
const RELEASE: Record<string, readonly HoldType[]> = {
  mechanic: ["maintenance"],
  shop_lead: ["maintenance", "damage", "administrative"],
  safety: ["safety", "inspection", "compliance"],
  management: ["inspection", "safety", "compliance", "damage", "administrative"],
};

export type Decision = { allowed: true; reason: string } | { allowed: false; reason: string };

/**
 * The effect a new hold takes. `out_of_service` exactly when the type is `safety` (reconciliation R-1).
 * Maintenance, inspection and compliance holds block unless the placer asks for a warning; damage and
 * administrative holds warn unless management places them as blocking (design O-5).
 */
export function holdEffectFor(args: { holdType: HoldType; requested: "warn" | "block" | null; roles: readonly string[] }): { effect: HoldEffect } | { refused: string } {
  if (args.holdType === "safety") {
    if (args.requested === "warn") return { refused: "A safety hold is out of service; it cannot be placed as a warning" };
    return { effect: "out_of_service" };
  }
  if (args.holdType === "damage" || args.holdType === "administrative") {
    if (args.requested === "block" && !args.roles.includes("management")) return { refused: `Only management places a ${args.holdType} hold as blocking` };
    return { effect: args.requested === "block" ? "block" : "warn" };
  }
  return { effect: args.requested === "warn" ? "warn" : "block" };
}

export function mayPlaceHold(roles: readonly string[], holdType: HoldType): Decision {
  const by = roles.find(r => PLACE[r]?.includes(holdType));
  return by ? { allowed: true, reason: `${by} may place a ${holdType} hold` } : { allowed: false, reason: `None of your roles (${roles.join(", ") || "none"}) may place a ${holdType} hold` };
}

/** A hold is released by someone other than the person who placed it, holding a role that releases its type. */
export function mayReleaseHold(args: { roles: readonly string[]; holdType: HoldType; placedByUserId: number; userId: number; status: "active" | "released" }): Decision {
  if (args.status !== "active") return { allowed: false, reason: "This hold is already released" };
  if (args.placedByUserId === args.userId) return { allowed: false, reason: "The person who placed a hold may not release it — a second person decides the unit may move" };
  const by = args.roles.find(r => RELEASE[r]?.includes(args.holdType));
  return by ? { allowed: true, reason: `${by} may release a ${args.holdType} hold` } : { allowed: false, reason: `None of your roles (${args.roles.join(", ") || "none"}) may release a ${args.holdType} hold` };
}

/** The role a caller acts in for this act: the first of theirs that the rule names. */
export const actingRoleFor = (roles: readonly string[], holdType: HoldType, act: "place" | "release") =>
  roles.find(r => (act === "place" ? PLACE : RELEASE)[r]?.includes(holdType)) ?? null;

/* ------------------------------------------------------------------ */
/* Operational state                                                   */
/* ------------------------------------------------------------------ */

export type OperationalStatus = "available" | "warning" | "maintenance_hold" | "out_of_service" | "indeterminate";
export type ReasonCategory = "maintenance" | "inspection" | "compliance" | "safety" | "damage" | "administrative" | "enforcement" | "telematics" | "meter" | "source" | "lifecycle" | "component";

export type StateReason = {
  code: string;
  status: Exclude<OperationalStatus, "available">;
  category: ReasonCategory;
  label: string;
  source: { table: string; ref: string };
  since: Date | null;
  /** The act that lifts it — never a shortcut around its source. */
  liftedBy: string;
};

export type PortfolioFacts = {
  /** `sourceKind` says which act lifts the hold: a hand-placed one by `fleet.holdRelease`, a workflow's by that workflow. */
  holds: readonly { holdRef: string; holdType: HoldType; dispatchEffect: HoldEffect; reason: string; placedAt: Date; sourceKind?: string; sourceRef?: string | null }[];
  /** Open defects and every critical defect whatever its status — the readiness composer's own read. */
  defects: readonly { id: number; title: string; severity: "advisory" | "inspection_required" | "critical"; status: "open" | "in_progress" | "resolved"; resolvedByReleaseId: number | null; reportedAt: Date }[];
  releases: readonly (StoredRelease & { restrictionDetail: string | null })[];
  /** Active government orders reaching this unit (vehicle or trailer scope), matched structurally. */
  activeOrders: readonly { orderRef: string; scope: string; issuedAt: Date | null; issuingAgency: string | null }[];
  unestablishedInspections: readonly { inspectionRef: string }[];
  openRoadside: readonly { eventRef: string; status: string; occurredAt: Date | null }[];
  faults: readonly { id: number; code: string; status: string; severityDetermination: string; occurrenceCount: number; lastSeenAt: Date | null }[];
  meters: readonly Pick<MeterSequence, "meterType" | "trust" | "regressions">[];
  /** 0221 — the stored lifecycle; absent (an older caller) reads as active, which is what every existing unit is. */
  lifecycle?: { status: "active" | "seasonal_storage" | "retired" | "sold" | "transferred"; changedAt: Date | null } | null;
  /** 0221 — the components attached now, each with the two facts that hold the parent (O-9). */
  components?: readonly { componentRef: string; childUnitId: number; childUnitNumber: string; relationship: string; criticalDefectOpen: boolean; safetyHold: boolean }[];
  /** Sources the caller tried and failed to read. Each one makes the state indeterminate. */
  unreadable: readonly string[];
};

/**
 * What this projection does not evaluate, stated so `available` never claims it (reconciliation
 * R-7, R-8). Dispatch readiness evaluates documents and insurance; the rest is later work. R-2 closed
 * in CP1.5: an incident that holds its unit places a `unitHolds` row, read here like any other hold.
 */
export const NOT_EVALUATED = [
  { domain: "documents_and_insurance", reason: "Decided by the dispatch readiness composer, which reads the requirement registry and insurance" },
  { domain: "dispatched", reason: "Whether the unit is on a job is a booking, not a condition of the unit" },
] as const;

/**
 * CP1.5 — the act that lifts a hold is the act that placed it. A hold placed by hand is released by
 * hand (`fleet.holdRelease`, which refuses any other). A hold an incident placed is lifted by that
 * incident's safety review; nothing else releases it.
 */
export function liftedByFor(h: { sourceKind?: string; sourceRef?: string | null }): string {
  if (!h.sourceKind || h.sourceKind === "manual") return "fleet.holdRelease";
  if (h.sourceKind === "incident") return "records.incident.review";
  return `the ${h.sourceKind} workflow that placed it${h.sourceRef ? ` (${h.sourceRef})` : ""}`;
}

export type OperationalState = {
  status: OperationalStatus;
  reasons: StateReason[];
  /** Stated restrictions a restricted release returns the unit under. */
  restrictions: string[];
  /** When the earliest reason that sets the status began — the start of downtime, when held. */
  since: Date | null;
  notEvaluated: typeof NOT_EVALUATED;
  /** Changes when, and only when, the basis of the answer changes. */
  version: string;
};

const RANK: Record<OperationalStatus, number> = { available: 0, warning: 1, indeterminate: 2, maintenance_hold: 3, out_of_service: 4 };
const HOLD_STATUS: Record<HoldEffect, StateReason["status"]> = { warn: "warning", block: "maintenance_hold", out_of_service: "out_of_service" };

export function operationalState(f: PortfolioFacts): OperationalState {
  const reasons: StateReason[] = [];
  const push = (r: StateReason) => reasons.push(r);

  // 0221 — out of the fleet is out of service; storage holds the unit; a component's critical defect or
  // safety hold holds its parent until it is detached, which is a recorded act.
  const life = f.lifecycle?.status ?? "active";
  if (life === "retired" || life === "sold" || life === "transferred") {
    push({ code: `unit_${life}`, status: "out_of_service", category: "lifecycle", label: `${life === "transferred" ? "Transferred to another organization" : life[0]!.toUpperCase() + life.slice(1)}: not in the fleet`, source: { table: "units", ref: "lifecycleStatus" }, since: f.lifecycle?.changedAt ?? null, liftedBy: "fleet.lifecycleSet (management returns a unit to the fleet)" });
  } else if (life === "seasonal_storage") {
    push({ code: "unit_in_storage", status: "maintenance_hold", category: "lifecycle", label: "In seasonal storage", source: { table: "units", ref: "lifecycleStatus" }, since: f.lifecycle?.changedAt ?? null, liftedBy: "fleet.lifecycleSet" });
  }
  for (const c of f.components ?? []) {
    if (c.criticalDefectOpen) push({ code: `component_critical_defect:${c.childUnitId}`, status: "maintenance_hold", category: "component", label: `Component ${c.childUnitNumber} (${c.relationship}) has an unresolved critical defect`, source: { table: "unitComponents", ref: c.componentRef }, since: null, liftedBy: "records.maintenance.resolveDefect on the component, or fleet.componentDetach" });
    if (c.safetyHold) push({ code: `component_hold_safety:${c.childUnitId}`, status: "out_of_service", category: "component", label: `Component ${c.childUnitNumber} (${c.relationship}) is out of service`, source: { table: "unitComponents", ref: c.componentRef }, since: null, liftedBy: "fleet.holdRelease on the component, or fleet.componentDetach" });
  }

  for (const h of f.holds) {
    push({ code: `hold_${h.holdType}`, status: HOLD_STATUS[h.dispatchEffect], category: h.holdType, label: h.reason, source: { table: "unitHolds", ref: h.holdRef }, since: h.placedAt, liftedBy: liftedByFor(h) });
  }

  // The defect and its release, decided separately, exactly as the readiness composer decides them.
  const critical = f.defects.filter(d => d.severity === "critical");
  for (const d of critical.filter(d => d.status !== "resolved")) {
    push({ code: "critical_defect", status: "maintenance_hold", category: "maintenance", label: `Critical defect open: ${d.title}`, source: { table: "maintenanceDefects", ref: String(d.id) }, since: d.reportedAt, liftedBy: "records.maintenance.resolveDefect" });
  }
  const owing = critical.filter(d => d.status !== "resolved" || d.resolvedByReleaseId != null);
  for (const d of owing.filter(d => currentReleaseEvidenceFor(d.id, f.releases) == null)) {
    push({ code: "mechanic_release_missing", status: "maintenance_hold", category: "maintenance", label: `No standing mechanic release names defect ${d.id} (${d.title})`, source: { table: "maintenanceDefects", ref: String(d.id) }, since: d.reportedAt, liftedBy: "shop.workOrderRelease" });
  }
  for (const d of f.defects.filter(d => d.severity === "inspection_required" && d.status !== "resolved")) {
    push({ code: "defect_inspection_required", status: "warning", category: "inspection", label: `Defect needs inspecting: ${d.title}`, source: { table: "maintenanceDefects", ref: String(d.id) }, since: d.reportedAt, liftedBy: "records.maintenance.resolveDefect" });
  }

  // A restricted release: per work order, the newest release that still stands decides.
  const byWo = new Map<number, (StoredRelease & { restrictionDetail: string | null })[]>();
  for (const r of f.releases) byWo.set(r.workOrderId, [...(byWo.get(r.workOrderId) ?? []), r]);
  const restrictions: string[] = [];
  for (const rs of Array.from(byWo.values())) {
    const newest = [...rs].sort((a, b) => b.releasedAt.getTime() - a.releasedAt.getTime() || b.id - a.id)[0];
    if (newest && newest.releaseType === "restricted" && releaseIsPositiveEvidence(newest)) {
      const text = newest.restrictionDetail?.trim() || "Released under a restriction that was not stated";
      restrictions.push(text);
      push({ code: "restricted_release", status: "warning", category: "maintenance", label: text, source: { table: "workOrderReleases", ref: String(newest.id) }, since: newest.releasedAt, liftedBy: "shop.workOrderRelease" });
    }
  }

  for (const o of f.activeOrders) {
    push({ code: `oos.${o.scope}`, status: "out_of_service", category: "enforcement", label: `Out-of-service order ${o.orderRef}${o.issuingAgency ? ` (${o.issuingAgency})` : ""} — a mechanic release does not lift it`, source: { table: "outOfServiceOrders", ref: o.orderRef }, since: o.issuedAt, liftedBy: "enforcement.orderRelease" });
  }
  for (const i of f.unestablishedInspections) {
    push({ code: "enforcement_result_unknown", status: "indeterminate", category: "enforcement", label: `Roadside inspection ${i.inspectionRef}: result not established`, source: { table: "enforcementEvents", ref: i.inspectionRef }, since: null, liftedBy: "enforcement.findingRecord" });
  }
  for (const r of f.openRoadside) {
    push({ code: "roadside_event_open", status: "maintenance_hold", category: "maintenance", label: `Roadside event ${r.eventRef} open (${r.status.replace(/_/g, " ")})`, source: { table: "roadsideServiceEvents", ref: r.eventRef }, since: r.occurredAt, liftedBy: "roadside close (not yet built — unit-scope sweep)" });
  }
  for (const x of f.faults) {
    const eff = faultDispatchEffect(x);
    const code = x.code.toLowerCase();
    if (eff.severity === "blocking") push({ code: `fault_${code}_critical`, status: "maintenance_hold", category: "telematics", label: eff.label, source: { table: "faultCodes", ref: String(x.id) }, since: x.lastSeenAt, liftedBy: "telematics.faultClear" });
    else if (eff.severity === "unknown") push({ code: `fault_${code}_active`, status: "indeterminate", category: "telematics", label: eff.label, source: { table: "faultCodes", ref: String(x.id) }, since: x.lastSeenAt, liftedBy: "telematics.faultAcknowledge" });
    else if (eff.severity === "review") push({ code: `fault_${code}_inspection`, status: "warning", category: "telematics", label: eff.label, source: { table: "faultCodes", ref: String(x.id) }, since: x.lastSeenAt, liftedBy: "telematics.faultClear" });
  }

  /*
   * A meter that went backwards does not ground a truck — the owner's rule is about maintenance
   * evaluation, which reads METER_REGRESSION from `meterProgress` and answers indeterminate. The unit
   * carries a warning naming the sequence, so nobody plans service on it unawares.
   */
  for (const m of f.meters.filter(m => m.trust === UNTRUSTED_METER_SEQUENCE)) {
    const r = m.regressions[0];
    push({ code: UNTRUSTED_METER_SEQUENCE, status: "warning", category: "meter", label: `${m.meterType} went down from ${r.earlier.value} to ${r.later.value} — distance-based service cannot be evaluated from before this`, source: { table: r.later.sourceTable, ref: r.later.ref }, since: r.later.recordedAt, liftedBy: "a verified reading taken as a new service baseline" });
  }

  for (const s of f.unreadable) {
    push({ code: "source_unreadable", status: "indeterminate", category: "source", label: `Could not read ${s} — the unit's state cannot be established without it`, source: { table: s, ref: "*" }, since: null, liftedBy: "the source becoming readable" });
  }

  let status: OperationalStatus = "available";
  for (const r of reasons) if (RANK[r.status] > RANK[status]) status = r.status;
  const deciding = reasons.filter(r => r.status === status && r.since);
  const since = deciding.length ? new Date(Math.min(...deciding.map(r => r.since!.getTime()))) : null;
  const version = createHash("sha256").update(JSON.stringify(reasons.map(r => [r.code, r.status, r.source.table, r.source.ref]).sort())).digest("hex").slice(0, 32);
  return { status, reasons, restrictions, since, notEvaluated: NOT_EVALUATED, version };
}

/** The words a driver reads. Nothing here softens a hold. */
export function driverNotice(s: Pick<OperationalState, "status" | "reasons" | "restrictions">): string {
  const labels = (st: StateReason["status"]) => s.reasons.filter(r => r.status === st).map(r => r.label).join("; ");
  switch (s.status) {
    case "out_of_service": return `Out of service — do not operate: ${labels("out_of_service")}`;
    case "maintenance_hold": return `Maintenance hold — do not operate: ${labels("maintenance_hold")}`;
    case "indeterminate": return `Status cannot be established — check with the shop before operating: ${labels("indeterminate")}`;
    case "warning": return `Operational, with warnings: ${labels("warning")}`;
    default: return "Operational";
  }
}
