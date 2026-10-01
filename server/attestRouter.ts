/**
 * Sign & Attest — the staff surface (SA1).
 *
 * Built under the owner's SA1 ruling (docs/sign-attest/SA1_OWNER_RULING.md): the foundation that
 * binds a mark to a document revision's hash and keeps the trail append-only. No pad, no offline
 * envelope, no PDF, no templates, no saved marks — those are SA2–SA4 and stay blocked by their own
 * prerequisites.
 *
 * **Every input is strict.** An unknown field is refused, never dropped. **The organization is the
 * server's**: `resolveActingScope` on every call; two live memberships and no selection is a refusal,
 * not a guess. A revision another organization owns is "not found". Signing somebody else's field
 * fails closed in the service (`WRONG_SIGNER`), and the attempt is a row.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { AmbiguousOrganization, resolveActingScope, SINGLE_TENANT_ID } from "./_core/actingScope";
import { ATTEST_AUTH_METHODS, ATTEST_FIELD_TYPES, ATTEST_INPUT_KINDS, ATTEST_MARK_KINDS, ATTEST_REVISION_STATES, ATTEST_SUBJECT_TYPES, CONSENT_VERSION_V1 } from "../shared/attest";
import {
  AttestRefusal, assignSigner, declineSession, exportReceipt, finalizeRevision, listRevisions, openRevision, placeFields, submitSession, supersedeRevision, verifyRevision, viewRevision, voidRevision,
  type Caller, type RefusalCode,
} from "./_core/attest/attestService";
import { attestProofFor } from "./_core/attest/attestProof";
import { submitDeviceEnvelope } from "./_core/attest/attestOffline";
import { permissionsFor } from "./_core/recordsAuthorization";
import type { Db } from "./_core/dbTypes";

async function db(): Promise<Db> {
  const d = await getDb();
  if (!d) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  return d;
}

async function callerFor(d: Db, userId: number): Promise<Caller> {
  try {
    const acting = await resolveActingScope(d, userId);
    return { userId, orgRef: acting.tenantId === SINGLE_TENANT_ID ? null : acting.tenantId };
  } catch (e) {
    if (e instanceof AmbiguousOrganization) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Your acting organization is not established. Choose one before signing." });
    throw e;
  }
}

const CODE: Record<RefusalCode, TRPCError["code"]> = { not_found: "NOT_FOUND", bad_request: "BAD_REQUEST", conflict: "CONFLICT", precondition: "PRECONDITION_FAILED", forbidden: "FORBIDDEN" };

/** A service refusal becomes the tRPC code it names. The message never echoes a bearer token or an email. */
async function refusing<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (e) {
    if (e instanceof AttestRefusal) throw new TRPCError({ code: CODE[e.code], message: e.message });
    throw e;
  }
}

const REF = z.string().min(3).max(120);
const HEX64 = z.string().regex(/^[a-f0-9]{64}$/, "a 64-character sha256 hex digest");
const fieldInput = z.object({
  fieldKey: z.string().min(1).max(80), fieldType: z.enum(ATTEST_FIELD_TYPES), page: z.number().int().positive(),
  xFrac: z.number().min(0).max(1), yFrac: z.number().min(0).max(1), widthFrac: z.number().positive().max(1), heightFrac: z.number().positive().max(1),
  signerRole: z.string().min(1).max(60), required: z.boolean().optional(), signingOrder: z.number().int().positive().nullable().optional(),
  subjectLineRef: z.string().max(120).nullable().optional(), groupKey: z.string().max(80).nullable().optional(),
}).strict();
const signerBase = { displayName: z.string().min(1).max(180), company: z.string().max(180).nullable().optional(), signerRole: z.string().min(1).max(60), requiredAuth: z.enum(ATTEST_AUTH_METHODS).optional(), signingOrder: z.number().int().positive().nullable().optional(), fieldKeys: z.array(z.string().min(1).max(80)).min(1).max(100) };
const signerInput = z.discriminatedUnion("partyKind", [
  z.object({ partyKind: z.literal("internal_user"), userId: z.number().int().positive(), ...signerBase }).strict(),
  z.object({ partyKind: z.literal("external_identity"), externalIdentityId: z.number().int().positive(), ...signerBase }).strict(),
  z.object({ partyKind: z.literal("named_witnessed"), ...signerBase }).strict(),
]);
const markInput = z.object({
  fieldKey: z.string().min(1).max(80), markKind: z.enum(ATTEST_MARK_KINDS), inputKind: z.enum(ATTEST_INPUT_KINDS), valueText: z.string().max(500).nullable().optional(),
  strokeEvidenceRecordId: z.number().int().positive().nullable().optional(), strokeHash: HEX64.nullable().optional(),
  renderedEvidenceRecordId: z.number().int().positive().nullable().optional(), renderedHash: HEX64.nullable().optional(),
  canvas: z.object({ widthPx: z.number().int().positive(), heightPx: z.number().int().positive(), devicePixelRatio: z.number().positive(), orientation: z.enum(["portrait", "landscape"]) }).strict().nullable().optional(),
  pointCount: z.number().int().nonnegative().nullable().optional(), strokeCount: z.number().int().nonnegative().nullable().optional(), durationMs: z.number().int().nonnegative().nullable().optional(), pressureAvailable: z.boolean().nullable().optional(),
}).strict();
const deviceAttestation = z.object({ deviceRef: z.string().min(1).max(64), keyFingerprint: z.string().min(16).max(80), signatureP1363Base64: z.string().min(80).max(128), signedAt: z.coerce.date() }).strict();
const submitInput = z.object({
  revisionRef: REF, signerRef: REF, revisionHashAtStart: HEX64, consentVersion: z.string().min(1).max(40).default(CONSENT_VERSION_V1),
  marks: z.array(markInput).min(1).max(200), deviceAttestation: deviceAttestation.nullable().optional(), capturedOffline: z.boolean().optional(),
  gps: z.object({ latitude: z.number(), longitude: z.number() }).strict().nullable().optional(), sessionRef: z.string().min(8).max(120).nullable().optional(),
});

