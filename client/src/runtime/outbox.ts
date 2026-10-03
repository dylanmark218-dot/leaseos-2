/**
 * The durable outbox.
 *
 * A capture is saved the moment it exists and moves through the six states
 * the UI shows. Nothing is deleted by the outbox: a failed item is retained
 * with its reason, a conflict is retained with both versions, and only a
 * synchronized item is ever eligible for eviction under storage pressure —
 * the same rule the server's storage plan applies.
 */

import { isDirectCapture, type CaptureAuthorizationClaim, type CaptureKind, type GpsFix, type LocalCapture, type LocalStore, type FileVault, type Clock, type Connectivity } from "./contracts";
import { FIELD_OPERATIONS, decideFieldOperation, type FieldOperation } from "../../../shared/offlinePolicy";

/**
 * SPINE item 3 — every capture kind has a row in the shared offline policy. A kind added to
 * `contracts.ts` without one fails to compile here, rather than being refused at the outbox.
 */
void (FIELD_OPERATIONS satisfies Record<CaptureKind, FieldOperation>);

/** The offline policy would not queue this. The draft stays on the device, saved_locally. */
export class FieldOperationRefused extends Error {
  constructor(readonly localId: string, readonly kind: string, note: string) { super(note); this.name = "FieldOperationRefused"; }
}

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

export class Outbox {
  /**
   * `connectivity` feeds the offline policy. Without one the outbox assumes it is offline — the
   * stricter answer — because an outbox that cannot tell must not behave as though a server is there.
   */
  constructor(private store: LocalStore, private vault: FileVault, private clock: Clock, private connectivity?: Connectivity) {}

  /** Save a draft locally. It is on the device and nowhere else. */
  async saveDraft(args: { kind: CaptureKind; formKey: string | null; title: string; category: string; fields: Record<string, unknown>; files?: { bytes: Uint8Array; fileName: string; mimeType: string }[]; gps?: GpsFix | null; jobId?: number | null; unitId?: number | null; capturedAt?: Date; captureAuthorizationClaim?: CaptureAuthorizationClaim; captureAuthorizationReason?: string | null }): Promise<LocalCapture> {
    const now = this.clock.now().toISOString();
    const files: LocalCapture["files"] = [];
    for (const f of args.files ?? []) {
      const stored = await this.vault.put(f.bytes, f.mimeType);
      files.push({ vaultRef: stored.vaultRef, fileName: f.fileName, mimeType: f.mimeType, bytes: stored.bytes, contentHash: stored.contentHash });
    }
    const c: LocalCapture = {
      localId: uid(), kind: args.kind, formKey: args.formKey, title: args.title, category: args.category, fields: args.fields, files,
      capturedAt: (args.capturedAt ?? this.clock.now()).toISOString(), gps: args.gps ?? null, jobId: args.jobId ?? null, unitId: args.unitId ?? null,
      captureAuthorizationClaim: args.captureAuthorizationClaim ?? "unknown", captureAuthorizationReason: args.captureAuthorizationReason ?? null,
      syncState: "saved_locally", attempts: 0, lastError: null, serverEvidenceId: null, sealed: false, sealManifestHash: null, packagedIn: null, createdAt: now, updatedAt: now,
    };
    await this.store.putCapture(c);
    return c;
  }

  /** The worker is done with it: queue it. A queued capture is complete and waits for a connection. */
  async queue(localId: string): Promise<LocalCapture> {
    const c = await this.must(localId);
    if (c.syncState !== "saved_locally" && c.syncState !== "failed") throw new Error(`Capture ${localId} is ${c.syncState}; only a draft or a failed capture can be queued`);
    // SPINE item 3: the shared offline policy decides whether this kind may run or queue now. The
    // key is the capture's kind — never a class or flag in its fields — and an unknown kind is
    // refused online or off. This is the device keeping itself correct offline; the server runs
    // the same policy again on arrival, because this check is not authority.
    const decision = decideFieldOperation(c.kind, { online: this.connectivity ? await this.connectivity.online() : false });
    if (decision.outcome === "refused" || decision.outcome === "unavailable") throw new FieldOperationRefused(localId, c.kind, decision.note);
    // The vault refuses to seal a record that relates to nothing. Better the
    // worker hears it now — "which job or unit is this for?" — than the sync
    // engine hears it hours later.
    //
    // 0205/0206 — a direct capture is never sealed; it relates to a channel, a
    // message or a post instead, and must name one. Relating to nothing is
    // refused the same way.
    if (isDirectCapture(c.kind)) {
      const f = c.fields as { channelRef?: unknown; messageRef?: unknown; postRef?: unknown };
      if (!f.channelRef && !f.messageRef && !f.postRef) throw new Error(`Capture ${localId} relates to no channel, message or post — name one before queuing`);
    } else if (c.jobId == null && c.unitId == null) {
      throw new Error(`Capture ${localId} relates to no job or unit — it cannot be sealed on the server; attach it to one before queuing`);
    }
    return this.transition(c, "queued", { lastError: null });
  }

