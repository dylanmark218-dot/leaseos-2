/**
 * Sign & Attest — the one write path (SA1).
 *
 * docs/sign-attest/SIGN_ATTEST_DESIGN.md §3, §5, §6.3–6.5, §8, §14. Every mutation runs inside one
 * transaction: the revision row is locked, the rule modules (`attestState`, `attestBinding`,
 * `attestPayload`) decide, the rows are written, exactly one `attestEvents` row per state change is
 * appended with the hash of the one before it, and the cross-domain outbox event commits with it or
 * not at all (`eventEmitter`'s rule). Refusals are rows: a rejected submission is a session in state
 * `rejected` with a code, written after the refusing transaction so the refusal survives the rollback.
 *
 * The organization is the caller's, resolved by the router from the session (`resolveActingScope`);
 * nothing here reads it from input, and a revision another organization owns is "not found".
 * Portal signers never resolve an organization at all: their scope is the signer row that names
 * their identity, and nothing else.
 */
import { and, desc, eq, inArray, isNull, sql, type SQL } from "drizzle-orm";
import {
  attestArtifacts, attestDocumentRevisions, attestEvents, attestFields, attestMarks, attestSigners, attestSigningSessions,
  commercialDocuments, coreRecordOwnership, domainEventOutbox, evidenceRecords, evidenceSeals, fieldDevices, fieldTicketRevisions, fieldTickets, jobs, organizationMemberships,
  type AttestDocumentRevisionRow, type AttestFieldRow, type AttestSignerRow,
} from "../../../drizzle/schema";
import {
  ATTEST_AUTH_METHODS, ATTEST_FIELD_TYPES, ATTEST_INPUT_KINDS, ATTEST_MARK_KINDS, CONSENT_TEXTS, EVENT_FOR_FIELD,
  type AttestAuthMethod, type AttestEventType, type AttestFieldType, type AttestInputKind, type AttestMarkKind, type AttestRejectionCode, type AttestRevisionState, type AttestSubjectType,
} from "../../../shared/attest";
import { SINGLE_TENANT_ID } from "../actingScope";
import { buildOutboxRow } from "../eventEmitter";
import { checkSignatureAttestation, type DeviceAttestation } from "../deviceSignature";
import type { Db } from "../dbTypes";
import { isSubjectType, resolveBinding, type SubjectFacts } from "./attestBinding";
import {
  authMethodSatisfies, bindingVerdict, completionVerdict, earlierOrderPending, fieldVerdict, markShapeVerdict, revisionTransition, type FieldForVerdict,
} from "./attestState";
import { consentTextHash, eventHash, markPayloadHash, receiptManifest, RECEIPT_RENDERER, sessionPayloadBytes, sha256Hex, signerIdentityOf, verifyChain } from "./attestPayload";

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTx = Db | Tx;

/* ------------------------------------------------------------------ */
/* Refusals                                                             */
/* ------------------------------------------------------------------ */

export type RefusalCode = "not_found" | "bad_request" | "conflict" | "precondition" | "forbidden";
export class AttestRefusal extends Error {
  constructor(readonly code: RefusalCode, message: string, readonly rejection: AttestRejectionCode | null = null, readonly detail: Record<string, unknown> = {}) { super(message); }
}
const refuse = (code: RefusalCode, message: string, rejection: AttestRejectionCode | null = null, detail: Record<string, unknown> = {}): never => { throw new AttestRefusal(code, message, rejection, detail); };

/** The tRPC code a rejection code maps to, when a submission is refused (§6.3 step 4). */
export function trpcCodeForRejection(code: AttestRejectionCode): RefusalCode {
  switch (code) {
    case "WRONG_SIGNER": case "SIGNER_NOT_AUTHENTICATED": case "AUTH_METHOD_INSUFFICIENT":
    case "DEVICE_NOT_ENROLLED": case "DEVICE_NOT_ACTIVE": case "KEY_FINGERPRINT_MISMATCH": case "SIGNATURE_INVALID": case "SIGNATURE_STALE":
      return "forbidden";
    case "REVISION_MISMATCH": case "FIELD_ALREADY_COMPLETED": case "REPLAY":
      return "conflict";
    case "DOCUMENT_VOIDED": case "DOCUMENT_FINALIZED": case "DOCUMENT_SUPERSEDED": case "FIELD_NOT_ASSIGNED": case "MARK_NOT_SEALED": case "MARK_HASH_MISMATCH": case "CONSENT_MISSING": case "CLOCK_SKEW_TOO_LARGE":
      return "precondition";
    default:
      return "bad_request";
  }
}

/* ------------------------------------------------------------------ */
/* Callers and inputs                                                   */
/* ------------------------------------------------------------------ */

/**
 * A caller: the acting organization is the server's (null = the historical single tenant). A producer
 * acting for a portal identity (the consultant signing through the portal) names the identity instead
 * of a user; the router never does.
 */
export type Caller = { userId: number | null; orgRef: string | null; deviceRef?: string | null; externalIdentityId?: number | null };

export type FieldInput = {
  fieldKey: string; fieldType: AttestFieldType; page: number; xFrac: number; yFrac: number; widthFrac: number; heightFrac: number;
  signerRole: string; required?: boolean; signingOrder?: number | null; subjectLineRef?: string | null; groupKey?: string | null;
};
export type SignerInput =
  | { partyKind: "internal_user"; userId: number; displayName: string; company?: string | null; signerRole: string; requiredAuth?: AttestAuthMethod; signingOrder?: number | null; fieldKeys: string[] }
  | { partyKind: "external_identity"; externalIdentityId: number; displayName: string; company?: string | null; signerRole: string; requiredAuth?: AttestAuthMethod; signingOrder?: number | null; fieldKeys: string[] }
  | { partyKind: "named_witnessed"; displayName: string; company?: string | null; signerRole: string; requiredAuth?: AttestAuthMethod; signingOrder?: number | null; fieldKeys: string[] };

export type OpenInput = {
  subjectType: AttestSubjectType; subjectRef: string;
  fields?: FieldInput[]; signers?: SignerInput[];
  pageCount?: number; pageGeometry?: unknown; completionRule?: "all_required_fields" | "all_required_fields_in_order";
  /** When an open revision already exists for this exact subject and hash, return it instead of refusing. */
  reuseOpen?: boolean;
  deviceRef?: string | null;
};

export type SubmitActor =
  | { kind: "user"; userId: number }
  | { kind: "external"; externalIdentityId: number }
  | { kind: "witness"; userId: number };

export type MarkInput = {
  fieldKey: string; markKind: AttestMarkKind; inputKind: AttestInputKind; valueText?: string | null;
  strokeEvidenceRecordId?: number | null; strokeHash?: string | null; renderedEvidenceRecordId?: number | null; renderedHash?: string | null;
  canvas?: { widthPx: number; heightPx: number; devicePixelRatio: number; orientation: "portrait" | "landscape" } | null;
  pointCount?: number | null; strokeCount?: number | null; durationMs?: number | null; pressureAvailable?: boolean | null;
};

export type SubmitInput = {
  revisionRef: string; signerRef: string; revisionHashAtStart: string; authMethod: AttestAuthMethod; consentVersion: string;
  marks: MarkInput[];
  /** Required under device_auth, refused under any other method (both directions, as closeout does). */
  deviceAttestation?: (DeviceAttestation & { /** A producer that already verified this attestation over its own payload says so; the service records it rather than re-verifying over a payload the device never signed. */ verifiedOver?: string }) | null;
  capturedOffline?: boolean; gps?: { latitude: number; longitude: number } | null;
  /** Caller-minted for idempotent retries; a repeat returns the first result. */
  sessionRef?: string | null;
  occurredAt?: Date;
  /** SA2 — an offline session: the device's clock at send time, the skew the server measured, and whose clock `occurredAt` is. */
  deviceClockAt?: Date | null;
  clockSkewMs?: number | null;
  clockSource?: "server" | "device";
};

export type SubmitResult = {
  sessionRef: string; state: "completed"; alreadyRecorded: boolean; revisionState: AttestRevisionState; signerState: string;
  marks: { fieldRef: string; fieldKey: string; markRef: string; payloadHash: string }[];
};

/* ------------------------------------------------------------------ */
/* Small helpers                                                        */
/* ------------------------------------------------------------------ */

const HEX64 = /^[0-9a-f]{64}$/;
/** Hashed timestamps are stored in `timestamp` columns, which keep seconds: hash what the row will hold. */
const secs = (d: Date) => new Date(Math.floor(d.getTime() / 1000) * 1000);
const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const scopeKeyOf = (orgRef: string | null) => orgRef ?? "default";
const tenantOf = (orgRef: string | null) => orgRef ?? SINGLE_TENANT_ID;
const sameOrg = (a: string | null, b: string | null) => (a ?? null) === (b ?? null);
const orgWhere = (orgRef: string | null) => (orgRef == null ? isNull(attestDocumentRevisions.orgRef) : eq(attestDocumentRevisions.orgRef, orgRef));

type ActorRow = { source: "human" | "system" | "external" | "integration"; userId: number | null; externalIdentityId: number | null; deviceRef: string | null };

/** Per-transaction chain state: the last event's hash and sequence, loaded once under the revision lock. */
type Chain = { revision: AttestDocumentRevisionRow; sequence: number; head: string | null };

async function lockRevision(tx: Tx, where: SQL | undefined): Promise<Chain | null> {
  const rev = (await tx.select().from(attestDocumentRevisions).where(where).limit(1).for("update"))[0];
  if (!rev) return null;
  const last = (await tx.select({ sequence: attestEvents.sequence, eventHash: attestEvents.eventHash }).from(attestEvents).where(eq(attestEvents.revisionId, rev.id)).orderBy(desc(attestEvents.sequence)).limit(1))[0];
  return { revision: rev, sequence: last?.sequence ?? 0, head: last?.eventHash ?? null };
}