export const attestRouter = router({
  /** Open a document revision for signing: fixes its hash, places fields, assigns signers. SENSITIVE. */
  open: roleProcedure("attest.open")
    .input(z.object({
      subjectType: z.enum(ATTEST_SUBJECT_TYPES), subjectRef: z.string().min(1).max(120),
      fields: z.array(fieldInput).max(200).optional(), signers: z.array(signerInput).max(50).optional(),
      pageCount: z.number().int().positive().max(500).optional(), pageGeometry: z.array(z.object({ widthPt: z.number().positive(), heightPt: z.number().positive(), rotation: z.number().int().optional(), sourceEvidenceRecordId: z.number().int().positive().nullable().optional() }).strict()).max(500).optional(),
      completionRule: z.enum(["all_required_fields", "all_required_fields_in_order"]).optional(), reuseOpen: z.boolean().optional(),
    }).strict())
    .mutation(async ({ ctx, input }) => { const d = await db(); const c = await callerFor(d, ctx.user.id); return refusing(() => openRevision(d, c, input)); }),

  placeFields: roleProcedure("attest.placeFields")
    .input(z.object({ revisionRef: REF, fields: z.array(fieldInput).min(1).max(200) }).strict())
    .mutation(async ({ ctx, input }) => { const d = await db(); const c = await callerFor(d, ctx.user.id); return refusing(() => placeFields(d, c, input.revisionRef, input.fields)); }),

  assignSigner: roleProcedure("attest.assignSigner")
    .input(z.object({ revisionRef: REF, signer: signerInput }).strict())
    .mutation(async ({ ctx, input }) => { const d = await db(); const c = await callerFor(d, ctx.user.id); return refusing(() => assignSigner(d, c, input.revisionRef, input.signer)); }),

  /** Sign your OWN assigned field(s). Universal and self-scoped: the signer row must name `ctx.user.id`. */
  sign: roleProcedure("attest.sign")
    .input(submitInput.extend({ authMethod: z.enum(["session_login", "device_auth"]).default("session_login") }).strict())
    .mutation(async ({ ctx, input }) => { const d = await db(); const c = await callerFor(d, ctx.user.id); return refusing(() => submitSession(d, { kind: "user", userId: ctx.user.id }, { orgRef: c.orgRef }, input)); }),

  /**
   * SA2 — the device envelope: a session signed offline by the device key, carried in an envelope signed
   * again at send time (`docs/sign-attest/SA2_OWNER_RULING.md`; design §6.3). Self-scoped like `sign`: the
   * device must be bound to the caller and the signer row must name them; a witnessed session inside it is
   * accepted only from a caller who holds `attest.witness`. The answer is a code, never a thrown refusal.
   */
  submitSession: roleProcedure("attest.submitSession")
    .input(z.object({ deviceRef: z.string().min(1).max(64), signedWithFingerprint: HEX64, signatureP1363Base64: z.string().min(80).max(128), signedPayloadJson: z.string().min(2).max(2_000_000) }).strict())
    .mutation(async ({ ctx, input }) => {
      const d = await db();
      const c = await callerFor(d, ctx.user.id);
      const canWitness = permissionsFor(ctx.roles).includes("attest.witness");
      return submitDeviceEnvelope(d, { userId: ctx.user.id, tenantId: c.orgRef ?? SINGLE_TENANT_ID, orgRef: c.orgRef, canWitness }, input);
    }),

  /** Witness a named signer who has no account (drawn in your presence, or filed from a paper scan). The row and the receipt say "witnessed". SENSITIVE. */
  witness: roleProcedure("attest.witness")
    .input(submitInput.extend({ authMethod: z.enum(["witnessed", "paper_scan"]).default("witnessed") }).strict())
    .mutation(async ({ ctx, input }) => { const d = await db(); const c = await callerFor(d, ctx.user.id); return refusing(() => submitSession(d, { kind: "witness", userId: ctx.user.id }, { orgRef: c.orgRef }, input)); }),

  decline: roleProcedure("attest.decline")
    .input(z.object({ revisionRef: REF, signerRef: REF, reason: z.string().min(3).max(500) }).strict())
    .mutation(async ({ ctx, input }) => { const d = await db(); const c = await callerFor(d, ctx.user.id); return refusing(() => declineSession(d, { kind: "user", userId: ctx.user.id }, { orgRef: c.orgRef }, input)); }),

  finalize: roleProcedure("attest.finalize")
    .input(z.object({ revisionRef: REF }).strict())
    .mutation(async ({ ctx, input }) => { const d = await db(); const c = await callerFor(d, ctx.user.id); return refusing(() => finalizeRevision(d, c, input.revisionRef)); }),

  void: roleProcedure("attest.void")
    .input(z.object({ revisionRef: REF, reason: z.string().min(10).max(500) }).strict())
    .mutation(async ({ ctx, input }) => { const d = await db(); const c = await callerFor(d, ctx.user.id); return refusing(() => voidRevision(d, c, input.revisionRef, input.reason)); }),

  supersede: roleProcedure("attest.supersede")
    .input(z.object({ revisionRef: REF, reason: z.string().min(10).max(500), subjectRef: z.string().min(1).max(120).nullable().optional() }).strict())
    .mutation(async ({ ctx, input }) => { const d = await db(); const c = await callerFor(d, ctx.user.id); return refusing(() => supersedeRevision(d, c, input.revisionRef, { reason: input.reason, subjectRef: input.subjectRef ?? null })); }),

  view: roleProcedure("attest.view")
    .input(z.object({ revisionRef: REF }).strict())
    .query(async ({ ctx, input }) => { const d = await db(); const c = await callerFor(d, ctx.user.id); return refusing(() => viewRevision(d, { orgRef: c.orgRef }, input.revisionRef)); }),

  list: roleProcedure("attest.list")
    .input(z.object({ subjectType: z.enum(ATTEST_SUBJECT_TYPES).optional(), instanceRef: z.string().max(120).optional(), state: z.enum(ATTEST_REVISION_STATES).optional(), limit: z.number().int().positive().max(200).optional() }).strict().optional())
    .query(async ({ ctx, input }) => { const d = await db(); const c = await callerFor(d, ctx.user.id); return listRevisions(d, { orgRef: c.orgRef }, input ?? {}); }),

  /** Recompute the chain and the receipt. Writes a verification_run event; a failure is reported, never repaired. */
  verify: roleProcedure("attest.verify")
    .input(z.object({ revisionRef: REF }).strict())
    .mutation(async ({ ctx, input }) => { const d = await db(); const c = await callerFor(d, ctx.user.id); return refusing(() => verifyRevision(d, c, input.revisionRef)); }),

  /** The read contract for billing, disposal, jobs and the wallet (design §11.2). */
  proof: roleProcedure("attest.proof")
    .input(z.object({ subjectType: z.enum(ATTEST_SUBJECT_TYPES), subjectRef: z.string().max(120).optional(), instanceRef: z.string().max(120).optional() }).strict())
    .query(async ({ ctx, input }) => { const d = await db(); const c = await callerFor(d, ctx.user.id); return attestProofFor(d, { orgRef: c.orgRef }, input); }),

  /** The audit receipt's bytes. The export event is written before they are handed over. SENSITIVE. */
  exportReceipt: roleProcedure("attest.exportReceipt")
    .input(z.object({ revisionRef: REF }).strict())
    .mutation(async ({ ctx, input }) => { const d = await db(); const c = await callerFor(d, ctx.user.id); return refusing(() => exportReceipt(d, c, input.revisionRef)); }),
});
