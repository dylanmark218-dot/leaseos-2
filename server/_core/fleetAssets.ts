/**
 * Fleet & Equipment Portfolio — asset identity, lifecycle and components: the rules.
 *
 * Pure. Reached from `server/fleetPortfolioRouter.ts` through `server/fleetPortfolioService.ts` in the
 * same change, so the unwired-engine census does not rise (design C-1). Nothing here reads a table.
 *
 * Three rules this module exists to hold (design §B.1–B.3, owner decisions O-4, O-9):
 *
 *   - lifecycle is stored and transitions are explicit acts; `retired` and `sold` are left only by
 *     management's recorded reactivation, and `transferred` is refused until an ownership history
 *     exists;
 *   - a component relation is between two `units` rows, is never deleted, and a child with a critical
 *     defect or a safety hold holds its parent (O-9) until a person detaches it — a recorded act;
 *   - a slot's class is checked against the unit's class when the unit has one: a trailer slot filled
 *     by a truck is a mismatch, and an unclassified unit is reported unclassified, never guessed.
 */
import { ASSET_CLASSES, OUT_OF_FLEET, type AssetClass, type ComponentRelationship, type LifecycleStatus } from "../../shared/fleetAssetTypes";
import type { DispatchBlocker } from "./dispatchReadiness";

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

export type LifecycleDecision = { allowed: true; terminal: boolean } | { allowed: false; reason: string };

/**
 * Which transitions a person may record. Storage is reversible by anyone who may set lifecycle;
 * leaving `retired` or `sold` is a reactivation only management records, with a reason; `transferred`
 * is refused outright (O-4). A no-op transition is refused so the history never carries a change that
 * changed nothing.
 */
export function lifecycleTransition(args: { from: LifecycleStatus; to: LifecycleStatus; roles: readonly string[] }): LifecycleDecision {
  const { from, to, roles } = args;
  if (from === to) return { allowed: false, reason: `The unit is already ${to.replace(/_/g, " ")}` };
  if (to === "transferred" || from === "transferred") return { allowed: false, reason: "Tenant-to-tenant transfer is not recorded yet (owner decision O-4): a transfer needs an ownership history before it can be a lifecycle state" };
  if (OUT_OF_FLEET.includes(from) && !roles.includes("management")) return { allowed: false, reason: `A ${from} unit is returned to the fleet only by management, with the reason recorded` };
  return { allowed: true, terminal: OUT_OF_FLEET.includes(to) };
}

/** Lifecycle as a dispatch blocker. Out of the fleet is overridable by no one; storage needs an approved policy (design §B.5). */
export function lifecycleBlocker(subject: "unit" | "trailer", unitNumber: string, status: LifecycleStatus): DispatchBlocker | null {
  const who = subject === "unit" ? "truck" : "trailer";
  const name = subject === "unit" ? "Unit" : "Trailer";
  if (status === "active") return null;
  if (status === "seasonal_storage") return { code: `${subject}_in_storage`, label: `${name} ${unitNumber} is in seasonal storage`, severity: "blocking", subject: who, overridable: true, overrideAuthority: "manager" };
  return { code: `${subject}_${status}`, label: `${name} ${unitNumber} is ${status}: it is not in the fleet`, severity: "blocking", subject: who, overridable: false };
}

/* ------------------------------------------------------------------ */
/* Class                                                               */
/* ------------------------------------------------------------------ */

/**
 * A unit bound where a power unit belongs must be one, and a unit bound as the trailer must be a
 * trailer — when the unit's class is known. An unclassified unit is left to the existing
 * `trailer_compatibility_unknown` finding; this never guesses a class from free text.
 */
export function classMismatchBlocker(subject: "unit" | "trailer", unitNumber: string, assetClass: AssetClass | null): DispatchBlocker | null {
  if (assetClass == null) return null;
  const expected: AssetClass = subject === "unit" ? "power_unit" : "trailer";
  if (assetClass === expected) return null;
  return {
    code: `${subject}_class_mismatch`,
    label: `${subject === "unit" ? "Unit" : "Trailer"} ${unitNumber} is a ${assetClass.replace(/_/g, " ")}, bound where a ${expected.replace(/_/g, " ")} belongs`,
    severity: "blocking", subject: subject === "unit" ? "truck" : "trailer", overridable: false,
  };
}

export const isAssetClass = (v: unknown): v is AssetClass => typeof v === "string" && (ASSET_CLASSES as readonly string[]).includes(v);

/* ------------------------------------------------------------------ */
/* Components                                                          */
/* ------------------------------------------------------------------ */

