/**
 * Payroll P2 — data access for pay schedules and the periods they generate.
 *
 * The pure engine (`_core/payrollSchedule.ts`) decides what a calendar is and which transitions are legal; this
 * module writes rows, in a transaction where the schedule must be locked (generation) and with a guarded UPDATE
 * where a transition must not race another (`WHERE state = from`).
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "./db";
import { payPeriods, payRuns, payrollEarningEvents, paySchedules } from "../drizzle/schema";
import { dateText } from "./payrollCompensationService";
import { fromDateText } from "./_core/transport/fields";
import type { GeneratedPeriod, PayPeriodState } from "./_core/payrollSchedule";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
const scheduleDates = ["anchorDate"] as const;
const periodDates = ["periodStartDate", "periodEndDate", "paymentDate", "cutoffDate"] as const;
function withDates<T extends Record<string, unknown>>(row: T, keys: readonly (keyof T)[]): T {
  const out = { ...row };
  for (const k of keys) (out as Record<string, unknown>)[k as string] = dateText(row[k]);
  return out;
}

/* ---------------- Schedules ---------------- */

export async function listSchedules(entityIds: readonly number[]) {
  const db = await getDb();
  if (!db || !entityIds.length) return [];
  return (await db.select().from(paySchedules).where(inArray(paySchedules.financialEntityId, [...entityIds])).orderBy(asc(paySchedules.id))).map(r => withDates(r, scheduleDates));
}

export async function loadSchedule(scheduleRef: string) {
  const db = await getDb();
  if (!db) return null;
  const r = (await db.select().from(paySchedules).where(eq(paySchedules.scheduleRef, scheduleRef)).limit(1))[0];
  return r ? withDates(r, scheduleDates) : null;
}

export async function createSchedule(values: Omit<typeof paySchedules.$inferInsert, "scheduleRef">) {
  const db = await getDb();
  if (!db) return undefined;
  const scheduleRef = ref("PS");
  await db.insert(paySchedules).values({ ...values, scheduleRef });
  return scheduleRef;
}

export async function retireSchedule(args: { id: number; retiredByUserId: number }): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const r = await db.update(paySchedules).set({ status: "retired", retiredByUserId: args.retiredByUserId, retiredAt: new Date() }).where(and(eq(paySchedules.id, args.id), eq(paySchedules.status, "active")));
  return (r[0]?.affectedRows ?? 0) === 1;
}

/**
 * Insert the generated periods that do not exist yet, under the schedule row's lock. A period's identity is
 * (schedule, start date), so generating twice — or two administrators generating at once — creates each period
 * once. The legacy instant columns are derived from the dates in the schedule's zone: startsOn is the start
 * date's local midnight, endsOn the end date's (exclusive).
 */
export async function insertGeneratedPeriods(args: {
  schedule: { id: number; scheduleRef: string; financialEntityId: number; timezone: string };
  periods: readonly GeneratedPeriod[];
  createdByUserId: number;
}): Promise<{ created: string[]; existing: string[] }> {
  const db = await getDb();
  if (!db) return { created: [], existing: [] };
  return db.transaction(async tx => {
    await tx.select({ id: paySchedules.id }).from(paySchedules).where(eq(paySchedules.id, args.schedule.id)).for("update").limit(1);
    const have = new Set(
      (await tx.select({ d: payPeriods.periodStartDate }).from(payPeriods).where(eq(payPeriods.payScheduleId, args.schedule.id))).map(r => dateText(r.d)),
    );
    const created: string[] = [];
    const existing: string[] = [];
    for (const p of args.periods) {
      const periodRef = `${args.schedule.scheduleRef}-${p.start}`;
      if (have.has(p.start)) { existing.push(periodRef); continue; }
      const startsOn = fromDateText(p.start, args.schedule.timezone);
      const endsOn = fromDateText(p.end, args.schedule.timezone);
      if (!startsOn || !endsOn) throw new Error(`Could not place ${p.start}..${p.end} in ${args.schedule.timezone}`);
      await tx.insert(payPeriods).values({
        periodRef, financialEntityId: args.schedule.financialEntityId, startsOn, endsOn, state: "collecting",
        payScheduleId: args.schedule.id, periodStartDate: p.start, periodEndDate: p.end, paymentDate: p.paymentDate, cutoffDate: p.cutoffDate,
        createdByUserId: args.createdByUserId,
      });
      created.push(periodRef);
    }
    return { created, existing };
  });
}

/* ---------------- Periods ---------------- */

export async function listSchedulePeriods(payScheduleId: number) {
  const db = await getDb();
  if (!db) return [];
  return (await db.select().from(payPeriods).where(eq(payPeriods.payScheduleId, payScheduleId)).orderBy(asc(payPeriods.periodStartDate)).limit(500)).map(r => withDates(r, periodDates));
}

export async function loadPeriodByRef(periodRef: string) {
  const db = await getDb();
  if (!db) return null;
  const r = (await db.select().from(payPeriods).where(eq(payPeriods.periodRef, periodRef)).limit(1))[0];
  return r ? withDates(r, periodDates) : null;
}

export async function loadPeriodState(payPeriodId: number): Promise<PayPeriodState | null> {
  const db = await getDb();
  if (!db) return null;
  return ((await db.select({ state: payPeriods.state }).from(payPeriods).where(eq(payPeriods.id, payPeriodId)).limit(1))[0]?.state as PayPeriodState) ?? null;
}

export async function runStatesForPeriod(payPeriodId: number): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  return (await db.select({ state: payRuns.state }).from(payRuns).where(eq(payRuns.payPeriodId, payPeriodId))).map(r => r.state);
}

export async function earningCountForPeriod(payPeriodId: number): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  return Number((await db.select({ n: sql<number>`count(*)` }).from(payrollEarningEvents).where(eq(payrollEarningEvents.payPeriodId, payPeriodId)))[0]?.n ?? 0);
}

/** Move a period from one state to another only if it is still in `from` — two people racing make one move. */
export async function transitionPeriod(args: { id: number; from: PayPeriodState; to: PayPeriodState; set: Partial<typeof payPeriods.$inferInsert> }): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const r = await db.update(payPeriods).set({ ...args.set, state: args.to }).where(and(eq(payPeriods.id, args.id), eq(payPeriods.state, args.from)));
  return (r[0]?.affectedRows ?? 0) === 1;
}
