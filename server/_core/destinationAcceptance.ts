/**
 * Destination acceptance for dispatch, from the facility directory.
 *
 * For each load on the job, the LATEST loadFacilityAssessment decides: blocking → the
 * job's destination acceptance is false (a named, non-overridable dispatch blocker);
 * non-blocking → that load is fine. No loads, or a load with no assessment at all, is
 * null — unknown stays review, it does not pass. Nothing here re-runs the engine; it
 * reads what a person asked it and what it said.
 */
import { desc, eq, inArray } from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { facilities, loadFacilityAssessments, loads } from "../../drizzle/schema";

type Db = MySql2Database<Record<string, unknown>>;
export type DestinationAssessment = { loadNumber: string; facilityKey: string; facilityName: string; outcome: string; blocking: boolean; reasonCodes: string[]; assessedAt: Date };
const jsonArray = <T,>(v: unknown): T[] => (typeof v === "string" ? (JSON.parse(v) as T[]) : Array.isArray(v) ? (v as T[]) : []);

export async function destinationAcceptanceForJob(db: Db, jobId: number | null): Promise<{ verified: boolean | null; assessments: DestinationAssessment[] }> {
  if (jobId === null) return { verified: null, assessments: [] };
  const jobLoads = await db.select({ id: loads.id, loadNumber: loads.loadNumber }).from(loads).where(eq(loads.jobId, jobId));
  if (!jobLoads.length) return { verified: null, assessments: [] };
  const rows = await db.select().from(loadFacilityAssessments).where(inArray(loadFacilityAssessments.loadId, jobLoads.map(l => l.id))).orderBy(desc(loadFacilityAssessments.assessedAt), desc(loadFacilityAssessments.id));   // timestamps are second-resolution; the id breaks ties in insertion order
  const latest = new Map<number, typeof rows[number]>();
  for (const r of rows) if (!latest.has(r.loadId)) latest.set(r.loadId, r);
  const facilityIds = Array.from(new Set(Array.from(latest.values()).map(r => r.facilityId)));
  const facs = facilityIds.length ? await db.select({ id: facilities.id, facilityKey: facilities.facilityKey, name: facilities.name }).from(facilities).where(inArray(facilities.id, facilityIds)) : [];
  const assessments: DestinationAssessment[] = jobLoads.flatMap(l => {
    const a = latest.get(l.id); if (!a) return [];
    const f = facs.find(x => x.id === a.facilityId);
    return [{ loadNumber: l.loadNumber ?? String(l.id), facilityKey: f?.facilityKey ?? String(a.facilityId), facilityName: f?.name ?? String(a.facilityId), outcome: a.outcome, blocking: a.blocking, reasonCodes: jsonArray<string>(a.reasonCodes), assessedAt: a.assessedAt }];
  });
  if (assessments.some(a => a.blocking)) return { verified: false, assessments };
  if (assessments.length === jobLoads.length) return { verified: true, assessments };
  return { verified: null, assessments };   // at least one load nobody assessed
}