async function appendEvent(tx: Tx, chain: Chain, e: {
  eventType: AttestEventType; actor: ActorRow; sessionId?: number | null; sessionRef?: string | null; fieldId?: number | null; fieldRef?: string | null;
  markId?: number | null; markRef?: string | null; artifactId?: number | null; artifactRef?: string | null; previousState?: string | null; newState?: string | null;
  detail?: Record<string, unknown> | null; occurredAt: Date; clockSource?: "server" | "device";
}): Promise<{ sequence: number; eventHash: string }> {
  const sequence = chain.sequence + 1;
  const detailJson = e.detail ? JSON.stringify(e.detail) : null;
  e = { ...e, occurredAt: secs(e.occurredAt) };
  const hash = eventHash(chain.head, {
    revisionRef: chain.revision.revisionRef, sequence, eventType: e.eventType,
    sessionId: e.sessionId ?? null, fieldId: e.fieldId ?? null, markId: e.markId ?? null, artifactId: e.artifactId ?? null,
    actorSource: e.actor.source, actorUserId: e.actor.userId, actorExternalIdentityId: e.actor.externalIdentityId, deviceRef: e.actor.deviceRef,
    previousState: e.previousState ?? null, newState: e.newState ?? null, detailJson, occurredAt: e.occurredAt,
  });
  await tx.insert(attestEvents).values({
    eventRef: ref("ATE"), revisionId: chain.revision.id, orgRef: chain.revision.orgRef, sequence, eventType: e.eventType,
    sessionId: e.sessionId ?? null, fieldId: e.fieldId ?? null, markId: e.markId ?? null, artifactId: e.artifactId ?? null,
    actorSource: e.actor.source, actorUserId: e.actor.userId, actorExternalIdentityId: e.actor.externalIdentityId, deviceRef: e.actor.deviceRef,
    previousState: e.previousState ?? null, newState: e.newState ?? null, detailJson, prevEventHash: chain.head, eventHash: hash,
    clockSource: e.clockSource ?? "server", occurredAt: e.occurredAt,
  });
  chain.sequence = sequence; chain.head = hash;
  return { sequence, eventHash: hash };
}

/** The cross-domain event, in the same transaction (eventEmitter's rule), through the outbox table the drain worker reads. */
async function emitOutbox(tx: Tx, rev: AttestDocumentRevisionRow, actor: ActorRow, type: string, payload: Record<string, unknown>, occurredAt: Date) {
  const row = buildOutboxRow({
    type, actor: { source: actor.source === "external" ? "human" : actor.source, userId: actor.userId != null ? String(actor.userId) : null },
    subject: { entityType: "attestDocumentRevision", entityId: rev.revisionRef }, tenantId: tenantOf(rev.orgRef),
    payload: { revisionRef: rev.revisionRef, instanceRef: rev.instanceRef, subjectType: rev.subjectType, subjectRef: rev.subjectRef, revisionHash: rev.revisionHash, ...payload },
    occurredAt,
  }, occurredAt);
  await tx.insert(domainEventOutbox).values(row);
}

function parseBox(f: FieldInput) {
  if (!(ATTEST_FIELD_TYPES as readonly string[]).includes(f.fieldType)) refuse("bad_request", `Unknown field type ${f.fieldType}`);
  if (!(f.page >= 1) || f.xFrac < 0 || f.yFrac < 0 || f.widthFrac <= 0 || f.heightFrac <= 0 || f.xFrac + f.widthFrac > 1.000001 || f.yFrac + f.heightFrac > 1.000001) refuse("bad_request", `Field ${f.fieldKey}: the box must lie within page ${f.page}`);
  if (!/^[A-Za-z0-9_.:-]{1,80}$/.test(f.fieldKey)) refuse("bad_request", `Field key ${f.fieldKey} must be 1–80 letters, digits, '_', '.', ':' or '-'`);
}

/* ------------------------------------------------------------------ */
/* Subject loading, in scope                                            */
/* ------------------------------------------------------------------ */

/** The organization that owns a ticket: its job's, else its unit's owner, else the historical single tenant. */
async function ticketOrg(tx: DbOrTx, t: { jobId: number | null; unitId: number | null }): Promise<string | null> {
  if (t.jobId != null) {
    const j = (await tx.select({ orgRef: jobs.orgRef }).from(jobs).where(eq(jobs.id, t.jobId)).limit(1))[0];
    return j?.orgRef ?? null;
  }
  if (t.unitId != null) {
    const o = (await tx.select({ orgRef: coreRecordOwnership.orgRef }).from(coreRecordOwnership).where(and(eq(coreRecordOwnership.recordType, "unit"), eq(coreRecordOwnership.recordId, t.unitId))).limit(1))[0];
    return o?.orgRef ?? null;
  }
  return null;
}

async function evidenceOrg(tx: DbOrTx, e: { jobId: number | null; capturedBy: number | null }): Promise<string | null> {
  if (e.jobId != null) {
    const j = (await tx.select({ orgRef: jobs.orgRef }).from(jobs).where(eq(jobs.id, e.jobId)).limit(1))[0];
    return j?.orgRef ?? null;
  }
  if (e.capturedBy != null) {
    const ms = await tx.select({ orgRef: organizationMemberships.orgRef }).from(organizationMemberships).where(and(eq(organizationMemberships.userId, e.capturedBy), eq(organizationMemberships.status, "active")));
    const orgs = Array.from(new Set(ms.map(m => m.orgRef)));
    return orgs.length === 1 ? orgs[0]! : null;
  }
  return null;
}

/** Load the subject the caller may see, or "not found" — never "forbidden" across the boundary. */
export async function loadSubjectInScope(tx: DbOrTx, orgRef: string | null, subjectType: string, subjectRef: string): Promise<SubjectFacts> {
  if (!isSubjectType(subjectType)) return refuse("bad_request", `Unknown subject type ${subjectType}`);
  const notFound = () => refuse("not_found", `${subjectType} ${subjectRef} not found`);
  switch (subjectType) {
    case "field_ticket_revision": {
      const r = (await tx.select().from(fieldTicketRevisions).where(eq(fieldTicketRevisions.documentRef, subjectRef)).limit(1))[0];
      if (!r) return notFound();
      const t = (await tx.select({ id: fieldTickets.id, ticketNumber: fieldTickets.ticketNumber, jobId: fieldTickets.jobId, unitId: fieldTickets.unitId }).from(fieldTickets).where(eq(fieldTickets.id, r.fieldTicketId)).limit(1))[0];
      if (!t || !sameOrg(await ticketOrg(tx, t), orgRef)) return notFound();
      return { subjectType, documentRef: r.documentRef, fieldTicketId: t.id, ticketNumber: t.ticketNumber, snapshotJson: r.snapshotJson, snapshotHash: r.snapshotHash };
    }
    case "evidence_record": {
      // `evidence:<id>`, `<id>`, or the stored form `evidence:<id>:v<n>`; the current version always wins.
      const m = /^(?:evidence:)?(\d+)(?::v\d+)?$/.exec(subjectRef);
      if (!m) return notFound();
      const e = (await tx.select().from(evidenceRecords).where(eq(evidenceRecords.id, Number(m[1]))).limit(1))[0];
      if (!e || !sameOrg(await evidenceOrg(tx, e), orgRef)) return notFound();
      const seal = (await tx.select({ contentHash: evidenceSeals.contentHash, version: evidenceSeals.version }).from(evidenceSeals).where(eq(evidenceSeals.evidenceRecordId, e.id)).orderBy(desc(evidenceSeals.version)).limit(1))[0] ?? null;
      return { subjectType, evidenceRecordId: e.id, trackingNumber: e.trackingNumber, sealState: e.sealState, currentVersion: e.currentVersion, seal };
    }
    case "commercial_document": {
      const d = (await tx.select().from(commercialDocuments).where(eq(commercialDocuments.documentRef, subjectRef)).limit(1))[0];
      if (!d || !sameOrg(d.bookOrgRef, orgRef)) return notFound();
      // The instance is the chain's root: walk supersedes back to version 1 (bounded).
      let root = d; let hops = 0;
      while (root.supersedesDocumentId != null && hops++ < 50) {
        const p = (await tx.select().from(commercialDocuments).where(eq(commercialDocuments.id, root.supersedesDocumentId)).limit(1))[0];
        if (!p) break; root = p;
      }
      return { subjectType, documentId: d.id, documentRef: d.documentRef, status: d.status, contentHash: d.contentHash, version: d.version, rootDocumentRef: root.documentRef };
    }
  }
}

/* ------------------------------------------------------------------ */
/* Open                                                                 */
/* ------------------------------------------------------------------ */

export type OpenResult = { revisionRef: string; revision: number; instanceRef: string; revisionHash: string; state: AttestRevisionState; reused: boolean; fields: { fieldKey: string; fieldRef: string }[]; signers: { signerRef: string; displayName: string }[] };

export async function openRevision(db: Db, caller: Caller, input: OpenInput): Promise<OpenResult> {
  return db.transaction(tx => openRevisionInTx(tx, caller, input));
}

