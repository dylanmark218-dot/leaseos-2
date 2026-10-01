/**
 * The Secretary's idempotency identity fits where it is stored.
 *
 * A propose tool's key is derived from the device's own capture id, so an
 * offline replay proposes once. #7 started passing that key to
 * `assistant.draft`, whose input caps it at 40 characters and which stores it
 * as the proposal id — a `varchar(40)`. The key was the raw
 * `toolKey:clientCaptureId`, which for a propose tool and a standard UUID
 * capture id is about 59 characters: every propose call would have been
 * refused at input validation.
 *
 * The fix hashes a canonical serialization to a bounded, versioned value. The
 * format is pinned by exact vectors below, because a key that silently changes
 * shape on a refactor stops recognising replays — which is the one job it has.
 */
import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import { SECRETARY_TOOLS, idempotencyKeyFor, proposalIdForCapture } from "./_core/ai/tools/registry";

/** What a device actually sends: a v4 UUID. */
const CAPTURE = "3f1c9a52-7d4e-4b8a-9c21-5e6f7a8b9c0d";
const PROPOSE = SECRETARY_TOOLS.filter(t => t.category === "propose");
const IDEMPOTENT = SECRETARY_TOOLS.filter(t => t.requiresIdempotencyKey);

type Parser = { safeParse: (v: unknown) => { success: boolean } };
// Mounted under fieldRoute; the tool registry names it by its permission key, assistant.draft.
type Proc = { _def: { inputs: { shape: Record<string, Parser> }[] } };
const draftInput = (appRouter as unknown as { _def: { procedures: Record<string, Proc> } })._def
  .procedures["fieldRoute.assistant.draft"]!._def.inputs[0]!.shape;

describe("the idempotency key fits assistant.draft", () => {
  it("the raw toolKey:captureId form was too long for any propose tool with a real capture id", () => {
    // The evidence for the defect, kept as a fact about the inputs rather than
    // about the old function: the unhashed identity cannot be the stored key.
    for (const tool of PROPOSE) {
      expect(`${tool.key}:${CAPTURE}`.length).toBeGreaterThan(40);
    }
  });

  it("is at most 40 characters for every idempotent tool", () => {
    for (const tool of IDEMPOTENT) {
      expect(idempotencyKeyFor({ toolKey: tool.key, clientCaptureId: CAPTURE }).length).toBeLessThanOrEqual(40);
    }
    // A capture id of any length still yields a bounded key.
    expect(idempotencyKeyFor({ toolKey: "propose.unloadStop", clientCaptureId: "x".repeat(10_000) }).length).toBeLessThanOrEqual(40);
  });

  it("is accepted by assistant.draft's own input schema", () => {
    for (const tool of PROPOSE) {
      const key = idempotencyKeyFor({ toolKey: tool.key, clientCaptureId: CAPTURE });
      expect(draftInput.idempotencyKey!.safeParse(key).success, key).toBe(true);
    }
  });

  it("fits the proposal id column it becomes (varchar 40)", () => {
    // assistant.draft stores `input.idempotencyKey` as the proposal id.
    const key = idempotencyKeyFor({ toolKey: "propose.preTripFinding", clientCaptureId: CAPTURE });
    expect(key.length).toBeLessThanOrEqual(40);
    expect(key).toMatch(/^[\x21-\x7e]+$/);
  });
});

describe("the idempotency key is a stable identity", () => {
  it("is the same on every retry of the same (tool, capture)", () => {
    const first = idempotencyKeyFor({ toolKey: "propose.unloadStop", clientCaptureId: CAPTURE });
    for (let i = 0; i < 5; i++) {
      expect(idempotencyKeyFor({ toolKey: "propose.unloadStop", clientCaptureId: CAPTURE })).toBe(first);
    }
  });

  it("differs by tool and by capture", () => {
    const keys = new Set<string>();
    for (const tool of IDEMPOTENT) {
      for (const capture of [CAPTURE, "3f1c9a52-7d4e-4b8a-9c21-5e6f7a8b9c0e"]) {
        keys.add(idempotencyKeyFor({ toolKey: tool.key, clientCaptureId: capture }));
      }
    }
    expect(keys.size).toBe(IDEMPOTENT.length * 2);
  });

  it("cannot be confused by a separator inside the capture id", () => {
    // A plain `a:b` join would make ("x", "y:z") and ("x:y", "z") the same key.
    expect(idempotencyKeyFor({ toolKey: "x", clientCaptureId: "y:z" })).not.toBe(
      idempotencyKeyFor({ toolKey: "x:y", clientCaptureId: "z" })
    );
  });

  it("carries nothing readable from its inputs", () => {
    const key = idempotencyKeyFor({ toolKey: "propose.unloadStop", clientCaptureId: CAPTURE });
    expect(key).toMatch(/^IK1-[0-9a-f]{36}$/);
    expect(key).not.toContain(CAPTURE.slice(0, 8));
    expect(key).not.toContain("unload");
  });

  it("is pinned to its version-1 format", () => {
    // Exact vectors. If these move, every in-flight offline replay is
    // re-proposed instead of recognised: change the version, not the value.
    expect(idempotencyKeyFor({ toolKey: "propose.unloadStop", clientCaptureId: CAPTURE })).toBe(
      "IK1-592737cff9cf30c0fe7faa2eb73ffd36ada0"
    );
  });

  it("depends on the tool key alone for everything server-owned", () => {
    // The identity is (toolKey, capture). That is complete only because a tool's
    // procedure and pinned form are constants of its registry entry — the caller
    // cannot supply either. Two entries sharing a key would break that.
    expect(new Set(SECRETARY_TOOLS.map(t => t.key)).size).toBe(SECRETARY_TOOLS.length);
  });
});

describe("the worker's proposal id", () => {
  it("is a bounded, deterministic identity for the capture", () => {
    const id = proposalIdForCapture(CAPTURE);
    expect(id.length).toBeLessThanOrEqual(40);
    expect(id).toBe(proposalIdForCapture(CAPTURE));
    expect(id).not.toBe(proposalIdForCapture("3f1c9a52-7d4e-4b8a-9c21-5e6f7a8b9c0e"));
    expect(id).toMatch(/^PROP-[0-9a-f]{35}$/);
  });

  it("keeps the identity #7 shipped: PROP- and the first 35 hex of sha256(captureId)", () => {
    // Moving the hashing out of the job body must not change the id.
    expect(proposalIdForCapture(CAPTURE)).toBe("PROP-b4d155faeaa91bc0ccf78744b6ef3ec11d1");
  });
});