export type ComponentCandidate = {
  parent: { id: number; assetClass: AssetClass | null; lifecycleStatus: LifecycleStatus };
  child: { id: number; assetClass: AssetClass | null; lifecycleStatus: LifecycleStatus };
  relationship: ComponentRelationship;
  /** Active relations in the organization: parent → child, for cycle and double-attachment checks. */
  active: readonly { parentUnitId: number; childUnitId: number }[];
};

export type ComponentDecision = { allowed: true } | { allowed: false; reason: string };

/**
 * What may be attached to what. A power unit or a trailer is never a child (they are dispatched,
 * not mounted); a child is in one place at a time; a unit never contains itself, directly or
 * through a chain; nothing out of the fleet is attached or attached to.
 */
export function componentAttachment(c: ComponentCandidate): ComponentDecision {
  if (c.parent.id === c.child.id) return { allowed: false, reason: "A unit cannot be a component of itself" };
  if (c.child.assetClass === "power_unit" || c.child.assetClass === "trailer") return { allowed: false, reason: `A ${c.child.assetClass.replace(/_/g, " ")} is dispatched beside a unit, not mounted on it` };
  if (c.parent.assetClass === "component") return { allowed: false, reason: "A component carries no components of its own in this checkpoint" };
  if (OUT_OF_FLEET.includes(c.parent.lifecycleStatus)) return { allowed: false, reason: `The parent unit is ${c.parent.lifecycleStatus}` };
  if (OUT_OF_FLEET.includes(c.child.lifecycleStatus)) return { allowed: false, reason: `The component is ${c.child.lifecycleStatus}` };
  if (c.active.some(r => r.childUnitId === c.child.id)) return { allowed: false, reason: "The component is attached elsewhere; detach it first" };
  // A cycle: walking up from the parent must never reach the child.
  const parents = new Map<number, number[]>();
  for (const r of c.active) parents.set(r.childUnitId, [...(parents.get(r.childUnitId) ?? []), r.parentUnitId]);
  const seen = new Set<number>();
  const stack = [c.parent.id];
  while (stack.length) {
    const id = stack.pop()!;
    if (id === c.child.id) return { allowed: false, reason: "That would make the component an ancestor of itself" };
    if (seen.has(id)) continue;
    seen.add(id);
    for (const p of parents.get(id) ?? []) stack.push(p);
  }
  return { allowed: true };
}

export type ComponentState = {
  componentRef: string;
  childUnitId: number;
  childUnitNumber: string;
  relationship: ComponentRelationship;
  removable: boolean;
  criticalDefectOpen: boolean;
  safetyHold: boolean;
};

/**
 * A child's critical defect or safety hold holds the parent (O-9) — a mounted vacuum system with a
 * critical defect is the truck's problem until someone detaches it, and the detachment is recorded.
 * One blocker per child per cause, named by the child's id so the classification can match it.
 */
export function componentBlockers(parentNumber: string, components: readonly ComponentState[]): DispatchBlocker[] {
  const out: DispatchBlocker[] = [];
  for (const c of components) {
    if (c.criticalDefectOpen) out.push({ code: `component_critical_defect:${c.childUnitId}`, label: `Unit ${parentNumber}: component ${c.childUnitNumber} (${c.relationship}) has an unresolved critical defect`, severity: "blocking", subject: "truck", overridable: false });
    if (c.safetyHold) out.push({ code: `component_hold_safety:${c.childUnitId}`, label: `Unit ${parentNumber}: component ${c.childUnitNumber} (${c.relationship}) is out of service`, severity: "blocking", subject: "truck", overridable: false });
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* The unit-side verdict                                               */
/* ------------------------------------------------------------------ */

export type UnitSideVerdict = "clear" | "review" | "blocked" | "unknown";

/**
 * "Why can't this unit leave?" without a driver. The same severities the dispatch engine orders —
 * blocking > unknown > review — reduced to a word; `clear` means no unit-side finding stood, which
 * is NOT a dispatch verdict: the driver, HOS, the job, the route and the load are not evaluated here.
 */
export function unitSideVerdict(findings: readonly Pick<DispatchBlocker, "severity">[]): UnitSideVerdict {
  if (findings.some(f => f.severity === "blocking")) return "blocked";
  if (findings.some(f => f.severity === "unknown")) return "unknown";
  if (findings.some(f => f.severity === "review")) return "review";
  return "clear";
}

/** The axes a unit-side answer leaves unevaluated, stated so `clear` never claims them. */
export const UNIT_SIDE_NOT_EVALUATED = [
  { axis: "operator", reason: "No driver was named: licence, qualifications, medical fitness, HOS and availability are decided at dispatch" },
  { axis: "job", reason: "No job was named: the load, dangerous goods, destination acceptance and customer requirements are decided at dispatch" },
  { axis: "route", reason: "No route approval was named: road restrictions, communications and permits are decided at dispatch" },
] as const;
