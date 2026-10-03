/**
 * SPINE item 3 — one offline policy, enforced on both sides.
 *
 * The field client needs the rule because, offline, there is no server to ask. The server needs the
 * same rule because the client is not an authorization boundary. Both run `shared/offlinePolicy.ts`;
 * neither keeps a copy. These tests pin the policy, the client's use of it, the server's use of it
 * (the database half is in `fieldRuntime.test.ts` and `fieldDevice.test.ts`), and that there is one
 * implementation.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  FIELD_OPERATIONS, decideFieldOperation, fieldOperation, revalidatePackagedOperation,
  classRiskDisagreements, offlineOutcome,
} from "../shared/offlinePolicy";
import * as serverAdapter from "./_core/offlineCapability";
import { Outbox, FieldOperationRefused } from "../client/src/runtime/outbox";
import { FlagConnectivity, MemoryKeystore, MemoryStore, MemoryVault, SettableClock } from "../client/src/runtime/adapters/memory";
import type { CaptureKind } from "../client/src/runtime/contracts";

const AT = new Date("2026-10-03T14:00:00Z");

/* Every capture kind the device can produce. Kept as a value so the test fails when a kind is added
 * to `contracts.ts` without a policy row; `outbox.ts` holds the compile-time twin of this check. */
const CAPTURE_KINDS: readonly CaptureKind[] = [
  "pretrip", "posttrip", "hos_event", "job_accept", "load_ticket", "disposal_ticket", "fuel_receipt",
  "expense_receipt", "photo", "signature", "incident", "defect_report", "tailgate", "tdg_document", "voice_note",
  "roadside_enforcement", "oos_order", "scanned_document", "board_message", "board_acknowledgement", "shift_response",
];

describe("the catalogue: every field operation is declared, and declared consistently", () => {
  it("has a row for every capture kind the device can produce", () => {
    for (const k of CAPTURE_KINDS) expect(fieldOperation(k), k).not.toBeNull();
  });

  it("never lets a class and its risk disagree", () => {
    expect(classRiskDisagreements(Object.values(FIELD_OPERATIONS))).toEqual([]);
  });

  it("declares no device operation as server-authoritative-and-recordable: a device records evidence, not decisions", () => {
    for (const op of Object.values(FIELD_OPERATIONS)) {
      expect(op.offlineClass === "local_capture" || op.offlineClass === "local_prepare", op.key).toBe(true);
    }
  });

  it("keeps job acceptance a draft the server decides, not a capture of a decision", () => {
    expect(fieldOperation("job_accept")?.offlineClass).toBe("local_prepare");
  });

  it("routes board messages to their own procedure, never the evidence package", () => {
    for (const k of ["board_message", "board_acknowledgement", "shift_response"]) expect(fieldOperation(k)?.channel, k).toBe("direct");
    expect(fieldOperation("disposal_ticket")?.channel).toBe("package");
  });
});

describe("the decision: what an offline device may do with an operation", () => {
  it("captures an observation locally while offline and queues it for the server", () => {
    expect(decideFieldOperation("defect_report", { online: false }).outcome).toBe("capture_locally");
  });

  it("prepares a server-decided operation and queues it, never executing it", () => {
    const d = decideFieldOperation("job_accept", { online: false });
    expect(d.outcome).toBe("prepare_and_queue");
    expect(d.outcome).not.toBe("execute_locally");
  });

  it("fails closed on an operation the policy does not know, online or not", () => {
    for (const online of [true, false]) {
      const d = decideFieldOperation("oos_release", { online });
      expect(d.outcome).toBe("refused");
      expect(d.note).toMatch(/not a field operation/);
    }
  });

  it("is a pure function of its inputs", () => {
    expect(decideFieldOperation("photo", { online: false })).toEqual(decideFieldOperation("photo", { online: false }));
  });

  it("never executes a server-authoritative capability offline (the class rule the catalogue is built on)", () => {
    const cap = { key: "maintenance.clearOutOfService", riskLevel: "restricted" as const, offlineClass: "server_authoritative" as const };
    expect(offlineOutcome(cap, { online: false, draftable: false }).outcome).toBe("unavailable");
    expect(offlineOutcome(cap, { online: false, draftable: true }).outcome).toBe("prepare_and_queue");
  });
});

