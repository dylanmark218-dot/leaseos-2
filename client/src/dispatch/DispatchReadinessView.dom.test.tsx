/**
 * The Readiness Panel, as a screen.
 *
 * The panel has exactly one job: show a dispatcher what the server decided about one job, without
 * ever improving on it. So the tests below are almost entirely negative — they assert what the
 * screen must *not* say — because every way this component can fail is a way it tells somebody a
 * truck is fit to dispatch when the server did not say so.
 *
 * `DispatchReadinessView` is pure: props in, DOM out, no tRPC, no fetch. The container above it
 * does the query. That split is what makes "the client displays exactly what the server returns"
 * a testable claim rather than a hope.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);
import {
  DispatchReadinessView,
  type CapabilityRow,
  type DispatchReadinessViewProps,
  type ReadinessResult,
} from "./DispatchReadinessView";

const blocker = (o: Partial<ReadinessResult["blockers"][number]> = {}): ReadinessResult["blockers"][number] => ({
  code: "critical_defect", label: "Open critical defect on this unit", severity: "blocking",
  subject: "truck", overridable: false, ...o,
});

const result = (o: Partial<ReadinessResult> = {}): ReadinessResult => ({
  verdict: "eligible",
  explanation: "Nothing stands in the way of this assignment.",
  blockers: [],
  contributions: [{ engine: "compliance", finding: "Medical fitness: eligible" }],
  ...o,
});

const props = (o: Partial<DispatchReadinessViewProps> = {}): DispatchReadinessViewProps => ({
  jobId: 41,
  subject: { operatorId: 7, unitId: 12, trailerId: null },
  state: { kind: "loaded", result: result() },
  capabilities: null,
  capabilityVerdict: null,
  onRefresh: vi.fn(),
  refreshing: false,
  ...o,
});

/** The single safety question, asked of the whole rendered document. */
const saysReadyAnywhere = () =>
  document.querySelectorAll('[data-readiness="ready"]').length > 0 ||
  screen.queryAllByText(/^\s*Ready\s*$/).length > 0;

const overall = () => screen.getByTestId("overall-verdict");

/* ── 2. the panel renders the actual backend result ─────────────────────────── */

describe("the panel renders what the server returned", () => {
  it("shows the server's verdict, its explanation, its blockers and its contributions verbatim", () => {
    render(<DispatchReadinessView {...props({
      state: { kind: "loaded", result: result({
        verdict: "blocked",
        explanation: "Two conditions must be corrected before this unit can be dispatched.",
        blockers: [
          blocker({ code: "critical_defect", label: "Open critical defect on this unit" }),
          blocker({ code: "out_of_service_order", label: "Active out-of-service order", subject: "truck" }),
        ],
        contributions: [
          { engine: "enforcement", finding: "Enforcement: blocked — 1 active order(s)" },
          { engine: "maintenance", finding: "1 critical defect without standing release evidence" },
        ],
      }) },
    })} />);

    expect(overall().textContent).toContain("blocked");
    expect(screen.getByTestId("explanation").textContent)
      .toBe("Two conditions must be corrected before this unit can be dispatched.");

    expect(within(screen.getByTestId("blocker-critical_defect")).getByText("Open critical defect on this unit")).toBeInTheDocument();
    expect(within(screen.getByTestId("blocker-out_of_service_order")).getByText("Active out-of-service order")).toBeInTheDocument();
    expect(screen.getAllByTestId(/^blocker-/)).toHaveLength(2);

    const findings = screen.getByTestId("contributions").textContent ?? "";
    expect(findings).toContain("Enforcement: blocked — 1 active order(s)");
    expect(findings).toContain("1 critical defect without standing release evidence");
    expect(findings).toContain("enforcement");
  });

  it("does not invent an explanation the server did not send", () => {
    render(<DispatchReadinessView {...props({ state: { kind: "loaded", result: result({ explanation: "" }) } })} />);
    expect(screen.getByTestId("explanation").textContent).toBe("");
  });

  it("names the subject it asked about, so a dispatcher can see it is the right truck and driver", () => {
    render(<DispatchReadinessView {...props()} />);
    const s = screen.getByTestId("subject").textContent ?? "";
    expect(s).toContain("7");
    expect(s).toContain("12");
  });
});

/* ── 3. eligible is ready ───────────────────────────────────────────────────── */

describe("an eligible verdict", () => {
  it("is the one case the panel presents as ready", () => {
    render(<DispatchReadinessView {...props({ state: { kind: "loaded", result: result({ verdict: "eligible" }) } })} />);
    expect(overall()).toHaveAttribute("data-readiness", "ready");
    expect(saysReadyAnywhere()).toBe(true);
  });
});

/* ── 4. review stays review ─────────────────────────────────────────────────── */

