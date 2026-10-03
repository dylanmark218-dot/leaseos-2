/**
 * SPINE item 3 — HS1 (what the device can physically do) is kept apart from the offline policy (may
 * this run without the server) and from authority (may this person do it).
 *
 *   hardware facts ──► HS1 `capabilities()` / `missingHardware` ──► can only NARROW availability
 *   requiresOnline (actionGateway, the one declaration) ──► may it run without the server
 *   connectivity ──► only satisfies connectivity
 *        └────────► offlineCapability.runtimeAvailability ──► capture / queue / refuse
 *
 * Authority is never decided here: a capture reaches the server as evidence or as a request, and the
 * server authorizes it then (`spineItem3Reconnect.db.test.ts`).
 */
import { describe, expect, it } from "vitest";
import { HARDWARE_CAPABILITIES, missingHardware, type CapabilityMatrix } from "@shared/hardwareCapability";
import { capabilities, CAPTURE_OPERATIONS, captureGate } from "../client/src/runtime/capabilities";
import { FlagConnectivity, MemoryKeystore, MemoryStore, MemoryVault, SettableClock, memoryProbes } from "../client/src/runtime/adapters/memory";
import { Outbox } from "../client/src/runtime/outbox";
import { NotOnDeviceError, type CaptureKind } from "../client/src/runtime/contracts";
import { offlineClassOf, runtimeAvailability, type DeviceOperation, type RuntimeAvailability } from "./_core/offlineCapability";
import { decide, mayRunWithoutServer, buildRegistry, type CapabilityDefinition } from "./_core/actionGateway";

const all = (v: boolean): CapabilityMatrix => Object.fromEntries(HARDWARE_CAPABILITIES.map(k => [k, v])) as CapabilityMatrix;
const without = (...keys: (keyof CapabilityMatrix)[]): CapabilityMatrix => ({ ...all(true), ...Object.fromEntries(keys.map(k => [k, false])) });
const op = (o: Partial<DeviceOperation>): DeviceOperation => ({ key: "x", riskLevel: "low_risk_action", requiresOnline: false, requiredHardware: [], draftable: false, ...o });

const photo = op({ key: "capture.photo", requiredHardware: ["localStore", "fileVault", "camera"] });
const located = op({ key: "capture.located", requiredHardware: ["localStore", "location"] });
const releaseOos = op({ key: "maintenance.clearOutOfService", riskLevel: "restricted", requiresOnline: true });
const shiftResponse = op({ key: "capture.shift_response", requiresOnline: true, draftable: true, requiredHardware: ["localStore"] });

describe("HS1 — hardware capability", () => {
  it("uses the frozen HS1 vocabulary and nothing else", () => {
    expect([...HARDWARE_CAPABILITIES]).toEqual(["localStore", "fileVault", "keystore", "camera", "location", "network"]);
  });
  it("passes when the required hardware is present", () => {
    expect(missingHardware(all(true), ["camera", "location"])).toEqual([]);
  });
  it("names a missing camera and a missing GPS", () => {
    expect(missingHardware(without("camera"), ["localStore", "camera"])).toEqual(["camera"]);
    expect(missingHardware(without("location"), ["location"])).toEqual(["location"]);
  });
  it("is not blocked by hardware the operation does not need", () => {
    expect(missingHardware(without("camera", "location"), ["localStore"])).toEqual([]);
  });
  it("gives the same answer for the same facts", () => {
    const facts = without("camera");
    expect(missingHardware(facts, ["camera", "localStore"])).toEqual(missingHardware({ ...facts }, ["camera", "localStore"]));
  });
  it("probes every capability, and a probe that throws or is absent reads as unavailable — never as present", async () => {
    const m = await capabilities({ ...memoryProbes(), camera: async () => { throw new Error("plugin crashed"); } });
    expect(Object.keys(m).sort()).toEqual([...HARDWARE_CAPABILITIES].sort());
    expect(m.camera).toBe(false);
    expect((await capabilities(memoryProbes())).location).toBe(false);   // the browser fallback has no GPS binding
  });
});

