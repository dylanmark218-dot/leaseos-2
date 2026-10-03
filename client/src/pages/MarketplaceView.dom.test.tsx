import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarketplaceView, type MarketplaceViewProps, type PostingDetail, type PostingRow } from "./MarketplaceView";

afterEach(cleanup);

const posting = (over: Partial<PostingRow> = {}): PostingRow => ({
  postingRef: "MKT-ABCDEFGHJK", title: "Produced water haul — Fox Creek", workType: "FLUID_HAULING", operatingArea: "Fox Creek", pickupLocation: "Fox Creek, AB", destination: "Disposal XYZ",
  unitsRequired: 4, equipmentType: "Tri-drive vac", requestedStart: "2026-10-24T07:00:00Z", biddingClosesAt: "2026-10-22T18:00:00Z", state: "bidding", visibility: "sealed", distribution: "public",
  biddingWindow: { open: true, closesAt: "2026-10-22T18:00:00Z", remainingMs: 18 * 3_600_000 }, isClient: false, version: 3, clientOrgRef: "ORG-CLIENT", ...over,
});
const detail = (over: Partial<PostingDetail> = {}): PostingDetail => ({
  ...posting(), description: "600 m³ produced water, 8 loads estimated.",
  requirements: { workerQualificationCodes: ["H2S_ALIVE", "TDG_ROAD"], organizationDocTypes: ["wcb_clearance"], tdgRequired: true, insurance: { coverageType: "general_liability", minimumLimitCents: 500_000_000, additionalInsuredRequired: false }, equipmentClasses: ["TRI_DRIVE_VAC"], jurisdiction: "CA-AB", clientSpecific: ["Crews attend site orientation"] },
  liveBidCount: 2, openBidRange: null, award: null, invitations: [], ...over,
});
const props = (o: Partial<MarketplaceViewProps> = {}): MarketplaceViewProps => ({
  tab: "board", onTab: vi.fn(), busy: false,
  postings: [posting()], selectedRef: "MKT-ABCDEFGHJK", onSelect: vi.fn(), detail: detail(),
  clarifications: [], onAsk: vi.fn(), onAnswer: vi.fn(), onPublishClarification: vi.fn(), onNotice: vi.fn(),
  onPublish: vi.fn(), onOpenBidding: vi.fn(), onCloseBidding: vi.fn(), onCancel: vi.fn(),
  clientBids: [], onShortlist: vi.fn(), onAward: vi.fn(), onIssueContract: vi.fn(), onNewPosting: vi.fn(),
  readiness: null, myBidOnSelected: null, onSaveDraft: vi.fn(), onSubmit: vi.fn(), onWithdraw: vi.fn(),
  myBids: [], contracts: [], onDispatch: vi.fn(),
  ...o,
});
const ready = (verdict: "submittable" | "blocked") => ({
  verdict, dependencyFingerprint: "MR-" + "a".repeat(64),
  checks: [
    { check: "organization", result: "PASS" as const, blocking: false, detail: "Bidding organization is active." },
    { check: "insurance", result: verdict === "blocked" ? "BLOCK" as const : "PASS" as const, blocking: verdict === "blocked", detail: verdict === "blocked" ? "Customer requires 5000000; policy limit is 2000000" : "general_liability meets the customer's requirement under POL-1" },
    { check: "equipment", result: "WARN" as const, blocking: false, detail: "3 of 4 required compliant unit(s) of class TRI_DRIVE_VAC." },
  ],
  notEvaluated: [{ capability: "hos", decidedBy: "dispatch gate at assignment" }],
});

