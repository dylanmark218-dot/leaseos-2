/**
 * SPINE item 3 follow-up — the server re-checks the one offline policy at sync.
 *
 * #143 put the policy on the device: each capture kind declares `requiresOnline` once, read only
 * through `actionGateway.mayRunWithoutServer`, and the gated outbox obeys it. The device is not an
 * authorization boundary, so the server asks the same question again when a package arrives — from
 * the same declaration, about the operation the server's OWN seal recorded. One fact, two
 * enforcement points. These are the pure halves; the database half is
 * `spineItem3SyncRecheck.db.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { CAPTURE_POLICY, capturePolicyFor } from "./_core/captureOperations";
import { applyOperationPolicy, recordTypeOfSealManifest, revalidatePackagedCapture } from "./_core/fieldDevice";
import { CAPTURE_OPERATIONS } from "../client/src/runtime/capabilities";

describe("one declaration, read by both sides", () => {
  it("the device's CAPTURE_OPERATIONS carry exactly the server's policy fields, kind for kind", () => {
    for (const [kind, op] of Object.entries(CAPTURE_OPERATIONS)) {
      const policy = capturePolicyFor(kind);
      expect(policy, kind).not.toBeNull();
      expect({ key: op.key, riskLevel: op.riskLevel, requiresOnline: op.requiresOnline, draftable: op.draftable }, kind).toEqual(policy);
    }
    expect(Object.keys(CAPTURE_POLICY).sort()).toEqual(Object.keys(CAPTURE_OPERATIONS).sort());
  });

  it("the client no longer declares requiresOnline itself — it takes the server module's value", () => {
    expect(readFileSync("client/src/runtime/capabilities.ts", "utf8")).not.toMatch(/requiresOnline\s*:/);
  });

  it("looks up own keys only: an inherited name is not an operation", () => {
    for (const k of ["toString", "constructor", "__proto__", "", "oos_release"]) expect(capturePolicyFor(k), k).toBeNull();
    expect(capturePolicyFor(null)).toBeNull();
  });
});

describe("the server derives the operation from its own seal", () => {
  it("reads recordType from the seal manifest the server built", () => {
    expect(recordTypeOfSealManifest(JSON.stringify({ contentHash: "a".repeat(64), recordType: "defect_report" }))).toBe("defect_report");
  });

  it("treats a malformed or empty manifest as no operation at all", () => {
    for (const m of [null, undefined, "", "not json", "null", "[]", JSON.stringify({ recordType: 7 }), JSON.stringify({ recordType: "" }), JSON.stringify({})]) {
      expect(recordTypeOfSealManifest(m as string | null | undefined), String(m)).toBeNull();
    }
  });
});

describe("the re-check: the same policy, decided again on the server", () => {
  it("accepts evidence the policy lets run without the server", () => {
    expect(revalidatePackagedCapture("defect_report")).toEqual({ accepted: true });
    expect(revalidatePackagedCapture("photo")).toEqual({ accepted: true });
  });

  it("refuses a connected-required operation arriving as offline-captured evidence", () => {
    for (const k of ["board_message", "board_acknowledgement", "shift_response"]) {
      expect(revalidatePackagedCapture(k), k).toMatchObject({ accepted: false, code: "CONNECTED_REQUIRED" });
    }
  });

  it("fails closed on an operation it cannot establish", () => {
    for (const k of [null, "", "other", "oos_release", "toString"]) {
      expect(revalidatePackagedCapture(k), String(k)).toMatchObject({ accepted: false, code: "UNKNOWN_OPERATION" });
    }
  });

  it("applies the CURRENT policy: an operation that was offline-safe when captured and is connected-required now is refused", () => {
    const changed = (kind: string | null | undefined) => {
      const p = capturePolicyFor(kind);
      return p && kind === "photo" ? { ...p, requiresOnline: true } : p;
    };
    expect(revalidatePackagedCapture("photo")).toEqual({ accepted: true });
    expect(revalidatePackagedCapture("photo", changed)).toMatchObject({ accepted: false, code: "CONNECTED_REQUIRED" });
  });

  it("only rejects: a hash rejection stands, a policy refusal rejects, and nothing is promoted to verified", () => {
    const out = applyOperationPolicy({
      verdicts: [
        { evidenceRecordId: 1, outcome: "verified", reason: "ok" },
        { evidenceRecordId: 2, outcome: "verified", reason: "ok" },
        { evidenceRecordId: 3, outcome: "rejected", reason: "Content hash differs" },
        { evidenceRecordId: 4, outcome: "rejected", reason: "Manifest hash differs" },
      ],
      recordTypeById: new Map<number, string | null>([[1, "photo"], [2, "board_message"], [3, "photo"], [4, null]]),
    });
    expect(out.verdicts.map(v => v.outcome)).toEqual(["verified", "rejected", "rejected", "rejected"]);
    expect(out.verdicts[1].reason).toMatch(/offline policy.*connected-required|CONNECTED_REQUIRED/i);
    expect(out.verdicts[2].reason).toBe("Content hash differs");
    expect(out.verdicts[3].reason).toBe("Manifest hash differs");
    expect(out.packageOutcome).toBe("failed");
  });
});

describe("where the re-check runs", () => {
  const router = readFileSync("server/deviceRouter.ts", "utf8");

  it("sync.receivePackage applies it after the hash checks, from the seal manifest", () => {
    expect(router).toMatch(/applyOperationPolicy\(/);
    expect(router).toMatch(/recordTypeOfSealManifest\(/);
    expect(router).toMatch(/canonicalManifest: evidenceSeals\.canonicalManifest/);
  });

  it("does not import HS1 or the device composition: hardware never feeds the server's answer", () => {
    expect(router).not.toMatch(/hardwareCapability|offlineCapability/);
    expect(readFileSync("server/_core/fieldDevice.ts", "utf8")).not.toMatch(/hardwareCapability|offlineCapability/);
  });

  it("asks mayRunWithoutServer rather than reading requiresOnline", () => {
    const engine = readFileSync("server/_core/fieldDevice.ts", "utf8");
    expect(engine).toMatch(/mayRunWithoutServer\(/);
    expect(engine).not.toMatch(/\.requiresOnline\b/);
  });
});