export async function openRevisionInTx(tx: Tx, caller: Caller, input: OpenInput, now: Date = secs(new Date()), supersedes: { revisionId: number; revisionRef: string } | null = null): Promise<OpenResult> {
  const facts = await loadSubjectInScope(tx, caller.orgRef, input.subjectType, input.subjectRef);
  const binding = resolveBinding(facts);
  if (!binding.ok) return refuse("precondition", `Cannot open ${input.subjectType} ${input.subjectRef} for signing: ${binding.reason}`);
  const scopeKey = scopeKeyOf(caller.orgRef);
  const actor: ActorRow = caller.userId != null
    ? { source: "human", userId: caller.userId, externalIdentityId: null, deviceRef: input.deviceRef ?? caller.deviceRef ?? null }
    : { source: "external", userId: null, externalIdentityId: caller.externalIdentityId ?? null, deviceRef: input.deviceRef ?? null };

  // One live signing revision per subject revision. A second open against the same hash is the same act.
  const existing = (await tx.select().from(attestDocumentRevisions)
    .where(and(eq(attestDocumentRevisions.orgScopeKey, scopeKey), eq(attestDocumentRevisions.subjectType, input.subjectType), eq(attestDocumentRevisions.subjectRef, binding.subjectRef)))
    .orderBy(desc(attestDocumentRevisions.revision)).limit(1).for("update"))[0];
  if (existing && (existing.state === "open" || existing.state === "completed")) {
    if (input.reuseOpen && existing.revisionHash === binding.revisionHash) {
      const fs = await tx.select({ fieldKey: attestFields.fieldKey, fieldRef: attestFields.fieldRef }).from(attestFields).where(eq(attestFields.revisionId, existing.id));
      const ss = await tx.select({ signerRef: attestSigners.signerRef, displayName: attestSigners.displayName }).from(attestSigners).where(eq(attestSigners.revisionId, existing.id));
      return { revisionRef: existing.revisionRef, revision: existing.revision, instanceRef: existing.instanceRef, revisionHash: existing.revisionHash, state: existing.state, reused: true, fields: fs, signers: ss };
    }
    return refuse("conflict", `${input.subjectType} ${binding.subjectRef} is already open for signing as ${existing.revisionRef}`);
  }
  if (existing && existing.state === "finalized" && !supersedes) {
    return refuse("conflict", `${input.subjectType} ${binding.subjectRef} is finalized as ${existing.revisionRef}; a correction is a superseding revision`);
  }

  const [{ maxRevision }] = await tx.select({ maxRevision: sql<number | null>`MAX(${attestDocumentRevisions.revision})` }).from(attestDocumentRevisions)
    .where(and(eq(attestDocumentRevisions.orgScopeKey, scopeKey), eq(attestDocumentRevisions.instanceRef, binding.instanceRef)));
  const revision = (maxRevision == null ? 0 : Number(maxRevision)) + 1;
  const revisionRef = ref("ATR");
  const ins = await tx.insert(attestDocumentRevisions).values({
    revisionRef, orgRef: caller.orgRef, orgScopeKey: scopeKey, instanceRef: binding.instanceRef, revision,
    subjectType: input.subjectType, subjectRef: binding.subjectRef, subjectId: binding.subjectId, revisionHash: binding.revisionHash,
    pageCount: input.pageCount ?? 1, pageGeometryJson: input.pageGeometry != null ? JSON.stringify(input.pageGeometry) : null,
    state: "open", completionRule: input.completionRule ?? "all_required_fields",
    supersedesRevisionId: supersedes?.revisionId ?? null, openedByUserId: caller.userId, openedByExternalIdentityId: caller.userId == null ? (caller.externalIdentityId ?? null) : null, openedAt: now,
  });
  const rev = (await tx.select().from(attestDocumentRevisions).where(eq(attestDocumentRevisions.id, Number(ins[0].insertId))).limit(1))[0]!;
  const chain: Chain = { revision: rev, sequence: 0, head: null };
  await appendEvent(tx, chain, { eventType: input.subjectType === "evidence_record" ? "document_scanned" : "document_created", actor, newState: "open", occurredAt: now, detail: { revisionHash: binding.revisionHash, revision, supersedes: supersedes?.revisionRef ?? null } });

  const fields = input.fields?.length ? await placeFieldsInTx(tx, chain, caller, actor, input.fields, now) : [];
  const signers: { signerRef: string; displayName: string }[] = [];
  for (const s of input.signers ?? []) signers.push(await assignSignerInTx(tx, chain, caller, actor, s, now));
  await emitOutbox(tx, rev, actor, "attest.document_opened", { revision, supersedes: supersedes?.revisionRef ?? null }, now);
  return { revisionRef, revision, instanceRef: binding.instanceRef, revisionHash: binding.revisionHash, state: "open", reused: false, fields, signers };
}

/* ------------------------------------------------------------------ */
/* Fields and signers                                                   */
/* ------------------------------------------------------------------ */

async function requireOpenRevision(tx: Tx, caller: Caller, revisionRef: string): Promise<Chain> {
  if (caller.userId == null) refuse("forbidden", "This act needs an authenticated staff user");
  const chain = await lockRevision(tx, and(eq(attestDocumentRevisions.revisionRef, revisionRef), orgWhere(caller.orgRef)));
  if (!chain) return refuse("not_found", `Signing revision ${revisionRef} not found`);
  return chain;
}

async function placeFieldsInTx(tx: Tx, chain: Chain, caller: Caller, actor: ActorRow, inputs: FieldInput[], now: Date): Promise<{ fieldKey: string; fieldRef: string }[]> {
  const rev = chain.revision;
  if (rev.state !== "open") refuse("precondition", `Fields can be placed only while the revision is open; ${rev.revisionRef} is ${rev.state}`);
  const existing = await tx.select().from(attestFields).where(eq(attestFields.revisionId, rev.id));
  if (existing.some(f => f.state === "completed")) refuse("precondition", "A field has already been completed on this revision; a changed layout is a new revision");
  const out: { fieldKey: string; fieldRef: string }[] = [];
  for (const f of inputs) {
    parseBox(f);
    if (f.page > rev.pageCount) refuse("bad_request", `Field ${f.fieldKey}: page ${f.page} is beyond the revision's ${rev.pageCount} page(s)`);
    const prior = existing.find(e => e.fieldKey === f.fieldKey);
    const values = { fieldType: f.fieldType, page: f.page, xFrac: f.xFrac, yFrac: f.yFrac, widthFrac: f.widthFrac, heightFrac: f.heightFrac, signerRole: f.signerRole, required: f.required ?? true, signingOrder: f.signingOrder ?? null, subjectLineRef: f.subjectLineRef ?? null, groupKey: f.groupKey ?? null };
    if (prior) {
      await tx.update(attestFields).set(values).where(eq(attestFields.id, prior.id));
      out.push({ fieldKey: f.fieldKey, fieldRef: prior.fieldRef });
    } else {
      const fieldRef = ref("ATF");
      await tx.insert(attestFields).values({ fieldRef, revisionId: rev.id, orgRef: rev.orgRef, fieldKey: f.fieldKey, ...values, createdByUserId: caller.userId });
      out.push({ fieldKey: f.fieldKey, fieldRef });
    }
  }
  await appendEvent(tx, chain, { eventType: "fields_placed", actor, occurredAt: now, detail: { fields: out.map(o => o.fieldKey) } });
  return out;
}

export async function placeFields(db: Db, caller: Caller, revisionRef: string, fields: FieldInput[]): Promise<{ fields: { fieldKey: string; fieldRef: string }[] }> {
  if (!fields.length) refuse("bad_request", "Place at least one field");
  return db.transaction(async tx => {
    const chain = await requireOpenRevision(tx, caller, revisionRef);
    const actor: ActorRow = { source: "human", userId: caller.userId, externalIdentityId: null, deviceRef: caller.deviceRef ?? null };
    return { fields: await placeFieldsInTx(tx, chain, caller, actor, fields, new Date()) };
  });
}

async function assignSignerInTx(tx: Tx, chain: Chain, caller: Caller, actor: ActorRow, s: SignerInput, now: Date): Promise<{ signerRef: string; displayName: string }> {
  const rev = chain.revision;
  if (rev.state !== "open") refuse("precondition", `Signers can be assigned only while the revision is open; ${rev.revisionRef} is ${rev.state}`);
  if (!s.displayName.trim()) refuse("bad_request", "A signer has a name");
  if (!s.fieldKeys.length) refuse("bad_request", `Signer ${s.displayName} is assigned no fields`);
  const requiredAuth: AttestAuthMethod = s.requiredAuth ?? (s.partyKind === "external_identity" ? "portal_link" : s.partyKind === "named_witnessed" ? "witnessed" : "session_login");
  if (!(ATTEST_AUTH_METHODS as readonly string[]).includes(requiredAuth)) refuse("bad_request", `Unknown authentication method ${requiredAuth}`);
  if (s.partyKind === "named_witnessed" && requiredAuth !== "witnessed" && requiredAuth !== "paper_scan") refuse("bad_request", "A named signer without an account can only be witnessed or filed from a paper scan");
  if (s.partyKind !== "named_witnessed" && (requiredAuth === "witnessed" || requiredAuth === "paper_scan")) refuse("bad_request", `A ${s.partyKind} signer signs under their own authentication, not a witness's`);
  const fields = await tx.select().from(attestFields).where(eq(attestFields.revisionId, rev.id));
  const targets = s.fieldKeys.map(k => fields.find(f => f.fieldKey === k) ?? refuse("not_found", `Field ${k} not found on ${rev.revisionRef}`));
  const signerRef = ref("ATSG");
  const ins = await tx.insert(attestSigners).values({
    signerRef, revisionId: rev.id, orgRef: rev.orgRef, partyKind: s.partyKind,
    userId: s.partyKind === "internal_user" ? s.userId : null, externalIdentityId: s.partyKind === "external_identity" ? s.externalIdentityId : null,
    displayName: s.displayName, company: s.company ?? null, signerRole: s.signerRole, requiredAuth, signingOrder: s.signingOrder ?? null, state: "active",
    invitedByUserId: caller.userId, invitedAt: now,
  });
  const signerId = Number(ins[0].insertId);
  for (const f of targets) {
    if (f.state !== "pending") refuse("precondition", `Field ${f.fieldKey} is ${f.state} and cannot be reassigned`);
    if (f.assignedSignerId != null) refuse("conflict", `Field ${f.fieldKey} is already assigned to another signer`);
    if (f.signerRole !== s.signerRole) refuse("bad_request", `Field ${f.fieldKey} is for role ${f.signerRole}; ${s.displayName} is ${s.signerRole}`);
    await tx.update(attestFields).set({ assignedSignerId: signerId }).where(eq(attestFields.id, f.id));
  }
  await appendEvent(tx, chain, { eventType: "signer_assigned", actor, occurredAt: now, detail: { signerRef, partyKind: s.partyKind, signerRole: s.signerRole, fields: s.fieldKeys } });
  await appendEvent(tx, chain, { eventType: "signing_requested", actor, occurredAt: now, detail: { signerRef } });
  await emitOutbox(tx, rev, actor, "attest.signing_requested", { signerRef, partyKind: s.partyKind, signerRole: s.signerRole, fieldKeys: s.fieldKeys }, now);
  return { signerRef, displayName: s.displayName };
}

export async function assignSigner(db: Db, caller: Caller, revisionRef: string, signer: SignerInput): Promise<{ signerRef: string }> {
  return db.transaction(async tx => {
    const chain = await requireOpenRevision(tx, caller, revisionRef);
    const actor: ActorRow = { source: "human", userId: caller.userId, externalIdentityId: null, deviceRef: caller.deviceRef ?? null };
    return { signerRef: (await assignSignerInTx(tx, chain, caller, actor, signer, new Date())).signerRef };
  });
}

