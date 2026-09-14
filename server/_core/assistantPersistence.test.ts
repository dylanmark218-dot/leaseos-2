import { describe, expect, it } from "vitest";
import { generateReadBack } from "./aiProposal";
import { rehydrateProposal } from "./assistantPersistence";

const completeUnloadFields = [
  ["arrivedAt", "Arrived", "10:00", "exact"],
  ["operationStartedAt", "Unloading started", "10:15", "exact"],
  ["operationCompletedAt", "Unloading complete", "10:40", "exact"],
  ["quantity", "Quantity", 8000, "exact"],
  ["measurementMethod", "Measured by", "Meter", "exact"],
] as const;

const fieldRows = completeUnloadFields.map(([fieldKey, label, value, precision]) => ({
  fieldKey,
  label,
  fieldValue: JSON.stringify(value),
  precision,
  source: "human_corrected" as const,
  confidence: "high" as const,
  status: "confirmed" as const,
  sourceUtterance: null,
  correctedFrom: null,
}));

const row = {
  proposalId: "PROP-rehydrate",
  formKey: "unload_stop",
  targetRef: "TRIP-42 unload stop",
  readBack: null,
  readBackAcknowledged: false,
  commitState: "drafting" as const,
};

describe("rehydrateProposal", () => {
  it("recomputes gaps from persisted fields instead of keeping the empty-proposal gaps", () => {
    const proposal = rehydrateProposal(row, fieldRows);
    expect(proposal.gaps).toEqual([]);
    expect(proposal.questions).toEqual([]);
  });

  it("allows a complete persisted proposal to enter read-back", () => {
    const proposal = generateReadBack(rehydrateProposal(row, fieldRows));
    expect(proposal.commitState).toBe("awaiting_readback");
    expect(proposal.readBack).toContain("quantity 8000");
  });

  it("still derives a real gap when a required persisted field is absent", () => {
    const proposal = rehydrateProposal(
      row,
      fieldRows.filter(f => f.fieldKey !== "quantity")
    );
    expect(proposal.gaps.map(g => g.key)).toContain("quantity");
  });

  it("fails closed when a persisted form definition is unknown", () => {
    expect(() =>
      rehydrateProposal({ ...row, formKey: "retired_form" }, fieldRows)
    ).toThrow(/cannot be safely rehydrated/);
  });
});
