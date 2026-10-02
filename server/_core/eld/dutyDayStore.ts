/**
 * 0224 — the only writer of `eldDutyDayDesignations`, and the one reader the HOS path uses.
 *
 * A designation says where an operator's duty day begins: an IANA zone and a local start minute,
 * in force from `effectiveFrom`. The table is history (triggers refuse UPDATE and DELETE), and this
 * module adds the one rule the triggers cannot express: HISTORY IS ONLY EVER EXTENDED AT ITS END.
 *
 *   effectiveFrom may not be earlier than the moment it is recorded;
 *   effectiveFrom must be later than every earlier designation's effectiveFrom for the operator.
 *
 * Together these mean that once the engine has answered for an instant, no later designation can
 * change which designation was in force at that instant — the day counted for last March is the
 * day counted when an auditor asks about last March. The price is that an instant before an
 * operator's first designation has no designated day and reads UNKNOWN. Backfilling history from
 * evidence is a separate, reviewed path (docs/eld/FOLLOWUPS.md F-8), not something this writer does.
 *
 * Both checks and the insert run in one transaction holding the operator row, so two concurrent
 * designations for one operator cannot both pass the "later than the latest" check.
 */
import { and, asc, desc, eq, lte } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { eldDutyDayDesignations, operators, type EldDutyDayDesignationRow } from "../../../drizzle/schema";
import type { Db } from "../dbTypes";
import { recordBelongsToOrganization } from "../coreRecordOwnership";
import { canonicalTimezone, runtimeTzVersion } from "./dutyDay";

export type DutyDayDesignationRefusal =
  | "operator_not_found"
  | "timezone_unknown"
  | "day_start_invalid"
  | "reason_required"
  | "backdated"
  | "not_after_latest";

export type RecordDutyDayDesignationResult =
  | { state: "recorded"; designation: EldDutyDayDesignationRow }
  | { state: "refused"; code: DutyDayDesignationRefusal; reason: string };

const designationRef = () => `ELDDD-${randomUUID().toUpperCase()}`;

export async function recordDutyDayDesignation(db: Db, args: {
  orgRef: string;
  operatorId: number;
  timezone: string;
  dayStartMinutes: number;
  /** Defaults to `recordedAt`. */
  effectiveFrom?: Date | null;
  reason: string;
  recordedByUserId: number;
  recordedAt: Date;
}): Promise<RecordDutyDayDesignationResult> {
  const refuse = (code: DutyDayDesignationRefusal, reason: string) => ({ state: "refused" as const, code, reason });
  const reason = args.reason.trim();
  if (!reason) return refuse("reason_required", "A designation records why it was made");
  // Stored under the database's own name, so one zone is never two strings.
  const timezone = canonicalTimezone(args.timezone);
  if (!timezone) return refuse("timezone_unknown", `"${args.timezone}" is not a timezone this server's IANA database (${runtimeTzVersion() ?? "version unknown"}) knows; a fixed UTC offset is not accepted`);
  if (!Number.isInteger(args.dayStartMinutes) || args.dayStartMinutes < 0 || args.dayStartMinutes > 1439) {
    return refuse("day_start_invalid", `The duty day's start is a minute of the local day, 0–1439; got ${args.dayStartMinutes}`);
  }
  // The server's clock decides "now"; a caller who means "from now" omits effectiveFrom.
  const effectiveFrom = args.effectiveFrom ?? args.recordedAt;
  if (effectiveFrom.getTime() < args.recordedAt.getTime()) {
    return refuse("backdated", `A designation cannot take effect before it is recorded (${effectiveFrom.toISOString()} < ${args.recordedAt.toISOString()}): it would change days the engine has already counted`);
  }
  // Out of scope reads as absent, as everywhere else in LeaseOS.
  if (!(await recordBelongsToOrganization(db, args.orgRef, "operator", args.operatorId))) {
    return refuse("operator_not_found", `Operator ${args.operatorId} not found`);
  }

  return db.transaction(async (tx) => {
    const op = (await tx.select({ id: operators.id }).from(operators).where(eq(operators.id, args.operatorId)).for("update").limit(1))[0];
    if (!op) return refuse("operator_not_found", `Operator ${args.operatorId} not found`);
    const latest = (await tx.select({ effectiveFrom: eldDutyDayDesignations.effectiveFrom, designationRef: eldDutyDayDesignations.designationRef })
      .from(eldDutyDayDesignations)
      .where(and(eq(eldDutyDayDesignations.orgRef, args.orgRef), eq(eldDutyDayDesignations.operatorId, args.operatorId)))
      .orderBy(desc(eldDutyDayDesignations.effectiveFrom), desc(eldDutyDayDesignations.id)).limit(1))[0];
    if (latest && effectiveFrom.getTime() <= latest.effectiveFrom.getTime()) {
      return refuse("not_after_latest", `${latest.designationRef} already takes effect at ${latest.effectiveFrom.toISOString()}; a new designation must take effect after it`);
    }
    const ref = designationRef();
    await tx.insert(eldDutyDayDesignations).values({
      designationRef: ref, orgRef: args.orgRef, operatorId: args.operatorId,
      timezone, dayStartMinutes: args.dayStartMinutes, effectiveFrom,
      reason: reason.slice(0, 300), tzVersion: runtimeTzVersion(),
      recordedByUserId: args.recordedByUserId, recordedAt: args.recordedAt,
    });
    const row = (await tx.select().from(eldDutyDayDesignations).where(eq(eldDutyDayDesignations.designationRef, ref)).limit(1))[0]!;
    return { state: "recorded" as const, designation: row };
  });
}

/** The designation in force at `at`: the latest `effectiveFrom` at or before it (ties to the later row). */
export async function dutyDayDesignationAt(db: Db, args: { orgRef: string; operatorId: number; at: Date }): Promise<EldDutyDayDesignationRow | null> {
  return (await db.select().from(eldDutyDayDesignations)
    .where(and(eq(eldDutyDayDesignations.orgRef, args.orgRef), eq(eldDutyDayDesignations.operatorId, args.operatorId), lte(eldDutyDayDesignations.effectiveFrom, args.at)))
    .orderBy(desc(eldDutyDayDesignations.effectiveFrom), desc(eldDutyDayDesignations.id)).limit(1))[0] ?? null;
}

/** Every designation the operator has had in this organization, oldest first. */
export async function dutyDayDesignationHistory(db: Db, args: { orgRef: string; operatorId: number }): Promise<EldDutyDayDesignationRow[]> {
  return db.select().from(eldDutyDayDesignations)
    .where(and(eq(eldDutyDayDesignations.orgRef, args.orgRef), eq(eldDutyDayDesignations.operatorId, args.operatorId)))
    .orderBy(asc(eldDutyDayDesignations.effectiveFrom), asc(eldDutyDayDesignations.id));
}