describe("an eligible_review verdict", () => {
  it("stays review and is never shown as ready", () => {
    render(<DispatchReadinessView {...props({
      state: { kind: "loaded", result: result({ verdict: "eligible_review", blockers: [blocker({ code: "route_unapproved", label: "Route approval outstanding", severity: "review", overridable: true, overrideAuthority: "dispatcher" })] }) },
    })} />);
    expect(overall()).toHaveAttribute("data-readiness", "review");
    expect(saysReadyAnywhere()).toBe(false);
  });
});

/* ── explicit BLOCKED rendering ─────────────────────────────────────────────── */

describe("a blocked verdict", () => {
  it("is presented as blocked, names every blocker, and offers no way to proceed", () => {
    render(<DispatchReadinessView {...props({
      state: { kind: "loaded", result: result({ verdict: "blocked", blockers: [blocker()] }) },
    })} />);
    expect(overall()).toHaveAttribute("data-readiness", "blocked");
    expect(saysReadyAnywhere()).toBe(false);

    // The panel reads. It does not award, override, or force.
    expect(screen.queryByRole("button", { name: /award|assign|override|force|proceed|dispatch anyway/i })).toBeNull();
  });

  it("says plainly that a non-overridable blocker has no override", () => {
    render(<DispatchReadinessView {...props({
      state: { kind: "loaded", result: result({ verdict: "blocked", blockers: [blocker({ overridable: false })] }) },
    })} />);
    expect(screen.getByTestId("blocker-critical_defect").textContent).toMatch(/no override/i);
  });

  it("warns when a blocker is flagged overridable but still blocking, because award refuses it first", () => {
    render(<DispatchReadinessView {...props({
      state: { kind: "loaded", result: result({ verdict: "blocked", blockers: [blocker({ code: "hos_exhausted", label: "Hours of service exhausted", severity: "blocking", overridable: true, overrideAuthority: "manager" })] }) },
    })} />);
    const row = screen.getByTestId("blocker-hos_exhausted");
    expect(row).toHaveAttribute("data-readiness", "blocked");
    expect(row.textContent).toMatch(/refused at award|cannot permit/i);
  });
});

/* ── 5 & 6. unknown and not-evaluated never round up ────────────────────────── */

describe("an unknown verdict", () => {
  it("is presented as insufficient information — never as pass, never as review", () => {
    render(<DispatchReadinessView {...props({
      state: { kind: "loaded", result: result({ verdict: "unknown", explanation: "Enforcement state could not be read." }) },
    })} />);
    expect(overall()).toHaveAttribute("data-readiness", "insufficient");
    expect(overall()).not.toHaveAttribute("data-readiness", "review");
    expect(saysReadyAnywhere()).toBe(false);
  });

  it("refuses to render a verdict string it does not recognise as anything but unavailable", () => {
    for (const junk of ["ok", "READY", "eligible ", "pass"]) {
      cleanup();
      render(<DispatchReadinessView {...props({ state: { kind: "loaded", result: result({ verdict: junk }) } })} />);
      expect(overall(), `"${junk}"`).toHaveAttribute("data-readiness", "unavailable");
      expect(saysReadyAnywhere(), `"${junk}"`).toBe(false);
    }
  });
});

describe("capability statuses", () => {
  const caps = (rows: CapabilityRow[]) => props({ capabilities: rows });

  it("shows each capability at the status the server gave it", () => {
    render(<DispatchReadinessView {...caps([
      { capability: "mechanic release", status: "PASS", detail: "No critical defect outstanding" },
      { capability: "hours of service", status: "REVIEW", detail: "Attested, not computed" },
      { capability: "enforcement orders", status: "BLOCKED", detail: "1 active order" },
      { capability: "insurance", status: "UNKNOWN", detail: "No policy found" },
      { capability: "route approval", status: "NOT_EVALUATED", detail: "No route named" },
    ])} />);

    expect(screen.getByTestId("capability-mechanic release")).toHaveAttribute("data-readiness", "ready");
    expect(screen.getByTestId("capability-hours of service")).toHaveAttribute("data-readiness", "review");
    expect(screen.getByTestId("capability-enforcement orders")).toHaveAttribute("data-readiness", "blocked");
    expect(screen.getByTestId("capability-insurance")).toHaveAttribute("data-readiness", "insufficient");
    expect(screen.getByTestId("capability-route approval")).toHaveAttribute("data-readiness", "not_evaluated");
  });

  it("never rounds UNKNOWN or NOT_EVALUATED up to ready or review", () => {
    render(<DispatchReadinessView {...caps([
      { capability: "insurance", status: "UNKNOWN", detail: null },
      { capability: "route approval", status: "NOT_EVALUATED", detail: null },
    ])} />);
    for (const k of ["insurance", "route approval"]) {
      const el = screen.getByTestId(`capability-${k}`);
      expect(el).not.toHaveAttribute("data-readiness", "ready");
      expect(el).not.toHaveAttribute("data-readiness", "review");
    }
  });

  it("does not let a passing capability make an overall blocked verdict look ready", () => {
    render(<DispatchReadinessView {...props({
      state: { kind: "loaded", result: result({ verdict: "blocked", blockers: [blocker()] }) },
      capabilities: [{ capability: "mechanic release", status: "PASS", detail: null }, { capability: "insurance", status: "PASS", detail: null }],
    })} />);
    expect(overall()).toHaveAttribute("data-readiness", "blocked");
    // The overall verdict is the server's. The panel does not compute one from the cards.
    expect(screen.getByTestId("overall-verdict").textContent).toContain("blocked");
  });

  it("says outright when the server sent no capability picture at all, rather than showing an empty pass", () => {
    render(<DispatchReadinessView {...props({ capabilities: null })} />);
    expect(screen.getByTestId("capabilities-unavailable").textContent).toMatch(/not (returned|supplied)/i);
    expect(screen.queryAllByTestId(/^capability-/)).toHaveLength(0);
    expect(saysReadyAnywhere()).toBe(true); // the overall verdict is eligible here — the capability section still claims nothing
    expect(document.querySelectorAll('[data-testid^="capability-"][data-readiness="ready"]')).toHaveLength(0);
  });
});

