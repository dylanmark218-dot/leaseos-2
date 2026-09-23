/**
 * The Dispatch Detail screen, as a screen.
 *
 * It reads one job: its header, who and what is assigned to it, and the readiness verdict for that
 * pairing. It changes nothing. The assignment controls a dispatcher would expect are deliberately
 * absent, and the screen says why rather than showing a dead button — the only reachable assignment
 * mutation (`jobUnits.create`) also carries award semantics, so a "Change driver" control here
 * could mark an eligibility check as awarded.
 *
 * Almost every test below is negative. The failure this screen must not have is showing something
 * that looks like fact and is not: a name it could not resolve, a job it could not read, an empty
 * assignment list that means "we only looked at the last hundred".
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);
import {
  DispatchJobDetailView,
  type AssignmentRow,
  type DispatchJobDetailViewProps,
  type JobHeader,
} from "./DispatchJobDetailView";

const header = (o: Partial<JobHeader> = {}): JobHeader => ({
  id: 41, jobCode: "WH-2291", type: "water_haul", mode: "transport", customer: "Northgate Energy",
  location: "04-12-052-09W5", status: "dispatched", progress: 0, eta: null,
  vehicleText: null, driverText: null, ...o,
});

const row = (o: Partial<AssignmentRow> = {}): AssignmentRow => ({
  jobUnitId: 900, unitId: 512, unitName: null, operatorId: 77, operatorName: null,
  role: "operator", joinedAt: new Date("2026-09-21T13:00:00Z"), departedAt: null, ...o,
});

const props = (o: Partial<DispatchJobDetailViewProps> = {}): DispatchJobDetailViewProps => ({
  jobId: 41,
  job: { kind: "loaded", job: header() },
  assignments: { kind: "loaded", rows: [row()] },
  namesResolved: true,
  readiness: <div data-testid="readiness-slot">readiness lives here</div>,
  onRefresh: vi.fn(),
  refreshing: false,
  ...o,
});

/** Nothing on this screen may read as a fabricated fact. */
const saysUnknown = () => screen.queryAllByText(/\bunknown\b/i).length > 0;

/* ── D1. real backend data ──────────────────────────────────────────────────── */

describe("D1 — the header shows what the server sent, and only that", () => {
  it("renders the job's own fields", () => {
    render(<DispatchJobDetailView {...props()} />);
    const h = screen.getByTestId("job-header").textContent ?? "";
    expect(h).toContain("WH-2291");
    expect(h).toContain("Northgate Energy");
    expect(h).toContain("04-12-052-09W5");
    expect(h).toContain("water_haul");
    expect(h).toContain("transport");
    expect(h).toContain("dispatched");
  });

  it("omits a field the server left null rather than inventing a placeholder", () => {
    render(<DispatchJobDetailView {...props({ job: { kind: "loaded", job: header({ eta: null }) } })} />);
    const h = screen.getByTestId("job-header").textContent ?? "";
    expect(h).not.toMatch(/null|undefined|N\/A|TBD/);
    expect(saysUnknown()).toBe(false);
  });

  /*
   * `jobs.vehicle` and `jobs.driver` are varchar free text a client typed — not references to a
   * unit or an operator. Showing them beside the real assignment without saying so would read as
   * two sources agreeing, when one of them is a note.
   */
  it("marks the job's free-text vehicle and driver as captured text, not as the assignment", () => {
    render(<DispatchJobDetailView {...props({
      job: { kind: "loaded", job: header({ vehicleText: "the blue vac", driverText: "Dana" }) },
    })} />);
    const noted = screen.getByTestId("job-captured-text");
    expect(noted.textContent).toContain("the blue vac");
    expect(noted.textContent).toContain("Dana");
    expect(noted.textContent).toMatch(/typed|captured|not a record|free text/i);
  });
});

/* ── D2/D3. current assignment ──────────────────────────────────────────────── */

