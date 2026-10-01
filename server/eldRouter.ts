/**
 * 0220 — the ELD ledger's API.
 *
 * Two procedures and nothing that decides. `eventsAppend` is the device's push: the same transport
 * discipline as `sync.receivePackage` (enrolled device, P-256 signature over the canonical batch,
 * single-use nonce, freshness by the device's clock), then everything about identity, tenancy and
 * idempotency is `appendEldEvents`'s. `deviceIntegrity` reads what one device's chain proves.
 *
 * No procedure here accepts an organization, an operator or a driver's name. The device is the
 * identity, and the device is looked up.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { deviceKeyEvents, deviceSyncNonces, fieldDevices } from "../drizzle/schema";
import { resolveActingScope } from "./_core/actingScope";
import { DEVICE_SIGNATURE_MAX_SKEW_MS, handleSyncRefusal, signatureFreshness, verifyP256PackageSignature, type SyncRefusalCode } from "./_core/deviceSignature";
import { admitPackage, type FieldDeviceRecord, type KeyEvent } from "./_core/fieldDevice";
import { canonicalEldBatch, type BatchProblem } from "./_core/eld/ledger";
import { appendEldEvents, deviceLedgerIntegrity } from "./_core/eld/eldLedgerStore";

/** Why the transport refused, before any event was looked at. Content refusals use the store's codes. */
export type EldTransportRefusalCode = "device_unknown" | "device_no_organization" | "device_legacy_key" | "signature_stale" | "signature_invalid" | "device_not_admitted";

const FINGERPRINT = z.string().regex(/^[a-f0-9]{64}$/, "fingerprint must be a lowercase SHA-256 hex string");

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
});
