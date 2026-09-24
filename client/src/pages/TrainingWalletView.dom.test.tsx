import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompliancePanel, PathwayPanel, StudyCentrePanel, TutorPanel, WalletPanel, type StudyCourse, type WalletData } from "./TrainingWalletView";

afterEach(cleanup);

const wallet = (o: Partial<WalletData> = {}): WalletData => ({
  disclaimer: "Studied, demonstrated, held, expiring and arranged are five different answers.",
  studied: [{ ref: "A1", courseCode: "H2S-TRACK", title: "H2S Alive external credential tracking", status: "completed", note: "Study/preparation only — not a licence, endorsement or external certificate" }],
  demonstrated: [],
  credentials: [
    { holdingRef: "H1", code: "H2S_ALIVE", displayName: "H2S Alive® (Energy Safety Canada)", issuer: "ESC provider", issuingJurisdiction: "CA", certificateNumber: "123", issuedAt: "2024-01-01", expiresAt: "2027-01-01", endorsements: [], restrictions: [], verificationState: "verified", verifiedAt: "2024-01-05", boundary: "external_provider", lifecycle: "actual_expiry", current: true, supersededByHoldingRef: null },
    { holdingRef: "H2", code: "FIRST_AID", displayName: "Alberta workplace First Aid", issuer: null, issuingJurisdiction: null, certificateNumber: null, issuedAt: null, expiresAt: "2028-01-01", endorsements: [], restrictions: [], verificationState: "unverified", verifiedAt: null, boundary: "external_provider", lifecycle: "actual_expiry", current: false, supersededByHoldingRef: null },
    { holdingRef: "H3", code: "AIR_BRAKE_Q", displayName: "Alberta air-brake (Q) endorsement", issuer: null, issuingJurisdiction: "CA-AB", certificateNumber: null, issuedAt: "2020-01-01", expiresAt: null, endorsements: [], restrictions: [], verificationState: "verified", verifiedAt: "2020-01-02", boundary: "regulator_issued", lifecycle: "no_expiry_endorsement", current: true, supersededByHoldingRef: null },
  ],
  expiring: [{ code: "H2S_ALIVE", basis: "actual_expiry", legalExpiry: "2027-01-01", employerReviewAt: null, labels: ["Certificate expires 2027-01-01"], held: true, heldReason: "", canRequestTraining: true }],
  arranged: [{ handoffRef: "HO-1", code: "FIRST_AID", status: "BOOKED", worker: { label: "Booked", step: 3 }, appointmentAt: null, bookingReference: "BK-9", requestedAt: "2026-09-01" }],
  ...o,
});

