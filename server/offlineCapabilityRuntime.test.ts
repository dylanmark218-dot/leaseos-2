/**
 * SPINE item 3 — the device runtime calls offlineCapability.
 *
 * Until this checkpoint `server/_core/offlineCapability.ts` was declared unwired
 * ("no device runtime calls them yet"). The outbox and the sync engine now ask it
 * what each capture is: the outbox before saving and before queuing, the sync
 * engine before uploading. The shipped declarations are all `local_capture`, so
 * nothing a worker does today changes; the tests below pin the declarations and
 * prove, with a policy that marks one kind server-authoritative, that the device
 * would refuse it at both points.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { FlagConnectivity, MemoryKeystore, MemoryStore, MemoryVault, SettableClock } from "../client/src/runtime/adapters/memory";
import { Outbox } from "../client/src/runtime/outbox";
import { SyncEngine } from "../client/src/runtime/syncEngine";
import type { CaptureKind, LocalCapture, Transport } from "../client/src/runtime/contracts";
import {
  assertQueueable, CAPTURE_CAPABILITIES, captureCapability, captureEnvelope, capturePolicyDisagreements,
  UndeclaredCaptureKind, type CapturePolicy,
} from "../client/src/runtime/offlinePolicy";
import { DeviceAuthorityRefused } from "./_core/offlineCapability";

const AT = new Date("2026-10-01T15:00:00Z");

function rig(policy?: CapturePolicy) {
  const clock = new SettableClock(AT);
  const keystore = new MemoryKeystore(clock);
  const vault = new MemoryVault(keystore);
  const store = new MemoryStore();
  return { clock, keystore, vault, store, outbox: new Outbox(store, vault, clock, policy) };
}

/** The same declarations, except that recording an OOS order is (hypothetically) a server decision. */
const OOS_IS_SERVER: CapturePolicy = {
  ...CAPTURE_CAPABILITIES,
  oos_order: { ...CAPTURE_CAPABILITIES.oos_order, riskLevel: "restricted", offlineClass: "server_authoritative" },
};

const KINDS = Object.keys(CAPTURE_CAPABILITIES) as CaptureKind[];

describe("every capture kind is declared, and the declarations agree with the gateway's risks", () => {
  it("declares all eighteen kinds, each keyed by its kind", () => {
    expect(KINDS).toHaveLength(18);
    for (const k of KINDS) expect(CAPTURE_CAPABILITIES[k].key).toBe(`capture.${k}`);
  });

  it("has no class/risk disagreement", () => {
    expect(capturePolicyDisagreements()).toEqual([]);
  });

  it("ships no server-authoritative capture: recording is never deciding", () => {
    expect(KINDS.filter(k => CAPTURE_CAPABILITIES[k].offlineClass !== "local_capture")).toEqual([]);
  });

  it("names the permission the server checks when the evidence arrives", () => {
    for (const k of KINDS) expect(CAPTURE_CAPABILITIES[k].requiredPermissions).toEqual(["evidence.upload"]);
  });

  it("catches a policy whose label and risk disagree", () => {
    const mislabelled: CapturePolicy = { ...CAPTURE_CAPABILITIES, photo: { ...CAPTURE_CAPABILITIES.photo, riskLevel: "restricted" } };
    expect(capturePolicyDisagreements(mislabelled)).toEqual([expect.stringContaining("capture.photo is local_capture but carries risk restricted")]);
  });
});

