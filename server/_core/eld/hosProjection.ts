/**
 * HOS phase 2 — from the ledger to the clock engine's input, without a database and without a rule.
 *
 * The clock engine (`server/_core/hos.ts`) consumes `DutyEntry[]`: a status, a start, an end. The
 * ledger holds events. This is the bridge, and it is deliberately dumb:
 *
 *   it applies corrections by SUPERSESSION, never by editing — an event named by an active
 *     correction is left out of the projection. A correction carries no duty status of its own (the
 *     ledger contract forbids it), so it only retracts; the status that replaces a retracted one is
 *     whatever duty-status event the device recorded for it;
 *   it turns each active duty-status change into an entry that runs until the next one, or is open;
 *   it does NOT decide what personal conveyance or a yard move counts as: those segments are
 *     reported beside the entries, and a mechanics module with a verified rule may map them later;
 *   it does NOT invent a status for a gap: a window with no duty status projects to nothing, and
 *     the engine says so.
 *
 * Pure. Given the same rows it produces the same entries, and it never looks at a clock.
 */
import type { DutyStatus, DutyEntry } from "../hos";
import type { HosReasonCode } from "./reasonCodes";

/** What the projection needs from a ledger row. A subset of `EldEventRow`, so tests can build them by hand. */
export type LedgerEventLike = {
  eventRef: string;
  deviceSequence: number | null;
  operatorId: number | null;
  eventType: string;
  eventCode: string | null;
  dutyStatus: DutyStatus | null;
  eventAt: Date;
  supersedesEventRef: string | null;
};

export type SpecialCategorySegment = {
  category: string;               // the eventCode as recorded: personal_conveyance | yard_move | none | anything a device sent
  startedAt: Date;
  endedAt: Date | null;
  eventRef: string;
};

export type HosProjection = {
  operatorId: number;
  entries: DutyEntry[];
  /** The duty-status events that produced `entries`, in order, so a reader can trace each entry to its event. */
  entryEventRefs: string[];
  /** Events left out because an active correction names them. */
  supersededEventRefs: string[];
  /** Corrections that were applied (active corrections naming a row that was present). */
  correctionsApplied: { correctionEventRef: string; supersedesEventRef: string }[];
  /** Corrections whose target is not in the window: recorded, not applied, not an error. */
  correctionsWithoutTarget: string[];
  /** Rows whose supersession forms a cycle; treated as active and reported, never resolved by guess. */
  correctionCycles: string[];
  specialCategories: SpecialCategorySegment[];
  /** Rows carrying another operator or no operator, ignored here and counted so nothing is silently dropped. */
  ignoredForeignEvents: number;
  reasonCodes: HosReasonCode[];
  notes: string[];
};

const byTime = (a: LedgerEventLike, b: LedgerEventLike) =>
  a.eventAt.getTime() - b.eventAt.getTime() || (a.deviceSequence ?? 0) - (b.deviceSequence ?? 0) || (a.eventRef < b.eventRef ? -1 : 1);

/**
 * Which rows are active. A row is superseded when an ACTIVE row names it; a correction that is itself
 * superseded names nothing, so retracting a correction restores what it retracted.
 *
 * Every row names at most one target, so the "supersedes" edges form chains that can only end in a
 * cycle, never branch. The ledger does not stop two corrections naming each other (a device can
 * name a target it has not sent yet). A cycle has no meaning, so its members are treated as active
 * and their supersession is ignored — deterministically, whatever order the rows arrive in — and
 * they are reported so a person can look.
 */