describe("MarketplaceView — the board as a bidder", () => {
  it("lists postings with their window, shows the selected tender's requirements, and keeps sealed prices sealed", () => {
    render(<MarketplaceView {...props()} />);
    expect(screen.getByTestId("posting-list").textContent).toContain("Bidding open · 18 h left");
    expect(screen.getByTestId("posting-list").textContent).toContain("sealed");
    const req = screen.getByTestId("requirements").textContent!;
    expect(req).toContain("Workers hold H2S_ALIVE");
    expect(req).toContain("Dangerous goods on the haul (TDG)");
    expect(req).toContain("general_liability cover ≥");
    expect(req).toContain("client-stated; not machine-checked");
    expect(screen.getByTestId("posting-detail").textContent).toContain("prices sealed until bidding closes");
  });

  it("shows the bidder its own readiness rows with the six-state vocabulary, and submits only when the server says submittable", () => {
    const onSubmit = vi.fn();
    const bid = { bidRef: "BID-1", posting: { postingRef: "MKT-ABCDEFGHJK", title: "x", state: "bidding" as const }, state: "draft" as const, version: 2, revisions: [], currentReadiness: null, readinessChangedSinceSubmission: null };
    const { unmount } = render(<MarketplaceView {...props({ readiness: ready("blocked"), myBidOnSelected: bid, onSubmit })} />);
    expect(screen.getByTestId("readiness").textContent).toContain("× Blocked");
    expect(screen.getByTestId("readiness").textContent).toContain("policy limit is 2000000");
    expect(screen.getByTestId("readiness").textContent).toContain("! Review");
    expect(screen.getByTestId("readiness").textContent).toContain("Not decided here: hos (dispatch gate at assignment)");
    expect(screen.getByTestId("submit-bid")).toBeDisabled();
    expect(screen.getByTestId("my-bid").textContent).toContain("You can keep preparing this draft");
    unmount();
    render(<MarketplaceView {...props({ readiness: ready("submittable"), myBidOnSelected: bid, onSubmit })} />);
    expect(screen.getByTestId("submit-bid")).toBeEnabled();
    fireEvent.click(screen.getByTestId("submit-bid"));
    expect(onSubmit).toHaveBeenCalledWith("BID-1", 2);
  });

  it("saves a draft only with an integer amount and a positive unit count, passing the pricing shape along", () => {
    const onSaveDraft = vi.fn();
    render(<MarketplaceView {...props({ onSaveDraft })} />);
    const save = screen.getByTestId("save-draft");
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Total in cents"), { target: { value: "1480000" } });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Units offered"), { target: { value: "4" } });
    expect(save).toBeEnabled();
    fireEvent.change(screen.getByLabelText("Pricing type"), { target: { value: "unit_rate" } });
    fireEvent.change(screen.getByLabelText("Rate unit"), { target: { value: "M3" } });
    fireEvent.click(save);
    expect(onSaveDraft).toHaveBeenCalledWith("MKT-ABCDEFGHJK", expect.objectContaining({ pricingType: "unit_rate", amountCents: "1480000", unitsOffered: "4", unit: "M3" }));
  });

  it("asks a question of at least five characters and shows a published clarification with the asker withheld", () => {
    const onAsk = vi.fn();
    render(<MarketplaceView {...props({ onAsk, clarifications: [{ clarificationRef: "CLQ-1", kind: "question", status: "published", askerOrgRef: null, question: "Is disposal included?", answer: "Billed separately by the facility.", mine: false }] })} />);
    expect(screen.getByTestId("discussion").textContent).toContain("Question (asker withheld)");
    expect(screen.getByTestId("discussion").textContent).toContain("Billed separately");
    fireEvent.change(screen.getByLabelText("Your question"), { target: { value: "Is the road weight restricted?" } });
    fireEvent.click(screen.getByText("Ask"));
    expect(onAsk).toHaveBeenCalledWith("MKT-ABCDEFGHJK", "Is the road weight restricted?");
  });
});

describe("MarketplaceView — the board as the client", () => {
  const clientDetail = () => detail({ isClient: true, state: "bidding_closed", biddingWindow: { open: false, reason: "closed_by_client" } });
  const bids = () => [
    { bidRef: "BID-A", bidderOrgRef: "ORG-PRAIRIE", state: "submitted" as const, revisionCount: 2, pricing: { visible: true as const, summary: "CA$19,400.00 fixed", comparableTotalCents: 1_940_000 }, submissionReadiness: { eligibility: "eligible" as const, checks: [{ check: "insurance", result: "PASS" as const }], blockerCount: 0, warningCount: 0 }, currentReadiness: { eligibility: "not_currently_eligible" as const, checks: [{ check: "insurance", result: "BLOCK" as const }], blockerCount: 1, warningCount: 0 }, readinessChangedSinceSubmission: true, unitsOffered: 4 },
    { bidRef: "BID-B", bidderOrgRef: "ORG-ABC", state: "submitted" as const, revisionCount: 1, pricing: { visible: false as const, reason: "This is a sealed tender" }, submissionReadiness: null, currentReadiness: { eligibility: "eligible_with_warnings" as const, checks: [{ check: "equipment", result: "WARN" as const }], blockerCount: 0, warningCount: 1 }, readinessChangedSinceSubmission: false, unitsOffered: 3 },
  ];

  it("shows each bidder's eligibility projection, not its reasons, and awards only with a ten-character rationale", () => {
    const onAward = vi.fn();
    render(<MarketplaceView {...props({ detail: clientDetail(), clientBids: bids(), onAward })} />);
    const a = screen.getByTestId("client-bid-BID-A").textContent!;
    expect(a).toContain("CA$19,400.00 fixed");
    expect(a).toContain("Not currently eligible");
    expect(a).toContain("changed since submission");
    expect(a).not.toContain("policy limit");
    const b = screen.getByTestId("client-bid-BID-B").textContent!;
    expect(b).toContain("Price withheld: This is a sealed tender");
    expect(b).toContain("Eligible with warnings");
    const btn = screen.getByTestId("award-BID-B");
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Award rationale for ORG-ABC"), { target: { value: "too short" } });
    expect(btn).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Award rationale for ORG-ABC"), { target: { value: "Three compliant units on the start date; Prairie's cover lapsed." } });
    fireEvent.click(btn);
    expect(onAward).toHaveBeenCalledWith("MKT-ABCDEFGHJK", "BID-B", "Three compliant units on the start date; Prairie's cover lapsed.", 3);
    expect(screen.getByTestId("client-bids").textContent).toContain("never decided by the lowest number");
  });

  it("offers the lifecycle action the state allows, and a cancel only with a reason", () => {
    const onPublish = vi.fn(), onCancel = vi.fn(), onIssueContract = vi.fn();
    const { unmount } = render(<MarketplaceView {...props({ detail: detail({ isClient: true, state: "draft" }), onPublish, onCancel })} />);
    fireEvent.click(screen.getByText("Publish"));
    expect(onPublish).toHaveBeenCalledWith("MKT-ABCDEFGHJK", 3);
    expect(screen.getByText("Cancel posting")).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Cancellation reason"), { target: { value: "well shut in" } });
    fireEvent.click(screen.getByText("Cancel posting"));
    expect(onCancel).toHaveBeenCalledWith("MKT-ABCDEFGHJK", 3, "well shut in");
    unmount();
    render(<MarketplaceView {...props({ detail: detail({ isClient: true, state: "awarded", award: { awardRef: "AWD-1", contractorOrgRef: "ORG-PRAIRIE", state: "awarded", comparableTotalCents: 1_940_000, currency: "CAD", rationale: "Four units on the date." } }), onIssueContract })} />);
    expect(screen.getByTestId("award").textContent).toContain("Awarded to ORG-PRAIRIE");
    fireEvent.click(screen.getByText("Issue contract"));
    expect(onIssueContract).toHaveBeenCalledWith("MKT-ABCDEFGHJK", 3);
  });

  it("creates a draft posting only with a title and an upper-snake work type", () => {
    const onNewPosting = vi.fn();
    render(<MarketplaceView {...props({ detail: null, selectedRef: null, onNewPosting })} />);
    const create = screen.getByTestId("create-posting");
    expect(create).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Posting title"), { target: { value: "Gravel haul" } });
    fireEvent.change(screen.getByLabelText("Work type"), { target: { value: "gravel" } });
    expect(create).toBeEnabled();
    fireEvent.click(create);
    expect(onNewPosting).toHaveBeenCalledWith(expect.objectContaining({ title: "Gravel haul", workType: "GRAVEL", visibility: "sealed", distribution: "public" }));
  });
});

