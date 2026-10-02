/**
 * F1 — legacy money records assigned to no book: find the evidence, never invent it.
 *
 * After F1 a record whose `financialEntityId` is NULL is in nobody's scope (`ownsEntity`), so every
 * finance endpoint answers "not found" for it — including the single tenant, and including whichever
 * organization asks first. Valid history is not abandoned: this module reads the ownership evidence
 * the record already carries and classifies it.
 *
 *   PROVEN     every piece of evidence names the same one book  → eligible for explicit backfill
 *   AMBIGUOUS  evidence names more than one book, or conflicts   → quarantined for an administrator
 *   UNPROVEN   no evidence at all                                → quarantined for an administrator
 *
 * Evidence is only what LeaseOS already records about the row:
 *   direct        the customer account's book; the books of payments allocated to it; the books of
 *                 credits raised against it;
 *   organization  the owning organization of its job or billing book's job (0132 `jobs.orgRef`),
 *                 which names a book only when that organization owns exactly one.
 *
 * `invoices` is the only table behind the F1 routers whose book column is nullable (every other money
 * record there is NOT NULL or takes its book from a parent), so it is the only table audited here.
 *
 * Nothing here runs at request time. The report is read-only; a backfill is an explicit administrator
 * action, one named invoice at a time, re-proved under a row lock, and recorded as a domain event in
 * the same transaction (`scripts/finance-legacy-ownership.ts`).
 */
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import { SINGLE_TENANT_ID } from "./_core/actingScope";

export type Evidence = { source: "customer_account" | "payment_allocation" | "customer_credit" | "job_organization"; ref: string; entityIds: number[] };
export type Classification =
  | { verdict: "PROVEN"; financialEntityId: number; evidence: Evidence[] }
  | { verdict: "AMBIGUOUS"; candidates: number[]; evidence: Evidence[]; reason: string }
  | { verdict: "UNPROVEN"; evidence: Evidence[]; reason: string };

/**
 * Pure. Direct evidence each names one book; organization evidence names the set of books the
 * organization owns. Proven only when the direct books agree on exactly one and the organization (if
 * known) owns it — or, with no direct evidence, when the organization owns exactly one book.
 */
export function classifyOwnership(evidence: Evidence[]): Classification {
  const direct = Array.from(new Set(evidence.filter(e => e.source !== "job_organization").flatMap(e => e.entityIds)));
  const orgSets = evidence.filter(e => e.source === "job_organization").map(e => new Set(e.entityIds));
  const orgAllowed = orgSets.length ? Array.from(orgSets[0]!).filter(id => orgSets.every(s => s.has(id))) : null;
  if (direct.length > 1) return { verdict: "AMBIGUOUS", candidates: [...direct].sort((a, b) => a - b), evidence, reason: "Direct evidence names more than one book" };
  if (direct.length === 1) {
    const [only] = direct;
    if (orgAllowed && !orgAllowed.includes(only!)) return { verdict: "AMBIGUOUS", candidates: [only!, ...orgAllowed].sort((a, b) => a - b), evidence, reason: "The customer/payment book is not owned by the job's organization" };
    return { verdict: "PROVEN", financialEntityId: only!, evidence };
  }
  if (orgAllowed == null) return { verdict: "UNPROVEN", evidence, reason: "No customer account, payment, credit or job to prove ownership from" };
  if (orgAllowed.length === 1) return { verdict: "PROVEN", financialEntityId: orgAllowed[0]!, evidence };
  if (orgAllowed.length === 0) return { verdict: "UNPROVEN", evidence, reason: "The job's organization owns no book (or its jobs disagree)" };
  return { verdict: "AMBIGUOUS", candidates: orgAllowed.sort((a, b) => a - b), evidence, reason: "The job's organization owns more than one book" };
}

type Queryable = Pick<Pool, "query"> | Pick<PoolConnection, "query">;
const rows = async (c: Queryable, sql: string, params: unknown[]) => ((await c.query(sql, params)) as unknown as [RowDataPacket[]])[0];

/** The evidence one invoice carries (read inside the backfill transaction too, after the invoice row is locked). */
export async function invoiceEvidence(c: Queryable, invoiceId: number): Promise<{ invoiceNumber: string; financialEntityId: number | null; evidence: Evidence[] } | null> {
  const [inv] = await rows(c, "SELECT id, invoiceNumber, financialEntityId, customerAccountId, jobId, billingBookId FROM invoices WHERE id = ?", [invoiceId]);
  if (!inv) return null;
  const evidence: Evidence[] = [];
  if (inv.customerAccountId != null) {
    const [a] = await rows(c, "SELECT accountRef, financialEntityId FROM customerAccounts WHERE id = ?", [inv.customerAccountId]);
    if (a) evidence.push({ source: "customer_account", ref: a.accountRef, entityIds: [a.financialEntityId] });
  }
  for (const p of await rows(c, "SELECT DISTINCT cp.paymentRef, cp.financialEntityId FROM paymentAllocations pa JOIN customerPayments cp ON cp.id = pa.customerPaymentId WHERE pa.invoiceId = ?", [invoiceId])) evidence.push({ source: "payment_allocation", ref: p.paymentRef, entityIds: [p.financialEntityId] });
  for (const cr of await rows(c, "SELECT creditRef, financialEntityId FROM customerCredits WHERE invoiceId = ?", [invoiceId])) evidence.push({ source: "customer_credit", ref: cr.creditRef, entityIds: [cr.financialEntityId] });
  const jobIds = new Set<number>();
  if (inv.jobId != null) jobIds.add(inv.jobId);
  if (inv.billingBookId != null) { const [b] = await rows(c, "SELECT jobId FROM billingBooks WHERE id = ?", [inv.billingBookId]); if (b?.jobId != null) jobIds.add(b.jobId); }
  for (const jobId of Array.from(jobIds)) {
    const [j] = await rows(c, "SELECT jobCode, orgRef FROM jobs WHERE id = ?", [jobId]);
    if (!j) continue;
    // The 0132/0146 rule: NULL (or "default") on both sides is the historical single tenant.
    const books = j.orgRef == null || j.orgRef === "default"
      ? await rows(c, "SELECT id FROM financialEntities WHERE orgRef IS NULL OR orgRef = 'default'", [])
      : await rows(c, "SELECT id FROM financialEntities WHERE orgRef = ?", [j.orgRef]);
    evidence.push({ source: "job_organization", ref: `${j.jobCode} (${j.orgRef ?? "single tenant"})`, entityIds: books.map(b => Number(b.id)) });
  }
  return { invoiceNumber: inv.invoiceNumber, financialEntityId: inv.financialEntityId, evidence };
}