describe("offline policy — requiresOnline is the one answer", () => {
  it("requiresOnline=true offline never executes or captures locally", () => {
    const r = runtimeAvailability(releaseOos, { hardware: all(true), online: false });
    expect(r).toMatchObject({ outcome: "unavailable", reason: "server_required_offline" });
    expect(runtimeAvailability(shiftResponse, { hardware: all(true), online: false })).toMatchObject({ outcome: "prepare_and_queue", reason: "server_decides" });
  });
  it("requiresOnline=false offline with its hardware present takes the existing offline path", () => {
    expect(runtimeAvailability(photo, { hardware: all(true), online: false })).toMatchObject({ outcome: "capture_locally" });
  });
  it("requiresOnline=false with its hardware missing is blocked by hardware", () => {
    expect(runtimeAvailability(photo, { hardware: without("camera"), online: false })).toMatchObject({ outcome: "unavailable", reason: "hardware_missing", missing: ["camera"] });
  });
  it("online does not supply missing hardware", () => {
    expect(runtimeAvailability(photo, { hardware: without("camera"), online: true })).toMatchObject({ outcome: "unavailable", reason: "hardware_missing" });
    expect(runtimeAvailability(located, { hardware: without("location"), online: true })).toMatchObject({ reason: "hardware_missing", missing: ["location"] });
  });
  it("online + requiresOnline=true only satisfies connectivity: the work goes to the server, it is not done here", () => {
    const r = runtimeAvailability(releaseOos, { hardware: all(true), online: true });
    expect(r).toMatchObject({ outcome: "prepare_and_queue", reason: "server_decides" });
  });
  it("the offline class is derived from requiresOnline and the risk, never declared — and a contradiction refuses", () => {
    expect(offlineClassOf(releaseOos)).toBe("server_authoritative");
    expect(offlineClassOf(photo)).toBe("local_capture");
    expect(offlineClassOf(op({ riskLevel: "read" }))).toBe("local_safe");
    expect(offlineClassOf(op({ riskLevel: "prepare" }))).toBe("local_prepare");
    // Approval or restricted work that claims it can run without the server is a contradiction, not a class.
    expect(() => offlineClassOf(op({ riskLevel: "approval_required", requiresOnline: false }))).toThrow(/without the server/);
    expect(() => runtimeAvailability(op({ riskLevel: "restricted", requiresOnline: false }), { hardware: all(true), online: false })).toThrow();
  });
  it("the gateway and the runtime read requiresOnline through one predicate", () => {
    expect(mayRunWithoutServer({ requiresOnline: true })).toBe(false);
    expect(mayRunWithoutServer({ requiresOnline: false })).toBe(true);
  });
});

/** A rule that lets the device execute server work is wrong whatever else it gets right. */
function serverWorkExecutedLocally(rule: (o: DeviceOperation, c: { hardware: CapabilityMatrix; online: boolean }) => Pick<RuntimeAvailability, "outcome">): string[] {
  const out: string[] = [];
  const ops = [releaseOos, shiftResponse, op({ key: "billing.issueInvoice", riskLevel: "approval_required", requiresOnline: true })];
  for (const o of ops) for (const online of [true, false]) for (const hardware of [all(true), without("camera")]) {
    const r = rule(o, { hardware, online });
    if (r.outcome === "execute_locally" || r.outcome === "capture_locally") out.push(`${o.key} online=${online} → ${r.outcome}`);
  }
  return out;
}

describe("regression — online is not a licence to execute locally", () => {
  it("rejects the old rule, planted: 'online means execute locally for every action'", () => {
    const planted = (_o: DeviceOperation, c: { online: boolean }) => (c.online ? { outcome: "execute_locally" as const } : { outcome: "unavailable" as const });
    expect(serverWorkExecutedLocally(planted)).not.toEqual([]);
  });
  it("the corrected rule never executes or captures server work on the device, online or not", () => {
    expect(serverWorkExecutedLocally(runtimeAvailability)).toEqual([]);
  });
});

