// Fixture permissions translated from the engine's scratch vocabulary to the branch's real permission names (B28 port).
/**
 * B28C — authorization, data source and domain engine are three facts.
 */
import { describe, expect, it } from "vitest";
import {
  contractConfirmed, hasFabricatedProcedure, SOURCE_CONTRACTS,
  type WidgetSourceContract,
} from "./_core/widgetSourceContract";
import { definitionFor } from "./_core/widgetRegistry";

describe("the three contracts can disagree", () => {
  it("lets a server widget share one answer across all three", () => {
    const c = SOURCE_CONTRACTS.hosRemaining as WidgetSourceContract;
    expect(c.authorization).toMatchObject({ kind: "procedure", procedure: "hos.status" });
    expect(c.data).toMatchObject({ kind: "server", procedure: "hos.status" });
    expect(c.domain.confidence).toBe("CONFIRMED");
  });

  it("lets a confirmed data source sit beside an unresolved authorization", () => {
    // dispatch.readiness is real; its permission is not evidenced. One field
    // could not hold both facts.
    const c = SOURCE_CONTRACTS.dispatchReadiness as WidgetSourceContract;
    expect(c.data).toMatchObject({ kind: "server", procedure: "dispatch.readiness" });
    expect(c.authorization.kind).toBe("unresolved");
    expect(contractConfirmed(c)).toBe(false);
  });

  it("lets a device-local widget have no server procedure at all", () => {
    const c = SOURCE_CONTRACTS.syncStatus as WidgetSourceContract;
    expect(c.data).toMatchObject({ kind: "device_local", resolver: "sync_queue" });
    expect(c.authorization.kind).toBe("unresolved");
    // No procedure field anywhere in the data contract.
    expect(JSON.stringify(c.data)).not.toContain("procedure");
  });
});

describe("fabricated procedures", () => {
  it("flags a device-local widget carrying a server procedure", () => {
    const fabricated: WidgetSourceContract = {
      authorization: { kind: "procedure", procedure: "hos.status" },
      data: { kind: "device_local", resolver: "sync_queue" },
      domain: { engine: "device outbox", confidence: "PARTIAL" },
    };
    expect(hasFabricatedProcedure(fabricated)).toBe(true);
  });

  it("does not flag a legitimate server widget", () => {
    expect(hasFabricatedProcedure(SOURCE_CONTRACTS.hosRemaining as WidgetSourceContract)).toBe(false);
  });

  it("does not flag the device-local widget once its procedure is gone", () => {
    expect(hasFabricatedProcedure(SOURCE_CONTRACTS.syncStatus as WidgetSourceContract)).toBe(false);
  });
});

describe("the registry still carries the old model", () => {
  it("still gives syncStatus a server procedure it may not need", () => {
    // Documented, not fixed. Migrating the registry needs evidence for what
    // authorizes a device-local widget, and the 0088 snapshot has none.
    expect(definitionFor("syncStatus").procedure).toBe("sync.receivePackage");
    expect((SOURCE_CONTRACTS.syncStatus as WidgetSourceContract).data.kind).toBe("device_local");
  });

  it("confirms nothing while any part is unresolved", () => {
    for (const [key, c] of Object.entries(SOURCE_CONTRACTS)) {
      if (key === "hosRemaining") { expect(contractConfirmed(c)).toBe(true); continue; }
      expect(contractConfirmed(c), key).toBe(false);
    }
  });
});