/* ------------------------------------------------------------------ */
/* Submit — one act of signing                                          */
/* ------------------------------------------------------------------ */

export type Rejection = { code: AttestRejectionCode; reason: string; detail?: Record<string, unknown> };

/** How the submission locates its revision: by the caller's organization, or by the portal identity the signer row names. */
export type SubmitScope = { orgRef: string | null } | { externalIdentityId: number };

async function revisionForScope(tx: Tx, scope: SubmitScope, revisionRef: string): Promise<Chain | null> {
  if ("orgRef" in scope) return lockRevision(tx, and(eq(attestDocumentRevisions.revisionRef, revisionRef), orgWhere(scope.orgRef)));
  const named = (await tx.select({ revisionId: attestSigners.revisionId }).from(attestSigners).innerJoin(attestDocumentRevisions, eq(attestDocumentRevisions.id, attestSigners.revisionId))
    .where(and(eq(attestDocumentRevisions.revisionRef, revisionRef), eq(attestSigners.externalIdentityId, scope.externalIdentityId))).limit(1))[0];
  if (!named) return null;
  return lockRevision(tx, eq(attestDocumentRevisions.id, named.revisionId));
}

export type SubmitOutcome = { ok: true; result: SubmitResult } | { ok: false; rejection: Rejection; revisionId: number; signerId: number | null; revisionRef: string };

/** The checks that need no database: shape, method/actor agreement, attestation in both directions. */
export function validateSubmitInput(actor: SubmitActor, input: SubmitInput): ActorRow {
  if (!input.marks.length) refuse("bad_request", "A session carries at least one mark");
  if (!HEX64.test(input.revisionHashAtStart)) refuse("bad_request", "revisionHashAtStart must be a 64-character sha256 hex digest");
  if (!(ATTEST_AUTH_METHODS as readonly string[]).includes(input.authMethod)) refuse("bad_request", `Unknown authentication method ${input.authMethod}`);
  for (const m of input.marks) {
    if (!(ATTEST_MARK_KINDS as readonly string[]).includes(m.markKind)) refuse("bad_request", `Unknown mark kind ${m.markKind}`);
    if (!(ATTEST_INPUT_KINDS as readonly string[]).includes(m.inputKind)) refuse("bad_request", `Unknown input kind ${m.inputKind}`);
  }
  // Both directions, as closeout: a device_auth claim without proof is a label; a proof under another method is misfiled.
  if (input.authMethod === "device_auth" && !input.deviceAttestation) refuse("bad_request", "A device_auth session must carry the device attestation. Without it the method is a label.");
  // A witnessed session may carry the WITNESS's enrolled-device proof (the consultant signed on the driver's tablet); any other method may not.
  if (input.authMethod !== "device_auth" && input.authMethod !== "witnessed" && input.deviceAttestation) refuse("bad_request", `A ${input.authMethod} session carries no device attestation; state the method as device_auth or remove it.`);
  const actorKindOk = (actor.kind === "user" && (input.authMethod === "session_login" || input.authMethod === "device_auth"))
    || (actor.kind === "external" && input.authMethod === "portal_link")
    || (actor.kind === "witness" && (input.authMethod === "witnessed" || input.authMethod === "paper_scan"));
  if (!actorKindOk) refuse("bad_request", `A ${actor.kind} caller cannot submit a ${input.authMethod} session`);
  return actor.kind === "external"
    ? { source: "external", userId: null, externalIdentityId: actor.externalIdentityId, deviceRef: input.deviceAttestation?.deviceRef ?? null }
    : { source: "human", userId: actor.userId, externalIdentityId: null, deviceRef: input.deviceAttestation?.deviceRef ?? null };
}

/**
 * One act of signing, inside the caller's transaction. Returns the outcome rather than throwing a
 * rejection, so a producer can decide and the wrapper below can persist the refusal after rollback.
 */
