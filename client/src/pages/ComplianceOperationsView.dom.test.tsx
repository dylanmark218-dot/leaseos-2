import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RenewalQueuePanel, SourceReviewPanel, SystemExceptionsPanel, VerificationQueuePanel } from "./ComplianceOperationsView";
import { renewalRows, sourceRows, sweepRuns, verificationItems } from "./complianceOpsFixtures";

afterEach(cleanup);

describe("RenewalQueuePanel", () => {
  it("shows days remaining, readiness impact, handoff, last reminder and next escalation; a company review is never called expired", () => {
    render(<RenewalQueuePanel rows={renewalRows} notice="Company notification policy" />);
    const q = screen.getByTestId("renewal-queue").textContent!;
    expect(q).toContain("Expires in 12 day(s)");
    expect(q).toContain("H2S Alive for sour sites");
    expect(q).toContain("requested");
    expect(q).toContain("URGENT: H2S Alive expires in 14 days");
    expect(q).toContain("7-day notice in 5 day(s)");
    expect(q).toContain("Company review overdue");
    expect(q).not.toMatch(/Expired 3/);
  });
});

describe("VerificationQueuePanel", () => {
  it("verifies exactly what was uploaded, requires a reason to reject or correct, and disables self-review", () => {
    const onVerify = vi.fn(), onReject = vi.fn(), onRequestCorrection = vi.fn();
    render(<VerificationQueuePanel items={verificationItems} onVerify={onVerify} onReject={onReject} onRequestCorrection={onRequestCorrection} busy={false} />);
    const row = within(screen.getByTestId("verify-FIRST_AID"));
    expect(row.getByText("Verify as uploaded")).toBeDisabled();
    fireEvent.change(row.getByLabelText("What you checked against"), { target: { value: "Red Cross registry" } });
    fireEvent.click(row.getByText("Verify as uploaded"));
    expect(onVerify).toHaveBeenCalledWith(expect.objectContaining({ holdingRef: "WQ-9", method: "document_inspection", verificationSource: "Red Cross registry", expiresAt: new Date("2029-09-01") }));
    expect(row.getByText("Request correction")).toBeDisabled();
    fireEvent.change(row.getByLabelText("Reason (reject or correction)"), { target: { value: "Expiry year does not match card" } });
    fireEvent.click(row.getByText("Request correction"));
    expect(onRequestCorrection).toHaveBeenCalledWith("WQ-9", "Expiry year does not match card");
    const own = within(screen.getByTestId("verify-H2S_ALIVE"));
    expect(own.getByText(/This is your own credential/)).toBeInTheDocument();
    expect(own.getByText("Verify as uploaded")).toBeDisabled();
    expect(own.getByText("Reject")).toBeDisabled();
  });
});

describe("SourceReviewPanel", () => {
  it("shows authority, edition, fingerprint and what a source governs; offers only the next legal action", () => {
    const onAct = vi.fn();
    render(<SourceReviewPanel sources={sourceRows} onAct={onAct} busy={false} />);
    const current = within(screen.getByTestId("source-SRC-TDG"));
    expect(current.getByText(/legacy-stableHash/)).toBeInTheDocument();
    expect(current.getByText(/6 lesson\(s\), 40 question\(s\)/)).toBeInTheDocument();
    expect(current.queryByText("Approve (second person)")).toBeNull();
    fireEvent.change(current.getByLabelText("Review note (10+ characters)"), { target: { value: "2026 consolidation replaces it" } });
    expect(current.getByText("Mark superseded")).toBeDisabled();
    fireEvent.change(current.getByLabelText("Superseded by"), { target: { value: "SRC-TDG@v2" } });
    fireEvent.click(current.getByText("Mark superseded"));
    expect(onAct).toHaveBeenCalledWith("SRC-TDG", "MARK_SUPERSEDED", "2026 consolidation replaces it", "SRC-TDG@v2");
    const next = within(screen.getByTestId("source-SRC-TDG@v2"));
    expect(next.getByText("Review")).toBeDisabled();
    expect(next.getByText(/source unreviewed/)).toBeInTheDocument();
  });
});

describe("SystemExceptionsPanel", () => {
  it("labels sweep failures as SYSTEM FAILURE and lists run health", () => {
    render(<SystemExceptionsPanel runs={sweepRuns} exceptions={[{ key: "sweep-failure:RUN-1", title: "SYSTEM FAILURE — renewal sweep: NOTIFICATION_WRITE_FAILED", reason: "This says nothing about whether the credential is valid." }]} notice="A failed run says nothing about any credential." />);
    const p = screen.getByTestId("system-exceptions").textContent!;
    expect(p).toContain("System failure");
    expect(p).toContain("says nothing about whether the credential is valid");
    expect(p).toContain("partial");
    expect(p).toContain("NOTIFICATION_WRITE_FAILED");
  });
});