describe("D2/D3 — the current operator and unit", () => {
  it("shows the ids as the authoritative text", () => {
    render(<DispatchJobDetailView {...props()} />);
    const a = screen.getByTestId("assignment-900").textContent ?? "";
    expect(a).toContain("512");
    expect(a).toContain("77");
  });

  it("appends a resolved name as secondary, never in place of the id", () => {
    render(<DispatchJobDetailView {...props({
      assignments: { kind: "loaded", rows: [row({ unitName: "HV-0031", operatorName: "J. Mercer" })] },
    })} />);
    const a = screen.getByTestId("assignment-900").textContent ?? "";
    expect(a).toContain("512");
    expect(a).toContain("HV-0031");
    expect(a).toContain("77");
    expect(a).toContain("J. Mercer");
  });

  /*
   * A name can fail to resolve for at least four reasons a client cannot tell apart: the fleet
   * exceeds the hundred-row list cap, the roster does, the record belongs to another organization,
   * or the row is gone. "Unknown" asserts absence. The data only supports "not resolved".
   */
  it("says a name was not resolved rather than calling the record unknown", () => {
    render(<DispatchJobDetailView {...props({
      assignments: { kind: "loaded", rows: [row({ unitName: null, operatorName: null })] },
    })} />);
    expect(screen.getByTestId("assignment-900").textContent).toMatch(/not resolved/i);
    expect(saysUnknown()).toBe(false);
  });

  it("shows an assignment with no operator as exactly that", () => {
    render(<DispatchJobDetailView {...props({
      // The unit name resolves, so anything reading "not resolved" here would be about the operator.
      assignments: { kind: "loaded", rows: [row({ unitName: "HV-0031", operatorId: null, operatorName: null })] },
    })} />);
    const a = screen.getByTestId("assignment-900").textContent ?? "";
    expect(a).toMatch(/no operator/i);
    expect(a).not.toMatch(/not resolved/i);   // nothing failed to resolve; there is nobody to resolve
  });

  it("shows the captured role verbatim, labelled as captured", () => {
    render(<DispatchJobDetailView {...props({ assignments: { kind: "loaded", rows: [row({ role: "support unit" })] } })} />);
    const a = screen.getByTestId("assignment-900");
    expect(a.textContent).toContain("support unit");
    expect(a.textContent).toMatch(/captured|as recorded|free text/i);
  });

  it("lists every assignment row the server returned, not just the newest", () => {
    render(<DispatchJobDetailView {...props({
      assignments: { kind: "loaded", rows: [row(), row({ jobUnitId: 901, unitId: 513, operatorId: 78 })] },
    })} />);
    expect(screen.getAllByTestId(/^assignment-\d+$/)).toHaveLength(2);
  });

  /*
   * `jobUnits.list` returns the tenant's hundred most recent assignments with no job filter, so an
   * empty list for this job is not proof that the job is unassigned. The screen must not convert
   * "we did not see one" into "there is not one".
   */
  it("states the window the assignment list came from", () => {
    render(<DispatchJobDetailView {...props()} />);
    expect(screen.getByTestId("assignment-window").textContent).toMatch(/most recent|hundred|100/i);
  });
});

/* ── D4. trailer ────────────────────────────────────────────────────────────── */

describe("D4 — trailer and equipment", () => {
  /*
   * There is no trailer assignment in this system to show: no trailers table, no trailer column on
   * jobUnits, and the one trailer write (dispatchRoles.assignedTrailerId) sits behind an award path
   * whose posting rows no procedure can create. An empty "Trailer: —" row would imply the concept
   * exists and is simply unset.
   */
  it("says trailer assignment is not represented in the data, rather than showing it as unset", () => {
    render(<DispatchJobDetailView {...props()} />);
    const t = screen.getByTestId("trailer-unsupported").textContent ?? "";
    expect(t).toMatch(/not (represented|recorded|supported)/i);
    expect(screen.queryByTestId("trailer-value")).toBeNull();
  });
});

/* ── D5. unassigned ─────────────────────────────────────────────────────────── */

describe("D5 — a job with no assignment", () => {
  it("renders an explicit unassigned state", () => {
    render(<DispatchJobDetailView {...props({ assignments: { kind: "loaded", rows: [] } })} />);
    expect(screen.getByTestId("assignment-none").textContent).toMatch(/no assignment/i);
    expect(screen.queryAllByTestId(/^assignment-\d+$/)).toHaveLength(0);
    expect(saysUnknown()).toBe(false);
  });

  it("still states the window, because an empty list is not proof of an unassigned job", () => {
    render(<DispatchJobDetailView {...props({ assignments: { kind: "loaded", rows: [] } })} />);
    expect(screen.getByTestId("assignment-window")).toBeInTheDocument();
  });
});

/* ── D6. failure ────────────────────────────────────────────────────────────── */