export async function submitSessionInTx(tx: Tx, actor: SubmitActor, scope: SubmitScope, input: SubmitInput, now: Date = input.occurredAt ?? new Date()): Promise<SubmitOutcome> {
  const actorRow = validateSubmitInput(actor, input);
  now = secs(now);
  {

    const chain = await revisionForScope(tx, scope, input.revisionRef);
    if (!chain) return refuse("not_found", `Signing revision ${input.revisionRef} not found`);
    const rev = chain.revision;

    // Idempotent retry: the same caller-minted sessionRef returns the first result (§6.4).
    if (input.sessionRef) {
      const prior = (await tx.select().from(attestSigningSessions).where(eq(attestSigningSessions.sessionRef, input.sessionRef)).limit(1))[0];
      if (prior) {
        if (prior.revisionId !== rev.id) return refuse("conflict", `Session ${input.sessionRef} belongs to another revision`);
        if (prior.state === "rejected") return refuse(trpcCodeForRejection((prior.rejectionCode ?? "MALFORMED") as AttestRejectionCode), prior.rejectionReason ?? "Session was rejected", (prior.rejectionCode ?? "MALFORMED") as AttestRejectionCode);
        const signer = (await tx.select().from(attestSigners).where(eq(attestSigners.id, prior.signerId)).limit(1))[0]!;
        const marks = await tx.select({ markRef: attestMarks.markRef, payloadHash: attestMarks.payloadHash, fieldId: attestMarks.fieldId }).from(attestMarks).where(eq(attestMarks.sessionId, prior.id));
        const fs = await tx.select({ id: attestFields.id, fieldRef: attestFields.fieldRef, fieldKey: attestFields.fieldKey }).from(attestFields).where(eq(attestFields.revisionId, rev.id));
        return { ok: true, result: { sessionRef: prior.sessionRef, state: "completed", alreadyRecorded: true, revisionState: rev.state, signerState: signer.state, marks: marks.map(m => { const f = fs.find(x => x.id === m.fieldId)!; return { fieldRef: f.fieldRef, fieldKey: f.fieldKey, markRef: m.markRef, payloadHash: m.payloadHash }; }) } };
      }
    }

    const signer = (await tx.select().from(attestSigners).where(and(eq(attestSigners.signerRef, input.signerRef), eq(attestSigners.revisionId, rev.id))).limit(1))[0];
    if (!signer) return refuse("not_found", `Signer ${input.signerRef} not found on ${rev.revisionRef}`);
    const reject = (code: AttestRejectionCode, reason: string, detail?: Record<string, unknown>) => ({ ok: false as const, rejection: { code, reason, detail }, revisionId: rev.id, signerId: signer.id, revisionRef: rev.revisionRef });

    // Who is signing — fail closed, by identity, never by name (§13).
    if (actor.kind === "user" && !(signer.partyKind === "internal_user" && signer.userId === actor.userId)) return reject("WRONG_SIGNER", "This field is assigned to another person. Nobody signs for somebody else; a witnessed signature is a different act and says so.");
    if (actor.kind === "external" && !(signer.partyKind === "external_identity" && signer.externalIdentityId === actor.externalIdentityId)) return reject("WRONG_SIGNER", "This field is assigned to another identity.");
    if (actor.kind === "witness" && signer.partyKind !== "named_witnessed") return reject("WRONG_SIGNER", `${signer.displayName} has their own account; they sign themselves, nobody witnesses for them.`);
    if (signer.state === "revoked" || signer.state === "declined") return reject("SIGNER_NOT_AUTHENTICATED", `Signer ${signer.signerRef} is ${signer.state}.`);
    if (!authMethodSatisfies(input.authMethod, signer.requiredAuth)) return reject("AUTH_METHOD_INSUFFICIENT", `This signer must authenticate by ${signer.requiredAuth}; ${input.authMethod} is not enough.`);
    const consentHash = consentTextHash(input.consentVersion);
    if (!consentHash) return reject("CONSENT_MISSING", `Unknown consent statement ${input.consentVersion}.`);

    const binding = bindingVerdict({ revisionState: rev.state, revisionHash: rev.revisionHash, revisionHashAtStart: input.revisionHashAtStart });
    if (!binding.ok) return reject(binding.code, binding.reason, { revisionHashAtStart: input.revisionHashAtStart, revisionHash: rev.revisionHash });

    const fieldRows = await tx.select().from(attestFields).where(eq(attestFields.revisionId, rev.id)).for("update");
    const signerRefOf = new Map<number, string>();
    for (const s of await tx.select({ id: attestSigners.id, signerRef: attestSigners.signerRef }).from(attestSigners).where(eq(attestSigners.revisionId, rev.id))) signerRefOf.set(s.id, s.signerRef);
    const verdictView = (f: AttestFieldRow): FieldForVerdict => ({ fieldRef: f.fieldRef, fieldType: f.fieldType as AttestFieldType, state: f.state, assignedSignerRef: f.assignedSignerId != null ? signerRefOf.get(f.assignedSignerId) ?? null : null, signingOrder: f.signingOrder, required: f.required });
    const all = fieldRows.map(verdictView);

    const planned: { field: AttestFieldRow; mark: MarkInput; payloadHash: string }[] = [];
    const seen = new Set<string>();
    for (const m of input.marks) {
      if (seen.has(m.fieldKey)) return reject("MALFORMED", `Field ${m.fieldKey} appears twice in one session.`);
      seen.add(m.fieldKey);
      const field = fieldRows.find(f => f.fieldKey === m.fieldKey);
      if (!field) return reject("MALFORMED", `Field ${m.fieldKey} does not exist on ${rev.revisionRef}.`);
      const fv = fieldVerdict({ field: verdictView(field), signerRef: signer.signerRef, markKind: m.markKind, earlierPending: earlierOrderPending(verdictView(field), all), rule: rev.completionRule as "all_required_fields" | "all_required_fields_in_order" });
      if (!fv.ok) return reject(fv.code, fv.reason, { fieldKey: m.fieldKey });
      const shape = markShapeVerdict({ markKind: m.markKind, strokeEvidenceRecordId: m.strokeEvidenceRecordId ?? null, strokeHash: m.strokeHash ?? null, renderedEvidenceRecordId: m.renderedEvidenceRecordId ?? null, valueText: m.valueText ?? null });
      if (!shape.ok) return reject(shape.code, shape.reason, { fieldKey: m.fieldKey });
      if (input.authMethod === "paper_scan" && m.markKind !== "paper_scan") return reject("MALFORMED", "A paper_scan session files paper_scan marks.");
      if (input.authMethod !== "paper_scan" && m.markKind === "paper_scan") return reject("MALFORMED", "A paper_scan mark is filed under a paper_scan session.");
      // A sealed stroke or scan record: it exists, its seal matches the declared hash, and it belongs to this organization.
      for (const [col, want] of [["strokeEvidenceRecordId", m.strokeHash ?? null], ["renderedEvidenceRecordId", m.renderedHash ?? null]] as const) {
        const id = m[col] ?? null;
        if (id == null) continue;
        const e = (await tx.select({ id: evidenceRecords.id, jobId: evidenceRecords.jobId, capturedBy: evidenceRecords.capturedBy, sealState: evidenceRecords.sealState }).from(evidenceRecords).where(eq(evidenceRecords.id, id)).limit(1))[0];
        if (!e) return reject("MARK_NOT_SEALED", `Evidence record ${id} for field ${m.fieldKey} does not exist.`);
        if (e.jobId != null && !sameOrg(await evidenceOrg(tx, e), rev.orgRef)) return reject("MARK_NOT_SEALED", `Evidence record ${id} is not this organization's.`);
        const seal = (await tx.select({ contentHash: evidenceSeals.contentHash }).from(evidenceSeals).where(eq(evidenceSeals.evidenceRecordId, id)).orderBy(desc(evidenceSeals.version)).limit(1))[0];
        if (col === "strokeEvidenceRecordId" || want) {
          if (!seal || e.sealState === "draft") return reject("MARK_NOT_SEALED", `Evidence record ${id} for field ${m.fieldKey} is not sealed.`);
          if (want && seal.contentHash !== want) return reject("MARK_HASH_MISMATCH", `The declared hash for field ${m.fieldKey} does not match the sealed record.`);
        }
      }
      const payloadHash = markPayloadHash({
        revisionRef: rev.revisionRef, revisionHash: rev.revisionHash, instanceRef: rev.instanceRef,
        fieldRef: field.fieldRef, fieldKey: field.fieldKey, fieldType: field.fieldType, signerRef: signer.signerRef, signerIdentity: signerIdentityOf(signer),
        markKind: m.markKind, strokeHash: m.strokeHash ?? null, renderedHash: m.renderedHash ?? null, valueText: m.markKind === "date" ? now.toISOString() : (m.valueText ?? null),
        consentTextHash: consentHash, completedAt: now,
      });
      planned.push({ field, mark: m, payloadHash });
    }

    // Device proof, over the session payload — unless a producer already verified the same device over its own payload and says so.
    let device: { fieldDeviceId: number | null } = { fieldDeviceId: null };
    const sessionRef = input.sessionRef ?? ref("ATS");
    if (input.deviceAttestation && !input.deviceAttestation.verifiedOver && !input.sessionRef) return reject("MALFORMED", "A device-signed session names its own sessionRef; the device signed it, so the server cannot mint it.");
    if (input.deviceAttestation) {
      const a = input.deviceAttestation;
      const dev = (await tx.select().from(fieldDevices).where(eq(fieldDevices.deviceRef, a.deviceRef)).limit(1))[0] ?? null;
      if (dev && !sameOrg(dev.orgRef, rev.orgRef)) return reject("DEVICE_NOT_ENROLLED", `Device ${a.deviceRef} is not enrolled with this organization.`);
      if (!a.verifiedOver) {
        const verdict = checkSignatureAttestation({
          attestation: a, now,
          device: dev ? { deviceRef: dev.deviceRef, keyFingerprint: dev.keyFingerprint ?? "", publicKeySpkiBase64: dev.publicKeySpkiBase64 ?? "", status: dev.status, revokedAt: dev.revokedAt, suspendedAt: dev.suspendedAt } : null,
          payload: sessionPayloadBytes({ sessionRef, revisionRef: rev.revisionRef, revisionHash: rev.revisionHash, signerRef: signer.signerRef, marks: planned.map(p => ({ fieldKey: p.field.fieldKey, markKind: p.mark.markKind, strokeHash: p.mark.strokeHash ?? null, renderedHash: p.mark.renderedHash ?? null, valueText: p.mark.markKind === "date" ? null : (p.mark.valueText ?? null) })), consentTextHash: consentHash, signedAt: a.signedAt }),
        });
        if (!verdict.ok) return reject(verdict.code, verdict.reason);
      } else if (!dev || dev.status !== "active" || dev.revokedAt || dev.suspendedAt) {
        return reject(dev ? "DEVICE_NOT_ACTIVE" : "DEVICE_NOT_ENROLLED", `Device ${a.deviceRef} is ${dev ? dev.status : "not enrolled"}.`);
      }
      device = { fieldDeviceId: dev?.id ?? null };
    }

    // Commit: session, marks, field completions, signer and revision states, events, outbox.
    const sIns = await tx.insert(attestSigningSessions).values({
      sessionRef, revisionId: rev.id, signerId: signer.id, orgRef: rev.orgRef, revisionHashAtStart: input.revisionHashAtStart, authMethod: input.authMethod,
      actorUserId: actor.kind === "external" ? null : actor.userId, actorExternalIdentityId: actor.kind === "external" ? actor.externalIdentityId : null,
      witnessedByUserId: actor.kind === "witness" ? actor.userId : null,
      deviceRef: input.deviceAttestation?.deviceRef ?? null, fieldDeviceId: device.fieldDeviceId, keyFingerprint: input.deviceAttestation?.keyFingerprint ?? null,
      deviceSignatureBase64: input.deviceAttestation?.signatureP1363Base64 ?? null, deviceSignedAt: input.deviceAttestation?.signedAt ?? null,
      capturedOffline: input.capturedOffline ?? false, deviceClockAt: input.deviceClockAt ?? null, clockSkewMs: input.clockSkewMs ?? null,
      consentVersion: input.consentVersion, consentTextHash: consentHash,
      capturedLatitude: input.gps?.latitude ?? null, capturedLongitude: input.gps?.longitude ?? null,
      state: "completed", startedAt: now, completedAt: now,
    });
    const sessionId = Number(sIns[0].insertId);
    const clockSource = input.clockSource ?? "server";
    await appendEvent(tx, chain, { eventType: "signing_started", actor: actorRow, sessionId, sessionRef, occurredAt: now, clockSource, detail: { signerRef: signer.signerRef, authMethod: input.authMethod, capturedOffline: input.capturedOffline ?? false, attestationVerifiedOver: input.deviceAttestation?.verifiedOver ?? (input.deviceAttestation ? "session_payload" : null) } });

    const marksOut: SubmitResult["marks"] = [];
    for (const p of planned) {
      const markRef = ref("ATM");
      const mIns = await tx.insert(attestMarks).values({
        markRef, sessionId, fieldId: p.field.id, orgRef: rev.orgRef, markKind: p.mark.markKind, inputKind: p.mark.inputKind,
        strokeEvidenceRecordId: p.mark.strokeEvidenceRecordId ?? null, strokeHash: p.mark.strokeHash ?? null, renderedEvidenceRecordId: p.mark.renderedEvidenceRecordId ?? null, renderedHash: p.mark.renderedHash ?? null,
        canvasWidthPx: p.mark.canvas?.widthPx ?? null, canvasHeightPx: p.mark.canvas?.heightPx ?? null, devicePixelRatio: p.mark.canvas?.devicePixelRatio ?? null, orientation: p.mark.canvas?.orientation ?? null,
        pointCount: p.mark.pointCount ?? null, strokeCount: p.mark.strokeCount ?? null, durationMs: p.mark.durationMs ?? null, pressureAvailable: p.mark.pressureAvailable ?? null,
        valueText: p.mark.markKind === "date" ? now.toISOString() : (p.mark.valueText ?? null), payloadHash: p.payloadHash, completedAt: now,
      });
      const markId = Number(mIns[0].insertId);
      await tx.update(attestFields).set({ state: "completed", completedMarkId: markId }).where(eq(attestFields.id, p.field.id));
      await appendEvent(tx, chain, { eventType: EVENT_FOR_FIELD[p.field.fieldType as AttestFieldType], actor: actorRow, sessionId, sessionRef, fieldId: p.field.id, fieldRef: p.field.fieldRef, markId, markRef, previousState: "pending", newState: "completed", occurredAt: now, clockSource, detail: { fieldKey: p.field.fieldKey, markKind: p.mark.markKind, inputKind: p.mark.inputKind, payloadHash: p.payloadHash, subjectLineRef: p.field.subjectLineRef } });
      await emitOutbox(tx, rev, actorRow, "attest.field_completed", { sessionRef, signerRef: signer.signerRef, fieldRef: p.field.fieldRef, fieldKey: p.field.fieldKey, fieldType: p.field.fieldType, subjectLineRef: p.field.subjectLineRef, markRef, payloadHash: p.payloadHash }, now);
      marksOut.push({ fieldRef: p.field.fieldRef, fieldKey: p.field.fieldKey, markRef, payloadHash: p.payloadHash });
    }

    const after = await tx.select().from(attestFields).where(eq(attestFields.revisionId, rev.id));
    const mine = after.filter(f => f.assignedSignerId === signer.id);
    let signerState = signer.state;
    if (mine.length && mine.every(f => f.state === "completed")) {
      signerState = "completed";
      await tx.update(attestSigners).set({ state: "completed", completedAt: now }).where(eq(attestSigners.id, signer.id));
      await appendEvent(tx, chain, { eventType: "signing_completed", actor: actorRow, sessionId, sessionRef, occurredAt: now, clockSource, detail: { signerRef: signer.signerRef } });
      await emitOutbox(tx, rev, actorRow, "attest.signing_completed", { sessionRef, signerRef: signer.signerRef }, now);
    }
    let revisionState: AttestRevisionState = rev.state;
    const completion = completionVerdict(after.map(f => ({ fieldRef: f.fieldRef, state: f.state, required: f.required })));
    if (completion.complete && rev.state === "open") {
      revisionState = "completed";
      await tx.update(attestDocumentRevisions).set({ state: "completed" }).where(eq(attestDocumentRevisions.id, rev.id));
      await appendEvent(tx, chain, { eventType: "document_completed", actor: actorRow, occurredAt: now, clockSource, previousState: "open", newState: "completed", detail: { notCompletedOptional: completion.pendingOptional } });
    }
    return { ok: true, result: { sessionRef, state: "completed", alreadyRecorded: false, revisionState, signerState, marks: marksOut } };
  }
}

