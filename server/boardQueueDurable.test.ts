/**
 * Checkpoint 5 — the Board queue across a restart, an organization switch and a sign-out.
 *
 * The store here is a stand-in for the device's persistent store: every write is serialized to a
 * shared "disk" and every read parses it back, so a new `BoardQueue` over a new store instance sees
 * exactly what survived — nothing held in an object, a closure or a module. That is the property the
 * native encrypted store gives; what these prove is that the queue does the right thing over it.
 * They do not prove the native store exists: in this repository it does not yet (see the design's
 * §16), and the browser fallback stays memory-only and says so.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { FlagConnectivity, MemoryKeystore, MemoryVault, SettableClock } from "../client/src/runtime/adapters/memory";
import { BoardQueue, INTERRUPTED, NoScope, type BoardTransport } from "../client/src/runtime/boardQueue";
import { Outbox } from "../client/src/runtime/outbox";
import { SyncEngine } from "../client/src/runtime/syncEngine";
import { DIRECT_CAPTURE_KINDS, type CaptureKind, type LocalCapture, type LocalPackage, type LocalStore, type SyncState, type Transport } from "../client/src/runtime/contracts";

const T0 = new Date("2026-10-20T14:00:00Z");
const A = { orgKey: "ORG-A", userId: 7 };
const B = { orgKey: "ORG-B", userId: 7 };
const OTHER_PERSON = { orgKey: "ORG-A", userId: 8 };

/** A store whose only state is serialized text on a shared disk. */
class DiskStore implements LocalStore {
  constructor(private disk: Map<string, string>) {}
  private read<T>(key: string, fallback: T): T { const v = this.disk.get(key); return v == null ? fallback : JSON.parse(v) as T; }
  private write(key: string, v: unknown) { this.disk.set(key, JSON.stringify(v)); }
  async putCapture(c: LocalCapture) { const all = this.read<Record<string, LocalCapture>>("captures", {}); all[c.localId] = c; this.write("captures", all); }
  async getCapture(id: string) { return this.read<Record<string, LocalCapture>>("captures", {})[id] ?? null; }
  async listCaptures(filter?: { syncState?: SyncState | SyncState[] }) {
    const want = filter?.syncState == null ? null : new Set(Array.isArray(filter.syncState) ? filter.syncState : [filter.syncState]);
    return Object.values(this.read<Record<string, LocalCapture>>("captures", {})).filter(c => !want || want.has(c.syncState));
  }
  async putPackage(p: LocalPackage) { const all = this.read<Record<string, LocalPackage>>("packages", {}); all[p.packageRef] = p; this.write("packages", all); }
  async listPackages() { return Object.values(this.read<Record<string, LocalPackage>>("packages", {})); }
  async getMeta(k: string) { return this.read<Record<string, string>>("meta", {})[k] ?? null; }
  async setMeta(k: string, v: string) { const all = this.read<Record<string, string>>("meta", {}); all[k] = v; this.write("meta", all); }
}

/** A server keyed the way the real one is: (deviceId, clientMutationId) → one record. */
function fakeServer() {
  const calls: { proc: string; input: Record<string, unknown>; as: string }[] = [];
  const written = new Map<string, string>();
  let session = "none";
  let seq = 0;
  let failNext: unknown = null;
  const fail = () => { if (failNext) { const e = failNext; failNext = null; throw e; } };
  const transport: BoardTransport = {
    async post(input) {
      calls.push({ proc: "post", input, as: session }); fail();
      const key = `${input.deviceId}:${input.clientMutationId}`;
      const prior = written.get(key);
      if (prior) return { messageRef: prior, replayed: true };
      const ref = `MSG-${++seq}`; written.set(key, ref); return { messageRef: ref, replayed: false };
    },
    async acknowledge(input) { calls.push({ proc: "acknowledge", input, as: session }); fail(); return { state: "acknowledged" }; },
    async respond(input) { calls.push({ proc: "respond", input, as: session }); fail(); return { recorded: true }; },
  };
  return { transport, calls, written, signIn: (s: string) => { session = s; }, failNext: (e: unknown) => { failNext = e; } };
}