describe("D6 — when a query fails", () => {
  it("shows the failure and no assignment data at all", () => {
    render(<DispatchJobDetailView {...props({ assignments: { kind: "failed", message: "Database unavailable" } })} />);
    const alerts = screen.getAllByRole("alert").map(a => a.textContent).join(" ");
    expect(alerts).toContain("Database unavailable");
    expect(screen.queryAllByTestId(/^assignment-\d+$/)).toHaveLength(0);
    expect(screen.queryByTestId("assignment-none")).toBeNull();   // a failure is not an unassigned job
  });

  it("shows a failed job read as a failure, not as a job with empty fields", () => {
    render(<DispatchJobDetailView {...props({ job: { kind: "failed", message: "No organization" } })} />);
    expect(screen.getAllByRole("alert").map(a => a.textContent).join(" ")).toContain("No organization");
    expect(screen.queryByTestId("job-header")).toBeNull();
  });

  it("renders nothing readable as data while loading", () => {
    render(<DispatchJobDetailView {...props({ job: { kind: "loading" }, assignments: { kind: "loading" } })} />);
    expect(screen.getByTestId("job-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("job-header")).toBeNull();
    expect(screen.queryByTestId("assignment-none")).toBeNull();
  });
});

/* ── D7. a job this caller cannot read ──────────────────────────────────────── */

describe("D7 — a job outside what this caller can read", () => {
  /*
   * `jobs.list` returns the hundred most recently updated jobs in scope and takes no id. A job in
   * another organization and a job that is merely older both arrive the same way: absent. The
   * screen must not guess which, and must not render a header from nothing.
   */
  it("says the job is not among the ones it can read, and renders no header", () => {
    render(<DispatchJobDetailView {...props({ job: { kind: "outside_window" } })} />);
    const m = screen.getByTestId("job-unavailable").textContent ?? "";
    expect(m).toMatch(/not among/i);
    expect(m).toContain("41");
    expect(screen.queryByTestId("job-header")).toBeNull();
    expect(saysUnknown()).toBe(false);
  });

  it("does not claim the job does not exist", () => {
    render(<DispatchJobDetailView {...props({ job: { kind: "outside_window" } })} />);
    expect(screen.getByTestId("job-unavailable").textContent).not.toMatch(/does not exist|no such job|deleted/i);
  });
});

/* ── the readiness section is composed, never reimplemented ─────────────────── */

describe("readiness", () => {
  it("renders whatever readiness component it was handed, unmodified", () => {
    render(<DispatchJobDetailView {...props()} />);
    expect(screen.getByTestId("readiness-slot")).toBeInTheDocument();
  });

  it("shows the readiness section even when the job header could not be read", () => {
    // Readiness is about the operator/unit pairing, not about the job row. One failing does not
    // silence the other.
    render(<DispatchJobDetailView {...props({ job: { kind: "outside_window" } })} />);
    expect(screen.getByTestId("readiness-slot")).toBeInTheDocument();
  });

  it("never derives a readiness word of its own", () => {
    render(<DispatchJobDetailView {...props()} />);
    const page = document.body.textContent ?? "";
    for (const word of ["Ready", "Not ready", "Eligible", "Cleared to dispatch"]) {
      expect(page.includes(word), `the detail screen must not say "${word}" — readiness is the panel's`).toBe(false);
    }
  });
});

/* ── no assignment controls, and the screen says why ────────────────────────── */

describe("the screen changes nothing", () => {
  it("offers no control that would assign, award, override or force", () => {
    render(<DispatchJobDetailView {...props()} />);
    expect(screen.queryByRole("button", { name: /assign|change driver|change unit|award|override|force|dispatch now|unassign/i })).toBeNull();
  });

  /*
   * Saying nothing would be worse than saying "not yet": a dispatcher who cannot see why the
   * control is missing will look for it elsewhere, and the elsewhere is the procedure that carries
   * award semantics.
   */
  it("says plainly that assignment is not available from here, and why", () => {
    render(<DispatchJobDetailView {...props()} />);
    const note = screen.getByTestId("assignment-readonly-note").textContent ?? "";
    expect(note).toMatch(/read-only|cannot be changed|not available/i);
    expect(note).toMatch(/award/i);
  });

  it("offers a re-read, which is the only action it has", () => {
    const onRefresh = vi.fn();
    render(<DispatchJobDetailView {...props({ onRefresh })} />);
    expect(screen.getByTestId("refresh")).toBeInTheDocument();
  });
});