export async function submitSession(db: Db, actor: SubmitActor, scope: SubmitScope, input: SubmitInput): Promise<SubmitResult> {
  const now = secs(input.occurredAt ?? new Date());
  const actorRow = validateSubmitInput(actor, input);
  const outcome = await db.transaction(tx => submitSessionInTx(tx, actor, scope, input, now));
  if (outcome.ok) return outcome.result;

  // A refusal is a row. Written after the refusing transaction so it survives; the marks' evidence
  // records stay sealed in the vault as evidence of the attempt (§6.5).
  const { rejection } = outcome;
  await recordRejectedSession(db, actor, input, { revisionId: outcome.revisionId, signerId: outcome.signerId, rejection }, now);
  return refuse(trpcCodeForRejection(rejection.code), `${rejection.code}: ${rejection.reason}`, rejection.code, rejection.detail ?? {});
}

/**
 * The rejected-session row and its `signing_rejected` event, outside any refusing transaction. SA2's
 * offline envelope uses it too, for refusals it decides before the service runs (an inner signature
 * that does not verify, strokes that do not render to the declared hash) — refusals a retry cannot
 * change. Envelope-level refusals (device, clock, nonce) are not rows here: the handling tells the
 * device to fix the device and send the same session again, and a rejected row under its
 * `sessionRef` would make that impossible.
 */
export async function recordRejectedSession(db: Db, actor: SubmitActor, input: SubmitInput, outcome: { revisionId: number; signerId: number | null; rejection: Rejection }, now: Date = secs(new Date())): Promise<void> {
  const actorRow = validateSubmitInput(actor, input);
  const { rejection } = outcome;
  await db.transaction(async tx => {
    const chain = await lockRevision(tx, eq(attestDocumentRevisions.id, outcome.revisionId));
    if (!chain) return;
    const consentHash = consentTextHash(input.consentVersion) ?? sha256Hex(input.consentVersion);
    const sIns = await tx.insert(attestSigningSessions).values({
      sessionRef: input.sessionRef ?? ref("ATS"), revisionId: chain.revision.id, signerId: outcome.signerId ?? 0, orgRef: chain.revision.orgRef, revisionHashAtStart: input.revisionHashAtStart, authMethod: input.authMethod,
      actorUserId: actor.kind === "external" ? null : actor.userId, actorExternalIdentityId: actor.kind === "external" ? actor.externalIdentityId : null, witnessedByUserId: actor.kind === "witness" ? actor.userId : null,
      deviceRef: input.deviceAttestation?.deviceRef ?? null, keyFingerprint: input.deviceAttestation?.keyFingerprint ?? null, capturedOffline: input.capturedOffline ?? false,
      deviceClockAt: input.deviceClockAt ?? null, clockSkewMs: input.clockSkewMs ?? null,
      consentVersion: input.consentVersion, consentTextHash: consentHash, state: "rejected", rejectionCode: rejection.code, rejectionReason: rejection.reason.slice(0, 500), startedAt: now,
    });
    await appendEvent(tx, chain, { eventType: "signing_rejected", actor: actorRow, sessionId: Number(sIns[0].insertId), occurredAt: now, clockSource: input.clockSource ?? "server", detail: { code: rejection.code, reason: rejection.reason, ...(rejection.detail ?? {}) } });
    await emitOutbox(tx, chain.revision, actorRow, "attest.signing_rejected", { code: rejection.code, signerRef: input.signerRef }, now);
  });
}

/* ------------------------------------------------------------------ */
/* Decline                                                              */
/* ------------------------------------------------------------------ */

export async function declineSession(db: Db, actor: SubmitActor, scope: SubmitScope, input: { revisionRef: string; signerRef: string; reason: string }): Promise<{ signerRef: string; state: "declined" }> {
  if (input.reason.trim().length < 3) refuse("bad_request", "A decline carries a reason");
  const now = secs(new Date());
  return db.transaction(async tx => {
    const chain = await revisionForScope(tx, scope, input.revisionRef);
    if (!chain) return refuse("not_found", `Signing revision ${input.revisionRef} not found`);
    const signer = (await tx.select().from(attestSigners).where(and(eq(attestSigners.signerRef, input.signerRef), eq(attestSigners.revisionId, chain.revision.id))).limit(1))[0];
    if (!signer) return refuse("not_found", `Signer ${input.signerRef} not found`);
    const own = (actor.kind === "user" && signer.partyKind === "internal_user" && signer.userId === actor.userId)
      || (actor.kind === "external" && signer.partyKind === "external_identity" && signer.externalIdentityId === actor.externalIdentityId)
      || (actor.kind === "witness" && signer.partyKind === "named_witnessed");
    if (!own) refuse("forbidden", "WRONG_SIGNER: only the assigned signer may decline", "WRONG_SIGNER");
    if (chain.revision.state !== "open") refuse("precondition", `The revision is ${chain.revision.state}`);
    if (signer.state === "completed") refuse("precondition", "This signer has already completed their fields");
    const actorRow: ActorRow = actor.kind === "external" ? { source: "external", userId: null, externalIdentityId: actor.externalIdentityId, deviceRef: null } : { source: "human", userId: actor.userId, externalIdentityId: null, deviceRef: null };
    await tx.update(attestSigners).set({ state: "declined" }).where(eq(attestSigners.id, signer.id));
    await tx.update(attestFields).set({ state: "declined" }).where(and(eq(attestFields.assignedSignerId, signer.id), eq(attestFields.state, "pending")));
    const sIns = await tx.insert(attestSigningSessions).values({
      sessionRef: ref("ATS"), revisionId: chain.revision.id, signerId: signer.id, orgRef: chain.revision.orgRef, revisionHashAtStart: chain.revision.revisionHash,
      authMethod: actor.kind === "external" ? "portal_link" : actor.kind === "witness" ? "witnessed" : "session_login",
      actorUserId: actor.kind === "external" ? null : actor.userId, actorExternalIdentityId: actor.kind === "external" ? actor.externalIdentityId : null, witnessedByUserId: actor.kind === "witness" ? actor.userId : null,
      consentVersion: "n/a", consentTextHash: sha256Hex("declined"), state: "declined", rejectionReason: input.reason.slice(0, 500), startedAt: now, completedAt: now,
    });
    await appendEvent(tx, chain, { eventType: "signing_declined", actor: actorRow, sessionId: Number(sIns[0].insertId), occurredAt: now, detail: { signerRef: signer.signerRef, reason: input.reason } });
    await emitOutbox(tx, chain.revision, actorRow, "attest.signing_declined", { signerRef: signer.signerRef, reason: input.reason }, now);
    return { signerRef: signer.signerRef, state: "declined" as const };
  });
}

/* ------------------------------------------------------------------ */
/* Finalize, void, supersede                                            */
/* ------------------------------------------------------------------ */

export type FinalizeResult = { revisionRef: string; state: "finalized"; artifactRef: string; receiptHash: string; eventChainHead: string; alreadyFinalized: boolean };

async function receiptFor(tx: Tx, rev: AttestDocumentRevisionRow, generatedAt: Date) {
  const [fields, signers, sessions, events] = await Promise.all([
    tx.select().from(attestFields).where(eq(attestFields.revisionId, rev.id)),
    tx.select().from(attestSigners).where(eq(attestSigners.revisionId, rev.id)),
    tx.select().from(attestSigningSessions).where(eq(attestSigningSessions.revisionId, rev.id)),
    tx.select().from(attestEvents).where(eq(attestEvents.revisionId, rev.id)).orderBy(attestEvents.sequence),
  ]);
  const marks = sessions.length ? await tx.select().from(attestMarks).where(inArray(attestMarks.sessionId, sessions.map(s => s.id))) : [];
  const signerRefOf = (id: number | null) => (id == null ? null : signers.find(s => s.id === id)?.signerRef ?? null);
  const completion = completionVerdict(fields.map(f => ({ fieldRef: f.fieldRef, state: f.state, required: f.required })));
  return { fields, signers, sessions, marks, events, completion, manifest: receiptManifest({
    revision: { revisionRef: rev.revisionRef, instanceRef: rev.instanceRef, revision: rev.revision, subjectType: rev.subjectType, subjectRef: rev.subjectRef, revisionHash: rev.revisionHash, state: "finalized", pageCount: rev.pageCount, completionRule: rev.completionRule },
    fields: fields.map(f => { const m = f.completedMarkId != null ? marks.find(x => x.id === f.completedMarkId) ?? null : null; return { fieldRef: f.fieldRef, fieldKey: f.fieldKey, fieldType: f.fieldType, page: f.page, box: { xFrac: f.xFrac, yFrac: f.yFrac, widthFrac: f.widthFrac, heightFrac: f.heightFrac }, signerRef: signerRefOf(f.assignedSignerId), subjectLineRef: f.subjectLineRef, required: f.required, state: f.state, markRef: m?.markRef ?? null, payloadHash: m?.payloadHash ?? null, strokeHash: m?.strokeHash ?? null, renderedHash: m?.renderedHash ?? null }; }),
    signers: signers.map(s => ({ signerRef: s.signerRef, partyKind: s.partyKind, identity: signerIdentityOf(s), role: s.signerRole, requiredAuth: s.requiredAuth, state: s.state })),
    sessions: sessions.map(s => ({ sessionRef: s.sessionRef, signerRef: signerRefOf(s.signerId) ?? "", authMethod: s.authMethod, deviceRef: s.deviceRef, keyFingerprint: s.keyFingerprint, deviceSignatureBase64: s.deviceSignatureBase64, capturedOffline: s.capturedOffline, clockSkewMs: s.clockSkewMs, startedAt: s.startedAt, completedAt: s.completedAt, state: s.state, rejectionCode: s.rejectionCode })),
    events: events.map(e => ({ sequence: e.sequence, eventType: e.eventType, eventHash: e.eventHash })),
    chainHead: events.length ? events[events.length - 1]!.eventHash : null,
    notCompletedOptional: completion.pendingOptional,
    generatedAt,
  }) };
}

