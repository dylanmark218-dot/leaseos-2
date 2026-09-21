import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommercialOfficeView, type CommercialOfficeViewProps } from "./CommercialOfficeView";

afterEach(cleanup);
const props = (o: Partial<CommercialOfficeViewProps> = {}): CommercialOfficeViewProps => ({
  tab: "organizations", onTab: vi.fn(), orgQuery: "", onOrgQuery: vi.fn(),
  organizations: [{ orgRef: "ORG-1", name: "Fixture Energy", status: "active", roles: [{ roleKey: "client", commercialNumber: "CLI-000001" }] }, { orgRef: "ORG-2", name: "Big Iron", status: "active", roles: [] }],
  roleTypes: [{ roleKey: "client", label: "Client" }, { roleKey: "vendor", label: "Vendor" }], onCreateOrganization: vi.fn(), creating: false, onAssignRole: vi.fn(),
  candidateType: "vendor", onCandidateType: vi.fn(), candidates: [{ recordType: "vendor", recordId: 7, capturedName: "Big Iron", orgRef: "ORG-2", organizationName: "Big Iron", evidence: "exact_name_match", applied: false }], unlinkedCount: 3, onLink: vi.fn(),
  docFilter: { documentType: "", recordType: "", recordRef: "", includeSuperseded: false }, onDocFilter: vi.fn(), documents: [], selectedDoc: null, onSelectDoc: vi.fn(),
  statements: [], selectedStatement: null, onSelectStatement: vi.fn(), lines: [], onResolveLine: vi.fn(), resolving: false,
  entityId: "", onEntityId: vi.fn(), period: { from: "2026-09-01", to: "2026-09-30" }, onPeriod: vi.fn(), arAging: null, apAging: null, glReadiness: null, profitability: null, profitDimension: "job", onProfitDimension: vi.fn(), ...o,
});

describe("CommercialOfficeView", () => {
  it("shows organizations with their roles and numbers, offers roles for the one without, and proposes link candidates without applying them", () => {
    const onLink = vi.fn(), onAssignRole = vi.fn();
    render(<CommercialOfficeView {...props({ onLink, onAssignRole })} />);
    expect(screen.getByTestId("org-list").textContent).toContain("CLI-000001");
    expect(screen.getByTestId("org-list").textContent).toContain("no role yet");
    fireEvent.click(screen.getAllByText("+ Client")[0]!);
    expect(onAssignRole).toHaveBeenCalledWith("ORG-2", "client");
    expect(screen.getByTestId("candidates").textContent).toContain("exact name match");
    fireEvent.click(screen.getByText("Link"));
    expect(onLink).toHaveBeenCalledWith(expect.objectContaining({ recordId: 7, orgRef: "ORG-2" }));
  });
  it("creates an organization only with a name, passing the first role along", () => {
    const onCreateOrganization = vi.fn();
    render(<CommercialOfficeView {...props({ onCreateOrganization })} />);
    expect(screen.getByTestId("create-org")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Organization name"), { target: { value: "R360 Environmental Solutions" } });
    fireEvent.change(screen.getByLabelText("First role"), { target: { value: "vendor" } });
    fireEvent.click(screen.getByTestId("create-org"));
    expect(onCreateOrganization).toHaveBeenCalledWith("R360 Environmental Solutions", "vendor");
  });
  it("requires a ten-character note and, for an ambiguous line, a chosen ticket before resolving", () => {
    const onResolveLine = vi.fn();
    render(<CommercialOfficeView {...props({ tab: "disposal", selectedStatement: "FST-1", statements: [{ statementRef: "FST-1", facilityOrgRef: "ORG-9", periodStart: "2026-08-01", periodEnd: "2026-08-31", lineCount: 3, matchedCount: 1, varianceCount: 1, unmatchedCount: 0, ambiguousCount: 1, status: "open", openLines: 2 }], lines: [{ lineNo: 2, facilityTicketNumber: null, matchOutcome: "ambiguous", resolution: null, variances: null, candidateTicketIds: [11, 12], quantity: 8, amountCents: 120000 }], onResolveLine })} />);
    expect(screen.getByTestId("statements").textContent).toContain("2 open");
    fireEvent.click(screen.getByText("Resolve…"));
    const btn = screen.getByTestId("resolve-2");
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Resolution note"), { target: { value: "facility ticket 12 matches the scale weight" } });
    expect(btn).toBeDisabled();   // ambiguous: a chosen ticket is still required
    fireEvent.change(screen.getByLabelText("Chosen ticket id"), { target: { value: "12" } });
    expect(btn).toBeEnabled();
    fireEvent.click(btn);
    expect(onResolveLine).toHaveBeenCalledWith("FST-1", 2, "accepted", "facility ticket 12 matches the scale weight", 12);
  });
  it("shows GL blockers by name and never an export button, and says when a profitability dimension is not derivable", () => {
    render(<CommercialOfficeView {...props({ tab: "month_close", entityId: "7", glReadiness: { state: "BLOCKED", blockers: [{ reason: "revenue:disposal is posted 4 times and has no GL account" }] }, profitability: { dimension: "driver", derivable: "no", note: "invoices carry no driver; not derivable from evidence links", rows: [] }, arAging: { organizations: [{ orgRef: "ORG-1", label: "Fixture Energy", buckets: {}, totalOutstandingCents: 350000 }], unlinked: [{ label: "ABC Energy (captured name)", totalOutstandingCents: 1000 }] }, apAging: { organizations: [], unlinked: [] } })} />);
    expect(screen.getByTestId("gl").textContent).toContain("BLOCKED");
    expect(screen.getByTestId("gl").textContent).toContain("revenue:disposal");
    expect(screen.queryByText(/export now/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("profitability").textContent).toContain("Not derivable");
    expect(screen.getByTestId("aging-ar").textContent).toContain("unlinked");
  });
});
