/**
 * 0175 — Serving a released document to a customer.
 *
 * A release is a pointer into one of three catalogues. The bytes are read from the storage key the
 * catalogue row carries, hashed, and served only when the hash still matches the record; a release
 * that was withdrawn or has expired, and a document that was never released, are "not found". No
 * document number is minted here — the customer sees the record's own reference.
 */
import { TRPCError } from "@trpc/server";
import { and, eq } from "drizzle-orm";
import { commercialDocuments, customerDocumentReleases, evidenceRecords, fieldTicketDocuments, fieldTickets } from "../drizzle/schema";
import type { Db } from "./_core/dbTypes";
import { sha256Hex } from "./_core/ticketPdf";
import { storageRead } from "./storage";

export type ResolvedDocument = { sourceType: "fieldTicketDocument" | "evidenceRecord" | "commercialDocument"; sourceId: number; documentRef: string; title: string; kind: string; storageKey: string; contentHash: string | null; mimeType: string; byteLength: number | null };

/** What the catalogue holds for a candidate release. Throws NOT_FOUND when the record does not exist or has no bytes. */
export async function resolveCatalogueDocument(db: Db, sourceType: ResolvedDocument["sourceType"], sourceId: number): Promise<Omit<ResolvedDocument, "kind" | "title"> & { title: string; jobId: number | null }> {
  if (sourceType === "fieldTicketDocument") {
    const d = (await db.select().from(fieldTicketDocuments).where(eq(fieldTicketDocuments.id, sourceId)).limit(1))[0];
    if (!d) throw new TRPCError({ code: "NOT_FOUND", message: "Document not found" });
    const t = (await db.select({ jobId: fieldTickets.jobId, ticketNumber: fieldTickets.ticketNumber }).from(fieldTickets).where(eq(fieldTickets.id, d.fieldTicketId)).limit(1))[0];
    return { sourceType, sourceId, documentRef: d.documentRef, title: `${d.kind.replace(/_/g, " ")} ${t?.ticketNumber ?? ""}`.trim(), storageKey: d.storageKey, contentHash: d.contentHash, mimeType: "application/pdf", byteLength: d.byteLength, jobId: t?.jobId ?? null };
  }
  if (sourceType === "evidenceRecord") {
    const e = (await db.select().from(evidenceRecords).where(eq(evidenceRecords.id, sourceId)).limit(1))[0];
    if (!e || !e.storageKey) throw new TRPCError({ code: "NOT_FOUND", message: "Document not found" });
    return { sourceType, sourceId, documentRef: e.trackingNumber ?? `EVIDENCE-${e.id}`, title: e.title, storageKey: e.storageKey, contentHash: null, mimeType: e.mimeType ?? "application/octet-stream", byteLength: null, jobId: e.jobId };
  }
  const c = (await db.select().from(commercialDocuments).where(eq(commercialDocuments.id, sourceId)).limit(1))[0];
  if (!c || c.status !== "current") throw new TRPCError({ code: "NOT_FOUND", message: "Document not found" });
  if (c.storageKey) return { sourceType, sourceId, documentRef: c.documentRef, title: c.title, storageKey: c.storageKey, contentHash: c.contentHash, mimeType: c.mimeType ?? "application/octet-stream", byteLength: c.byteLength, jobId: null };
  if (c.fieldTicketDocumentId) { const inner = await resolveCatalogueDocument(db, "fieldTicketDocument", c.fieldTicketDocumentId); return { ...inner, sourceType, sourceId, documentRef: c.documentRef, title: c.title, contentHash: c.contentHash }; }
  if (c.evidenceRecordId) { const inner = await resolveCatalogueDocument(db, "evidenceRecord", c.evidenceRecordId); return { ...inner, sourceType, sourceId, documentRef: c.documentRef, title: c.title }; }
  throw new TRPCError({ code: "NOT_FOUND", message: "Document not found" });
}

/**
 * The bytes of a released document on a job, or NOT_FOUND. The release must be current, must belong
 * to the job the caller is scoped to, and the stored bytes must still hash to the recorded hash.
 */
export async function readReleasedDocument(db: Db, args: { jobId: number; releaseRef: string; now?: Date }): Promise<{ release: typeof customerDocumentReleases.$inferSelect; doc: ResolvedDocument; bytes: Buffer; contentHash: string }> {
  const now = args.now ?? new Date();
  const release = (await db.select().from(customerDocumentReleases).where(and(eq(customerDocumentReleases.releaseRef, args.releaseRef), eq(customerDocumentReleases.jobId, args.jobId))).limit(1))[0];
  if (!release || release.status !== "released" || (release.expiresAt && release.expiresAt <= now)) throw new TRPCError({ code: "NOT_FOUND", message: "Document not found" });
  const cat = await resolveCatalogueDocument(db, release.sourceType, release.sourceId);
  const bytes = await storageRead(cat.storageKey);
  const contentHash = sha256Hex(bytes);
  const expected = release.contentHash ?? cat.contentHash;
  if (expected && expected !== contentHash) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Stored document does not match its recorded hash — not served" });
  return { release, doc: { ...cat, kind: release.kind, title: release.title }, bytes, contentHash };
}