describe("the server's revalidation: it derives the answer itself", () => {
  it("accepts a packaged capture the policy knows", () => {
    expect(revalidatePackagedOperation("disposal_ticket")).toMatchObject({ accepted: true });
  });

  it("refuses an item whose operation it cannot establish — no seal, unreadable kind, unknown kind", () => {
    for (const recordType of [null, "", "other", "oos_release", "brand_new_type"]) {
      const r = revalidatePackagedOperation(recordType);
      expect(r.accepted, String(recordType)).toBe(false);
    }
  });

  it("refuses a direct capture arriving as packaged evidence", () => {
    const r = revalidatePackagedOperation("board_message");
    expect(r).toMatchObject({ accepted: false });
    if (!r.accepted) expect(r.reason).toMatch(/own procedure/);
  });

  it("reads the kind from the server's own seal manifest, never from anything the package says", () => {
    const manifest = JSON.stringify({ contentHash: "a".repeat(64), recordType: "photo", relationships: [] });
    expect(serverAdapter.recordTypeOfSealManifest(manifest)).toBe("photo");
    expect(serverAdapter.recordTypeOfSealManifest("not json")).toBeNull();
    expect(serverAdapter.recordTypeOfSealManifest(JSON.stringify({ recordType: 7 }))).toBeNull();
    expect(serverAdapter.recordTypeOfSealManifest(null)).toBeNull();
  });

  it("turns a verified item the policy refuses into a rejected one, and leaves hash rejections alone", () => {
    const out = serverAdapter.revalidatePackageItems({
      verdicts: [
        { evidenceRecordId: 1, outcome: "verified", reason: "ok" },
        { evidenceRecordId: 2, outcome: "verified", reason: "ok" },
        { evidenceRecordId: 3, outcome: "rejected", reason: "Content hash differs" },
      ],
      recordTypeById: new Map<number, string | null>([[1, "photo"], [2, null], [3, "photo"]]),
    });
    expect(out.verdicts.map(v => v.outcome)).toEqual(["verified", "rejected", "rejected"]);
    expect(out.verdicts[1].reason).toMatch(/offline field policy/i);
    expect(out.verdicts[2].reason).toBe("Content hash differs");
    expect(out.packageOutcome).toBe("failed");
  });
});

describe("the client consumes the policy: the outbox will not queue what the policy refuses", () => {
  const outbox = (online: boolean) => {
    const clock = new SettableClock(AT);
    const keystore = new MemoryKeystore(clock, "software");
    return new Outbox(new MemoryStore(), new MemoryVault(keystore), clock, new FlagConnectivity(online));
  };

  it("queues a known capture offline", async () => {
    const o = outbox(false);
    const c = await o.saveDraft({ kind: "defect_report", formKey: "defect_report", title: "Hose", category: "defect", fields: {}, unitId: 142 });
    expect((await o.queue(c.localId)).syncState).toBe("queued");
  });

  it("refuses to queue an operation the policy does not know, and keeps the draft", async () => {
    for (const online of [true, false]) {
      const o = outbox(online);
      const c = await o.saveDraft({ kind: "oos_release" as CaptureKind, formKey: null, title: "x", category: "x", fields: {}, unitId: 142 });
      await expect(o.queue(c.localId)).rejects.toBeInstanceOf(FieldOperationRefused);
      const after = (await o.status()).counts;
      expect(after.saved_locally).toBe(1);
      expect(after.queued).toBe(0);
    }
  });

  it("does not take the capture's own word for its class: fields cannot promote an operation", async () => {
    const o = outbox(false);
    const c = await o.saveDraft({ kind: "oos_release" as CaptureKind, formKey: null, title: "x", category: "x", fields: { offlineClass: "local_capture", offlineAllowed: true }, unitId: 142 });
    await expect(o.queue(c.localId)).rejects.toBeInstanceOf(FieldOperationRefused);
  });

  it("treats an outbox with no connectivity as offline, never as online", async () => {
    const clock = new SettableClock(AT);
    const o = new Outbox(new MemoryStore(), new MemoryVault(new MemoryKeystore(clock, "software")), clock);
    const c = await o.saveDraft({ kind: "photo", formKey: null, title: "p", category: "photo", fields: {}, jobId: 1 });
    expect((await o.queue(c.localId)).syncState).toBe("queued");
  });
});

describe("one implementation", () => {
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(e => {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) return e === "node_modules" ? [] : walk(p);
    return /\.(ts|tsx)$/.test(e) && !/\.test\.tsx?$/.test(e) ? [p] : [];
  });
  const sources = [...walk("server"), ...walk("shared"), ...walk("client/src")].map(p => ({ p, body: readFileSync(p, "utf8") }));

  it("defines the policy only in shared/offlinePolicy.ts", () => {
    const definers = sources.filter(s => /export (function|const) (offlineOutcome|validateCapability|envelopeFor|decideFieldOperation|revalidatePackagedOperation|FIELD_OPERATIONS)\b/.test(s.body)).map(s => s.p);
    expect(definers).toEqual(["shared/offlinePolicy.ts"]);
  });

  it("keeps the server engine an adapter over the shared policy, not a second algorithm", () => {
    const body = readFileSync("server/_core/offlineCapability.ts", "utf8");
    expect(body).toMatch(/from "\.\.\/\.\.\/shared\/offlinePolicy"/);
    expect(body).not.toMatch(/switch \(capability\.offlineClass\)/);
  });

  it("has the production field client and the authoritative server path both consume it", () => {
    expect(readFileSync("client/src/runtime/outbox.ts", "utf8")).toMatch(/from "\.\.\/\.\.\/\.\.\/shared\/offlinePolicy"/);
    const router = readFileSync("server/deviceRouter.ts", "utf8");
    expect(router).toMatch(/from "\.\/_core\/offlineCapability"/);
    expect(router).toMatch(/revalidatePackageItems\(/);
  });

  it("never lets client code import the server engine to reuse it", () => {
    const offenders = sources.filter(s => s.p.startsWith("client/") && /server\/_core\/offlineCapability/.test(s.body)).map(s => s.p);
    expect(offenders).toEqual([]);
  });
});
