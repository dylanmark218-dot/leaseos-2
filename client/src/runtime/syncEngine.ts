/**
 * The sync engine — the device's half of the v20.20 protocol.
 *
 * For each queued capture, in order: upload the bytes (idempotent by the
 * device's reference — a retry returns the same id), seal (a retry that finds
 * it already sealed is a success), then send a signed package whose items
 * declare the hashes the device computed. The server recomputes and verifies
 * against the seal; the receipt decides each item's state.
 *
 * A revoked device is told so once and stops trying — its captures are
 * retained as failed with the reason, for recapture on an enrolled device.
 * Key rotation happens here too, before the push, when the key is old.
 */

import { ATTEST_ENVELOPE_FORMAT, ATTEST_SESSION_FORMAT, attestRefusalIsSettled, type AttestEnvelope, type OfflineAttestMark } from "@shared/attest";
import { isDirectCapture, type CaptureKind, type Clock, type Connectivity, type FileVault, type Keystore, type LocalAttestSession, type LocalCapture, type LocalStore, type Transport } from "./contracts";
import { canonicalJson, sha256Hex, sha256HexOfString, toBase64 } from "./crypto";
import { Outbox } from "./outbox";

export const KEY_ROTATION_DAYS = 30;
export const MAX_ITEMS_PER_PACKAGE = 500;
/**
 * Safety and legal-state evidence outruns bulk media. Age orders records only
 * inside a tier, so 500 old photos can never starve a newly queued HOS event.
 */
export function captureSyncPriority(kind: CaptureKind): number {
  switch (kind) {
    // A prohibition binds before the server hears about it, and it must reach
    // the server first when signal returns. Nothing outranks an out-of-service
    // order — not photographs, and not an HOS event.
    case "roadside_enforcement":
    case "oos_order":
    case "hos_event":
    case "incident":
    case "defect_report":
      return 0;
    case "pretrip":
    case "posttrip":
    case "tdg_document":
    case "job_accept":
    case "tailgate":
    case "signature":
      return 10;
    case "load_ticket":
    case "disposal_ticket":
    case "fuel_receipt":
    case "expense_receipt":
    case "voice_note":
    // An unclassified scan rides with the tickets rather than with the photos:
    // nobody has established what it is, and a disposal ticket nobody has
    // classified is still a disposal ticket.
    case "scanned_document":
      return 20;
    case "photo":
      return 40;
    // 0205/0206 — never packaged (see DIRECT_CAPTURE_KINDS); ranked only so the switch is total.
    // Their own sender orders them: acknowledgements first.
    case "board_acknowledgement":
    case "board_message":
    case "shift_response":
      return 10;
  }
}

export function prioritizeQueuedCaptures(captures: readonly LocalCapture[]): LocalCapture[] {
  return [...captures].sort((a, b) =>
    captureSyncPriority(a.kind) - captureSyncPriority(b.kind)
    || a.capturedAt.localeCompare(b.capturedAt)
    || a.localId.localeCompare(b.localId)
  );
}


/** SA2 — what happened to the signing sessions waiting on the device: sent, settled, refused, or still waiting for their marks. */
export type AttestSessionSyncOutcome = { sent: number; accepted: number; rejected: number; waiting: number };

export type SyncOutcome = {
  attempted: boolean;
  reason: string;
  packageRef: string | null;
  synchronized: number;
  failed: number;
  conflicts: number;
  deviceStatus: "active" | "revoked" | "unknown";
  rotatedKey: boolean;
  sessions: AttestSessionSyncOutcome;
};

const NO_SESSIONS: AttestSessionSyncOutcome = { sent: 0, accepted: 0, rejected: 0, waiting: 0 };

export class SyncEngine {
  private outbox: Outbox;
  constructor(private deps: { store: LocalStore; vault: FileVault; keystore: Keystore; transport: Transport; connectivity: Connectivity; clock: Clock; platform: "android" | "ios" | "web" }) {
    this.outbox = new Outbox(deps.store, deps.vault, deps.clock);
  }

