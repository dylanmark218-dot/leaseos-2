/**
 * Merchant memory, persisted.
 *
 * The engine (`merchantMemoryConfidence`) already decides how much a memory is
 * worth: confirmed filings, not sightings. This is the ledger it reads from
 * and the two events that write to it.
 *
 *   seen       every extraction. Raises seenCount only.
 *   confirmed  a person committed a proposal for this vendor as this type.
 *              Raises confirmedCount. This is the only event that earns trust.
 *   rejected   a person said "no, that's not a receipt / not that vendor".
 *              Raises rejectedCount and is subtracted from what the memory
 *              is worth — a vendor whose classification keeps getting
 *              corrected should stop being trusted, not keep being asked.
 */

import { and, eq, sql } from "drizzle-orm";
import { getDb } from "./db";
import { merchantMemory } from "../drizzle/schema";
import { normalizeVendor, merchantMemoryConfidence, type DocumentType } from "./_core/documentExtraction";

export async function recallMerchant(vendorName: string): Promise<
  { vendorName: string; documentType: DocumentType; confidence: number; categoryKey: string | null } | null
> {
  const db = await getDb();
  if (!db) return null;
  const rows = await db
    .select()
    .from(merchantMemory)
    .where(eq(merchantMemory.vendorNormalized, normalizeVendor(vendorName)));
  if (rows.length === 0) return null;

  // A vendor may have produced more than one document type. Recall the one
  // with the most earned confidence, and only if it has earned any.
  let best: (typeof rows)[number] | null = null;
  let bestScore = 0;
  for (const r of rows) {
    const score = merchantMemoryConfidence({
      vendorNormalized: r.vendorNormalized,
      documentType: r.documentType as DocumentType,
      categoryKey: r.categoryKey,
      // Rejections count against the memory.
      seenCount: r.seenCount + r.rejectedCount,
      confirmedCount: Math.max(0, r.confirmedCount - r.rejectedCount),
    });
    if (score > bestScore) { best = r; bestScore = score; }
  }
  if (!best || bestScore === 0) return null;
  return {
    vendorName: best.vendorDisplay ?? vendorName,
    documentType: best.documentType as DocumentType,
    confidence: bestScore,
    categoryKey: best.categoryKey,
  };
}

async function upsert(vendorName: string, documentType: DocumentType, delta: { seen?: number; confirmed?: number; rejected?: number; categoryKey?: string | null }) {
  const db = await getDb();
  if (!db) return;
  const normalized = normalizeVendor(vendorName);
  const existing = await db
    .select({ id: merchantMemory.id })
    .from(merchantMemory)
    .where(and(eq(merchantMemory.vendorNormalized, normalized), eq(merchantMemory.documentType, documentType)))
    .limit(1);
  const now = new Date();
  if (!existing[0]) {
    await db.insert(merchantMemory).values({
      vendorNormalized: normalized,
      vendorDisplay: vendorName.trim(),
      documentType,
      categoryKey: delta.categoryKey ?? null,
      seenCount: delta.seen ?? 0,
      confirmedCount: delta.confirmed ?? 0,
      rejectedCount: delta.rejected ?? 0,
      lastSeenAt: now,
      lastConfirmedAt: delta.confirmed ? now : null,
    });
    return;
  }
  await db
    .update(merchantMemory)
    .set({
      seenCount: sql`${merchantMemory.seenCount} + ${delta.seen ?? 0}`,
      confirmedCount: sql`${merchantMemory.confirmedCount} + ${delta.confirmed ?? 0}`,
      rejectedCount: sql`${merchantMemory.rejectedCount} + ${delta.rejected ?? 0}`,
      lastSeenAt: now,
      ...(delta.confirmed ? { lastConfirmedAt: now } : {}),
      ...(delta.categoryKey !== undefined ? { categoryKey: delta.categoryKey } : {}),
    })
    .where(eq(merchantMemory.id, existing[0].id));
}

export const noteMerchantSeen = (vendorName: string, documentType: DocumentType) =>
  upsert(vendorName, documentType, { seen: 1 });

export const noteMerchantConfirmed = (vendorName: string, documentType: DocumentType, categoryKey?: string | null) =>
  upsert(vendorName, documentType, { seen: 1, confirmed: 1, categoryKey });

export const noteMerchantRejected = (vendorName: string, documentType: DocumentType) =>
  upsert(vendorName, documentType, { rejected: 1 });