/* ── 7. the server failed ───────────────────────────────────────────────────── */

describe("when the readiness query fails", () => {
  it("says it failed, says why, and shows no verdict at all", () => {
    render(<DispatchReadinessView {...props({ state: { kind: "failed", message: "Database unavailable" } })} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Database unavailable");
    expect(saysReadyAnywhere()).toBe(false);
    expect(screen.queryByTestId("overall-verdict")).toBeNull();
    expect(screen.queryAllByTestId(/^blocker-/)).toHaveLength(0);
  });

  it("offers a retry rather than a stale answer", () => {
    const onRefresh = vi.fn();
    render(<DispatchReadinessView {...props({ state: { kind: "failed", message: "fetch failed" }, onRefresh })} />);
    expect(screen.getByTestId("retry")).toBeInTheDocument();
  });

  it("shows nothing readable as a verdict while it is still loading", () => {
    render(<DispatchReadinessView {...props({ state: { kind: "loading" } })} />);
    expect(screen.getByTestId("panel-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("overall-verdict")).toBeNull();
    expect(saysReadyAnywhere()).toBe(false);
  });
});

/* ── 8. nothing came back ───────────────────────────────────────────────────── */

describe("when the server returned nothing", () => {
  it("says nothing was returned rather than fabricating readiness", () => {
    render(<DispatchReadinessView {...props({ state: { kind: "loaded", result: null } })} />);
    expect(screen.getByTestId("panel-empty").textContent).toMatch(/no readiness/i);
    expect(screen.queryByTestId("overall-verdict")).toBeNull();
    expect(saysReadyAnywhere()).toBe(false);
  });

  it("treats a result with no verdict as unavailable, not as clear", () => {
    render(<DispatchReadinessView {...props({
      state: { kind: "loaded", result: { verdict: "", explanation: "", blockers: [], contributions: [] } },
    })} />);
    expect(overall()).toHaveAttribute("data-readiness", "unavailable");
    expect(saysReadyAnywhere()).toBe(false);
  });

  it("an eligible verdict with no contributions is still just what the server said", () => {
    render(<DispatchReadinessView {...props({ state: { kind: "loaded", result: result({ contributions: [] }) } })} />);
    expect(overall()).toHaveAttribute("data-readiness", "ready");
    expect(screen.getByTestId("contributions").textContent).toMatch(/none recorded|no findings/i);
  });
});

/* ── no subject to ask about ────────────────────────────────────────────────── */

describe("when the job has no assignment to evaluate", () => {
  /*
   * `dispatch.readiness` needs an operator and a unit. Since Checkpoint I the panel resolves those
   * from the canonical slot binding, so a job with no posting, a posting whose slots are all open,
   * or a filled slot carrying no operator each give it nothing to ask about — and a panel with no
   * question has no answer. It says that, rather than rendering an unanswered form as clear.
   */
  it("says there is nothing to evaluate rather than showing a verdict", () => {
    render(<DispatchReadinessView {...props({ subject: null, state: { kind: "loaded", result: null } })} />);
    expect(screen.getByTestId("panel-no-subject").textContent).toMatch(/no (unit and driver|assignment)/i);
    expect(screen.queryByTestId("overall-verdict")).toBeNull();
    expect(saysReadyAnywhere()).toBe(false);
  });
});

/* ── the capability picture, now that the server sends it ───────────────────── */

describe("the P8.1 capability picture", () => {
  const withCaps = (rows: CapabilityRow[], verdict: DispatchReadinessViewProps["capabilityVerdict"] = null) =>
    props({ capabilities: rows, capabilityVerdict: verdict });

  it("names each capability as the server named it, and shows the status it gave", () => {
    render(<DispatchReadinessView {...withCaps([
      { capability: "mechanic release", status: "BLOCKED", detail: "Open critical defect on this unit" },
      { capability: "enforcement orders", status: "PASS" },
      { capability: "route restrictions", status: "NOT_EVALUATED", reason: "not_applicable" },
    ])} />);

    const mech = screen.getByTestId("capability-mechanic release");
    expect(within(mech).getByText("mechanic release")).toBeInTheDocument();
    expect(mech).toHaveAttribute("data-readiness", "blocked");
    expect(mech.textContent).toContain("Open critical defect on this unit");
    expect(screen.getByTestId("capability-enforcement orders")).toHaveAttribute("data-readiness", "ready");
  });

  it("carries the reason a capability was not evaluated, because an unexplained NOT_EVALUATED is the hole this contract closes", () => {
    render(<DispatchReadinessView {...withCaps([
      { capability: "route restrictions", status: "NOT_EVALUATED", reason: "not_applicable" },
      { capability: "hos", status: "NOT_EVALUATED", reason: "no_data_source_loaded" },
    ])} />);
    expect(screen.getByTestId("capability-route restrictions").textContent).toContain("not_applicable");
    expect(screen.getByTestId("capability-hos").textContent).toContain("no_data_source_loaded");
    for (const k of ["route restrictions", "hos"]) {
      expect(screen.getByTestId(`capability-${k}`)).toHaveAttribute("data-readiness", "not_evaluated");
    }
  });

  it("does not invent evidence a capability did not carry", () => {
    render(<DispatchReadinessView {...withCaps([{ capability: "unit inspection", status: "PASS" }])} />);
    const row = screen.getByTestId("capability-unit inspection");
    // No detail was sent, so the row carries the status's own meaning and nothing dressed up as a finding.
    expect(row.textContent).not.toMatch(/undefined|null/);
  });

  it("shows an explicit empty state when the server returned zero capabilities", () => {
    render(<DispatchReadinessView {...withCaps([])} />);
    expect(screen.getByTestId("capabilities-empty").textContent).toMatch(/no capabilit/i);
    expect(screen.queryAllByTestId(/^capability-/)).toHaveLength(0);
    expect(document.querySelectorAll('[data-testid^="capability"][data-readiness="ready"]')).toHaveLength(0);
  });

  it("shows the server's combined capability status, labelled as the capability picture's own", () => {
    render(<DispatchReadinessView {...withCaps(
      [{ capability: "hos", status: "NOT_EVALUATED", reason: "not_licensed" }],
      { status: "REVIEW", explanation: "1 capability was not evaluated.", missingRequired: ["hos"] },
    )} />);
    const v = screen.getByTestId("capability-verdict");
    expect(v).toHaveAttribute("data-readiness", "review");
    expect(v.textContent).toContain("1 capability was not evaluated.");
    expect(v.textContent).toContain("hos");
  });
});

/* ── server authority: the capability rows never decide the verdict ─────────── */

describe("the overall verdict stays the server's", () => {
  it("a blocked verdict stays blocked even when every capability passed", () => {
    render(<DispatchReadinessView {...props({
      state: { kind: "loaded", result: result({ verdict: "blocked", blockers: [blocker()] }) },
      capabilities: [
        { capability: "hos", status: "PASS" },
        { capability: "mechanic release", status: "PASS" },
        { capability: "enforcement orders", status: "PASS" },
      ],
      capabilityVerdict: { status: "PASS", explanation: "All capabilities passed.", missingRequired: [] },
    })} />);
    expect(overall()).toHaveAttribute("data-readiness", "blocked");
    expect(overall().textContent).toContain("blocked");
  });

  it("an eligible verdict stays eligible even when a capability is BLOCKED — the panel reports, it does not arbitrate", () => {
    render(<DispatchReadinessView {...props({
      state: { kind: "loaded", result: result({ verdict: "eligible" }) },
      capabilities: [{ capability: "route restrictions", status: "BLOCKED", detail: "Bridge posting exceeded" }],
      capabilityVerdict: { status: "BLOCKED", explanation: "1 capability blocked.", missingRequired: [] },
    })} />);
    // Disagreement between the two server outputs is the server's to resolve, not the screen's.
    expect(overall()).toHaveAttribute("data-readiness", "ready");
    expect(screen.getByTestId("capability-route restrictions")).toHaveAttribute("data-readiness", "blocked");
  });
});
