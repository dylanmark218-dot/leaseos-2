/**
 * Document Control, Checkpoint G (manual) — the disposal domain's verification act.
 *
 * A disposal record enters `needs_review` from either writer (the facility portal, the assistant's typed
 * commit) and billing counts verified records only, yet nothing verified one or said who did. This is that
 * act, and it stays the disposal domain's: it writes the record's own verification columns (0244) and
 * nothing else of it, and the register only hears about it through its links (`document.domain_verified`).
 *
 * What it requires is the facility's own paper, confirmed in the register against this record: an external
 * document of a disposal-owned definition, issued by a third party, linked to the record and — where the
 * record carries the facility's number — carrying that number as a mirror of the record's column. A map pin,
 * a directory listing or a facility capability is planning evidence and is never consulted here; an issued
 * LeaseOS number (a device block's included) proves a document's identity, not a disposal.
 *
 * Not here: the load's chain state (no production path drives it, and G does not start one), facility
 * acceptance, closeout completeness, billing. Those consume the verified record; they are not decided by it.
 */
import { and, eq, inArray, notInArray } from "drizzle-orm";
import type { MySql2Database } from "drizzle-orm/mysql2";
import { commercialDocumentLinks, commercialDocuments, disposalTickets, documentExternalReferences, loads } from "../../drizzle/schema";
import { SINGLE_TENANT_ID } from "./actingScope";
import { EXTERNAL_ORIGINS, type OriginKind } from "./documentDefinitions";
import { appendDocumentEvent, definitionFor, DocumentControlRefusal, type Book } from "./documentRegisterService";
import { jobInScope } from "../db";

type Db = MySql2Database<Record<string, unknown>>;

export type VerifyOutcome = "verified" | "rejected";
export type VerifyResult = { ticketNumber: string; verificationStatus: VerifyOutcome; alreadyVerified: boolean; documentsTold: number };

const refuse = (code: DocumentControlRefusal["code"], msg: string): never => { throw new DocumentControlRefusal(code, msg); };

/** The issuers whose own paper can evidence a disposal: the facility, or an independent scale / third party. Never the tenant, never unknown. */
const EVIDENCE_ISSUERS = ["facility", "other_third_party"] as const;

/**
 * DC-G — what a disposal line on a field ticket may bill. A line whose source number is one of this business's
 * disposal records bills that record only when it is verified and on the field ticket's own job. A number that is
 * no record here — a facility's own number, or another business's record — is kept as typed: it is a fact the
 * person wrote, not a claim on the gate, and answering differently for another business's record would tell the
 * caller it exists. Returns the refusal, or null when the line may enter.
 */
export async function disposalLineRefusal(db: Db, args: { scope: { tenantId: string }; fieldTicketJobId: number | null; sourceTrackingNumber: string }): Promise<string | null> {
  const t = (await db.select({ ticketNumber: disposalTickets.ticketNumber, jobId: disposalTickets.jobId, loadId: disposalTickets.loadId, verificationStatus: disposalTickets.verificationStatus }).from(disposalTickets).where(eq(disposalTickets.ticketNumber, args.sourceTrackingNumber)).limit(1))[0];
  if (!t) return null;
  const jobId = t.jobId ?? (t.loadId != null ? (await db.select({ jobId: loads.jobId }).from(loads).where(eq(loads.id, t.loadId)).limit(1))[0]?.jobId ?? null : null);
  const ours = jobId != null ? !!(await jobInScope(jobId, args.scope)) : args.scope.tenantId === SINGLE_TENANT_ID;
  if (!ours) return null;
  if (args.fieldTicketJobId != null && jobId != null && jobId !== args.fieldTicketJobId) return `BLOCKED — disposal ticket ${t.ticketNumber} belongs to another job; a disposal line bills a record of this ticket's own job`;
  if (t.verificationStatus !== "verified") return `BLOCKED — disposal ticket ${t.ticketNumber} is ${t.verificationStatus}; a disposal line bills a verified record (commercialOffice.disposal.verifyTicket, against the facility's confirmed paper)`;
  return null;
}

