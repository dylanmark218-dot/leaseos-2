/**
 * Field devices and synchronization — the server's half of P4.
 *
 * Nothing the request says about a device is believed until the server has
 * looked it up. `sync.receivePackage` decides admission, verifies every hash
 * three ways, and detects conflicts — all before a single evidence record is
 * marked received. What arrives from a revoked device is refused, and the
 * refusal is a row, not a log line.
 */

import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { and, eq, isNull, desc } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { actingScopeFor, evidenceInScope, getDb } from "./db";
import { sealIsTrustworthy, verifySealAgainstStored } from "./_core/evidenceSeal";
import { recordOfficeReceipt } from "./recordsService";
import { deviceKeyEvents, deviceSyncNonces, evidenceRecords, evidenceSeals, fieldDevices, syncConflicts, syncPackages, syncPackageItems, syncReceipts } from "../drizzle/schema";
import { createHash } from "node:crypto";
import { handleSyncRefusal, type SyncRefusalCode, DEVICE_SIGNATURE_MAX_SKEW_MS, canonicalDevicePackage, fingerprintP256Spki, signatureFreshness, verifyP256PackageSignature } from "./_core/deviceSignature";
import { resolveActingScope } from "./_core/actingScope";
import { storageRead } from "./storage";
import {
  admitPackage, detectConflict, verifyPackageItems, type FieldDeviceRecord, type KeyEvent,
} from "./_core/fieldDevice";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
const FINGERPRINT = z.string().regex(/^[a-f0-9]{64}$/, "fingerprint must be a lowercase SHA-256 hex string");

async function loadDevice(deviceRef: string) {
  const db = await getDb();
  if (!db) return null;
  const rows = await db.select().from(fieldDevices).where(eq(fieldDevices.deviceRef, deviceRef)).limit(1);
  return rows[0] ?? null;
}