  /**
   * 0205/0206 — the send did not reach a server that answered: back to queued, attempt counted,
   * reason kept. Not `failed`: failed means the server refused it, and a dropped connection is
   * not a refusal. The retry carries the same mutation id, so it cannot become a second record.
   */
  async requeue(localId: string, reason: string) {
    const c = await this.must(localId);
    if (c.syncState !== "syncing") throw new Error(`Capture ${localId} is ${c.syncState}; only a capture being sent goes back to the queue`);
    return this.transition(c, "queued", { lastError: reason });
  }

  /** 0205/0206 — the server's reference for a direct capture, kept once it answered. */
  async setServerRef(localId: string, serverRef: string) {
    const c = await this.must(localId);
    c.fields = { ...c.fields, serverRef };
    c.updatedAt = this.clock.now().toISOString();
    await this.store.putCapture(c);
    return c;
  }

  async markSyncing(localId: string, packageRef: string) { return this.transition(await this.must(localId), "syncing", { packagedIn: packageRef, attempts: (await this.must(localId)).attempts + 1 }); }
  async markSynchronized(localId: string) { return this.transition(await this.must(localId), "synchronized", { lastError: null }); }
  async markFailed(localId: string, reason: string) { return this.transition(await this.must(localId), "failed", { lastError: reason }); }
  async markConflict(localId: string, reason: string) { return this.transition(await this.must(localId), "conflict", { lastError: reason }); }
  async setServerEvidenceId(localId: string, id: number) { const c = await this.must(localId); c.serverEvidenceId = id; c.updatedAt = this.clock.now().toISOString(); await this.store.putCapture(c); return c; }
  async setSealed(localId: string, manifestHash: string | null) { const c = await this.must(localId); c.sealed = true; c.sealManifestHash = manifestHash ?? c.sealManifestHash; c.updatedAt = this.clock.now().toISOString(); await this.store.putCapture(c); return c; }

  /**
   * What the UI shows: counts by state, and how long ago the oldest evidence
   * that has not reached the server was CAPTURED — the figure the office asks
   * for is "how old is the evidence we have not got", not "when was it queued".
   */
  async status(): Promise<{ counts: Record<LocalCapture["syncState"], number>; oldestUnsyncedCaptureMinutes: number | null }> {
    const all = await this.store.listCaptures();
    const counts: Record<LocalCapture["syncState"], number> = { saved_locally: 0, queued: 0, syncing: 0, synchronized: 0, failed: 0, conflict: 0 };
    let oldest: number | null = null;
    for (const c of all) {
      counts[c.syncState]++;
      if (c.syncState !== "synchronized") { const age = (this.clock.now().getTime() - new Date(c.capturedAt).getTime()) / 60_000; oldest = oldest == null ? age : Math.max(oldest, age); }
    }
    return { counts, oldestUnsyncedCaptureMinutes: oldest == null ? null : Math.round(oldest) };
  }

  /**
   * Storage pressure: only synchronized captures may be evicted, oldest first,
   * and only their files — the record of what was captured stays. Nothing the
   * office has not accepted is ever deleted by the device.
   */
  async evictSynchronizedFiles(targetBytes: number): Promise<{ evicted: number; freedBytes: number; refusedBecauseUnsynced: number }> {
    const used = await this.vault.usageBytes();
    if (used <= targetBytes) return { evicted: 0, freedBytes: 0, refusedBecauseUnsynced: 0 };
    const all = (await this.store.listCaptures()).sort((a, b) => new Date(a.updatedAt).getTime() - new Date(b.updatedAt).getTime());
    let freed = 0, evicted = 0, refused = 0;
    for (const c of all) {
      if (used - freed <= targetBytes) break;
      if (c.syncState !== "synchronized") { if (c.files.length) refused++; continue; }
      for (const f of c.files) { await this.vault.delete(f.vaultRef); freed += f.bytes; }
      if (c.files.length) { evicted++; c.files = c.files.map(f => ({ ...f, vaultRef: "" })); await this.store.putCapture(c); }
    }
    return { evicted, freedBytes: freed, refusedBecauseUnsynced: refused };
  }

  private async must(localId: string): Promise<LocalCapture> {
    const c = await this.store.getCapture(localId);
    if (!c) throw new Error(`No capture ${localId}`);
    return c;
  }
  private async transition(c: LocalCapture, to: LocalCapture["syncState"], patch: Partial<LocalCapture>): Promise<LocalCapture> {
    const next = { ...c, ...patch, syncState: to, updatedAt: this.clock.now().toISOString() };
    await this.store.putCapture(next);
    return next;
  }
}