export async function verifyDisposalTicket(db: Db, args: { book: Book; actorUserId: number; ticketNumber: string; outcome: VerifyOutcome; note?: string | null; now?: Date }): Promise<VerifyResult> {
  const scope = { tenantId: args.book.bookOrgRef ?? SINGLE_TENANT_ID };
  const notFound = () => refuse("NOT_FOUND", `Disposal ticket ${args.ticketNumber} not found`);
  const pre = (await db.select({ id: disposalTickets.id, jobId: disposalTickets.jobId, loadId: disposalTickets.loadId }).from(disposalTickets).where(eq(disposalTickets.ticketNumber, args.ticketNumber)).limit(1))[0] ?? notFound();
  // In scope through its job (or its load's job); a record on no job is the single tenant's only. Another business's record is not found.
  const jobId = pre.jobId ?? (pre.loadId != null ? (await db.select({ jobId: loads.jobId }).from(loads).where(eq(loads.id, pre.loadId)).limit(1))[0]?.jobId ?? null : null);
  if (jobId != null ? !(await jobInScope(jobId, scope)) : args.book.bookOrgRef !== null) notFound();
  const note = args.note?.trim() || null;
  if (args.outcome === "rejected" && (!note || note.length < 10)) refuse("BAD_REQUEST", "A rejection records its reason (at least 10 characters)");
  const now = args.now ?? new Date();

  return db.transaction(async tx => {
    // Locked: two verifiers cannot both decide the same record.
    const t = (await tx.select().from(disposalTickets).where(eq(disposalTickets.id, pre.id)).for("update").limit(1))[0] ?? notFound();
    if (t.verificationStatus === "verified" || t.verificationStatus === "rejected") {
      if (t.verificationStatus === args.outcome) return { ticketNumber: t.ticketNumber, verificationStatus: args.outcome, alreadyVerified: true, documentsTold: 0 };
      return refuse("PRECONDITION_FAILED", `BLOCKED — disposal ticket ${t.ticketNumber} is already ${t.verificationStatus}; a decided record is corrected through its own correction path, not re-decided here`);
    }
    // The register rows of this book that name this record, not void or withdrawn.
    const linked = await tx.select({ documentId: commercialDocuments.id, controlState: commercialDocuments.controlState, status: commercialDocuments.status, originKind: commercialDocuments.originKind, issuerKind: commercialDocuments.issuerKind, definitionKey: commercialDocuments.definitionKey })
      .from(commercialDocumentLinks).innerJoin(commercialDocuments, eq(commercialDocuments.id, commercialDocumentLinks.documentId))
      .where(and(eq(commercialDocumentLinks.recordType, "disposal_ticket"), eq(commercialDocumentLinks.recordId, t.id), eq(commercialDocumentLinks.confirmationStatus, "confirmed"),
        eq(commercialDocuments.bookScopeKey, scope.tenantId), notInArray(commercialDocuments.controlState, ["void", "withdrawn"])))
      .orderBy(commercialDocuments.id);
    if (args.outcome === "verified") {
      const evidence: number[] = [];
      for (const d of linked) {
        if (d.controlState !== "confirmed" || d.status !== "current") continue;
        if (!d.originKind || !EXTERNAL_ORIGINS.includes(d.originKind as OriginKind)) continue;
        if (!d.issuerKind || !(EVIDENCE_ISSUERS as readonly string[]).includes(d.issuerKind)) continue;
        if (!d.definitionKey || (await definitionFor(tx, args.book, d.definitionKey)).primaryDomainOwner !== "disposal") continue;
        evidence.push(d.documentId);
      }
      // Where the record carries the facility's number, the paper must carry it too — as the record's own column, mirrored.
      const carrying = evidence.length && t.facilityTicketNumber
        ? (await tx.select({ documentId: documentExternalReferences.documentId }).from(documentExternalReferences).where(and(inArray(documentExternalReferences.documentId, evidence), eq(documentExternalReferences.mirrorOfTable, "disposalTickets"), eq(documentExternalReferences.mirrorOfId, t.id), eq(documentExternalReferences.confirmationStatus, "confirmed")))).map(r => r.documentId)
        : evidence;
      if (!carrying.length) refuse("PRECONDITION_FAILED", `BLOCKED — disposal ticket ${t.ticketNumber} has no confirmed document of the facility's paper linked to it${t.facilityTicketNumber ? ` carrying its number ${t.facilityTicketNumber}` : ""}; confirm the facility's paper in the register first`);
    }
    await tx.update(disposalTickets).set({ verificationStatus: args.outcome, verifiedByUserId: args.actorUserId, verifiedAt: now, verificationNote: note }).where(eq(disposalTickets.id, t.id));
    for (const d of linked) await appendDocumentEvent(tx, { documentId: d.documentId, eventType: "document.domain_verified", actor: { userId: args.actorUserId, source: "human" }, occurredAt: now, detail: { domain: "disposal", recordType: "disposal_ticket", recordRef: t.ticketNumber, outcome: args.outcome, note } });
    return { ticketNumber: t.ticketNumber, verificationStatus: args.outcome, alreadyVerified: false, documentsTold: linked.length };
  });
}