describe("authority is not granted by the device", () => {
  const registry = buildRegistry([{ key: "maintenance.clearOutOfService", description: "", riskLevel: "restricted", requiredPermissions: ["enforcement.release"], requiresOnline: true, idempotent: true } satisfies CapabilityDefinition]);
  it("full hardware and a connection grant no permission: the gateway still refuses the missing permission", () => {
    expect(runtimeAvailability(releaseOos, { hardware: all(true), online: true }).outcome).not.toBe("execute_locally");
    const g = decide(
      { requestId: "r", runId: "run", capability: "maintenance.clearOutOfService", actor: { type: "user", id: "7" }, delegatedByUserId: null,
        target: { entityType: "unit", entityId: "1", revision: null }, payloadHash: "h", origin: "authorized_user", reasoningSummary: "", evidenceRefs: [] },
      { registry, heldPermissions: [], online: true, compliance: null, actualRevision: null, autoExecute: [], approvalForPayloadHash: null },
    );
    expect(g).toMatchObject({ decision: "deny", reasons: ["Missing enforcement.release"] });
  });
  it("no availability result carries a permission, a scope or an authorization claim", () => {
    const r = runtimeAvailability(photo, { hardware: all(true), online: true });
    for (const k of ["permission", "permissions", "authorized", "captureAuthorizationClaim", "scope", "tenantId", "orgRef"]) expect(r).not.toHaveProperty(k);
  });
});

describe("the runtime path — every capture is gated by HS1 and the one policy before it is saved", () => {
  const rig = (probes: ReturnType<typeof memoryProbes>, online: boolean) => {
    const clock = new SettableClock(new Date("2026-10-03T12:00:00Z"));
    const keystore = new MemoryKeystore(clock);
    const vault = new MemoryVault(keystore);
    const store = new MemoryStore();
    const gate = captureGate({ probes, connectivity: new FlagConnectivity(online) });
    return { store, outbox: new Outbox(store, vault, clock, gate) };
  };
  it("declares every capture kind once, with requiresOnline and its hardware", () => {
    const kinds = Object.keys(CAPTURE_OPERATIONS).sort();
    expect(kinds.length).toBeGreaterThan(20);
    for (const k of kinds) {
      const o = CAPTURE_OPERATIONS[k as CaptureKind];
      expect(o.key).toBe(`capture.${k}`);
      expect(typeof o.requiresOnline).toBe("boolean");
      expect(() => offlineClassOf(o)).not.toThrow();
    }
    // Evidence is recorded offline (the existing behaviour); a board message or open-work response is a
    // request the server decides, so it is queued for the server, never done on the device.
    expect(CAPTURE_OPERATIONS.photo.requiredHardware).toContain("camera");
    expect(CAPTURE_OPERATIONS.shift_response.requiresOnline).toBe(true);
    expect(CAPTURE_OPERATIONS.oos_order.requiresOnline).toBe(false);   // a photographed order is evidence; clearing one is the server's
  });
  it("a camera-required capture on a device without a camera is refused before anything is stored", async () => {
    const { outbox, store } = rig(memoryProbes(), false);
    await expect(outbox.saveDraft({ kind: "photo", formKey: null, title: "Load", category: "photo", fields: {}, unitId: 1 })).rejects.toBeInstanceOf(NotOnDeviceError);
    expect(await store.listCaptures()).toEqual([]);
  });
  it("an evidence capture with its hardware present is saved locally offline — the existing six-state path", async () => {
    const { outbox } = rig({ ...memoryProbes(), camera: async () => true }, false);
    const c = await outbox.saveDraft({ kind: "photo", formKey: null, title: "Load", category: "photo", fields: {}, unitId: 1 });
    expect(c.syncState).toBe("saved_locally");
    expect(c.captureAuthorizationClaim).toBe("unknown");   // the gate grants no claim
  });
  it("an open-work response offline is saved for the server to decide, not decided here", async () => {
    const { outbox } = rig(memoryProbes(), false);
    const c = await outbox.saveDraft({ kind: "shift_response", formKey: null, title: "Interested", category: "shift", fields: { postRef: "OS-1" } });
    expect(c.syncState).toBe("saved_locally");
  });
  it("without a gate the outbox behaves exactly as before (the gate narrows; it is not a new store)", async () => {
    const clock = new SettableClock(new Date("2026-10-03T12:00:00Z"));
    const ks = new MemoryKeystore(clock);
    const c = await new Outbox(new MemoryStore(), new MemoryVault(ks), clock).saveDraft({ kind: "photo", formKey: null, title: "x", category: "photo", fields: {}, unitId: 1 });
    expect(c.syncState).toBe("saved_locally");
  });
});