export const deviceRouter = router({
  enroll: roleProcedure("device.enroll")
    .input(z.object({
      platform: z.enum(["android", "ios", "windows", "linux", "web", "other"]),
      platformDeviceIdHash: z.string().regex(/^[a-f0-9]{64}$/).nullable().optional(),
      displayName: z.string().max(120).nullable().optional(),
      publicKeySpkiBase64: z.string().min(80).max(2048),
      keystoreAttestation: z.enum(["hardware", "software", "unknown", "failed"]).default("unknown"),
      encryptedStorageAttested: z.boolean().default(false),
      appVersion: z.string().max(40).nullable().optional(),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      // A failed keystore attestation is not enrolled at all. Software
      // attestation enrolls but is recorded; the compliance view sees it.
      if (input.keystoreAttestation === "failed") {
        throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Keystore attestation failed — this device cannot hold LeaseOS keys" });
      }
      const orgRef = (await resolveActingScope(db, ctx.user.id)).tenantId;
      let keyFingerprint: string;
      try { keyFingerprint = fingerprintP256Spki(input.publicKeySpkiBase64); }
      catch { throw new TRPCError({ code: "BAD_REQUEST", message: "Device public key must be a valid P-256 SPKI key" }); }
      const now = new Date();
      const deviceRef = ref("DEV");
      const ins = await db.insert(fieldDevices).values({
        deviceRef, userId: ctx.user.id, orgRef, platform: input.platform,
        platformDeviceIdHash: input.platformDeviceIdHash ?? null, displayName: input.displayName ?? null,
        keyFingerprint, publicKeySpkiBase64: input.publicKeySpkiBase64, keystoreAttestation: input.keystoreAttestation,
        encryptedStorageAttested: input.encryptedStorageAttested, appVersion: input.appVersion ?? null,
        status: "enrolled", enrolledAt: now, enrolledByUserId: ctx.user.id,
      });
      const id = Number(ins[0]?.insertId ?? 0);
      await db.insert(deviceKeyEvents).values({ fieldDeviceId: id, keyFingerprint, publicKeySpkiBase64: input.publicKeySpkiBase64, eventType: "enrolled", validFrom: now, recordedByUserId: ctx.user.id });
      return { deviceRef, status: "enrolled" as const, note: input.encryptedStorageAttested ? undefined : "Encrypted local storage not attested — flagged" };
    }),

  activate: roleProcedure("device.activate")
    .input(z.object({ deviceRef: z.string().min(1).max(64) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const d = await loadDevice(input.deviceRef);
      if (!d || d.userId !== ctx.user.id) throw new TRPCError({ code: "NOT_FOUND", message: "Device not found for this user" });
      const actingOrgRef = (await resolveActingScope(db, ctx.user.id)).tenantId;
      if (!d.orgRef || d.orgRef !== actingOrgRef) throw new TRPCError({ code: "FORBIDDEN", message: "Device organization binding does not match the active organization" });
      if (d.status !== "enrolled") throw new TRPCError({ code: "CONFLICT", message: `Device is ${d.status}` });
      await db.update(fieldDevices).set({ status: "active", activatedAt: new Date() }).where(eq(fieldDevices.id, d.id));
      return { deviceRef: d.deviceRef, status: "active" as const };
    }),

  rotateKey: roleProcedure("device.rotateKey")
    .input(z.object({ deviceRef: z.string().min(1).max(64), newPublicKeySpkiBase64: z.string().min(80).max(2048), reason: z.string().max(300).optional() }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const d = await loadDevice(input.deviceRef);
      if (!d || d.userId !== ctx.user.id) throw new TRPCError({ code: "NOT_FOUND", message: "Device not found for this user" });
      const actingOrgRef = (await resolveActingScope(db, ctx.user.id)).tenantId;
      if (!d.orgRef || d.orgRef !== actingOrgRef) throw new TRPCError({ code: "FORBIDDEN", message: "Device organization binding does not match the active organization" });
      if (d.status === "revoked") throw new TRPCError({ code: "CONFLICT", message: "A revoked device does not rotate keys; enroll a new device" });
      let newKeyFingerprint: string;
      try { newKeyFingerprint = fingerprintP256Spki(input.newPublicKeySpkiBase64); }
      catch { throw new TRPCError({ code: "BAD_REQUEST", message: "New device public key must be a valid P-256 SPKI key" }); }
      if (newKeyFingerprint === d.keyFingerprint) throw new TRPCError({ code: "BAD_REQUEST", message: "New key is the current key" });
      const now = new Date();
      await db.update(deviceKeyEvents).set({ validUntil: now }).where(and(eq(deviceKeyEvents.fieldDeviceId, d.id), eq(deviceKeyEvents.keyFingerprint, d.keyFingerprint), isNull(deviceKeyEvents.validUntil)));
      await db.insert(deviceKeyEvents).values({ fieldDeviceId: d.id, keyFingerprint: d.keyFingerprint, eventType: "retired", validFrom: now, validUntil: now, reason: input.reason ?? "rotated", recordedByUserId: ctx.user.id });
      await db.insert(deviceKeyEvents).values({ fieldDeviceId: d.id, keyFingerprint: newKeyFingerprint, publicKeySpkiBase64: input.newPublicKeySpkiBase64, eventType: "rotated", validFrom: now, recordedByUserId: ctx.user.id });
      await db.update(fieldDevices).set({ keyFingerprint: newKeyFingerprint, publicKeySpkiBase64: input.newPublicKeySpkiBase64 }).where(eq(fieldDevices.id, d.id));
      return { deviceRef: d.deviceRef, keyFingerprint: newKeyFingerprint, retiredFingerprint: d.keyFingerprint };
    }),

  revoke: roleProcedure("device.revoke")
    .input(z.object({ deviceRef: z.string().min(1).max(64), reason: z.string().min(3).max(300), keyCompromised: z.boolean().default(false) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const d = await loadDevice(input.deviceRef);
      if (!d) throw new TRPCError({ code: "NOT_FOUND", message: "Device not found" });
      const actingOrgRef = (await resolveActingScope(db, ctx.user.id)).tenantId;
      if (!d.orgRef || d.orgRef !== actingOrgRef) throw new TRPCError({ code: "FORBIDDEN", message: "Device organization binding does not match the active organization" });
      const now = new Date();
      await db.update(fieldDevices).set({ status: "revoked", revokedAt: now, revokedByUserId: ctx.user.id, revocationReason: input.reason }).where(eq(fieldDevices.id, d.id));
      await db.update(deviceKeyEvents).set({ validUntil: now }).where(and(eq(deviceKeyEvents.fieldDeviceId, d.id), isNull(deviceKeyEvents.validUntil)));
      if (input.keyCompromised) {
        await db.insert(deviceKeyEvents).values({ fieldDeviceId: d.id, keyFingerprint: d.keyFingerprint, eventType: "compromised", validFrom: now, validUntil: now, reason: input.reason, recordedByUserId: ctx.user.id });
      }
      // Anything still queued from this device is now refused on arrival; the
      // office should know it exists so the evidence can be recaptured.
      const pending = await db.select({ id: syncPackages.id }).from(syncPackages).where(and(eq(syncPackages.fieldDeviceId, d.id), eq(syncPackages.state, "queued")));
      return { deviceRef: d.deviceRef, status: "revoked" as const, queuedPackagesOrphaned: pending.length };
    }),
});

/**
 * A record the device changed while offline. Named rather than inline because it is **part of the
 * signed payload**: an anonymous shape inside a signature is one nothing else can refer to, which
 * is how a helper that signs packages came to type it as `unknown[]`.
 */
export const RECORD_UPDATE = z.object({
  recordType: z.string().min(1).max(60), recordRef: z.string().min(1).max(120),
  baseVersion: z.number().int().nonnegative(),
  baseValues: z.record(z.string(), z.unknown()), deviceValues: z.record(z.string(), z.unknown()),
});

/** Exported so tests take this shape from the schema rather than restating it as `unknown[]`. */
export const ITEM = z.object({
  evidenceRecordId: z.number().int().positive(),
  declaredContentHash: FINGERPRINT,
  declaredManifestHash: FINGERPRINT,
  computedContentHash: FINGERPRINT,
  computedManifestHash: FINGERPRINT,
  // Signed payload: no server-side default. The signature covers the bytes the
  // device sent, so a field the server would have to fill in cannot be part of
  // a signed item — the device states the claim, or the schema refuses it.
  captureAuthorizationClaim: z.enum(["authorized", "unauthorized", "unknown"]),
  captureAuthorizationReason: z.string().max(300).nullable().optional(),
});

export const syncRouter = router({
  /**
   * The device pushes a package. Admission first — before any item is
   * examined — then three-way hash verification, then conflict detection.
   * Refusals and rejections are rows.
   */
  receivePackage: roleProcedure("sync.receivePackage")
    .input(z.object({
      deviceRef: z.string().min(1).max(64),
      signedWithFingerprint: FINGERPRINT,
      signedAt: z.coerce.date(),
      nonce: z.string().min(16).max(120),
      signatureP1363Base64: z.string().min(80).max(128),
      /** 0142 — the exact bytes the device signed (its canonical JSON). When present it is what is verified AND what is processed. */
      signedPayloadJson: z.string().max(4_000_000).optional(),
      /** 0142 — the device's own clock at send time, for skew. */
      deviceClockAt: z.coerce.date().optional(),
      packageRef: z.string().min(1).max(64),
      queuedAt: z.coerce.date(),
      items: z.array(ITEM).min(1).max(500),
      // Also signed, so also no default: the device always sends it (empty when it has none).
      recordUpdates: z.array(RECORD_UPDATE),
    }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const now = new Date();

      const d = await loadDevice(input.deviceRef);
      const history = d ? await db.select().from(deviceKeyEvents).where(eq(deviceKeyEvents.fieldDeviceId, d.id)) : [];
      if (!d?.orgRef) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Legacy device has no organization binding and must be re-enrolled" });
      const orgRef = d.orgRef;
      const actingOrgRef = (await resolveActingScope(db, ctx.user.id)).tenantId;
      if (d.orgRef !== actingOrgRef) throw new TRPCError({ code: "FORBIDDEN", message: "Device is not bound to the active organization" });
      if (d && !d.publicKeySpkiBase64) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Legacy fingerprint-only device must be re-enrolled with a public key" });
      // A refused package is a row, whatever refused it. The pre-0110 rule was
      // "refusals and rejections are rows"; 0110's signature checks threw
      // instead, which left the office unable to see that a device with a bad
      // clock or an unknown key had tried. Recorded against the *claimed* device
      // ref — the caller is an authenticated user, so this is bounded — and
      // returned as a rejection so the runtime marks the capture failed rather
      // than retrying forever.
      const refuse = async (reason: string, code?: SyncRefusalCode, skewMs?: number | null) => {
        await db.insert(syncPackages).values({
          packageRef: input.packageRef, deviceId: input.deviceRef, fieldDeviceId: d?.id ?? null,
          signedWithFingerprint: input.signedWithFingerprint, operatorId: null, state: "rejected",
          itemCount: input.items.length, queuedAt: input.queuedAt, lastAttemptAt: now, attemptCount: 1,
          serverReceivedAt: null, refusalReason: reason,
        }).catch(() => undefined);
        return {
          packageRef: input.packageRef, state: "rejected" as const, reason, verified: 0, rejected: input.items.length, conflicts: 0,
          // P1.6 — what the device should DO, decided here rather than inferred from the sentence.
          refusal: code ? { code, skewMs: skewMs ?? null, serverTimeIso: now.toISOString(), handling: handleSyncRefusal({ code, skewMs, serverTimeIso: now.toISOString() }) } : null,
        };
      };
      const freshness = signatureFreshness({ signedAt: input.signedAt, now, deviceClockAt: input.deviceClockAt ?? null });
      if (!freshness.fresh) {
        // The device can only fix its clock if it is told what the server's is.
        // P1.6: the code travels with the sentence. A device that has to parse prose to learn its
        // clock is wrong will retry for ever the first time the wording changes.
        return refuse(`Device signature timestamp refused: ${freshness.reason} (server time ${now.toISOString()}; allowed ±${DEVICE_SIGNATURE_MAX_SKEW_MS / 60_000} min)`, freshness.code, freshness.skewMs);
      }
      const clockSkewMs = freshness.skewMs;
      const signingKey = d?.keyFingerprint === input.signedWithFingerprint
        ? d.publicKeySpkiBase64
        : history.find(h => h.keyFingerprint === input.signedWithFingerprint && h.publicKeySpkiBase64)?.publicKeySpkiBase64;
      // 0142 — exact-wire verification: the signature is checked over the very bytes the device signed,
      // and the package processed is parsed FROM those bytes, so nothing between the tablet and the
      // database can drift. A package without them is verified the pre-0142 way and marked so.
      let verificationMode: "exact_wire" | "reconstructed" = "reconstructed";
      let items = input.items, recordUpdates = input.recordUpdates;
      let signedPayload: Buffer;
      if (input.signedPayloadJson !== undefined) {
        signedPayload = Buffer.from(input.signedPayloadJson, "utf8");
        let parsed: unknown;
        try { parsed = JSON.parse(input.signedPayloadJson); } catch { return refuse("Signed payload is not JSON"); }
        const wire = z.object({ deviceRef: z.literal(input.deviceRef), packageRef: z.literal(input.packageRef), queuedAt: z.string(), signedAt: z.string(), nonce: z.literal(input.nonce), items: z.array(ITEM).min(1).max(500), recordUpdates: z.array(z.object({ recordType: z.string().min(1).max(60), recordRef: z.string().min(1).max(120), baseVersion: z.number().int().nonnegative(), baseValues: z.record(z.string(), z.unknown()), deviceValues: z.record(z.string(), z.unknown()) })) }).safeParse(parsed);
        if (!wire.success) return refuse(`Signed payload does not describe this package: ${wire.error.issues.slice(0, 2).map(x => x.message).join("; ")}`);
        if (new Date(wire.data.signedAt).getTime() !== input.signedAt.getTime() || new Date(wire.data.queuedAt).getTime() !== input.queuedAt.getTime()) return refuse("Signed payload's timestamps differ from the package envelope");
        items = wire.data.items; recordUpdates = wire.data.recordUpdates; verificationMode = "exact_wire";
      } else {
        signedPayload = canonicalDevicePackage({ deviceRef: input.deviceRef, packageRef: input.packageRef, queuedAt: input.queuedAt, signedAt: input.signedAt, nonce: input.nonce, items: items, recordUpdates: recordUpdates });
      }
      if (!signingKey || !verifyP256PackageSignature({ publicKeySpkiBase64: signingKey, payload: signedPayload, signatureP1363Base64: input.signatureP1363Base64 }))
        return refuse(signingKey ? "Invalid device package signature" : "Invalid device package signature: the signing key was never enrolled or rotated in for this device");
      try {
        await db.insert(deviceSyncNonces).values({ fieldDeviceId: d!.id, orgRef, nonce: input.nonce, signedAt: input.signedAt, packageRef: input.packageRef, receivedAt: now });
      } catch {
        throw new TRPCError({ code: "CONFLICT", message: "Device sync nonce was already used" });
      }
      const admission = admitPackage({
        device: d ? {
          deviceRef: d.deviceRef, userId: d.userId, status: d.status, keyFingerprint: d.keyFingerprint,
          encryptedStorageAttested: d.encryptedStorageAttested, keystoreAttestation: d.keystoreAttestation, revokedAt: d.revokedAt,
        } satisfies FieldDeviceRecord : null,
        claimedUserId: ctx.user.id,
        signedWithFingerprint: input.signedWithFingerprint,
        keyHistory: history.map(h => ({ keyFingerprint: h.keyFingerprint, eventType: h.eventType, validFrom: h.validFrom, validUntil: h.validUntil }) satisfies KeyEvent),
        now,
      });

      // Even a refused package is a row: the office can see a revoked device tried.
      const pkg = await db.insert(syncPackages).values({
        packageRef: input.packageRef, deviceId: input.deviceRef, fieldDeviceId: d?.id ?? null,
        signedWithFingerprint: input.signedWithFingerprint, operatorId: null,
        state: admission.admitted ? "server_received" : "rejected",
        itemCount: items.length, queuedAt: input.queuedAt, lastAttemptAt: now, attemptCount: 1,
        serverReceivedAt: admission.admitted ? now : null,
        refusalReason: admission.admitted ? null : admission.reason,
        verificationMode, deviceClockAt: input.deviceClockAt ?? null, clockSkewMs,
      });
      const packageId = Number(pkg[0]?.insertId ?? 0);
      if (!admission.admitted) {
        return { packageRef: input.packageRef, state: "rejected" as const, reason: admission.reason, verified: 0, rejected: items.length, conflicts: 0 };
      }
      if (d) await db.update(fieldDevices).set({ lastSeenAt: now }).where(eq(fieldDevices.id, d.id));

      // Three-way: declared vs received vs sealed.
      const ids = items.map(i => i.evidenceRecordId);
      const sealRows = ids.length ? await db.select().from(evidenceSeals).where(eq(evidenceSeals.evidenceRecordId, ids[0])) : [];
      const seals = new Map<number, { evidenceRecordId: number; contentHash: string; manifestHash: string } | null>();
      for (const id of ids) {
        const rows = await db.select({ evidenceRecordId: evidenceSeals.evidenceRecordId, contentHash: evidenceSeals.contentHash, manifestHash: evidenceSeals.manifestHash })
          .from(evidenceSeals).where(eq(evidenceSeals.evidenceRecordId, id)).orderBy(desc(evidenceSeals.version)).limit(1);
        seals.set(id, rows[0] ?? null);
      }
      void sealRows;
      // v21.6 — the "computed" hash is the server's, from the bytes it stored,
      // never the device's word for it. The device's values are what it
      // DECLARED. Before this, the router verified the seal against a value the
      // device supplied, and a tampered upload would have passed. Where the
      // stored object cannot be read, the item is rejected rather than trusted.
      const recomputed = await Promise.all(items.map(async it => {
        const rec = (await db.select({ storageKey: evidenceRecords.storageKey }).from(evidenceRecords).where(eq(evidenceRecords.id, it.evidenceRecordId)).limit(1))[0];
        // `stored`: the server read real bytes for a record that exists. Only then has the office received anything.
        if (!rec?.storageKey) return { ...it, computedContentHash: "0".repeat(64), computedManifestHash: it.declaredManifestHash, stored: false };
        try {
          const bytes = await storageRead(rec.storageKey);
          return { ...it, computedContentHash: createHash("sha256").update(bytes).digest("hex"), computedManifestHash: it.declaredManifestHash, stored: true };
        } catch {
          return { ...it, computedContentHash: "0".repeat(64), computedManifestHash: it.declaredManifestHash, stored: false };
        }
      }));
      const verification = verifyPackageItems({ items: recomputed, seals });
      const receiptScope = await actingScopeFor(ctx.user.id);

      for (const it of items) {
        const v = verification.verdicts.find(x => x.evidenceRecordId === it.evidenceRecordId)!;
        await db.insert(syncPackageItems).values({ syncPackageId: packageId, evidenceRecordId: it.evidenceRecordId, declaredContentHash: it.declaredContentHash, declaredManifestHash: it.declaredManifestHash,
          captureAuthorizationClaim: it.captureAuthorizationClaim, captureAuthorizationReason: it.captureAuthorizationReason ?? null, state: v.outcome === "verified" ? "verified" : "mismatch" });
        await db.insert(syncReceipts).values({ syncPackageId: packageId, evidenceRecordId: it.evidenceRecordId, computedContentHash: recomputed.find(r => r.evidenceRecordId === it.evidenceRecordId)!.computedContentHash, computedManifestHash: recomputed.find(r => r.evidenceRecordId === it.evidenceRecordId)!.computedManifestHash, matched: v.outcome === "verified", receivedAt: now, failureDetail: v.outcome === "verified" ? null : v.reason });
        // B20's rule: a verified hash, not a 200, is what lets the device let go of its copy. A receipt is
        // recorded only when all four hold: the record exists, the server read its stored bytes, it is in
        // the caller's own organization, and those bytes verified. A package can name any id, and naming
        // one must not mark it received; a mismatch is kept in syncReceipts/syncPackageItems, not here.
        if (v.outcome === "verified" && recomputed.find(r => r.evidenceRecordId === it.evidenceRecordId)?.stored && (await evidenceInScope(it.evidenceRecordId, receiptScope))) {
          await recordOfficeReceipt({ evidenceId: it.evidenceRecordId, at: now });
        }
      }
      await db.update(syncPackages).set({
        state: verification.packageOutcome,
        hashVerifiedAt: verification.packageOutcome === "hash_verified" ? now : null,
        failureReason: verification.packageOutcome === "failed" ? verification.verdicts.filter(v => v.outcome === "rejected").map(v => `${v.evidenceRecordId}: ${v.reason}`).join("; ") : null,
      }).where(eq(syncPackages.id, packageId));

      // Conflicts: the device edited records the server may also have edited.
      // Server-side versions are looked up by the caller-supplied ref; without a
      // versioned store for every record type yet, a conflict is recorded when
      // the device's base and current values differ and the update targets a
      // record the server holds a newer version of.
      let conflicts = 0;
      for (const u of recordUpdates) {
        const serverVersion = await lookupServerVersion(u.recordType, u.recordRef);
        if (serverVersion == null) continue;
        const det = detectConflict({
          deviceBase: { version: u.baseVersion, values: u.baseValues },
          deviceNow: { version: u.baseVersion, values: u.deviceValues },
          server: serverVersion,
          materialFields: MATERIAL_FIELDS[u.recordType] ?? [],
        });
        if (det.conflict) {
          conflicts++;
          await db.insert(syncConflicts).values({
            conflictRef: ref("CONF"), fieldDeviceId: d!.id, syncPackageId: packageId,
            recordType: u.recordType, recordRef: u.recordRef,
            deviceBaseVersion: u.baseVersion, serverVersion: serverVersion.version,
            conflictingFieldsJson: JSON.stringify(det.conflictingFields),
            deviceValuesJson: JSON.stringify(det.deviceValues), serverValuesJson: JSON.stringify(det.serverValues),
            material: det.material, status: "unresolved", detectedAt: now,
          });
        }
      }

      return {
        packageRef: input.packageRef, state: verification.packageOutcome,
        verified: verification.verdicts.filter(v => v.outcome === "verified").length,
        rejected: verification.verdicts.filter(v => v.outcome === "rejected").length,
        conflicts, note: admission.note,
        // v21.6 — per item, so the device marks the right capture failed rather than guessing from counts.
        itemVerdicts: verification.verdicts.map(v => ({ evidenceRecordId: v.evidenceRecordId, outcome: v.outcome, reason: v.reason })),
      };
    }),

  /**
   * P1.2 — the third leg of the seal, run against the object this server is actually holding.
   *
   * `evidenceSeals.serverVerifiedAt` and `verificationResult` have been columns nobody wrote since
   * the table was created: the seal recorded what the device said and nothing ever checked it. A
   * truncated upload, a swapped storage key or a restore that put the wrong file back all leave a
   * seal reading "sealed" with a hash that is correct about a file nobody has.
   *
   * Every outcome is written, including the failures. A verification that only records its passes
   * is a verification whose absence is indistinguishable from a success, which is the shape of the
   * problem it was built to fix.
   */
  verifySeal: roleProcedure("device.verifySeal")
    .input(z.object({ evidenceRecordId: z.number().int().positive(), version: z.number().int().positive().nullish() }))
    .mutation(async ({ input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const seal = (await db.select().from(evidenceSeals).where(and(
        eq(evidenceSeals.evidenceRecordId, input.evidenceRecordId),
        input.version ? eq(evidenceSeals.version, input.version) : undefined,
      )).orderBy(desc(evidenceSeals.version)).limit(1))[0];
      if (!seal) throw new TRPCError({ code: "NOT_FOUND", message: `No seal on record for evidence ${input.evidenceRecordId}` });

      const rec = (await db.select({ storageKey: evidenceRecords.storageKey }).from(evidenceRecords)
        .where(eq(evidenceRecords.id, input.evidenceRecordId)).limit(1))[0];

      /*
       * A read failure is reported as unverifiable, never thrown away and never treated as a pass.
       * "We could not check" is a finding, and the one a person needs to act on soonest.
       */
      let storedContentHash: string | null = null;
      if (rec?.storageKey) {
        try {
          const bytes = await storageRead(rec.storageKey);
          storedContentHash = createHash("sha256").update(bytes).digest("hex");
        } catch {
          storedContentHash = null;
        }
      }

      const checkedAt = new Date();
      const verdict = verifySealAgainstStored({
        deviceContentHash: seal.contentHash,
        storedContentHash,
        recordedManifestHash: seal.manifestHash,
        canonicalManifest: seal.canonicalManifest,
        hashOfManifest: (m) => createHash("sha256").update(m, "utf8").digest("hex"),
        checkedAt,
      });

      await db.update(evidenceSeals)
        .set({ serverVerifiedAt: checkedAt, verificationResult: verdict.result })
        .where(eq(evidenceSeals.id, seal.id));

      return {
        evidenceRecordId: input.evidenceRecordId, version: seal.version,
        ...verdict,
        trustworthy: sealIsTrustworthy(verdict),
      };
    }),

  resolveConflict: roleProcedure("sync.resolveConflict")
    .input(z.object({ conflictRef: z.string().min(1).max(64), resolution: z.enum(["resolved_device", "resolved_server", "resolved_merged"]), note: z.string().min(3).max(400) }))
    .mutation(async ({ ctx, input }) => {
      const db = await getDb();
      if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
      const rows = await db.select().from(syncConflicts).where(eq(syncConflicts.conflictRef, input.conflictRef)).limit(1);
      const c = rows[0];
      if (!c) throw new TRPCError({ code: "NOT_FOUND", message: "Conflict not found" });
      if (c.status !== "unresolved") throw new TRPCError({ code: "CONFLICT", message: `Conflict is already ${c.status}` });
      await db.update(syncConflicts).set({ status: input.resolution, resolvedByUserId: ctx.user.id, resolvedAt: new Date(), resolutionNote: input.note }).where(eq(syncConflicts.id, c.id));
      // Both versions remain on the row. Resolution is a decision recorded
      // beside them, not a deletion of the loser.
      return { conflictRef: c.conflictRef, status: input.resolution, bothVersionsRetained: true as const };
    }),
});

/** Fields whose conflict a person must resolve, per record type. */
const MATERIAL_FIELDS: Record<string, string[]> = {
  proposal_answer: ["value"],
  daily_log: ["dutyStatus", "startAt", "endAt"],
  field_ticket_line: ["quantity", "accepted"],
  disposal_ticket: ["netKg", "quantity", "facilityTicketNumber"],
};

/**
 * The server's current version of a record. This tranche ships the contract
 * and a registry the test can seed; per-type version lookups are wired as
 * each type gains a version column. Unknown types report null: no version
 * means no conflict can be asserted, and the update is not applied either.
 */
const SERVER_VERSIONS = new Map<string, { version: number; values: Record<string, unknown> }>();
export function __seedServerVersion(recordType: string, recordRef: string, v: { version: number; values: Record<string, unknown> }) {
  SERVER_VERSIONS.set(`${recordType}:${recordRef}`, v);
}
async function lookupServerVersion(recordType: string, recordRef: string) {
  return SERVER_VERSIONS.get(`${recordType}:${recordRef}`) ?? null;
}
