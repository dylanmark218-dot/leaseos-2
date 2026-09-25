/**
 * 0182/0183 — the board's offline queue, on the device half.
 *
 * Pure: memory adapters and a fake transport. What these prove is the device's side of the
 * promises the server suites prove on theirs: nothing reads as sent before the server answered, a
 * retry carries the same mutation id, a refusal is kept rather than dropped, acknowledgements go
 * first, and a board capture is never packaged as evidence.
 */
import { describe, expect, it } from "vitest";
import { FlagConnectivity, MemoryKeystore, MemoryStore, MemoryVault, SettableClock } from "../client/src/runtime/adapters/memory";
import { BoardQueue, errorCode, type BoardTransport } from "../client/src/runtime/boardQueue";
import { Outbox } from "../client/src/runtime/outbox";
import { SyncEngine } from "../client/src/runtime/syncEngine";
import { DIRECT_CAPTURE_KINDS, isDirectCapture, type Transport } from "../client/src/runtime/contracts";

const T0 = new Date("2026-10-20T14:00:00Z");

type Call = { proc: "post" | "acknowledge" | "respond"; input: Record<string, unknown> };

/** A server that remembers what it wrote, keyed the way the real one is: (deviceId, clientMutationId). */
function fakeServer() {
  const calls: Call[] = [];
  const written = new Map<string, string>();
  let nextFailure: unknown = null;
  let seq = 0;
  const maybeFail = () => { if (nextFailure) { const e = nextFailure; nextFailure = null; throw e; } };
  const transport: BoardTransport = {
    async post(input) {
      calls.push({ proc: "post", input });
      maybeFail();
      const key = `${input.deviceId}:${input.clientMutationId}`;
      const prior = written.get(key);
      if (prior) return { messageRef: prior, replayed: true };
      const ref = `MSG-${++seq}`;
      written.set(key, ref);
      return { messageRef: ref, replayed: false };
    },
    async acknowledge(input) { calls.push({ proc: "acknowledge", input }); maybeFail(); return { state: "acknowledged" }; },
    async respond(input) { calls.push({ proc: "respond", input }); maybeFail(); return { recorded: true }; },
  };
  return { transport, calls, written, failNext: (e: unknown) => { nextFailure = e; } };
}

async function rig(online = true) {
  const clock = new SettableClock(T0);
  const keystore = new MemoryKeystore(clock);
  const vault = new MemoryVault(keystore);
  const store = new MemoryStore();
  const connectivity = new FlagConnectivity(online);
  const server = fakeServer();
  const queue = new BoardQueue({ store, vault, clock, connectivity, transport: server.transport });
  await queue.open({ orgKey: "ORG-A", userId: 7 });
  return { clock, keystore, vault, store, connectivity, server, queue };
}

const trpcError = (code: string, message: string) => Object.assign(new Error(message), { data: { code } });

describe("the kinds and the outbox", () => {
  it("names exactly three direct kinds, and the outbox refuses one that relates to nothing", async () => {
    expect([...DIRECT_CAPTURE_KINDS]).toEqual(["board_message", "board_acknowledgement", "shift_response"]);
    expect(isDirectCapture("photo")).toBe(false);
    const r = await rig();
    const outbox = new Outbox(r.store, r.vault, r.clock);
    const orphan = await outbox.saveDraft({ kind: "board_message", formKey: null, title: "x", category: "board", fields: { body: "hello" } });
    await expect(outbox.queue(orphan.localId)).rejects.toThrow(/relates to no channel, message or post/);
    // A board capture needs no job or unit; an evidence capture still does.
    const photo = await outbox.saveDraft({ kind: "photo", formKey: null, title: "x", category: "c", fields: { channelRef: "CH-1" } });
    await expect(outbox.queue(photo.localId)).rejects.toThrow(/relates to no job or unit/);
  });
});

describe("nothing reads as sent before the server answered", () => {
  it("keeps a message queued while offline, sends nothing, and sends it with its own id when signal returns", async () => {
    const r = await rig(false);
    const c = await r.queue.message({ channelRef: "CH-1", body: "KM 42 washed out" });
    expect(c.syncState).toBe("queued");
    const offline = await r.queue.flush();
    expect(offline.attempted).toBe(false);
    expect(r.server.calls).toEqual([]);
    expect((await r.queue.list())[0]!.syncState).toBe("queued");

    r.connectivity.isOnline = true;
    const online = await r.queue.flush();
    expect(online.sent).toBe(1);
    expect(r.server.calls[0]!.input.clientMutationId).toBe(c.localId);
    // The device clock is when it was written, not when it was sent.
    expect((r.server.calls[0]!.input.deviceCreatedAt as Date).toISOString()).toBe(T0.toISOString());
    const after = (await r.queue.list())[0]!;
    expect(after.syncState).toBe("synchronized");
    expect(after.fields.serverRef).toBe("MSG-1");
  });
});