  /** Enroll once; the server assigns the device reference and the office activates it. */
  async enroll(displayName?: string): Promise<{ deviceRef: string; status: string }> {
    const existing = await this.deps.store.getMeta("deviceRef");
    if (existing) return { deviceRef: existing, status: (await this.deps.store.getMeta("deviceStatus")) ?? "enrolled" };
    const r = await this.deps.transport.enroll({ platform: this.deps.platform, publicKeySpkiBase64: await this.deps.keystore.publicKeySpkiBase64(), keystoreAttestation: await this.deps.keystore.attestation(), displayName });
    await this.deps.store.setMeta("deviceRef", r.deviceRef);
    await this.deps.store.setMeta("deviceStatus", r.status);
    return r;
  }

  /** Activation is the device's own second step — the worker completes enrolment from the tablet. */
  async activate(): Promise<{ status: string }> {
    const deviceRef = await this.deps.store.getMeta("deviceRef");
    if (!deviceRef) throw new Error("Enroll before activating");
    const r = await this.deps.transport.activate({ deviceRef });
    await this.deps.store.setMeta("deviceStatus", r.status);
    return r;
  }

  /** The manifest the device signs for a capture: what it is, when, where, and its files' hashes. */
  static manifestOf(c: LocalCapture): string {
    return canonicalJson({ kind: c.kind, formKey: c.formKey, title: c.title, category: c.category, fields: c.fields, capturedAt: c.capturedAt, gps: c.gps, jobId: c.jobId, unitId: c.unitId, files: c.files.map(f => ({ fileName: f.fileName, mimeType: f.mimeType, bytes: f.bytes, contentHash: f.contentHash })) });
  }

  /**
   * One pass: the queued captures as a signed package, then (SA2) every signing session whose mark
   * files are now on the server, as its own signed envelope. A session is never sent ahead of its
   * marks: the server verifies the strokes it holds, so it must hold them first (§6.2 step 4).
   */
  async syncOnce(): Promise<SyncOutcome> {
    const captures = await this.syncCaptures();
    if (!captures.attempted && (captures.deviceStatus === "revoked" || /^Offline|not enrolled/.test(captures.reason))) return { ...captures, sessions: NO_SESSIONS };
    const deviceRef = await this.deps.store.getMeta("deviceRef");
    if (!deviceRef) return { ...captures, sessions: NO_SESSIONS };
    const sessions = await this.pushAttestSessions(deviceRef);
    const attempted = captures.attempted || sessions.sent > 0;
    const reason = captures.attempted ? captures.reason : sessions.sent > 0 ? `Sent ${sessions.sent} signing session(s)` : sessions.waiting > 0 ? `${sessions.waiting} signing session(s) waiting for their marks to synchronize` : captures.reason;
    return { ...captures, attempted, reason, sessions };
  }