export async function finalizeRevision(db: Db, caller: Caller, revisionRef: string): Promise<FinalizeResult> {
  const now = secs(new Date());
  try {
    return await db.transaction(async tx => {
      const chain = await requireOpenRevision(tx, caller, revisionRef);
      const rev = chain.revision;
      if (rev.state === "finalized") {
        const art = (await tx.select().from(attestArtifacts).where(and(eq(attestArtifacts.revisionId, rev.id), eq(attestArtifacts.kind, "audit_receipt"))).limit(1))[0]!;
        return { revisionRef, state: "finalized" as const, artifactRef: art.artifactRef, receiptHash: rev.receiptHash!, eventChainHead: rev.eventChainHead!, alreadyFinalized: true };
      }
      const t = revisionTransition(rev.state, "finalize");
      if (!t.ok) refuse("precondition", `Cannot finalize ${revisionRef}: ${t.reason}`);
      const fields = await tx.select().from(attestFields).where(eq(attestFields.revisionId, rev.id));
      const completion = completionVerdict(fields.map(f => ({ fieldRef: f.fieldRef, state: f.state, required: f.required })));
      if (!completion.complete) refuse("precondition", `Required field(s) not completed: ${completion.pendingRequired.map(r => fields.find(f => f.fieldRef === r)?.fieldKey ?? r).join(", ")}`);
      const actor: ActorRow = { source: "human", userId: caller.userId, externalIdentityId: null, deviceRef: caller.deviceRef ?? null };
      // The finalization event is part of what the receipt certifies, so it is appended first and becomes the chain head.
      const fin = await appendEvent(tx, chain, { eventType: "document_finalized", actor, previousState: rev.state, newState: "finalized", occurredAt: now, detail: { notCompletedOptional: completion.pendingOptional } });
      const r = await receiptFor(tx, rev, now);
      const artifactRef = ref("ATA");
      const aIns = await tx.insert(attestArtifacts).values({
        artifactRef, revisionId: rev.id, orgRef: rev.orgRef, kind: "audit_receipt", manifestJson: r.manifest.manifestJson, mimeType: "application/json",
        byteLength: Buffer.byteLength(r.manifest.manifestJson, "utf8"), contentHash: r.manifest.receiptHash, sourceRevisionHash: rev.revisionHash, eventChainHead: fin.eventHash,
        rendererKey: RECEIPT_RENDERER.rendererKey, rendererVersion: RECEIPT_RENDERER.rendererVersion, generatedByUserId: caller.userId!, generatedAt: now,
      });
      const artifactId = Number(aIns[0].insertId);
      await tx.update(attestDocumentRevisions).set({ state: "finalized", finalizedAt: now, finalizedByUserId: caller.userId!, artifactId, receiptHash: r.manifest.receiptHash, eventChainHead: fin.eventHash }).where(eq(attestDocumentRevisions.id, rev.id));
      await appendEvent(tx, chain, { eventType: "artifact_generated", actor, artifactId, artifactRef, occurredAt: now, detail: { kind: "audit_receipt", contentHash: r.manifest.receiptHash } });
      await emitOutbox(tx, rev, actor, "attest.document_finalized", { artifactRef, receiptHash: r.manifest.receiptHash, eventChainHead: fin.eventHash }, now);
      return { revisionRef, state: "finalized" as const, artifactRef, receiptHash: r.manifest.receiptHash, eventChainHead: fin.eventHash, alreadyFinalized: false };
    });
  } catch (e) {
    // Two finalized revisions of one instance: the generated finalizedKey's unique index refused the second (§6.5 race 4).
    const code = e && typeof e === "object" ? ((e as { code?: string }).code ?? (e as { cause?: { code?: string } }).cause?.code) : undefined;
    if (code === "ER_DUP_ENTRY") refuse("conflict", `DOCUMENT_FINALIZED: another revision of this document is already finalized`, "DOCUMENT_FINALIZED");
    throw e;
  }
}

export async function voidRevision(db: Db, caller: Caller, revisionRef: string, reason: string): Promise<{ revisionRef: string; state: "voided" }> {
  if (reason.trim().length < 10) refuse("bad_request", "A void needs a reason of at least ten characters");
  const now = secs(new Date());
  return db.transaction(async tx => {
    const chain = await requireOpenRevision(tx, caller, revisionRef);
    const rev = chain.revision;
    const t = revisionTransition(rev.state, "void");
    if (!t.ok) refuse("precondition", `Cannot void ${revisionRef}: ${t.reason} A finalized document is superseded, never voided.`);
    const actor: ActorRow = { source: "human", userId: caller.userId, externalIdentityId: null, deviceRef: caller.deviceRef ?? null };
    await tx.update(attestDocumentRevisions).set({ state: "voided", voidedAt: now, voidedByUserId: caller.userId!, voidReason: reason }).where(eq(attestDocumentRevisions.id, rev.id));
    await tx.update(attestFields).set({ state: "voided" }).where(and(eq(attestFields.revisionId, rev.id), eq(attestFields.state, "pending")));
    await appendEvent(tx, chain, { eventType: "document_voided", actor, previousState: rev.state, newState: "voided", occurredAt: now, detail: { reason } });
    await emitOutbox(tx, rev, actor, "attest.document_voided", { reason }, now);
    return { revisionRef, state: "voided" as const };
  });
}

export async function supersedeRevision(db: Db, caller: Caller, revisionRef: string, input: { reason: string; subjectRef?: string | null }): Promise<OpenResult & { supersedes: string }> {
  if (input.reason.trim().length < 10) refuse("bad_request", "A superseding revision needs a reason of at least ten characters");
  const now = secs(new Date());
  return db.transaction(async tx => {
    const chain = await requireOpenRevision(tx, caller, revisionRef);
    const old = chain.revision;
    const t = revisionTransition(old.state, "supersede");
    if (!t.ok) refuse("precondition", `Cannot supersede ${revisionRef}: ${t.reason}`);
    // D-07: the person who finalized does not also replace what they finalized.
    if (old.state === "finalized" && old.finalizedByUserId === caller.userId) refuse("forbidden", "The person who finalized a document does not supersede it; a second person does.");
    const subjectRef = input.subjectRef ?? old.subjectRef;
    const facts = await loadSubjectInScope(tx, caller.orgRef, old.subjectType, subjectRef);
    const binding = resolveBinding(facts);
    if (!binding.ok) return refuse("precondition", `Cannot open the superseding revision: ${binding.reason}`);
    if (binding.instanceRef !== old.instanceRef) refuse("bad_request", `${subjectRef} belongs to ${binding.instanceRef}, not to ${old.instanceRef}`);
    if (binding.subjectRef === old.subjectRef && binding.revisionHash === old.revisionHash) refuse("bad_request", "Nothing changed: the subject still hashes to the signed revision. Supersede with the corrected document.");
    const actor: ActorRow = { source: "human", userId: caller.userId, externalIdentityId: null, deviceRef: caller.deviceRef ?? null };
    const oldFields = await tx.select().from(attestFields).where(eq(attestFields.revisionId, old.id));
    const oldSigners = await tx.select().from(attestSigners).where(eq(attestSigners.revisionId, old.id));
    // Close the old revision first (allowed on a finalized row: state → superseded and the pointer), then open the new one from the new hash.
    await tx.update(attestDocumentRevisions).set({ state: "superseded" }).where(eq(attestDocumentRevisions.id, old.id));
    await tx.update(attestFields).set({ state: "voided" }).where(and(eq(attestFields.revisionId, old.id), eq(attestFields.state, "pending")));
    await appendEvent(tx, chain, { eventType: "document_superseded", actor, previousState: old.state, newState: "superseded", occurredAt: now, detail: { reason: input.reason } });
    const opened = await openRevisionInTx(tx, caller, {
      subjectType: old.subjectType as AttestSubjectType, subjectRef, pageCount: old.pageCount, pageGeometry: old.pageGeometryJson ? JSON.parse(old.pageGeometryJson) : undefined,
      completionRule: old.completionRule as "all_required_fields" | "all_required_fields_in_order",
      // Marks are never carried forward: a signature is of a hash. Fields and signers are, as pending.
      fields: oldFields.map(f => ({ fieldKey: f.fieldKey, fieldType: f.fieldType as AttestFieldType, page: f.page, xFrac: f.xFrac, yFrac: f.yFrac, widthFrac: f.widthFrac, heightFrac: f.heightFrac, signerRole: f.signerRole, required: f.required, signingOrder: f.signingOrder, subjectLineRef: f.subjectLineRef, groupKey: f.groupKey })),
      signers: oldSigners.filter(s => s.state !== "revoked").map(s => {
        const fieldKeys = oldFields.filter(f => f.assignedSignerId === s.id).map(f => f.fieldKey);
        const base = { displayName: s.displayName, company: s.company, signerRole: s.signerRole, requiredAuth: s.requiredAuth as AttestAuthMethod, signingOrder: s.signingOrder, fieldKeys };
        return s.partyKind === "internal_user" ? { partyKind: "internal_user" as const, userId: s.userId!, ...base } : s.partyKind === "external_identity" ? { partyKind: "external_identity" as const, externalIdentityId: s.externalIdentityId!, ...base } : { partyKind: "named_witnessed" as const, ...base };
      }).filter(s => s.fieldKeys.length > 0),
    }, now, { revisionId: old.id, revisionRef: old.revisionRef });
    const newRow = (await tx.select({ id: attestDocumentRevisions.id }).from(attestDocumentRevisions).where(eq(attestDocumentRevisions.revisionRef, opened.revisionRef)).limit(1))[0]!;
    await tx.update(attestDocumentRevisions).set({ supersededByRevisionId: newRow.id }).where(eq(attestDocumentRevisions.id, old.id));
    await emitOutbox(tx, old, actor, "attest.document_superseded", { reason: input.reason, supersededBy: opened.revisionRef }, now);
    return { ...opened, supersedes: old.revisionRef };
  });
}

/* ------------------------------------------------------------------ */
/* Read, verify, export                                                 */
/* ------------------------------------------------------------------ */

export type ReadScope = { orgRef: string | null } | { externalIdentityId: number };

