import { describe, expect, it } from "vitest";
import type { CommittedField } from "./aiProposal";
import { planAssistantCommit } from "./assistantCommitAdapters";

const committedAt = new Date("2026-09-10T00:00:00Z");
const field = (
  key: string,
  value: string | number | boolean,
  precision: "exact" | "approximate" = "exact"
): CommittedField => ({
  key,
  label: key,
  value,
  precision,
  source: "human_corrected",
  confidence: "high",
  status: "confirmed",
  sourceUtterance: null,
  committedAt,
});

const unload = [
  field("arrivedAt", "23:50"),
  field("waitMinutes", 10),
  field("delayReason", "Queue"),
  field("operationStartedAt", "00:05"),
  field("operationCompletedAt", "00:40"),
  field("quantity", 8000),
  field("measurementMethod", "Meter"),
  field("departedAt", "00:50"),
];

describe("assistant commit adapters", () => {
  it("maps an unload proposal to one typed trip-stop update and rolls midnight once", () => {
    const plan = planAssistantCommit(
      {
        proposalId: "PROP-1",
        formKey: "unload_stop",
        targetRef: "TRIP-1 unload stop",
        targetRecordId: 77,
        tripId: 44,
        eventDateLocal: "2026-09-09",
        utcOffsetMinutes: -360,
        actorUserId: 9,
        capturedAt: committedAt,
      },
      unload
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.intent.kind).toBe("trip_stop_update");
    if (plan.intent.kind !== "trip_stop_update") return;
    expect(plan.intent.requiredPermission).toBe("trip.write");
    expect(plan.intent.values.arrivedAt?.toISOString()).toBe("2026-09-10T05:50:00.000Z");
    expect(plan.intent.values.operationStartedAt?.toISOString()).toBe("2026-09-10T06:05:00.000Z");
    expect(plan.intent.values.operationCompletedAt?.toISOString()).toBe("2026-09-10T06:40:00.000Z");
    expect(plan.intent.values.departedAt?.toISOString()).toBe("2026-09-10T06:50:00.000Z");
    expect(plan.intent.values.quantity).toBe(8000);
    expect(plan.intent.values.quantityUnit).toBe("L");
    expect(plan.intent.measurementMethod).toBe("Meter");
    // The operational trip-stop table has no measurement method column. It is
    // preserved on the receipt instead of being silently invented/flattened.
    expect(plan.intent.values).not.toHaveProperty("measurementMethod");
  });

  it("refuses approximate precision when the target table cannot preserve it", () => {
    const fields = unload.map(f =>
      f.key === "quantity" ? { ...f, precision: "approximate" as const } : f
    );
    const plan = planAssistantCommit(
      {
        proposalId: "PROP-2",
        formKey: "unload_stop",
        targetRef: "stop",
        targetRecordId: 1,
        tripId: 1,
        eventDateLocal: "2026-09-09",
        utcOffsetMinutes: -360,
        actorUserId: 9,
        capturedAt: committedAt,
      },
      fields
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusals.join(" ")).toMatch(/precision channel/);
  });

  it("refuses to guess a target stop, event date, or timezone", () => {
    const plan = planAssistantCommit(
      {
        proposalId: "PROP-3",
        formKey: "unload_stop",
        targetRef: "human label only",
        actorUserId: 9,
        capturedAt: committedAt,
      },
      unload
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusals).toEqual(
      expect.arrayContaining([
        expect.stringContaining("targetRecordId"),
        expect.stringContaining("eventDateLocal"),
        expect.stringContaining("utcOffsetMinutes"),
      ])
    );
  });

  it("creates only an advisory observation for a defect — never an AI diagnosis", () => {
    const plan = planAssistantCommit(
      {
        proposalId: "PROP-4",
        formKey: "defect_report",
        targetRef: "unit 12",
        unitId: 12,
        actorUserId: 9,
        capturedAt: committedAt,
      },
      [
        field("unitNumber", "12"),
        field("system", "Brakes"),
        field("observation", "Pedal feels softer than yesterday"),
        field("isNew", true),
      ]
    );
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.intent.kind).toBe("maintenance_defect_create");
    if (plan.intent.kind !== "maintenance_defect_create") return;
    expect(plan.intent.requiredPermission).toBe("maintenance.write_defect");
    expect(plan.intent.values.severity).toBe("advisory");
    expect(plan.intent.values.detail).toBe("Pedal feels softer than yesterday");
  });

  it("revalidates enums at the write boundary even after human correction", () => {
    const bad = unload.map(f =>
      f.key === "measurementMethod"
        ? { ...f, value: "Trust me" }
        : f
    );
    const plan = planAssistantCommit(
      {
        proposalId: "PROP-ENUM",
        formKey: "unload_stop",
        targetRef: "stop",
        targetRecordId: 1,
        tripId: 1,
        eventDateLocal: "2026-09-09",
        utcOffsetMinutes: -360,
        actorUserId: 9,
        capturedAt: committedAt,
      },
      bad
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusals.join(" ")).toMatch(/measurementMethod must be one of/);
  });

  it("fails closed when no adapter is registered", () => {
    const plan = planAssistantCommit(
      {
        proposalId: "PROP-5",
        formKey: "future_form",
        targetRef: "x",
        actorUserId: 9,
        capturedAt: committedAt,
      },
      []
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.refusals[0]).toMatch(/generic writes are forbidden/);
  });
});