describe("the outbox asks before it saves and before it queues", () => {
  it("refuses an undeclared kind before anything reaches the store or the vault", async () => {
    const r = rig();
    await expect(r.outbox.saveDraft({
      kind: "oos_release" as never, formKey: null, title: "x", category: "x", fields: {},
      files: [{ bytes: new Uint8Array([1, 2, 3]), fileName: "a.jpg", mimeType: "image/jpeg" }], jobId: 1,
    })).rejects.toThrow(UndeclaredCaptureKind);
    expect(await r.store.listCaptures()).toEqual([]);
    expect(await r.vault.usageBytes()).toBe(0);
  });

  it("queues every shipped kind", async () => {
    const r = rig();
    for (const kind of KINDS) {
      const c = await r.outbox.saveDraft({ kind, formKey: null, title: kind, category: kind, fields: {}, jobId: 7 });
      expect((await r.outbox.queue(c.localId)).syncState).toBe("queued");
    }
  });

  it("refuses to queue a server-authoritative kind, and keeps the draft", async () => {
    const r = rig(OOS_IS_SERVER);
    const c = await r.outbox.saveDraft({ kind: "oos_order", formKey: null, title: "OOS", category: "enforcement", fields: { order: "R-1" }, jobId: 7 });
    await expect(r.outbox.queue(c.localId)).rejects.toThrow(DeviceAuthorityRefused);
    await expect(r.outbox.queue(c.localId)).rejects.toThrow(/Losing signal is not a way around it/);
    expect((await r.store.getCapture(c.localId))?.syncState).toBe("saved_locally");
  });

  it("judges queuing as offline whatever the connection, so a queued capture never depended on signal", () => {
    expect(() => assertQueueable("defect_report")).not.toThrow();
    expect(() => assertQueueable("oos_order", OOS_IS_SERVER)).toThrow(DeviceAuthorityRefused);
  });
});

describe("the sync engine packages evidence only", () => {
  const capture = (kind: CaptureKind): LocalCapture => ({
    localId: `L-${kind}`, kind, formKey: null, title: kind, category: kind, fields: { said: "ticket 77492" }, files: [],
    capturedAt: AT.toISOString(), gps: null, jobId: 7, unitId: null, captureAuthorizationClaim: "unknown", captureAuthorizationReason: null,
    syncState: "queued", attempts: 0, lastError: null, serverEvidenceId: null, sealed: false, sealManifestHash: null, packagedIn: null,
    createdAt: AT.toISOString(), updatedAt: AT.toISOString(),
  });

  it("wraps a capture as evidence, with no device verdict", () => {
    const e = captureEnvelope(capture("disposal_ticket"), "DEV-1");
    expect(e).toMatchObject({ recordRef: "L-disposal_ticket", kind: "evidence", deviceId: "DEV-1", deviceAssessment: null, observation: { said: "ticket 77492" } });
  });

  it("fails a server-authoritative capture that reached the queue, uploads nothing for it, and retains it", async () => {
    const r = rig(OOS_IS_SERVER);
    await r.store.setMeta("deviceRef", "DEV-1");
    await r.store.setMeta("deviceStatus", "active");
    await r.store.putCapture(capture("oos_order"));
    const calls: string[] = [];
    const transport = new Proxy({}, { get: (_t, name) => async () => { calls.push(String(name)); throw new Error(`unexpected ${String(name)}`); } }) as Transport;
    const engine = new SyncEngine({ store: r.store, vault: r.vault, keystore: r.keystore, transport, connectivity: new FlagConnectivity(true), clock: r.clock, platform: "web", policy: OOS_IS_SERVER });

    const out = await engine.syncOnce();
    expect(out).toMatchObject({ attempted: true, failed: 1, synchronized: 0, reason: "Every item failed before packaging" });
    expect(calls).toEqual([]);
    const kept = await r.store.getCapture("L-oos_order");
    expect(kept?.syncState).toBe("failed");
    expect(kept?.lastError).toMatch(/server-authoritative and cannot be recorded as done by a device/);
  });

  it("refuses an undeclared kind by name rather than guessing", () => {
    expect(() => captureCapability("hos_override")).toThrow(/"hos_override" is not a declared capture kind/);
  });
});

describe("the engine stays safe to ship to a device", () => {
  it("imports nothing but types, so the client bundle carries no server code", () => {
    const imports = readFileSync("server/_core/offlineCapability.ts", "utf8").split("\n").filter(l => /^\s*import\b/.test(l));
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).toMatch(/^\s*import type\b/);
  });
});