/** One "device": a disk that outlives any process, and a way to start the app over it. */
function device(online = true) {
  const disk = new Map<string, string>();
  const clock = new SettableClock(T0);
  const connectivity = new FlagConnectivity(online);
  const server = fakeServer();
  const vault = new MemoryVault(new MemoryKeystore(clock));
  /** Start the app: a fresh store over the same disk, and a fresh queue. Nothing else carries over. */
  const boot = () => ({ store: new DiskStore(disk), queue: new BoardQueue({ store: new DiskStore(disk), vault, clock, connectivity, transport: server.transport }) });
  return { disk, clock, connectivity, server, vault, boot };
}

afterEach(() => vi.restoreAllMocks());

describe("a queue survives a restart, honestly", () => {
  it("round-trips a queued message through the store, and a restarted app shows it queued — not sent", async () => {
    const dev = device(false);
    const first = dev.boot();
    await first.queue.open(A);
    const c = await first.queue.message({ channelRef: "CH-1", body: "KM 42 washed out", priority: "important" });

    const second = dev.boot();                       // the app was killed and started again
    expect(await second.queue.list()).toEqual([]);   // no scope open yet: nothing shown
    const restored = await second.queue.open(A);
    expect(restored).toEqual({ restored: 1, interrupted: 0, refused: 0 });
    const [back] = await second.queue.list();
    expect(back).toMatchObject({ localId: c.localId, kind: "board_message", syncState: "queued", attempts: 0, scope: A, capturedAt: T0.toISOString() });
    expect(back!.fields).toMatchObject({ channelRef: "CH-1", body: "KM 42 washed out", priority: "important" });
    expect(back!.fields.serverRef).toBeUndefined();
    expect(dev.server.calls).toEqual([]);
  });

  it("puts a capture found mid-send back in the queue with the reason, and the resend is one record on the server", async () => {
    const dev = device();
    const first = dev.boot();
    await first.queue.open(A);
    const c = await first.queue.message({ channelRef: "CH-1", body: "on site" });
    // The send reached the server and the app died before the reply: syncing on disk, written on the server.
    await dev.server.transport.post({ channelRef: "CH-1", body: "on site", priority: "normal", deviceCreatedAt: T0, deviceId: await first.queue.deviceId(), clientMutationId: c.localId });
    await new Outbox(first.store, dev.vault, dev.clock).markSyncing(c.localId, "direct:board_message");

    const second = dev.boot();
    expect(await second.queue.open(A)).toEqual({ restored: 1, interrupted: 1, refused: 0 });
    const [waiting] = await second.queue.list();
    expect(waiting).toMatchObject({ syncState: "queued", lastError: INTERRUPTED, attempts: 1 });

    expect((await second.queue.flush()).sent).toBe(1);
    expect(dev.server.written.size).toBe(1);
    const posts = dev.server.calls.filter(x => x.proc === "post").map(x => `${x.input.deviceId}:${x.input.clientMutationId}`);
    expect(new Set(posts).size).toBe(1);             // same device, same id, every time
    expect((await second.queue.list())[0]).toMatchObject({ syncState: "synchronized", fields: { serverRef: "MSG-1" } });
  });

  it("keeps a refusal and its reason across a restart until it is retried", async () => {
    const dev = device();
    const first = dev.boot();
    await first.queue.open(A);
    const c = await first.queue.message({ channelRef: "CH-GONE", body: "hello?" });
    dev.server.failNext(Object.assign(new Error("Not a member of this channel"), { data: { code: "FORBIDDEN" } }));
    await first.queue.flush();

    const second = dev.boot();
    expect(await second.queue.open(A)).toEqual({ restored: 0, interrupted: 0, refused: 1 });
    expect((await second.queue.list())[0]).toMatchObject({ syncState: "failed", lastError: "FORBIDDEN: Not a member of this channel" });
    await second.queue.flush();
    expect(dev.server.calls).toHaveLength(1);         // a refusal is not resent on its own

    await second.queue.retry(c.localId);
    expect((await second.queue.list())[0]!.syncState).toBe("queued");
    expect((await second.queue.flush()).sent).toBe(1);
  });

  it("finishes a capture the app wrote but died before queuing, rather than losing it", async () => {
    const dev = device(false);
    const first = dev.boot();
    await first.queue.open(A);
    const c = await first.queue.message({ channelRef: "CH-1", body: "draft" });
    // Wind it back to the half-written state: saved, scoped, not queued.
    const raw = (await first.store.getCapture(c.localId))!;
    await first.store.putCapture({ ...raw, syncState: "saved_locally" });
    const second = dev.boot();
    expect((await second.queue.open(A)).restored).toBe(1);
    expect((await second.queue.list())[0]!.syncState).toBe("queued");
  });

  it("sends acknowledgements first after a restart, as before it", async () => {
    const dev = device(false);
    const first = dev.boot();
    await first.queue.open(A);
    await first.queue.respond({ postRef: "OS-1", response: "interested" });
    dev.clock.set(new Date(T0.getTime() + 60_000));
    await first.queue.message({ channelRef: "CH-1", body: "later" });
    dev.clock.set(new Date(T0.getTime() + 120_000));
    await first.queue.acknowledge({ messageRef: "MSG-STOP" });
    dev.connectivity.isOnline = true;
    const second = dev.boot();
    await second.queue.open(A);
    await second.queue.flush();
    expect(dev.server.calls.map(c => c.proc)).toEqual(["acknowledge", "post", "respond"]);
  });
});