describe("WalletPanel", () => {
  it("separates verified from uploaded, never shows Q as expiring, and wires Request Training", () => {
    const onRequestTraining = vi.fn(), onHandoffDone = vi.fn();
    render(<WalletPanel wallet={wallet()} policies={[]} onRequestTraining={onRequestTraining} requesting={false} onUpload={vi.fn()} uploading={false} onHandoffDone={onHandoffDone} />);
    expect(screen.getByTestId("credential-FIRST_AID").textContent).toContain("Uploaded — verification required");
    expect(screen.getByTestId("credential-AIR_BRAKE_Q").textContent).toContain("No renewal by rule");
    expect(screen.getByTestId("credential-AIR_BRAKE_Q").textContent).not.toContain("Expires");
    fireEvent.click(screen.getByText("Request training / renewal"));
    expect(onRequestTraining).toHaveBeenCalledWith("H2S_ALIVE");
    expect(screen.getByTestId("handoffs").textContent).toContain("Booked");
    fireEvent.click(screen.getByText("I finished the training"));
    expect(onHandoffDone).toHaveBeenCalledWith("HO-1");
    expect(screen.getByText(/not a licence, endorsement or external certificate/)).toBeInTheDocument();
  });
  it("will not add a credential without a document reference", () => {
    render(<WalletPanel wallet={wallet()} policies={[{ qualificationCode: "FIRST_AID", displayName: "Alberta workplace First Aid", boundary: "external_provider", lifecycle: "actual_expiry" }]} onRequestTraining={vi.fn()} requesting={false} onUpload={vi.fn()} uploading={false} onHandoffDone={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Credential"), { target: { value: "FIRST_AID" } });
    expect(screen.getByTestId("upload")).toBeDisabled();
  });
});

const course: StudyCourse = {
  courseCode: "AIRBRAKE-Q", title: "Air Brake Q Preparation (study only)", jurisdiction: "CA-AB", track: "commercial_driver",
  boundaryNotice: "Preparation only. Completion never creates a Q endorsement.", currentVersion: { ref: "AIRBRAKE-Q:2", number: 2 }, moduleCount: 5, bankSize: 25, mockQuestionCount: 25,
  enrolment: { assignmentRef: "ASG-1", status: "in_progress", onCurrentVersion: true, resumeModule: "AIRQ-03" },
  sources: [{ sourceRef: "SRC-AB-COMMERCIAL-GUIDE", title: "Commercial Driver's Guide", edition: "Spring 2025", url: "https://open.alberta.ca/publications/commercial-drivers-guide", reviewStatus: "unreviewed" }],
};

describe("StudyCentrePanel", () => {
  it("shows the boundary notice and source/version on every course and resumes where the learner left off", () => {
    const onOpenLessons = vi.fn(), onOpen = vi.fn();
    render(<StudyCentrePanel courses={[course]} onEnroll={vi.fn()} onOpen={onOpen} onOpenLessons={onOpenLessons} attempt={null} feedback={{}} onAnswer={vi.fn()} answers={{}} onSubmit={vi.fn()} result={null} onBookmark={vi.fn()} />);
    expect(screen.getByTestId("boundary-notice").textContent).toContain("never creates a Q endorsement");
    expect(screen.getByText(/Spring 2025/)).toBeInTheDocument();
    expect(screen.getByText(/not yet reviewed by your company/)).toBeInTheDocument();
    fireEvent.click(screen.getByText("Resume at AIRQ-03"));
    expect(onOpenLessons).toHaveBeenCalledWith("ASG-1");
    fireEvent.click(screen.getByText("Mock exam (25 questions)"));
    expect(onOpen).toHaveBeenCalledWith("ASG-1", "MOCK_EXAM");
  });
  it("practice mode shows the explanation and the source section after answering", () => {
    const attempt = { attemptRef: "ATT", kind: "PRACTICE" as const, notice: "Original LeaseOS practice questions — not government exam questions.", questions: [{ questionCode: "AIRQ-P01", domain: "supply", prompt: "What does the governor do?", options: ["Controls cut-in/cut-out", "Releases springs", "Warns", "Meters"], sourceSection: "Ch. 3 — Trip air brake inspection" }] };
    const onAnswer = vi.fn();
    const { rerender } = render(<StudyCentrePanel courses={[course]} onEnroll={vi.fn()} onOpen={vi.fn()} onOpenLessons={vi.fn()} attempt={attempt} feedback={{}} onAnswer={onAnswer} answers={{}} onSubmit={vi.fn()} result={null} onBookmark={vi.fn()} />);
    expect(screen.getByTestId("practice").textContent).toContain("not government exam questions");
    fireEvent.click(screen.getByText("Releases springs"));
    expect(onAnswer).toHaveBeenCalledWith("AIRQ-P01", 1);
    rerender(<StudyCentrePanel courses={[course]} onEnroll={vi.fn()} onOpen={vi.fn()} onOpenLessons={vi.fn()} attempt={attempt} feedback={{ "AIRQ-P01": { correct: false, correctPresentedIndex: 0, explanation: "The governor sets cut-out and cut-in.", source: { title: "Commercial Driver's Guide", section: "Ch. 3 — Trip air brake inspection", edition: "Spring 2025", url: null, reviewStatus: "unreviewed" }, studyThisTopic: { code: "AIRQ-01", title: "Compressor, governor and reservoirs" } } }} onAnswer={onAnswer} answers={{ "AIRQ-P01": 1 }} onSubmit={vi.fn()} result={null} onBookmark={vi.fn()} />);
    expect(screen.getByTestId("feedback").textContent).toContain("Not quite.");
    expect(screen.getByTestId("feedback").textContent).toContain("Ch. 3 — Trip air brake inspection");
    expect(screen.getByTestId("feedback").textContent).toContain("Study this topic: AIRQ-01");
  });
});

describe("TutorPanel, PathwayPanel, CompliancePanel", () => {
  it("labels an unsupported answer UNKNOWN — refer to authority", () => {
    render(<TutorPanel onAsk={vi.fn()} asking={false} answer={{ status: "UNKNOWN_REFER_TO_AUTHORITY", lines: ["UNKNOWN — the approved training sources do not support an answer."], citations: [], referTo: [{ sourceRef: "SRC-AB-C1LP", title: "Class 1 Learning Pathway", url: "https://www.alberta.ca/class-1-learning-pathway" }], practice: [], notice: "Refer to the authority." }} />);
    expect(screen.getByTestId("tutor-answer").textContent).toContain("UNKNOWN — refer to authority");
    expect(screen.getByText("Class 1 Learning Pathway")).toBeInTheDocument();
  });
  it("shows eligibility steps as UNKNOWN — verify with authority", () => {
    render(<PathwayPanel pathways={[{ code: "P", title: "Class 3 → Class 1", disclaimer: "A development view only.", steps: [{ code: "C1LP", title: "Official C1LP", state: "UNKNOWN_VERIFY_WITH_AUTHORITY", detail: "Verify with the authority" }] }]} />);
    expect(screen.getByTestId("pathway").textContent).toContain("UNKNOWN — verify with authority");
  });
  it("gives admin the request's facts and one-tap marks, and says readiness is unchanged", () => {
    const onMark = vi.fn();
    render(<CompliancePanel dashboard={{ headlines: ["3 people's H2S_ALIVE expire within 30 days."], people: 5, views: { expiringSoon: [1, 2, 3], studiedNotHeld: [1] } }} queue={[{ handoffRef: "HO-1", status: "REQUESTED", employee: { userId: 9, name: "Sam" }, credential: { code: "H2S_ALIVE", displayName: "H2S Alive®" }, currentExpiry: "2026-10-20", reason: "Expiring", latestVerified: { holdingRef: "H", expiresAt: "2026-10-20" }, requiredBy: "2026-10-20", dispatchImpact: "Required by sour sites", requestedAt: "2026-09-23", providerOptions: { official: [{ sourceRef: "SRC-ESC-H2S-ALIVE", title: "ESC authorized providers", sourceUrl: "https://www.energysafetycanada.com/course/10490" }], company: [{ vendorRef: "V1", name: "ABC Safety", phone: "780-555-0100", preferred: true }] } }]} onMark={onMark} onSweep={vi.fn()} sweeping={false} sweepResult={null} />);
    expect(screen.getByTestId("headlines").textContent).toContain("expire within 30 days");
    expect(screen.getByTestId("queue").textContent).toContain("ABC Safety (preferred)");
    expect(screen.getByTestId("queue").textContent).toContain("Dispatch impact: Required by sour sites");
    expect(screen.getByText(/never change dispatch readiness/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Booked" }));
    expect(onMark).toHaveBeenCalledWith("HO-1", "booked");
  });
});

describe("WalletPanel — 0187 statuses", () => {
  it("shows the credential's status and the renewal in motion separately; a company review is not an expiry; a correction request is actionable", () => {
    const w = wallet({
      credentials: [
        { holdingRef: "H1", code: "H2S_ALIVE", displayName: "H2S Alive", issuer: null, issuingJurisdiction: null, certificateNumber: null, issuedAt: "2024-01-01", expiresAt: "2026-10-01", endorsements: [], restrictions: [], verificationState: "verified", verifiedAt: "2024-01-05", boundary: "external_provider", lifecycle: "actual_expiry", current: true, supersededByHoldingRef: null },
        { holdingRef: "H4", code: "WHMIS_EMPLOYER", displayName: "WHMIS", issuer: null, issuingJurisdiction: null, certificateNumber: null, issuedAt: "2025-09-01", expiresAt: null, endorsements: [], restrictions: [], verificationState: "verified", verifiedAt: "2025-09-02", boundary: "employer_issued", lifecycle: "employer_review", current: true, supersededByHoldingRef: null },
        { holdingRef: "H5", code: "FIRST_AID", displayName: "First Aid", issuer: null, issuingJurisdiction: null, certificateNumber: null, issuedAt: null, expiresAt: "2028-01-01", endorsements: [], restrictions: [], verificationState: "unverified", verifiedAt: null, boundary: "external_provider", lifecycle: "actual_expiry", current: false, supersededByHoldingRef: null, correction: { requestedAt: "2026-09-20", note: "Expiry year unreadable" } },
      ],
      expiring: [
        { code: "H2S_ALIVE", basis: "actual_expiry", legalExpiry: "2026-10-01", employerReviewAt: null, labels: [], held: true, heldReason: "", canRequestTraining: true, walletStatus: "EXPIRING", renewalStatus: "BOOKED", statusLine: "Expires 2026-10-01 (8 day(s))", renewalSteps: [{ label: "Requested 2026-09-01", done: true }, { label: "Booked for 2026-09-28", done: true }, { label: "New certificate verified", done: false }], validityNote: "Your current credential counts only until its own expiry (2026-10-01). A renewal request or booking does not extend it." },
        { code: "WHMIS_EMPLOYER", basis: "employer_review", legalExpiry: null, employerReviewAt: "2026-09-01", labels: [], held: true, heldReason: "", canRequestTraining: false, walletStatus: "COMPANY_REVIEW_DUE", renewalStatus: "NONE", statusLine: "Company policy review due 2026-09-01 — not an expiry", renewalSteps: [], validityNote: "" },
      ],
    });
    render(<WalletPanel wallet={w} policies={[]} onRequestTraining={vi.fn()} requesting={false} onUpload={vi.fn()} uploading={false} onHandoffDone={vi.fn()} />);
    const h2s = screen.getByTestId("credential-H2S_ALIVE").textContent!;
    expect(h2s).toContain("Expiring");
    expect(h2s).toContain("Booked");
    expect(h2s).toContain("does not extend it");
    const whmis = screen.getByTestId("credential-WHMIS_EMPLOYER").textContent!;
    expect(whmis).toContain("Company review due");
    expect(whmis).toContain("not an expiry");
    expect(whmis).not.toContain("Expired");
    expect(screen.getByTestId("credential-FIRST_AID").textContent).toContain("Correction requested");
    fireEvent.click(screen.getByText("Upload a corrected record"));
    expect(screen.getByRole("heading", { name: "Upload a corrected record" })).toBeInTheDocument();
  });
});
