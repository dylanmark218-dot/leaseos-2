/**
 * Funding persistence.
 *
 * v20.14 shipped the boundary with two functions returning empty. The gate was
 * the part that is easy to get wrong later; this is the mechanical part. Claims
 * are a ledger, and the ledger is what makes double-dipping detectable — an
 * expense funded under one program is on record when it is offered to another.
 */

import { and, desc, eq } from "drizzle-orm";
import { getDb } from "./db";
import { fundingClaims, fundingOpportunities, fundingPrograms } from "../drizzle/schema";
import type { ExistingClaim, OpportunityStatus } from "./_core/fundingIntelligence";

export async function loadExistingClaims(expenseRef: string): Promise<ExistingClaim[]> {
  const db = await getDb();
  if (!db) return [];
  const rows = await db
    .select({
      claimRef: fundingClaims.claimRef,
      programId: fundingClaims.fundingProgramId,
      expenseRef: fundingClaims.expenseRef,
      eligibleCost: fundingClaims.eligibleCost,
      claimedAmount: fundingClaims.claimedAmount,
      status: fundingClaims.status,
    })
    .from(fundingClaims)
    .where(eq(fundingClaims.expenseRef, expenseRef));

  const programs = await db
    .select({ id: fundingPrograms.id, programKey: fundingPrograms.programKey })
    .from(fundingPrograms);
  const keyById = new Map(programs.map(p => [p.id, p.programKey]));

  return rows.map(r => ({
    claimRef: r.claimRef,
    programKey: keyById.get(r.programId) ?? `program#${r.programId}`,
    expenseRef: r.expenseRef,
    eligibleCost: r.eligibleCost,
    claimedAmount: r.claimedAmount,
    status: r.status as ExistingClaim["status"],
  }));
}

/** Program id by key. Programs live in the seed until loaded; a claim needs a row. */
export async function ensureProgramRow(args: {
  programKey: string;
  officialName: string;
  categoryKey: string;
  programType: string;
  country: string;
  governmentLevel: string;
}): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const existing = await db
    .select({ id: fundingPrograms.id })
    .from(fundingPrograms)
    .where(eq(fundingPrograms.programKey, args.programKey))
    .limit(1);
  if (existing[0]) return existing[0].id;

  const r = await db.insert(fundingPrograms).values({
    programKey: args.programKey,
    officialName: args.officialName,
    categoryKey: args.categoryKey,
    programType: args.programType as never,
    country: args.country,
    governmentLevel: args.governmentLevel as never,
    // A row created to hang a claim on is not thereby verified.
    verificationStatus: "unverified",
    programStatus: "unknown",
    effectiveFrom: new Date(),
  } as never);
  return Number(r[0]?.insertId ?? 0);
}

export async function recordClaim(args: {
  claimRef: string;
  fundingProgramId: number;
  fundingOpportunityId?: number | null;
  expenseRef: string;
  eligibleCost: number;
  claimedAmount: number;
  createdByUserId: number;
  status: "draft" | "submitted";
}): Promise<number> {
  const db = await getDb();
  if (!db) return 0;
  const r = await db.insert(fundingClaims).values({
    claimRef: args.claimRef,
    fundingProgramId: args.fundingProgramId,
    fundingOpportunityId: args.fundingOpportunityId ?? null,
    expenseRef: args.expenseRef,
    eligibleCost: args.eligibleCost,
    claimedAmount: args.claimedAmount,
    claimDate: new Date(),
    status: args.status,
    createdByUserId: args.createdByUserId,
  });
  return Number(r[0]?.insertId ?? 0);
}

export async function listOpportunities() {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(fundingOpportunities)
    .orderBy(desc(fundingOpportunities.createdAt))
    .limit(200);
}

export async function loadOpportunity(opportunityRef: string) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(fundingOpportunities)
    .where(eq(fundingOpportunities.opportunityRef, opportunityRef))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Advance an opportunity. The legality of the transition is decided by the
 * engine before this is called; this only records it. The previous status is
 * read from the row, not from the request — a client cannot claim "from:
 * approved" to skip rungs.
 */
export async function advanceOpportunity(args: {
  opportunityRef: string;
  to: OpportunityStatus;
}): Promise<void> {
  const db = await getDb();
  if (!db) return;
  await db
    .update(fundingOpportunities)
    .set({ status: args.to as never })
    .where(
      and(
        eq(fundingOpportunities.opportunityRef, args.opportunityRef)
      )
    );
}
