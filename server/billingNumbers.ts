/**
 * v23.32 — invoice and credit-note numbers, per organization, on the Document Control ledger.
 *
 * A number is minted from the organization's series (`numberSeries.mintNumberInTx`): atomic under the series row
 * lock, never max+1, written to `numberAllocations` in the caller's transaction so a rolled-back record rolls its
 * number back with it, and a void stays on the ledger. Uniqueness is per number scope (the organization), so two
 * organizations may both issue INV-2026-000001.
 *
 * Records numbered before 0233 came from the shared 'default' series. A freshly minted organization number that a
 * pre-0233 record in the same organization's books already carries is VOIDED on the ledger (duplicate_issue, with
 * the reason) and the next one taken — within one organization a number always names one record.
 */
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { customerCredits, invoices, numberAllocations } from "../drizzle/schema";
import type { Db, Tx } from "./_core/dbTypes";
import { ensureSeriesRow, mintNumberInTx, voidNumber } from "./_core/numberSeries";

export type NumberedKind = "INV" | "CR";
export type NumberingScope = { tenantId: string; entityIds: readonly number[] };

/** Seed the organization's series row. Called before the transaction that mints (numberSeries' contract). */
export async function prepareSeries(db: Db, tenantId: string, kind: NumberedKind, at = new Date()): Promise<void> {
  await ensureSeriesRow(db, { orgRef: tenantId, sequenceType: kind }, at);
}

async function numberTaken(tx: Tx, s: NumberingScope, kind: NumberedKind, n: string): Promise<boolean> {
  const books = s.entityIds.length ? [...s.entityIds] : [-1];
  if (kind === "INV") {
    const r = await tx.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.invoiceNumber, n), or(eq(invoices.numberScope, s.tenantId), inArray(invoices.financialEntityId, books)))).limit(1);
    return r.length > 0;
  }
  const r = await tx.select({ id: customerCredits.id }).from(customerCredits).where(and(eq(customerCredits.creditRef, n), or(eq(customerCredits.numberScope, s.tenantId), inArray(customerCredits.financialEntityId, books)))).limit(1);
  return r.length > 0;
}

/** Mint the organization's next number inside the caller's transaction. Returns the number, its ledger row and its scope. */
export async function mintScopedNumber(tx: Tx, s: NumberingScope, kind: NumberedKind, args: { recordType: string; actorUserId: number; at?: Date }): Promise<{ number: string; allocationRef: string; numberScope: string }> {
  for (let attempt = 0; attempt < 25; attempt++) {
    const m = await mintNumberInTx(tx, { orgRef: s.tenantId, sequenceType: kind }, { recordType: args.recordType, recordId: null, actor: { userId: args.actorUserId }, at: args.at });
    if (!(await numberTaken(tx, s, kind, m.number))) return { number: m.number, allocationRef: m.allocationRef, numberScope: m.scopeKey };
    await voidNumber(tx, { scopeKey: m.scopeKey, allocationRef: m.allocationRef, reasonCode: "duplicate_issue", reasonText: `${m.number} is already carried by a record numbered before this organization's ${kind} series`, actor: { userId: args.actorUserId }, at: args.at });
  }
  throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `Could not mint a free ${kind} number for this organization` });
}

/** Bind the ledger row to the record it numbered, once the record has an id. */
export async function bindNumber(tx: Tx, allocationRef: string, recordId: number): Promise<void> {
  await tx.update(numberAllocations).set({ recordId }).where(and(eq(numberAllocations.allocationRef, allocationRef), sql`${numberAllocations.recordId} IS NULL`));
}

/** Mark a number's ledger row void because its record was voided (the number is never reused). */
export async function voidBoundNumber(tx: Tx, args: { numberScope: string; allocationRef: string | null; reason: string; actorUserId: number; at?: Date }): Promise<void> {
  if (!args.allocationRef) return;
  const row = (await tx.select({ state: numberAllocations.state }).from(numberAllocations).where(eq(numberAllocations.allocationRef, args.allocationRef)).limit(1))[0];
  if (!row || (row.state !== "issued" && row.state !== "reserved")) return;
  await voidNumber(tx, { scopeKey: args.numberScope, allocationRef: args.allocationRef, reasonCode: "other", reasonText: args.reason.slice(0, 300), actor: { userId: args.actorUserId }, at: args.at });
}

/**
 * The approval ledger (commercialApprovals) is keyed globally on (subjectType, subjectRef). A per-organization
 * number is therefore qualified by its scope there; a pre-0233 ('default') number keeps its bare ref, so the
 * ledger rows already written for it still match.
 */
export function ledgerSubjectRef(ref: string, numberScope: string): string {
  return numberScope === "default" ? ref : `${ref}@${numberScope}`.slice(0, 64);
}
