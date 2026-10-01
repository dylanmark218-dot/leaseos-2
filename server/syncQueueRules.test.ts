/**
 * HS5 — the sync engine follows the contract's queue rules.
 *
 * fieldRuntime.test.ts proves the lost-connection path against the real server.
 * This file proves every other path with a scripted transport, so it runs with
 * no database: a failure is named by `classifySendFailure`, and what the queue
 * does next is `queueDisposition` — never "mark it failed and hope a person
 * re-queues it".
 */
import { describe, expect, it } from "vitest";
import { classifySendFailure, type SessionObservation } from "@shared/clientContract";
import { FlagConnectivity, MemoryKeystore, MemoryStore, MemoryVault, SettableClock } from "../client/src/runtime/adapters/memory";
import { Outbox } from "../client/src/runtime/outbox";
import { SyncEngine } from "../client/src/runtime/syncEngine";
import type { Transport } from "../client/src/runtime/contracts";

/** What a tRPC client error looks like to a shell. */
const trpcError = (code: string, httpStatus: number) => Object.assign(new Error(code), { name: "TRPCClientError", data: { code, httpStatus } });

describe("classifySendFailure", () => {
  it("names tRPC server answers by their code", () => {
    expect(classifySendFailure(trpcError("UNAUTHORIZED", 401))).toBe("unauthenticated");
    expect(classifySendFailure(trpcError("FORBIDDEN", 403))).toBe("forbidden");
    expect(classifySendFailure(trpcError("CONFLICT", 409))).toBe("conflict");
    expect(classifySendFailure(trpcError("TOO_MANY_REQUESTS", 429))).toBe("rate_limited");
    expect(classifySendFailure(trpcError("BAD_REQUEST", 400))).toBe("rejected");
    expect(classifySendFailure(trpcError("INTERNAL_SERVER_ERROR", 500))).toBe("server_unavailable");
  });
  it("names the contract gate's 426 by status when the body is not tRPC's", () => {
    expect(classifySendFailure(Object.assign(new Error("Upgrade Required"), { name: "TRPCClientError", data: null, meta: { response: { status: 426 } } }))).toBe("contract_refused");
    expect(classifySendFailure({ status: 503 })).toBe("server_unavailable");
  });
  it("names a lost connection, however the platform spells it", () => {
    expect(classifySendFailure(new Error("ECONNRESET: connection dropped mid-sync"))).toBe("network");
    expect(classifySendFailure(Object.assign(new Error("socket hang up"), { code: "ETIMEDOUT" }))).toBe("network");
    expect(classifySendFailure(new TypeError("Failed to fetch"))).toBe("network");
    expect(classifySendFailure(Object.assign(new Error("aborted"), { name: "AbortError" }))).toBe("network");
    expect(classifySendFailure(Object.assign(new Error("fetch failed"), { name: "TRPCClientError", data: null, cause: new TypeError("fetch failed") }))).toBe("network");
  });
  it("calls anything it cannot place `local`, which fails visibly rather than retrying forever", () => {
    expect(classifySendFailure(new Error("Encrypted file vault is only available on a device"))).toBe("local");
    expect(classifySendFailure("boom")).toBe("local");
    expect(classifySendFailure(null)).toBe("local");
  });
});

type Script = { upload?: (n: number) => unknown; seal?: (n: number) => unknown; pkg?: (n: number) => unknown };

function rig(script: Script = {}, session?: () => Promise<SessionObservation>) {
  const clock = new SettableClock(new Date("2026-09-24T12:00:00Z"));
  const keystore = new MemoryKeystore(clock);
  const vault = new MemoryVault(keystore);
  const store = new MemoryStore();
  const outbox = new Outbox(store, vault, clock);
  const net = new FlagConnectivity(true);
  const calls = { uploads: 0, seals: 0, packages: 0 };
  const transport: Transport = {
    enroll: async () => ({ deviceRef: "DEV-1", status: "active" }),
    activate: async () => ({ status: "active" }),
    rotateKey: async () => ({ status: "rotated" }),
    uploadEvidence: async () => { calls.uploads++; const e = script.upload?.(calls.uploads); if (e) throw e; return { id: 100 + calls.uploads }; },
    sealEvidence: async () => { calls.seals++; const e = script.seal?.(calls.seals); if (e) throw e; return { ok: true, alreadySealed: false, manifestHash: `m${calls.seals}` }; },
    receivePackage: async i => {
      calls.packages++; const e = script.pkg?.(calls.packages); if (e) throw e;
      return { packageRef: i.packageRef, state: "hash_verified", verified: i.items.length, rejected: 0, conflicts: 0, itemVerdicts: i.items.map(it => ({ evidenceRecordId: it.evidenceRecordId, outcome: "verified" as const })) };
    },
  };
  const engine = new SyncEngine({ store, vault, keystore, transport, connectivity: net, clock, platform: "android", jitter: () => 0, session });
  const queue = async (n: number) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) {
      const c = await outbox.saveDraft({ kind: "load_ticket", formKey: null, title: `T${i}`, category: "ticket", fields: { i }, jobId: 1, capturedAt: new Date(clock.now().getTime() + i * 1000) });
      await outbox.queue(c.localId); ids.push(c.localId);
    }
    return ids;
  };
  return { clock, store, outbox, engine, calls, queue };
}