describe("whose queue it is", () => {
  it("does not show or send organization A's waiting messages after switching to organization B", async () => {
    const dev = device(false);
    const app = dev.boot();
    await app.queue.open(A);
    await app.queue.message({ channelRef: "CH-A", body: "for A only" });
    await app.queue.open(B);
    expect(await app.queue.list()).toEqual([]);
    dev.connectivity.isOnline = true;
    dev.server.signIn("user 7 in B");
    expect((await app.queue.flush()).reason).toBe("Nothing waiting");
    expect(dev.server.calls).toEqual([]);
    await app.queue.message({ channelRef: "CH-B", body: "for B" });
    expect((await app.queue.list()).map(c => c.fields.channelRef)).toEqual(["CH-B"]);

    // Back in A, A's message is there, still queued, and goes as A.
    await app.queue.open(A);
    dev.server.signIn("user 7 in A");
    expect((await app.queue.list()).map(c => [c.fields.channelRef, c.syncState])).toEqual([["CH-A", "queued"]]);
    await app.queue.flush();
    expect(dev.server.calls.map(c => [c.input.channelRef, c.as])).toEqual([["CH-A", "user 7 in A"]]);
  });

  it("gives the next person on the device none of the previous person's queue, after sign-out and after a restart", async () => {
    const dev = device(false);
    const app = dev.boot();
    await app.queue.open(A);
    await app.queue.message({ channelRef: "CH-1", body: "mine, not yours" });
    await app.queue.close();                          // sign-out
    expect(await app.queue.list()).toEqual([]);
    await expect(app.queue.message({ channelRef: "CH-1", body: "nobody signed in" })).rejects.toBeInstanceOf(NoScope);
    dev.connectivity.isOnline = true;
    expect((await app.queue.flush()).reason).toMatch(/Not signed in/);

    const next = dev.boot();
    await next.queue.open(OTHER_PERSON);
    expect(await next.queue.list()).toEqual([]);
    await next.queue.flush();
    expect(dev.server.calls).toEqual([]);
    // Nothing unaccepted was deleted: it waits, on the device, for the person who wrote it.
    const again = dev.boot();
    await again.queue.open(A);
    expect((await again.queue.list()).map(c => c.fields.body)).toEqual(["mine, not yours"]);
  });

  it("stops a flush that is overtaken by a sign-out, leaving the rest for its own scope", async () => {
    const dev = device();
    const app = dev.boot();
    await app.queue.open(A);
    await app.queue.message({ channelRef: "CH-1", body: "one" });
    await app.queue.message({ channelRef: "CH-1", body: "two" });
    const original = dev.server.transport.post;
    dev.server.transport.post = async input => { const r = await original(input); void app.queue.close(); return r; };
    await app.queue.flush();
    expect(dev.server.calls.filter(c => c.proc === "post")).toHaveLength(1);
    dev.server.transport.post = original;
    await app.queue.open(A);
    expect((await app.queue.list()).map(c => c.syncState)).toEqual(["synchronized", "queued"]);
  });

  it("stops a flush overtaken by an organization switch, so A's rest never goes out as B", async () => {
    const dev = device();
    const app = dev.boot();
    await app.queue.open(A);
    await app.queue.message({ channelRef: "CH-A", body: "one" });
    await app.queue.message({ channelRef: "CH-A", body: "two" });
    const original = dev.server.transport.post;
    let switching: Promise<unknown> | null = null;
    dev.server.transport.post = async input => { const r = await original(input); switching ??= app.queue.open(B); return r; };
    await app.queue.flush();
    await switching;
    expect(dev.server.calls.filter(c => c.proc === "post")).toHaveLength(1);
    dev.server.transport.post = original;
    await app.queue.open(A);
    expect((await app.queue.list()).map(c => c.syncState)).toEqual(["synchronized", "queued"]);
  });

  it("never lists or sends a capture with no scope, which is how a half-written one fails", async () => {
    const dev = device();
    const app = dev.boot();
    const outbox = new Outbox(app.store, dev.vault, dev.clock);
    const orphan = await outbox.saveDraft({ kind: "board_message", formKey: null, title: "x", category: "board", fields: { channelRef: "CH-1", body: "unscoped" } });
    await outbox.queue(orphan.localId);
    await app.queue.open(A);
    expect(await app.queue.list()).toEqual([]);
    await app.queue.flush();
    expect(dev.server.calls).toEqual([]);
  });
});