describe("a retry is the same record", () => {
  it("puts a send with no answer back in the queue, and the retry carries the same id and device", async () => {
    const r = await rig();
    const c = await r.queue.message({ channelRef: "CH-1", body: "on site" });
    r.server.failNext(new TypeError("fetch failed"));
    const first = await r.queue.flush();
    expect(first.requeued).toBe(1);
    const mid = (await r.queue.list())[0]!;
    expect(mid.syncState).toBe("queued");
    expect(mid.lastError).toContain("fetch failed");
    expect(mid.attempts).toBe(1);
    await r.queue.flush();
    const ids = r.server.calls.map(x => `${x.input.deviceId}:${x.input.clientMutationId}`);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(1);
    expect(ids[0]).toContain(c.localId);
    expect((await r.queue.list())[0]!.syncState).toBe("synchronized");
  });

  it("resolves a send the server wrote but whose reply was lost: left syncing, retried, answered with the first record", async () => {
    const r = await rig();
    const c = await r.queue.message({ channelRef: "CH-1", body: "done for the day" });
    // The server writes it, then the reply never arrives — the app is killed mid-send.
    await r.server.transport.post({ channelRef: "CH-1", body: "done for the day", priority: "normal", deviceCreatedAt: T0, deviceId: await r.queue.deviceId(), clientMutationId: c.localId });
    await new Outbox(r.store, r.vault, r.clock).markSyncing(c.localId, "direct:board_message");
    const out = await r.queue.flush();
    expect(out.sent).toBe(1);
    expect(r.server.written.size).toBe(1);
    expect((await r.queue.list())[0]!.fields.serverRef).toBe("MSG-1");
  });

  it("mints one device id and keeps it; an enrolled device reference wins", async () => {
    const r = await rig();
    const a = await r.queue.deviceId();
    expect(await r.queue.deviceId()).toBe(a);
    await r.store.setMeta("deviceRef", "DEV-ENROLLED");
    expect(await r.queue.deviceId()).toBe("DEV-ENROLLED");
  });
});

describe("a refusal is kept, not dropped", () => {
  it("marks a refused message failed with the server's reason, keeps it, and carries on with the rest", async () => {
    const r = await rig();
    await r.queue.message({ channelRef: "CH-GONE", body: "hello?" });
    await r.queue.respond({ postRef: "OS-1", response: "interested" });
    r.server.failNext(trpcError("FORBIDDEN", "Not a member of this channel"));
    const out = await r.queue.flush();
    expect(out).toMatchObject({ failed: 1, sent: 1 });
    const [msg, resp] = await r.queue.list();
    expect(msg!.syncState).toBe("failed");
    expect(msg!.lastError).toBe("FORBIDDEN: Not a member of this channel");
    expect(resp!.syncState).toBe("synchronized");
  });

  it("marks a conflict as conflict, not as failed", async () => {
    const r = await rig();
    await r.queue.message({ channelRef: "CH-1", body: "x" });
    r.server.failNext(trpcError("CONFLICT", "That client mutation id was already used by this device for a different message"));
    expect((await r.queue.flush()).conflicts).toBe(1);
    expect((await r.queue.list())[0]!.syncState).toBe("conflict");
  });

  it("reads the code wherever the client put it, and none from a transport failure", () => {
    expect(errorCode(trpcError("NOT_FOUND", "x"))).toBe("NOT_FOUND");
    expect(errorCode({ code: "CONFLICT" })).toBe("CONFLICT");
    expect(errorCode(new TypeError("fetch failed"))).toBeNull();
  });
});

describe("order", () => {
  it("sends acknowledgements before messages and messages before responses, whatever order they were queued in", async () => {
    const r = await rig();
    await r.queue.respond({ postRef: "OS-1", response: "available" });
    r.clock.set(new Date(T0.getTime() + 60_000));
    await r.queue.message({ channelRef: "CH-1", body: "late" });
    r.clock.set(new Date(T0.getTime() + 120_000));
    await r.queue.acknowledge({ messageRef: "MSG-STOP-WORK" });
    await r.queue.flush();
    expect(r.server.calls.map(c => c.proc)).toEqual(["acknowledge", "post", "respond"]);
  });

  it("does not send the same capture twice when two flushes overlap", async () => {
    const r = await rig();
    await r.queue.message({ channelRef: "CH-1", body: "once" });
    await Promise.all([r.queue.flush(), r.queue.flush()]);
    expect(r.server.calls).toHaveLength(1);
  });
});

describe("a board capture is never evidence", () => {
  it("is left out of the sync engine's package, and still counts in the device's outbox status", async () => {
    const r = await rig();
    await r.store.setMeta("deviceRef", "DEV-1");
    await r.store.setMeta("deviceStatus", "active");
    await r.queue.message({ channelRef: "CH-1", body: "not evidence" });
    const transport = new Proxy({}, { get: () => () => { throw new Error("the evidence protocol was called"); } }) as Transport;
    const engine = new SyncEngine({ store: r.store, vault: r.vault, keystore: r.keystore, transport, connectivity: r.connectivity, clock: r.clock, platform: "web" });
    const outcome = await engine.syncOnce();
    expect(outcome.attempted).toBe(false);
    expect(outcome.reason).toBe("Nothing to sync");
    expect((await new Outbox(r.store, r.vault, r.clock).status()).counts.queued).toBe(1);
  });
});