async function findRevision(db: DbOrTx, scope: ReadScope, revisionRef: string): Promise<AttestDocumentRevisionRow | null> {
  if ("orgRef" in scope) return (await db.select().from(attestDocumentRevisions).where(and(eq(attestDocumentRevisions.revisionRef, revisionRef), orgWhere(scope.orgRef))).limit(1))[0] ?? null;
  const named = (await db.select({ rev: attestDocumentRevisions }).from(attestSigners).innerJoin(attestDocumentRevisions, eq(attestDocumentRevisions.id, attestSigners.revisionId))
    .where(and(eq(attestDocumentRevisions.revisionRef, revisionRef), eq(attestSigners.externalIdentityId, scope.externalIdentityId))).limit(1))[0];
  return named?.rev ?? null;
}

export async function viewRevision(db: Db, scope: ReadScope, revisionRef: string) {
  const rev = await findRevision(db, scope, revisionRef);
  if (!rev) return refuse("not_found", `Signing revision ${revisionRef} not found`);
  const [fields, signers, sessions, events, artifacts] = await Promise.all([
    db.select().from(attestFields).where(eq(attestFields.revisionId, rev.id)),
    db.select().from(attestSigners).where(eq(attestSigners.revisionId, rev.id)),
    db.select().from(attestSigningSessions).where(eq(attestSigningSessions.revisionId, rev.id)),
    db.select().from(attestEvents).where(eq(attestEvents.revisionId, rev.id)).orderBy(attestEvents.sequence),
    db.select().from(attestArtifacts).where(eq(attestArtifacts.revisionId, rev.id)),
  ]);
  const marks = sessions.length ? await db.select().from(attestMarks).where(inArray(attestMarks.sessionId, sessions.map(s => s.id))) : [];
  const external = !("orgRef" in scope);
  return {
    revision: { revisionRef: rev.revisionRef, instanceRef: rev.instanceRef, revision: rev.revision, subjectType: rev.subjectType, subjectRef: rev.subjectRef, revisionHash: rev.revisionHash, state: rev.state, pageCount: rev.pageCount, pageGeometry: rev.pageGeometryJson ? JSON.parse(rev.pageGeometryJson) : null, completionRule: rev.completionRule, finalizedAt: rev.finalizedAt, receiptHash: rev.receiptHash, eventChainHead: rev.eventChainHead, supersedesRevisionId: rev.supersedesRevisionId, supersededByRevisionId: rev.supersededByRevisionId, voidReason: rev.voidReason },
    fields: fields.map(f => ({ fieldRef: f.fieldRef, fieldKey: f.fieldKey, fieldType: f.fieldType, page: f.page, xFrac: f.xFrac, yFrac: f.yFrac, widthFrac: f.widthFrac, heightFrac: f.heightFrac, signerRole: f.signerRole, signerRef: signers.find(s => s.id === f.assignedSignerId)?.signerRef ?? null, required: f.required, signingOrder: f.signingOrder, subjectLineRef: f.subjectLineRef, groupKey: f.groupKey, state: f.state, mark: (() => { const m = marks.find(x => x.id === f.completedMarkId); return m ? { markRef: m.markRef, markKind: m.markKind, inputKind: m.inputKind, payloadHash: m.payloadHash, strokeHash: m.strokeHash, renderedHash: m.renderedHash, strokeEvidenceRecordId: m.strokeEvidenceRecordId, renderedEvidenceRecordId: m.renderedEvidenceRecordId, valueText: m.valueText, completedAt: m.completedAt } : null; })() })),
    // A portal reader sees the other signers' roles and states, not their account identifiers.
    signers: signers.map(s => ({ signerRef: s.signerRef, partyKind: s.partyKind, displayName: s.displayName, company: s.company, signerRole: s.signerRole, requiredAuth: s.requiredAuth, signingOrder: s.signingOrder, state: s.state, userId: external ? null : s.userId, externalIdentityId: external ? null : s.externalIdentityId })),
    sessions: sessions.map(s => ({ sessionRef: s.sessionRef, signerRef: signers.find(x => x.id === s.signerId)?.signerRef ?? null, authMethod: s.authMethod, state: s.state, rejectionCode: s.rejectionCode, rejectionReason: s.rejectionReason, capturedOffline: s.capturedOffline, deviceRef: s.deviceRef, keyFingerprint: s.keyFingerprint, startedAt: s.startedAt, completedAt: s.completedAt })),
    events: events.map(e => ({ sequence: e.sequence, eventType: e.eventType, actorSource: e.actorSource, actorUserId: external ? null : e.actorUserId, previousState: e.previousState, newState: e.newState, detail: e.detailJson ? JSON.parse(e.detailJson) : null, prevEventHash: e.prevEventHash, eventHash: e.eventHash, occurredAt: e.occurredAt, recordedAt: e.recordedAt })),
    artifacts: artifacts.map(a => ({ artifactRef: a.artifactRef, kind: a.kind, contentHash: a.contentHash, sourceRevisionHash: a.sourceRevisionHash, eventChainHead: a.eventChainHead, byteLength: a.byteLength, generatedAt: a.generatedAt })),
  };
}

export type VerifyResult = { revisionRef: string; chain: ReturnType<typeof verifyChain>; receipt: { declared: string | null; recomputed: string | null; matches: boolean } | null; head: { declared: string | null; matches: boolean }; verified: boolean };

export async function verifyRevision(db: Db, caller: Caller, revisionRef: string): Promise<VerifyResult> {
  const now = secs(new Date());
  return db.transaction(async tx => {
    const chain = await requireOpenRevision(tx, caller, revisionRef);
    const rev = chain.revision;
    const events = await tx.select().from(attestEvents).where(eq(attestEvents.revisionId, rev.id)).orderBy(attestEvents.sequence);
    const chainResult = verifyChain(events.map(e => ({
      revisionRef: rev.revisionRef, sequence: e.sequence, eventType: e.eventType,
      sessionId: e.sessionId, fieldId: e.fieldId, markId: e.markId, artifactId: e.artifactId,
      actorSource: e.actorSource, actorUserId: e.actorUserId, actorExternalIdentityId: e.actorExternalIdentityId, deviceRef: e.deviceRef,
      previousState: e.previousState, newState: e.newState, detailJson: e.detailJson, occurredAt: e.occurredAt, prevEventHash: e.prevEventHash, eventHash: e.eventHash,
    })));
    let receipt: VerifyResult["receipt"] = null;
    if (rev.state === "finalized" || rev.state === "superseded") {
      const art = (await tx.select().from(attestArtifacts).where(and(eq(attestArtifacts.revisionId, rev.id), eq(attestArtifacts.kind, "audit_receipt"))).limit(1))[0];
      if (art?.manifestJson) {
        const recomputed = sha256Hex(art.manifestJson);
        receipt = { declared: rev.receiptHash, recomputed, matches: recomputed === rev.receiptHash && recomputed === art.contentHash };
      } else if (rev.receiptHash) receipt = { declared: rev.receiptHash, recomputed: null, matches: false };
    }
    // The head recorded at finalization must be one of the hashes in the chain (events appended after it are fine).
    const head = { declared: rev.eventChainHead, matches: rev.eventChainHead == null || events.some(e => e.eventHash === rev.eventChainHead) };
    const verified = chainResult.ok && head.matches && (receipt == null || receipt.matches);
    const actor: ActorRow = { source: "human", userId: caller.userId, externalIdentityId: null, deviceRef: caller.deviceRef ?? null };
    await appendEvent(tx, chain, { eventType: "verification_run", actor, occurredAt: now, detail: { verified, chain: chainResult.ok ? "ok" : chainResult.reason, receipt: receipt?.matches ?? null } });
    return { revisionRef, chain: chainResult, receipt, head, verified };
  });
}

export async function exportReceipt(db: Db, caller: Caller, revisionRef: string): Promise<{ artifactRef: string; receiptHash: string; manifestJson: string }> {
  const now = secs(new Date());
  return db.transaction(async tx => {
    const chain = await requireOpenRevision(tx, caller, revisionRef);
    const art = (await tx.select().from(attestArtifacts).where(and(eq(attestArtifacts.revisionId, chain.revision.id), eq(attestArtifacts.kind, "audit_receipt"))).limit(1))[0];
    if (!art?.manifestJson) return refuse("precondition", `${revisionRef} has no audit receipt yet; finalize it first`);
    const actor: ActorRow = { source: "human", userId: caller.userId, externalIdentityId: null, deviceRef: caller.deviceRef ?? null };
    // The export event is written before the bytes are handed over (the restricted-vault rule): no row, no export.
    await appendEvent(tx, chain, { eventType: "artifact_exported", actor, artifactId: art.id, artifactRef: art.artifactRef, occurredAt: now, detail: { kind: art.kind, contentHash: art.contentHash } });
    return { artifactRef: art.artifactRef, receiptHash: art.contentHash, manifestJson: art.manifestJson };
  });
}

export async function listRevisions(db: Db, scope: ReadScope, f: { subjectType?: string; instanceRef?: string; state?: AttestRevisionState; limit?: number }) {
  const limit = Math.min(Math.max(f.limit ?? 50, 1), 200);
  if ("orgRef" in scope) {
    const conds = [orgWhere(scope.orgRef)];
    if (f.subjectType) conds.push(eq(attestDocumentRevisions.subjectType, f.subjectType));
    if (f.instanceRef) conds.push(eq(attestDocumentRevisions.instanceRef, f.instanceRef));
    if (f.state) conds.push(eq(attestDocumentRevisions.state, f.state));
    return (await db.select().from(attestDocumentRevisions).where(and(...conds)).orderBy(desc(attestDocumentRevisions.id)).limit(limit)).map(summary);
  }
  const rows = await db.select({ rev: attestDocumentRevisions, signerState: attestSigners.state, signerRef: attestSigners.signerRef }).from(attestSigners).innerJoin(attestDocumentRevisions, eq(attestDocumentRevisions.id, attestSigners.revisionId))
    .where(eq(attestSigners.externalIdentityId, scope.externalIdentityId)).orderBy(desc(attestDocumentRevisions.id)).limit(limit);
  return rows.map(r => ({ ...summary(r.rev), mySigner: { signerRef: r.signerRef, state: r.signerState } }));
}
const summary = (r: AttestDocumentRevisionRow) => ({ revisionRef: r.revisionRef, instanceRef: r.instanceRef, revision: r.revision, subjectType: r.subjectType, subjectRef: r.subjectRef, revisionHash: r.revisionHash, state: r.state, openedAt: r.openedAt, finalizedAt: r.finalizedAt });