describe("the sync engine applies the queue rules", () => {
  it("an expired session holds the whole queue — nothing failed, nothing sent — until it is cleared", async () => {
    let expired = true;
    const r = rig({ upload: () => (expired ? trpcError("UNAUTHORIZED", 401) : null) });
    await r.engine.enroll();
    const ids = await r.queue(3);
    const first = await r.engine.syncOnce();
    expect(first).toMatchObject({ attempted: true, next: "reauth", failed: 0, synchronized: 0 });
    expect(r.calls.uploads).toBe(1);
    expect((await r.outbox.status()).counts).toMatchObject({ queued: 3, failed: 0, syncing: 0 });

    // Held: even a forced pass sends nothing until the user has signed in again.
    const held = await r.engine.syncOnce({ force: true });
    expect(held).toMatchObject({ attempted: false, next: "reauth" });
    expect(held.reason).toMatch(/Sign in again/);
    expect(r.calls.uploads).toBe(1);

    expired = false;
    await r.engine.clearHold();
    const after = await r.engine.syncOnce();
    expect(after).toMatchObject({ synchronized: 3, failed: 0, next: null });
    for (const id of ids) expect((await r.store.getCapture(id))!.syncState).toBe("synchronized");
  });

  it("a refused app version holds the queue for an update, and keeps what was already prepared", async () => {
    const r = rig({ seal: n => (n === 2 ? Object.assign(new Error("Upgrade Required"), { status: 426 }) : null) });
    await r.engine.enroll();
    const [a, b] = await r.queue(2);
    const out = await r.engine.syncOnce();
    expect(out).toMatchObject({ next: "upgrade", synchronized: 0, failed: 0 });
    expect(r.calls.packages).toBe(0);                         // a held app sends no package either
    const ca = (await r.store.getCapture(a))!, cb = (await r.store.getCapture(b))!;
    expect([ca.syncState, cb.syncState]).toEqual(["queued", "queued"]);
    expect(ca.serverEvidenceId).toBe(101);                    // prepared work is kept: the retry is idempotent
    expect(ca.sealed).toBe(true);
    expect(await r.engine.hold()).toMatchObject({ hold: "upgrade" });
  });

  it("a lost versioned write is a conflict for a person; the rest of the pass carries on", async () => {
    const r = rig({ upload: n => (n === 1 ? trpcError("CONFLICT", 409) : null) });
    await r.engine.enroll();
    const [a] = await r.queue(3);
    const out = await r.engine.syncOnce();
    expect(out).toMatchObject({ conflicts: 1, synchronized: 2, failed: 0, next: null });
    expect((await r.store.getCapture(a))!.syncState).toBe("conflict");
  });

  it("a real refusal or a device-side error fails that capture only, retained with the reason", async () => {
    const r = rig({ upload: n => (n === 1 ? trpcError("BAD_REQUEST", 400) : n === 2 ? new Error("vault unreadable") : null) });
    await r.engine.enroll();
    const [a, b] = await r.queue(3);
    const out = await r.engine.syncOnce();
    expect(out).toMatchObject({ failed: 2, synchronized: 1, next: null });
    expect((await r.store.getCapture(a))!).toMatchObject({ syncState: "failed", lastError: "BAD_REQUEST" });
    expect((await r.store.getCapture(b))!).toMatchObject({ syncState: "failed", lastError: "vault unreadable" });
    expect((await r.store.listCaptures()).length).toBe(3);    // nothing deleted
  });

  it("a package lost in transit is requeued and backed off, not thrown; a forced pass then sends it once", async () => {
    let down = true;
    const r = rig({ pkg: () => (down ? new TypeError("Failed to fetch") : null) });
    await r.engine.enroll();
    const ids = await r.queue(2);
    const out = await r.engine.syncOnce();
    expect(out).toMatchObject({ attempted: true, next: "retry", synchronized: 0, failed: 0 });
    expect(out.retryAt).toBe(new Date(r.clock.now().getTime() + 1_000).toISOString()); // first step, jitter 0
    for (const id of ids) expect((await r.store.getCapture(id))!).toMatchObject({ syncState: "queued", serverEvidenceId: expect.any(Number), sealed: true });

    // Inside the back-off an automatic pass waits; the connection coming back (force) goes now.
    expect(await r.engine.syncOnce()).toMatchObject({ attempted: false, next: "retry" });
    down = false;
    const again = await r.engine.syncOnce({ force: true });
    expect(again).toMatchObject({ synchronized: 2, next: null, retryAt: null });
    expect(r.calls.uploads).toBe(2);                          // not re-uploaded: the server ids were kept
    expect(r.calls.seals).toBe(2);
  });

  it("backs off further on each consecutive loss, and resets once the server answers", async () => {
    let down = true;
    const r = rig({ upload: () => (down ? new Error("ECONNRESET") : null) });
    await r.engine.enroll();
    await r.queue(1);
    const steps: number[] = [];
    for (let i = 0; i < 3; i++) {
      const o = await r.engine.syncOnce({ force: true });
      steps.push(new Date(o.retryAt!).getTime() - r.clock.now().getTime());
    }
    expect(steps).toEqual([1_000, 2_000, 4_000]);
    down = false;
    expect(await r.engine.syncOnce({ force: true })).toMatchObject({ synchronized: 1, retryAt: null });
    expect(await r.store.getMeta("syncRetryStreak")).toBe("0");
  });
});