describe("MarketplaceView — the other tabs", () => {
  it("shows my bids with the submission picture beside the picture now, invitations, awards either way, contracts with the contractor's dispatch door, and an honest empty Completed Work", () => {
    const onDispatch = vi.fn(), onTab = vi.fn(), onSelect = vi.fn();
    const myBids = [{ bidRef: "BID-1", posting: { postingRef: "MKT-ABCDEFGHJK", title: "Produced water haul — Fox Creek", state: "bidding" as const }, state: "submitted" as const, version: 3, revisions: [{ revisionNumber: 1, submittedAt: "2026-10-01T12:00:00Z", summary: "CA$21,000.00 fixed", comparableTotalCents: 2_100_000, readinessVerdict: "submittable" }], currentReadiness: ready("blocked"), readinessChangedSinceSubmission: true }];
    const contracts = [{ contractRef: "CON-1", postingTitle: null, clientOrgRef: "ORG-CLIENT", contractorOrgRef: "ORG-ME", isClient: false, isContractor: true, state: "issued" as const, jobCode: "JOB-X", chainNumber: "JOB-X-C01", dispatchPostingNumber: null }];
    const { unmount } = render(<MarketplaceView {...props({ tab: "bids", myBids, onTab, onSelect })} />);
    const text = screen.getByTestId("my-bids").textContent!;
    expect(text).toContain("readiness at submission: submittable");
    expect(text).toContain("× Blocked");
    expect(text).toContain("changed since submission");
    fireEvent.click(screen.getByText("Produced water haul — Fox Creek"));
    expect(onSelect).toHaveBeenCalledWith("MKT-ABCDEFGHJK");
    expect(onTab).toHaveBeenCalledWith("board");
    unmount();
    const inv = render(<MarketplaceView {...props({ tab: "invitations", postings: [posting({ distribution: "invite_only" })] })} />);
    expect(screen.getByTestId("invitations").textContent).toContain("ORG-CLIENT invited your organization");
    inv.unmount();
    const aw = render(<MarketplaceView {...props({ tab: "awards", postings: [posting({ state: "awarded", isClient: true })], myBids: [{ ...myBids[0]!, state: "rejected" }] })} />);
    expect(screen.getByTestId("awards").textContent).toContain("awarded by you");
    expect(screen.getByTestId("awards").textContent).toContain("not awarded");
    aw.unmount();
    const con = render(<MarketplaceView {...props({ tab: "contracts", contracts, onDispatch })} />);
    expect(screen.getByTestId("contract-CON-1").textContent).toContain("chain JOB-X-C01");
    fireEvent.click(screen.getByTestId("dispatch-CON-1"));
    expect(onDispatch).toHaveBeenCalledWith("CON-1");
    con.unmount();
    render(<MarketplaceView {...props({ tab: "completed" })} />);
    expect(screen.getByTestId("completed").textContent).toContain("no work is called complete before it");
  });
});