describe("what leaves the queue", () => {
  it("keeps no message text in an error, and writes nothing to the console while sending", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(m => vi.spyOn(console, m).mockImplementation(() => undefined));
    const dev = device();
    const app = dev.boot();
    await app.queue.open(A);
    await app.queue.message({ channelRef: "CH-1", body: "gate code 4471" });
    dev.server.failNext(new TypeError("request body 'gate code 4471' could not be sent"));
    await app.queue.flush();
    const [c] = await app.queue.list();
    expect(c!.lastError).not.toContain("gate code 4471");
    expect(c!.lastError).toContain("[message text]");
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });

  it("offers no way to queue an answer to a dispatcher's offer: that write is connected-only", () => {
    const kinds: readonly CaptureKind[] = DIRECT_CAPTURE_KINDS;
    expect(kinds.some(k => /offer/.test(k))).toBe(false);
    expect(Object.getOwnPropertyNames(BoardQueue.prototype).filter(n => /offer|accept|decline/i.test(n))).toEqual([]);
  });
});

describe("a board capture is never evidence, whichever kind", () => {
  it("leaves all three kinds out of the evidence package, the photo vault's eviction and the sync engine", async () => {
    const dev = device();
    const app = dev.boot();
    await app.store.setMeta("deviceRef", "DEV-1");
    await app.store.setMeta("deviceStatus", "active");
    await app.queue.open(A);
    await app.queue.message({ channelRef: "CH-1", body: "not evidence" });
    await app.queue.acknowledge({ messageRef: "MSG-1", channelRef: "CH-1" });
    await app.queue.respond({ postRef: "OS-1", response: "available" });
    const kinds = (await app.store.listCaptures()).map(c => c.kind).sort();
    expect(kinds).toEqual([...DIRECT_CAPTURE_KINDS].sort());

    const evidence = new Proxy({}, { get: () => () => { throw new Error("the evidence protocol was called"); } }) as Transport;
    const engine = new SyncEngine({ store: app.store, vault: dev.vault, keystore: new MemoryKeystore(dev.clock), transport: evidence, connectivity: dev.connectivity, clock: dev.clock, platform: "web" });
    expect(await engine.syncOnce()).toMatchObject({ attempted: false, reason: "Nothing to sync" });
    expect(await app.store.listPackages()).toEqual([]);
    // No files, so nothing for the vault to evict, and nothing marked sealed or packaged.
    const outbox = new Outbox(app.store, dev.vault, dev.clock);
    expect(await outbox.evictSynchronizedFiles(0)).toEqual({ evicted: 0, freedBytes: 0, refusedBecauseUnsynced: 0 });
    for (const c of await app.store.listCaptures()) expect(c).toMatchObject({ files: [], sealed: false, serverEvidenceId: null });
  });
});
