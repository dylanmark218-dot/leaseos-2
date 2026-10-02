/**
 * 0220 — the ELD ledger's API.
 *
 * Five procedures and nothing that decides. `eventsAppend` is the device's push: the same transport
 * discipline as `sync.receivePackage` (enrolled device, P-256 signature over the canonical batch,
 * single-use nonce, freshness by the device's clock), then everything about identity, tenancy and
 * idempotency is `appendEldEvents`'s. `deviceIntegrity` reads what one device's chain proves.
 * `hosStatus` reads one operator's hours from the ledger through `evaluateHos`. `dutyDayDesignate`
 * and `dutyDayHistory` (0224) record and read where an operator's duty day begins.
 *
 * No procedure here accepts an organization or a driver's name. The device is the identity on the
 * write path, and it is looked up. An operator id is taken only where an operator is the subject —
 * `hosStatus`, the duty-day procedures — and is always checked against the caller's organization.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { deviceKeyEvents, deviceSyncNonces, fieldDevices, operators } from "../drizzle/schema";
import { resolveActingScope } from "./_core/actingScope";
import { DEVICE_SIGNATURE_MAX_SKEW_MS, handleSyncRefusal, signatureFreshness, verifyP256PackageSignature, type SyncRefusalCode } from "./_core/deviceSignature";
import { admitPackage, type FieldDeviceRecord, type KeyEvent } from "./_core/fieldDevice";
import { canonicalEldBatch, type BatchProblem } from "./_core/eld/ledger";
import { appendEldEvents, deviceLedgerIntegrity, loadHosLedgerWindow } from "./_core/eld/eldLedgerStore";
import { evaluateHos } from "./_core/eld/hosEngine";
import { dutyDayWindow } from "./_core/eld/dutyDay";
import { dutyDayDesignationAt, dutyDayDesignationHistory, recordDutyDayDesignation, type DutyDayDesignationRefusal } from "./_core/eld/dutyDayStore";
import { authorize } from "./_core/recordsAuthorization";
import { recordBelongsToOrganization } from "./_core/coreRecordOwnership";
import { loadProfiles } from "./hosRouter";

/** Why the transport refused, before any event was looked at. Content refusals use the store's codes. */
export type EldTransportRefusalCode = "device_unknown" | "device_no_organization" | "device_legacy_key" | "signature_stale" | "signature_invalid" | "device_not_admitted";

const FINGERPRINT = z.string().regex(/^[a-f0-9]{64}$/, "fingerprint must be a lowercase SHA-256 hex string");

/** A designation refusal is the caller's input or the history's order, never the server's fault. */
const DESIGNATION_REFUSAL_STATUS: Record<DutyDayDesignationRefusal, "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT"> = {
  operator_not_found: "NOT_FOUND", timezone_unknown: "BAD_REQUEST", day_start_invalid: "BAD_REQUEST",
  reason_required: "BAD_REQUEST", backdated: "BAD_REQUEST", not_after_latest: "CONFLICT",
};