  /**
   * SA2 — the session envelope (§6.2–6.3). Built from the session the device key signed at completion
   * plus the evidence ids its marks received when they synchronized; signed again by the current key
   * at send time with a fresh nonce; sent as exact bytes. The answer is a code: settled sessions
   * (accepted, already recorded, replayed) become synchronized; anything else is retained as failed
   * with the office's reason, because retrying cannot change a superseded document.
   */
  async pushAttestSessions(deviceRef: string): Promise<AttestSessionSyncOutcome> {
    const out: AttestSessionSyncOutcome = { sent: 0, accepted: 0, rejected: 0, waiting: 0 };
    const put = async (s: LocalAttestSession, patch: Partial<LocalAttestSession>) => { await this.deps.store.putAttestSession({ ...s, ...patch, updatedAt: this.deps.clock.now().toISOString() }); };
    for (const s of await this.deps.store.listAttestSessions({ state: "queued" })) {
      if (!s.deviceSignature || !s.completedAt) continue;   // not completed: nothing to send
      const marks: OfflineAttestMark[] = [];
      let ready = true;
      for (const m of s.marks) {
        const ids: (number | null)[] = [];
        for (const capId of [m.strokeCaptureId, m.renderCaptureId]) {
          if (!capId) { ids.push(null); continue; }
          const c = await this.deps.store.getCapture(capId);
          if (!c || c.syncState !== "synchronized" || c.serverEvidenceId == null) { ready = false; break; }
          ids.push(c.serverEvidenceId);
        }
        if (!ready) break;
        marks.push({
          fieldKey: m.fieldKey, markKind: m.markKind, inputKind: m.inputKind, valueText: m.valueText,
          strokeEvidenceRecordId: ids[0] ?? null, strokeHash: m.strokeHash, renderedEvidenceRecordId: ids[1] ?? null, renderedHash: m.renderedHash,
          canvas: m.canvas, pointCount: m.pointCount, strokeCount: m.strokeCount, durationMs: m.durationMs, pressureAvailable: m.pressureAvailable,
        });
      }
      if (!ready) { out.waiting++; continue; }
      const nowIso = this.deps.clock.now().toISOString();
      const nonce = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(24))).map(b => b.toString(16).padStart(2, "0")).join("");
      const envelope: AttestEnvelope = {
        format: ATTEST_ENVELOPE_FORMAT, deviceRef, nonce, signedAt: nowIso, deviceClockAt: nowIso,
        session: {
          format: ATTEST_SESSION_FORMAT, sessionRef: s.sessionRef, revisionRef: s.revisionRef, revisionHashAtStart: s.revisionHashAtStart, signerRef: s.signerRef,
          authMethod: s.authMethod, consentVersion: s.consentVersion, marks, startedAt: s.startedAt, completedAt: s.completedAt, gps: s.gps, capturedOffline: true, deviceSignature: s.deviceSignature,
        },
      };
      const signedPayloadJson = canonicalJson(envelope);
      const signatureP1363Base64 = await this.deps.keystore.signP1363(new TextEncoder().encode(signedPayloadJson));
      await put(s, { state: "syncing", attempts: s.attempts + 1 });
      let r: Awaited<ReturnType<Transport["submitAttestSession"]>>;
      try {
        r = await this.deps.transport.submitAttestSession({ deviceRef, signedWithFingerprint: await this.deps.keystore.fingerprint(), signatureP1363Base64, signedPayloadJson });
      } catch (e) {
        // A dropped connection is not a refusal: back to queued, reason kept, same session next time.
        await put(s, { state: "queued", attempts: s.attempts + 1, lastError: e instanceof Error ? e.message : String(e) });
        continue;
      }
      out.sent++;
      if (r.state !== "rejected") { out.accepted++; await put(s, { state: "synchronized", attempts: s.attempts + 1, lastError: null, lastCode: null, serverResult: r }); continue; }
      if (attestRefusalIsSettled(r.code)) { out.accepted++; await put(s, { state: "synchronized", attempts: s.attempts + 1, lastError: null, lastCode: r.code, serverResult: r }); continue; }
      out.rejected++;
      if (r.handling.action === "stop_and_prompt") {
        // A wrong clock refuses every envelope the same way: hold this session as queued with the
        // instruction, stop sending, and let the person fix the device. Nothing is lost.
        await put(s, { state: "queued", attempts: s.attempts + 1, lastError: r.reason, lastCode: r.code, serverResult: r });
        break;
      }
      if (r.code === "DEVICE_NOT_ACTIVE" || r.code === "DEVICE_NOT_ENROLLED") await this.deps.store.setMeta("deviceStatus", "revoked");
      await put(s, { state: "failed", attempts: s.attempts + 1, lastError: r.reason, lastCode: r.code, serverResult: r });
    }
    return out;
  }

  private async syncCaptures(): Promise<Omit<SyncOutcome, "sessions">> {
    const none = (reason: string, deviceStatus: SyncOutcome["deviceStatus"] = "unknown"): Omit<SyncOutcome, "sessions"> => ({ attempted: false, reason, packageRef: null, synchronized: 0, failed: 0, conflicts: 0, deviceStatus, rotatedKey: false });
    if (!(await this.deps.connectivity.online())) return none("Offline — captures are queued on the device and will sync when a connection returns");
    const deviceRef = await this.deps.store.getMeta("deviceRef");
    if (!deviceRef) return none("Device not enrolled");
    if ((await this.deps.store.getMeta("deviceStatus")) === "revoked") return none("This device was revoked — recapture on an enrolled device", "revoked");

    // 0205/0206 — direct captures (a message, an acknowledgement, a response to open work) go to
    // their own procedure through BoardQueue. Packaging one would upload a conversation as evidence.
    const queued = prioritizeQueuedCaptures((await this.deps.store.listCaptures({ syncState: "queued" })).filter(c => !isDirectCapture(c.kind))).slice(0, MAX_ITEMS_PER_PACKAGE);
    if (queued.length === 0) return none("Nothing to sync", "active");

    // Rotate an old key before pushing with it.
    let rotated = false;
    const keyAge = (this.deps.clock.now().getTime() - new Date(await this.deps.keystore.createdAt()).getTime()) / 86_400_000;
    if (keyAge >= KEY_ROTATION_DAYS) {
      const r = await this.deps.keystore.rotate();
      await this.deps.transport.rotateKey({ deviceRef, newPublicKeySpkiBase64: r.newPublicKeySpkiBase64, reason: `Scheduled rotation at ${Math.floor(keyAge)} days` });
      rotated = true;
    }

    // A package reference is unique by a durable per-device sequence, never by
    // the clock — a device clock can stall, jump, or be set back.
    const seq = Number((await this.deps.store.getMeta("packageSeq")) ?? "0") + 1;
    await this.deps.store.setMeta("packageSeq", String(seq));
    const packageRef = `PKG-${deviceRef}-${seq.toString(36).padStart(6, "0")}`;
    const queuedAt = this.deps.clock.now();
    const items: Parameters<Transport["receivePackage"]>[0]["items"] = [];
    const byEvidenceId = new Map<number, LocalCapture>();
    let failed = 0;

    for (const c of queued) {
      await this.outbox.markSyncing(c.localId, packageRef);
      try {
        // 1. Upload — idempotent by the device's reference.
        let evidenceId = c.serverEvidenceId;
        if (evidenceId == null) {
          const primary = c.files[0] ?? null;
          const bytes = primary ? await this.deps.vault.get(primary.vaultRef) : new TextEncoder().encode(SyncEngine.manifestOf(c));
          const up = await this.deps.transport.uploadEvidence({
            title: c.title, category: c.category, fileName: primary?.fileName ?? `${c.kind}.json`, mimeType: primary?.mimeType ?? "application/json", dataBase64: toBase64(bytes),
            latitude: c.gps?.latitude, longitude: c.gps?.longitude, notes: c.formKey ? `form:${c.formKey}` : undefined, clientCaptureRef: `${deviceRef}:${c.localId}`, capturedAt: new Date(c.capturedAt),
          });
          evidenceId = up.id;
          await this.outbox.setServerEvidenceId(c.localId, evidenceId);
        }
        // 2. Seal with the hash the device computed. Already sealed is success.
        const contentHash = c.files[0]?.contentHash ?? (await sha256HexOfString(SyncEngine.manifestOf(c)));
        let sealManifestHash = c.sealManifestHash;
        if (!c.sealed) {
          const sealed = await this.deps.transport.sealEvidence({ evidenceId, contentHash, recordType: c.kind, relationships: [...(c.jobId ? [{ entityType: "job", entityId: c.jobId, relation: "captured_for" }] : []), ...(c.unitId ? [{ entityType: "unit", entityId: c.unitId, relation: "captured_on" }] : [])], deviceId: deviceRef, devicePlatform: this.deps.platform });
          sealManifestHash = sealed.manifestHash ?? sealManifestHash;
          await this.outbox.setSealed(c.localId, sealManifestHash);
        }
        // 3. The package item: what the device declares — the content hash it sealed with, and the
        //    seal's own manifest hash as the server returned it. The server recomputes the content
        //    hash from the bytes it stored; the device's "computed" value is only its declaration.
        const declaredManifestHash = sealManifestHash ?? (await sha256HexOfString(SyncEngine.manifestOf(c)));
        items.push({
          evidenceRecordId: evidenceId, declaredContentHash: contentHash, declaredManifestHash,
          computedContentHash: contentHash, computedManifestHash: declaredManifestHash,
          captureAuthorizationClaim: c.captureAuthorizationClaim,
          captureAuthorizationReason: c.captureAuthorizationReason,
        });
        byEvidenceId.set(evidenceId, c);
      } catch (e) {
        failed++;
        await this.outbox.markFailed(c.localId, e instanceof Error ? e.message : String(e));
      }
    }

    if (items.length === 0) return { attempted: true, reason: "Every item failed before packaging", packageRef, synchronized: 0, failed, conflicts: 0, deviceStatus: "active", rotatedKey: rotated };

    // 4. Sign the complete canonical package with the non-exportable device key.
    // WebCrypto ECDSA emits IEEE-P1363 r||s; the server verifies that exact format.
    const signedAt = this.deps.clock.now();
    const nonceBytes = globalThis.crypto.getRandomValues(new Uint8Array(24));
    const nonce = Array.from(nonceBytes).map(b => b.toString(16).padStart(2, "0")).join("");
    const recordUpdates: Parameters<Transport["receivePackage"]>[0]["recordUpdates"] = [];
    const payload = canonicalJson({ deviceRef, packageRef, queuedAt: queuedAt.toISOString(), signedAt: signedAt.toISOString(), nonce, items, recordUpdates });
    const signatureP1363Base64 = await this.deps.keystore.signP1363(new TextEncoder().encode(payload));
    let receipt: Awaited<ReturnType<Transport["receivePackage"]>>;
    try {
      receipt = await this.deps.transport.receivePackage({ deviceRef, packageRef, queuedAt, signedWithFingerprint: await this.deps.keystore.fingerprint(), signedAt, nonce, signatureP1363Base64, items, recordUpdates });
    } catch (e) {
      // Upload/seal may have succeeded before the network failed. Return captures
      // to queued so idempotent retry can finish instead of stranding `syncing`.
      for (const c of Array.from(byEvidenceId.values())) {
        const latest = await this.deps.store.getCapture(c.localId);
        if (latest?.syncState === "syncing") await this.deps.store.putCapture({ ...latest, syncState: "queued", lastError: e instanceof Error ? e.message : String(e), updatedAt: this.deps.clock.now().toISOString() });
      }
      throw e;
    }
    await this.deps.store.putPackage({ packageRef, captureIds: Array.from(byEvidenceId.values()).map(c => c.localId), queuedAt: queuedAt.toISOString(), state: receipt.state === "rejected" ? "rejected" : receipt.rejected > 0 ? "partial" : "accepted", receipt, attempts: 1 });

    if (receipt.state === "rejected") {
      const revoked = /revoked|not enrolled|unknown device|suspended/i.test(receipt.reason ?? "");
      if (revoked) await this.deps.store.setMeta("deviceStatus", "revoked");
      for (const c of Array.from(byEvidenceId.values())) await this.outbox.markFailed(c.localId, receipt.reason ?? "Package rejected");
      return { attempted: true, reason: receipt.reason ?? "Package rejected", packageRef, synchronized: 0, failed: failed + byEvidenceId.size, conflicts: 0, deviceStatus: revoked ? "revoked" : "active", rotatedKey: rotated };
    }
    let synchronized = 0;
    const verdicts = new Map((receipt.itemVerdicts ?? []).map(v => [v.evidenceRecordId, v]));
    for (const [id, c] of Array.from(byEvidenceId.entries())) {
      const v = verdicts.get(id);
      if (v && v.outcome === "rejected") { failed++; await this.outbox.markFailed(c.localId, v.reason ?? "Hash mismatch — the server received different bytes than the device sealed"); }
      else if (!v && receipt.rejected > 0 && receipt.verified === 0) { failed++; await this.outbox.markFailed(c.localId, "Package not verified"); }
      else { synchronized++; await this.outbox.markSynchronized(c.localId); }
    }
    return { attempted: true, reason: `Sent ${items.length} item(s)`, packageRef, synchronized, failed, conflicts: receipt.conflicts, deviceStatus: "active", rotatedKey: rotated };
  }
}

export { sha256Hex };