describe("the sync engine sends a queue only under the person and company it was captured for", () => {
  const as = (userRef: string, tenantId: string) => ({ state: "confirmed" as const, scope: { userRef, tenantId } });

  function scoped(initial: SessionObservation) {
    let observed: SessionObservation | Error = initial;
    const r = rig({}, async () => { if (observed instanceof Error) throw observed; return observed; });
    return { ...r, set: (o: SessionObservation | Error) => { observed = o; } };
  }

  it("binds the queue to the first confirmed session, and keeps sending under it", async () => {
    const r = scoped(as("7", "acme"));
    await r.engine.enroll();
    await r.queue(1);
    expect(await r.engine.syncOnce()).toMatchObject({ synchronized: 1 });
    expect(await r.engine.boundScope()).toEqual({ userRef: "7", tenantId: "acme" });
    await r.queue(1);
    expect(await r.engine.syncOnce()).toMatchObject({ synchronized: 1 });
  });

  it("never sends one person's or company's queue under another sign-in", async () => {
    const r = scoped(as("7", "acme"));
    await r.engine.enroll();
    await r.queue(1);
    await r.engine.syncOnce();
    await r.queue(2);
    for (const other of [as("8", "acme"), as("7", "other-co")]) {
      r.set(other);
      const out = await r.engine.syncOnce({ force: true });
      expect(out).toMatchObject({ attempted: false, scope: "switch" });
      expect(out.reason).toMatch(/another sign-in or company/);
    }
    expect(r.calls.uploads).toBe(1);
    expect((await r.outbox.status()).counts.queued).toBe(2);
    expect(await r.engine.boundScope()).toEqual({ userRef: "7", tenantId: "acme" }); // not re-bound
    r.set(as("7", "acme"));
    expect(await r.engine.syncOnce({ force: true })).toMatchObject({ synchronized: 2 });
  });

  it("holds while the session is unconfirmed, and says why", async () => {
    const r = scoped({ state: "unconfirmed", why: "choose_organization" });
    await r.engine.enroll();
    await r.queue(1);
    const choose = await r.engine.syncOnce();
    expect(choose).toMatchObject({ attempted: false, scope: "hold", next: null });
    expect(choose.reason).toMatch(/Choose which company/);
    r.set(trpcError("UNAUTHORIZED", 401));
    expect(await r.engine.syncOnce()).toMatchObject({ scope: "hold", next: "reauth" });
    r.set(new TypeError("Failed to fetch"));
    expect(await r.engine.syncOnce()).toMatchObject({ scope: "hold", next: null });
    expect(r.calls.uploads).toBe(0);
    expect(await r.engine.boundScope()).toBeNull();          // nothing bound by an unconfirmed session
  });

  it("stops on withdrawn access and keeps the queue", async () => {
    const r = scoped(as("7", "acme"));
    await r.engine.enroll();
    await r.queue(1);
    await r.engine.syncOnce();
    await r.queue(1);
    r.set({ state: "revoked" });
    const out = await r.engine.syncOnce({ force: true });
    expect(out).toMatchObject({ attempted: false, scope: "revoked" });
    expect((await r.outbox.status()).counts).toMatchObject({ queued: 1, synchronized: 1 });
  });

  it("does not ask the server when there is nothing to send", async () => {
    let asked = 0;
    const { engine } = rig({}, async () => { asked++; return as("7", "acme"); });
    await engine.enroll();
    expect(await engine.syncOnce()).toMatchObject({ reason: "Nothing to sync" });
    expect(asked).toBe(0);
  });
});