export type AuditRow = { invoiceId: number; invoiceNumber: string } & Classification;

/** Read-only: every invoice assigned to no book, classified. */
export async function legacyFinanceOwnershipAudit(c: Queryable): Promise<{ table: "invoices"; unassigned: number; proven: AuditRow[]; ambiguous: AuditRow[]; unproven: AuditRow[] }> {
  const out = { table: "invoices" as const, unassigned: 0, proven: [] as AuditRow[], ambiguous: [] as AuditRow[], unproven: [] as AuditRow[] };
  for (const r of await rows(c, "SELECT id FROM invoices WHERE financialEntityId IS NULL ORDER BY id", [])) {
    const e = await invoiceEvidence(c, Number(r.id));
    if (!e) continue;
    out.unassigned++;
    const cls = classifyOwnership(e.evidence);
    const row = { invoiceId: Number(r.id), invoiceNumber: e.invoiceNumber, ...cls } as AuditRow;
    (cls.verdict === "PROVEN" ? out.proven : cls.verdict === "AMBIGUOUS" ? out.ambiguous : out.unproven).push(row);
  }
  return out;
}

/**
 * Explicit backfill of ONE invoice, by an administrator who names it. Re-proved inside the
 * transaction with the invoice locked; anything but PROVEN is refused and nothing changes. The
 * assignment and its evidence are one domain event in the same transaction.
 */
export async function assignProvenBook(pool: Pool, invoiceNumber: string, by: { userId: number | null; label: string; reason: string }): Promise<{ assigned: true; financialEntityId: number } | { assigned: false; refusal: string }> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [inv] = await rows(conn, "SELECT id, financialEntityId FROM invoices WHERE invoiceNumber = ? FOR UPDATE", [invoiceNumber]);
    if (!inv) { await conn.rollback(); return { assigned: false, refusal: `Invoice ${invoiceNumber} not found` }; }
    if (inv.financialEntityId != null) { await conn.rollback(); return { assigned: false, refusal: `Invoice ${invoiceNumber} already belongs to book ${inv.financialEntityId}` }; }
    const e = (await invoiceEvidence(conn, Number(inv.id)))!;
    const cls = classifyOwnership(e.evidence);
    if (cls.verdict !== "PROVEN") { await conn.rollback(); return { assigned: false, refusal: `${cls.verdict}: ${cls.reason} — quarantined for administrator review, not assigned` }; }
    const [ent] = await rows(conn, "SELECT orgRef FROM financialEntities WHERE id = ?", [cls.financialEntityId]);
    // TEN-INBOX-1: the event is the book owner's. A NULL orgRef is the historical single tenant (0146); a book
    // that does not exist has no owner, and its event is not written to anybody's queue.
    if (!ent) { await conn.rollback(); return { assigned: false, refusal: `Book ${cls.financialEntityId} not found` }; }
    await conn.query("UPDATE invoices SET financialEntityId = ? WHERE id = ? AND financialEntityId IS NULL", [cls.financialEntityId, inv.id]);
    // The assignment and its evidence are one outbox row in the same transaction. Written directly, as the
    // other outbox writers do (enforcementOutbox): `_core/eventEmitter` is declared unwired on purpose.
    const occurredAt = new Date();
    const eventId = `EVT-${occurredAt.getTime().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    await conn.query(
      "INSERT INTO domainEventOutbox (eventId, eventType, eventVersion, aggregateType, aggregateId, tenantId, correlationId, actorSource, actorUserId, payloadJson, occurredAt) VALUES (?, 'finance.legacy_book_assigned', 1, 'invoice', ?, ?, ?, 'human', ?, ?, ?)",
      [eventId, String(inv.id), ent.orgRef ?? SINGLE_TENANT_ID, eventId, by.userId != null ? String(by.userId) : null, JSON.stringify({ invoiceNumber, financialEntityId: cls.financialEntityId, previous: null, evidence: cls.evidence, reason: by.reason, assignedBy: by.label }), occurredAt],
    );
    await conn.commit();
    return { assigned: true, financialEntityId: cls.financialEntityId };
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}
