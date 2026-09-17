import { describe, expect, it } from "vitest";
import { matchFacilityStatementLine, type DisposalTicketLite } from "./facilityStatements";

const at = (s: string) => new Date(s);
const T = (o: Partial<DisposalTicketLite> & { id: number }): DisposalTicketLite => ({ facilityTicketNumber: null, scaleInAt: at("2026-09-10T14:00:00Z"), material: "produced water", quantity: 30, quantityUnit: "m3", unitNumber: "U-101", ...o });

describe("matching a facility statement line", () => {
  it("matches on the facility ticket number, carries a quantity variance instead of changing anything, and treats a different unit as a variance", () => {
    const tickets = [T({ id: 1, facilityTicketNumber: "FAC-778" }), T({ id: 2, facilityTicketNumber: "FAC-779" })];
    expect(matchFacilityStatementLine({ tickets, line: { facilityTicketNumber: "fac-778", receivedAt: at("2026-09-10T14:20:00Z"), material: "produced water", quantity: 30, quantityUnit: "m3", unitHint: "U-101" } }))
      .toMatchObject({ outcome: "match", ticketId: 1 });
    expect(matchFacilityStatementLine({ tickets, line: { facilityTicketNumber: "FAC-778", receivedAt: at("2026-09-10T14:20:00Z"), material: null, quantity: 31.5, quantityUnit: "m3", unitHint: null } }))
      .toMatchObject({ outcome: "match_with_variance", ticketId: 1, variances: [expect.stringContaining("Quantity differs")] });
    expect(matchFacilityStatementLine({ tickets, line: { facilityTicketNumber: "FAC-778", receivedAt: at("2026-09-10T14:20:00Z"), material: null, quantity: 30000, quantityUnit: "L", unitHint: null } }))
      .toMatchObject({ outcome: "match_with_variance", variances: [expect.stringContaining("Unit differs")] });
    expect(matchFacilityStatementLine({ tickets, line: { facilityTicketNumber: "FAC-000", receivedAt: at("2026-09-10T14:20:00Z"), material: null, quantity: 30, quantityUnit: "m3", unitHint: null } }))
      .toMatchObject({ outcome: "unmatched" });
  });
  it("without a ticket number, matches only when exactly one ticket fits the window and material; two is ambiguous, not a guess", () => {
    const tickets = [T({ id: 1 }), T({ id: 2, scaleInAt: at("2026-09-10T16:00:00Z") }), T({ id: 3, scaleInAt: at("2026-09-20T16:00:00Z") })];
    const line = { facilityTicketNumber: null, receivedAt: at("2026-09-10T15:00:00Z"), material: "produced water", quantity: 30, quantityUnit: "m3", unitHint: null };
    expect(matchFacilityStatementLine({ tickets, line })).toMatchObject({ outcome: "ambiguous", candidateTicketIds: [1, 2] });
    expect(matchFacilityStatementLine({ tickets: [tickets[0]!, tickets[2]!], line })).toMatchObject({ outcome: "match", ticketId: 1 });
    expect(matchFacilityStatementLine({ tickets, line: { ...line, receivedAt: at("2026-10-01T00:00:00Z") } })).toMatchObject({ outcome: "unmatched" });
  });
  it("lets a business tighten the quantity tolerance", () => {
    const tickets = [T({ id: 1, facilityTicketNumber: "FAC-1", quantity: 100 })];
    const line = { facilityTicketNumber: "FAC-1", receivedAt: at("2026-09-10T14:00:00Z"), material: null, quantity: 100.5, quantityUnit: "m3", unitHint: null };
    expect(matchFacilityStatementLine({ tickets, line }).outcome).toBe("match");                               // 0.5% within the 1% default
    expect(matchFacilityStatementLine({ tickets, line, quantityTolerance: 0.001 }).outcome).toBe("match_with_variance");
  });
});