export function activeEvents<T extends LedgerEventLike>(rows: readonly T[]): { active: T[]; superseded: string[]; cyclic: string[] } {
  const byRef = new Map(rows.map(r => [r.eventRef, r] as const));
  const target = (ref: string) => { const t = byRef.get(ref)?.supersedesEventRef; return t && byRef.has(t) ? t : null; };

  // Cycle members: walk each chain; a node met twice on the same walk closes a cycle.
  const cyclic = new Set<string>();
  for (const r of rows) {
    const path: string[] = [], onPath = new Map<string, number>();
    for (let x: string | null = r.eventRef; x != null && !cyclic.has(x); x = target(x)) {
      if (onPath.has(x)) { for (const y of path.slice(onPath.get(x)!)) cyclic.add(y); break; }
      onPath.set(x, path.length); path.push(x);
    }
  }

  // Active over the acyclic remainder: superseded iff some non-cyclic, active row names it.
  const namedBy = new Map<string, string[]>();
  for (const r of rows) {
    const t = target(r.eventRef);
    if (t && !cyclic.has(r.eventRef)) namedBy.set(t, [...(namedBy.get(t) ?? []), r.eventRef]);
  }
  const memo = new Map<string, boolean>();
  const isActive = (ref: string): boolean => {
    const known = memo.get(ref);
    if (known !== undefined) return known;
    const v = cyclic.has(ref) || !(namedBy.get(ref) ?? []).some(isActive);
    memo.set(ref, v);
    return v;
  };
  return {
    active: rows.filter(r => isActive(r.eventRef)),
    superseded: rows.filter(r => !isActive(r.eventRef)).map(r => r.eventRef).sort(),
    cyclic: Array.from(cyclic).sort(),
  };
}

/** Project one operator's ledger rows into the clock engine's entries. */
export function projectDutyEntries(operatorId: number, rows: readonly LedgerEventLike[]): HosProjection {
  const own = rows.filter(r => r.operatorId === operatorId);
  const ignoredForeignEvents = rows.length - own.length;
  const { active, superseded, cyclic } = activeEvents(own);
  const activeSet = new Set(active.map(r => r.eventRef));
  const presentRefs = new Set(own.map(r => r.eventRef));

  const retracted = new Set(superseded);
  const correctionsApplied = own
    .filter(r => r.supersedesEventRef && activeSet.has(r.eventRef) && retracted.has(r.supersedesEventRef))
    .map(r => ({ correctionEventRef: r.eventRef, supersedesEventRef: r.supersedesEventRef! }));
  const correctionsWithoutTarget = own
    .filter(r => r.supersedesEventRef && activeSet.has(r.eventRef) && !presentRefs.has(r.supersedesEventRef))
    .map(r => r.eventRef);

  // A duty status is carried only by a duty_status_change; the ledger contract keeps it off everything else.
  const dutyRows = active.filter(r => r.dutyStatus != null).sort(byTime);
  const entries: DutyEntry[] = [];
  const entryEventRefs: string[] = [];
  for (let i = 0; i < dutyRows.length; i++) {
    const r = dutyRows[i]!, next = dutyRows[i + 1];
    entries.push({ dutyStatus: r.dutyStatus!, startedAt: r.eventAt, endedAt: next ? next.eventAt : null });
    entryEventRefs.push(r.eventRef);
  }

  const specials = active.filter(r => r.eventType === "special_category_change").sort(byTime);
  const specialCategories: SpecialCategorySegment[] = specials.map((r, i) => ({
    category: r.eventCode ?? "unknown", startedAt: r.eventAt, endedAt: specials[i + 1]?.eventAt ?? null, eventRef: r.eventRef,
  })).filter(s => s.category !== "none");

  const reasonCodes: HosReasonCode[] = [];
  const notes: string[] = [];
  if (!entries.length) { reasonCodes.push("HOS_NO_DUTY_RECORD"); notes.push("The ledger holds no active duty status for this operator in the window"); }
  if (correctionsApplied.length) { reasonCodes.push("HOS_CORRECTION_APPLIED"); notes.push(`${correctionsApplied.length} correction(s) applied by supersession; the originals remain on the ledger and are left out here`); }
  if (entries.length && entries[entries.length - 1]!.endedAt === null) reasonCodes.push("HOS_OPEN_STATUS");
  if (specialCategories.length) { reasonCodes.push("HOS_SPECIAL_CATEGORY_UNMAPPED"); notes.push(`${specialCategories.length} special-category segment(s) (${Array.from(new Set(specialCategories.map(s => s.category))).join(", ")}) are reported and not counted as any duty status: no verified rule says what they count as`); }
  if (cyclic.length) { reasonCodes.push("HOS_CORRECTION_CYCLE"); notes.push(`${cyclic.length} event(s) supersede each other in a cycle; treated as active and left for a person to resolve`); }
  if (correctionsWithoutTarget.length) notes.push(`${correctionsWithoutTarget.length} correction(s) name an event outside this window; nothing was applied for them`);

  return { operatorId, entries, entryEventRefs, supersededEventRefs: superseded, correctionsApplied, correctionsWithoutTarget, correctionCycles: cyclic, specialCategories, ignoredForeignEvents, reasonCodes, notes };
}