export const eldRouter = router({
  /**
   * A device pushes a batch of ELD events. Refusals of the transport (signature, clock, admission)
   * come back as a structured `refusal` the runtime acts on; refusals of the content come back from
   * the store with a reason code and the offending events named. Neither throws, so the device
   * marks the right captures failed rather than retrying for ever.
   */
  eventsAppend: roleProcedure("eld.eventsAppend")
    .input(z.object({
      deviceRef: z.string().min(1).max(64),
      signedWithFingerprint: FINGERPRINT,
      signedAt: z.coerce.date(),
      nonce: z.string().min(16).max(120),
      signatureP1363Base64: z.string().min(80).max(128),
      deviceClockAt: z.coerce.date().optional(),
      batchRef: z.string().min(1).max(64),
      // Shapes are decided by the store, so a malformed event is a structured refusal naming it, not a thrown validation error.
      events: z.array(z.unknown()).min(1).max(500),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const now = new Date();
      const d = (await db.select().from(fieldDevices).where(eq(fieldDevices.deviceRef, input.deviceRef)).limit(1))[0] ?? null;
      const history = d ? await db.select().from(deviceKeyEvents).where(eq(deviceKeyEvents.fieldDeviceId, d.id)) : [];

      // A transport refusal carries the same shape as a content refusal from the store — a state, a
      // code, a reason, the offending events — so the runtime reads one shape. `refusal` adds the
      // clock/handling detail the field runtime already acts on for evidence packages.
      const refuse = (code: EldTransportRefusalCode, reason: string, syncCode?: SyncRefusalCode, skewMs?: number | null) => ({
        batchRef: input.batchRef, state: "refused" as const, code, reason, problems: [] as BatchProblem[],
        refusal: syncCode ? { code: syncCode, skewMs: skewMs ?? null, serverTimeIso: now.toISOString(), handling: handleSyncRefusal({ code: syncCode, skewMs, serverTimeIso: now.toISOString() }) } : null,
      });

      if (!d) return refuse("device_unknown", "Unknown device — not enrolled");
      // The device's organization is the batch's organization, and the caller must be acting for it.
      if (!d.orgRef) return refuse("device_no_organization", "Legacy device has no organization binding and must be re-enrolled");
      const acting = (await resolveActingScope(db, ctx.user.id)).tenantId;
      if (d.orgRef !== acting) throw new TRPCError({ code: "FORBIDDEN", message: "Device is not bound to the active organization" });
      if (!d.publicKeySpkiBase64) return refuse("device_legacy_key", "Legacy fingerprint-only device must be re-enrolled with a public key");

      const freshness = signatureFreshness({ signedAt: input.signedAt, now, deviceClockAt: input.deviceClockAt ?? null });
      if (!freshness.fresh) return refuse("signature_stale", `Device signature timestamp refused: ${freshness.reason} (server time ${now.toISOString()}; allowed ±${DEVICE_SIGNATURE_MAX_SKEW_MS / 60_000} min)`, freshness.code, freshness.skewMs);

      const signingKey = d.keyFingerprint === input.signedWithFingerprint
        ? d.publicKeySpkiBase64
        : history.find(h => h.keyFingerprint === input.signedWithFingerprint && h.publicKeySpkiBase64)?.publicKeySpkiBase64;
      const payload = canonicalEldBatch({ deviceRef: input.deviceRef, batchRef: input.batchRef, signedAt: input.signedAt, nonce: input.nonce, events: input.events });
      if (!signingKey || !verifyP256PackageSignature({ publicKeySpkiBase64: signingKey, payload, signatureP1363Base64: input.signatureP1363Base64 })) {
        return refuse("signature_invalid", signingKey ? "Invalid device batch signature" : "Invalid device batch signature: the signing key was never enrolled or rotated in for this device");
      }
      try {
        await db.insert(deviceSyncNonces).values({ fieldDeviceId: d.id, orgRef: d.orgRef, nonce: input.nonce, signedAt: input.signedAt, packageRef: input.batchRef, receivedAt: now });
      } catch {
        throw new TRPCError({ code: "CONFLICT", message: "Device sync nonce was already used" });
      }
      const admission = admitPackage({
        device: { deviceRef: d.deviceRef, userId: d.userId, status: d.status, keyFingerprint: d.keyFingerprint, encryptedStorageAttested: d.encryptedStorageAttested, keystoreAttestation: d.keystoreAttestation, revokedAt: d.revokedAt } satisfies FieldDeviceRecord,
        claimedUserId: ctx.user.id,
        signedWithFingerprint: input.signedWithFingerprint,
        keyHistory: history.map(h => ({ keyFingerprint: h.keyFingerprint, eventType: h.eventType, validFrom: h.validFrom, validUntil: h.validUntil }) satisfies KeyEvent),
        now,
      });
      if (!admission.admitted) return refuse("device_not_admitted", admission.reason);
      await db.update(fieldDevices).set({ lastSeenAt: now }).where(eq(fieldDevices.id, d.id));

      const result = await appendEldEvents(db, {
        device: { id: d.id, deviceRef: d.deviceRef, userId: d.userId, orgRef: d.orgRef, status: d.status },
        claimedUserId: ctx.user.id, events: input.events, receivedAt: now, sourceRef: input.batchRef,
      });
      return { batchRef: input.batchRef, refusal: null, ...result, note: admission.note ?? null };
    }),

  /** What one device's chain proves as it stands: gaps, verified and unverifiable links, mismatches. */
  deviceIntegrity: roleProcedure("eld.deviceIntegrity")
    .input(z.object({ deviceRef: z.string().min(1).max(64) }))
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const acting = (await resolveActingScope(db, ctx.user.id)).tenantId;
      const d = (await db.select({ id: fieldDevices.id, orgRef: fieldDevices.orgRef }).from(fieldDevices).where(eq(fieldDevices.deviceRef, input.deviceRef)).limit(1))[0];
      // Out of scope reads as absent, as everywhere else in LeaseOS.
      if (!d || d.orgRef !== acting) throw new TRPCError({ code: "NOT_FOUND", message: `Device ${input.deviceRef} not found` });
      return { deviceRef: input.deviceRef, ...(await deviceLedgerIntegrity(db, d.id)) };
    }),

  /**
   * ELD checkpoint 2b — hours of service computed from the ledger, read-only.
   *
   * Runs `evaluateHos` over one operator's ledger rows and returns its whole answer: the clocks,
   * the determination after the mechanics discipline, the reason codes, and the window it read.
   * It writes nothing and changes no other answer — dispatch still reads `hos_unknown`.
   *
   * Who may read whom: `hos.read` (the gate) lets a driver read their OWN operator, resolved from
   * the session, never from the input. Naming any other operator additionally needs `eld.read`, the
   * office's permission. Either way the operator must belong to the caller's organization, and one
   * that does not reads as not found.
   *
   * The operating context (authority, jurisdiction, weight, latitude) is the caller's statement,
   * exactly as `hos.status` takes it: the selector answers UNKNOWN for every rung it leaves out, so an
   * incomplete context makes the answer less certain, never more permissive.
   */
  hosStatus: roleProcedure("eld.hosStatus")
    .input(z.object({
      operatorId: z.number().int().positive().optional(),
      carrierAuthority: z.enum(["federal", "provincial", "territorial"]).nullish(),
      jurisdiction: z.string().max(8).nullish(),
      crossedBoundary: z.boolean().nullish(),
      registeredWeightKg: z.number().int().positive().max(200_000).nullish(),
      operationClass: z.string().max(40).nullish(),
      latitude: z.number().min(-90).max(90).nullish(),
      at: z.coerce.date().optional(),
      lookbackDays: z.number().int().min(1).max(30).default(16),
    }).strict())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const acting = (await resolveActingScope(db, ctx.user.id)).tenantId;

      const own = await db.select({ id: operators.id }).from(operators).where(eq(operators.userId, ctx.user.id));
      const ownId = own.length === 1 ? own[0]!.id : null;
      const operatorId = input.operatorId ?? ownId;
      if (operatorId == null) {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: own.length > 1 ? `User ${ctx.user.id} has ${own.length} operator records; which one is meant has to be established, not guessed` : "No operator record for the signed-in user; name an operator to read someone else's hours" });
      }
      if (operatorId !== ownId) {
        const roles = (ctx as unknown as { roles?: readonly string[] }).roles ?? [];
        // The organization the gate decided in: a role another employer granted never counts here.
        const organization = (ctx as { organization?: string | null }).organization ?? null;
        if (!authorize({ userId: ctx.user.id, roles, permission: "eld.read", organization }).allowed) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Reading another operator's hours needs eld.read" });
        }
      }
      // Out of scope reads as absent.
      const exists = (await db.select({ id: operators.id }).from(operators).where(eq(operators.id, operatorId)).limit(1))[0];
      if (!exists || !(await recordBelongsToOrganization(db, acting, "operator", operatorId))) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Operator ${operatorId} not found` });
      }

      const at = input.at ?? new Date();
      const designation = await dutyDayDesignationAt(db, { orgRef: acting, operatorId, at });
      // The window always covers the whole designated day, which can be 25 hours long — longer than
      // the shortest lookback. A zone the runtime no longer knows leaves the lookback as asked.
      let since = new Date(at.getTime() - input.lookbackDays * 86_400_000);
      if (designation) {
        try {
          const day = dutyDayWindow(at, designation);
          if (day.from.getTime() < since.getTime()) since = day.from;
        } catch { /* the engine reports HOS_TIMEZONE_UNKNOWN */ }
      }
      const window = await loadHosLedgerWindow(db, { orgRef: acting, operatorId, since, at });
      const result = evaluateHos({
        operatorId, events: window.rows,
        dutyDay: designation ? { timezone: designation.timezone, dayStartMinutes: designation.dayStartMinutes, designationRef: designation.designationRef, effectiveFrom: designation.effectiveFrom } : null,
        context: { carrierAuthority: input.carrierAuthority, jurisdiction: input.jurisdiction, crossedBoundary: input.crossedBoundary, registeredWeightKg: input.registeredWeightKg, operationClass: input.operationClass, latitude: input.latitude, at },
        profiles: await loadProfiles(db),
        chainGaps: window.chainGaps.map(g => ({ fromAt: g.fromAt, toAt: g.toAt })),
        at,
      });
      return { ...result, window: { from: since, to: at, rowsRead: window.rows.length, chainGaps: window.chainGaps } };
    }),

  /**
   * ELD checkpoint 2c — record where an operator's duty day begins, from a moment on.
   *
   * A new row every time; the store refuses a designation that would take effect before it is
   * recorded or before the operator's latest one, so no answer already given can change. The
   * timezone is checked against this server's IANA database and stored under its canonical name,
   * with the database version beside it. Recording a designation decides no limit: daily limits
   * stay UNKNOWN until a rule saying how a regime counts them over this day is verified.
   */
  dutyDayDesignate: roleProcedure("eld.dutyDayDesignate")
    .input(z.object({
      operatorId: z.number().int().positive(),
      timezone: z.string().min(1).max(64),
      dayStartMinutes: z.number().int().min(0).max(1439),
      effectiveFrom: z.coerce.date().optional(),
      reason: z.string().trim().min(1).max(300),
    }).strict())
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const acting = (await resolveActingScope(db, ctx.user.id)).tenantId;
      const r = await recordDutyDayDesignation(db, {
        orgRef: acting, operatorId: input.operatorId, timezone: input.timezone, dayStartMinutes: input.dayStartMinutes,
        effectiveFrom: input.effectiveFrom ?? null, reason: input.reason, recordedByUserId: ctx.user.id, recordedAt: new Date(),
      });
      if (r.state === "refused") throw new TRPCError({ code: DESIGNATION_REFUSAL_STATUS[r.code], message: `${r.code}: ${r.reason}` });
      return r.designation;
    }),

  /** Every duty-day designation an operator has had in the caller's organization, oldest first. */
  dutyDayHistory: roleProcedure("eld.dutyDayHistory")
    .input(z.object({ operatorId: z.number().int().positive() }).strict())
    .query(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const acting = (await resolveActingScope(db, ctx.user.id)).tenantId;
      // Out of scope reads as absent, and so does an operator that does not exist at all.
      const exists = (await db.select({ id: operators.id }).from(operators).where(eq(operators.id, input.operatorId)).limit(1))[0];
      if (!exists || !(await recordBelongsToOrganization(db, acting, "operator", input.operatorId))) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Operator ${input.operatorId} not found` });
      }
      return dutyDayDesignationHistory(db, { orgRef: acting, operatorId: input.operatorId });
    }),
});
