/**
 * The Dispatch Detail screen, as a screen — now that it can change something.
 *
 * PR #6 built this as a read-only view and said why in a banner: the only reachable assignment
 * mutation was `jobUnits.create`, which also carries award semantics, so a "Change driver" control
 * here could have marked an eligibility check as awarded. The canonical assignment backend removed
 * that reason, and Checkpoint I removes the banner.
 *
 * What replaces it is not just buttons. The screen now reads `dispatch.listRoles`, which answers a
 * different and better question than `jobUnits.list` did — it is keyed by job rather than job-blind,
 * so the hundred-row window PR #6 had to disclose is gone, and it returns the slots nobody is in,
 * which the old read could not represent at all.
 *
 * Most tests below are still negative, and the new ones concentrate on the three ways an editable
 * screen can lie where a read-only one could not: showing a refused write as though it succeeded,
 * letting a stale token through silently, and letting the act of filling a slot imply that the crew
 * in it may legally be dispatched.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(cleanup);
import {
  DispatchJobDetailView,
  type DispatchJobDetailViewProps,
  type HistoryRow,
  type JobHeader,
  type SlotRow,
  type StaffingPicture,
} from "./DispatchJobDetailView";

const header = (o: Partial<JobHeader> = {}): JobHeader => ({
  id: 41, jobCode: "WH-2291", type: "water_haul", mode: "transport", customer: "Northgate Energy",
  location: "04-12-052-09W5", status: "dispatched", progress: 0, eta: null,
  vehicleText: null, driverText: null, ...o,
});

const slot = (o: Partial<SlotRow> = {}): SlotRow => ({
  roleId: 900, postingId: 60, roleCode: "PRIMARY_UNIT", roleLabel: "Primary unit",
  displayName: "Primary unit", required: true, status: "assigned",
  operatorId: 77, operatorName: null, unitId: 512, unitName: null,
  trailerId: null, trailerName: null,
  requiredEquipmentClass: null, requiredTrailerClass: null,
  lastEventId: 4100, ...o,
});

const staffing = (o: Partial<StaffingPicture> = {}): StaffingPicture => ({
  state: "staffed", filled: 1, requiredTotal: 1, unfilledRoles: [],
  message: "All 1 required roles filled.", ...o,
});

const event = (o: Partial<HistoryRow> = {}): HistoryRow => ({
  id: 4100, roleId: 900, eventType: "assignment_created",
  fromOperatorId: null, fromUnitId: null, toOperatorId: 77, toUnitId: 512,
  reason: null, actorUserId: 3, occurredAt: new Date("2026-09-21T13:00:00Z"), ...o,
});

const props = (o: Partial<DispatchJobDetailViewProps> = {}): DispatchJobDetailViewProps => ({
  jobId: 41,
  job: { kind: "loaded", job: header() },
  slots: {
    kind: "loaded", rows: [slot()], staffing: staffing(),
    planningState: "staffed", history: [event()],
  },
  namesResolved: true,
  operatorChoices: [{ id: 77, label: "Dana Whitecalf" }, { id: 78, label: "R. Okonkwo" }],
  unitChoices: [{ id: 512, label: "T-512" }, { id: 513, label: "T-513" }],
  mutation: { kind: "idle" },
  canAssign: true,
  readiness: <div data-testid="readiness-slot">readiness lives here</div>,
  onAssign: vi.fn(),
  onUnassign: vi.fn(),
  onRefresh: vi.fn(),
  refreshing: false,
  ...o,
});

/** Nothing on this screen may read as a fabricated fact. */
const saysUnknown = () => screen.queryAllByText(/\bunknown\b/i).length > 0;
const pageText = () => document.body.textContent ?? "";

/* ══ preserved from PR #6: the header is unchanged by activation ═════════════ */

describe("D1 — the header shows what the server sent, and only that", () => {
  it("renders the job's own fields", () => {
    render(<DispatchJobDetailView {...props()} />);
    const h = screen.getByTestId("job-header").textContent ?? "";
    for (const v of ["WH-2291", "Northgate Energy", "04-12-052-09W5", "water_haul", "transport", "dispatched"]) {
      expect(h).toContain(v);
    }
  });

  it("omits a field the server left null rather than inventing a placeholder", () => {
    render(<DispatchJobDetailView {...props({ job: { kind: "loaded", job: header({ eta: null }) } })} />);
    const h = screen.getByTestId("job-header").textContent ?? "";
    expect(h).not.toMatch(/null|undefined|N\/A|TBD/);
    expect(saysUnknown()).toBe(false);
  });

  it("marks the job's free-text vehicle and driver as captured text, not as the assignment", () => {
    render(<DispatchJobDetailView {...props({
      job: { kind: "loaded", job: header({ vehicleText: "the blue vac", driverText: "Dana" }) },
    })} />);
    const noted = screen.getByTestId("job-captured-text");
    expect(noted.textContent).toContain("the blue vac");
    expect(noted.textContent).toMatch(/typed|captured|not a record|free text/i);
  });
});

/* ══ I2a. the slot list — including the slots nobody is in ═══════════════════ */

describe("I2a — every slot the posting has, filled or not", () => {
  /*
   * This is the capability `jobUnits` never had. A worklog row exists because somebody joined the
   * job; there is no row for a winch tractor nobody has been put on, so the old screen could not
   * distinguish "fully crewed" from "we have not staffed the rest yet".
   */
  it("renders an unfilled slot as a slot, not as an absence", () => {
    render(<DispatchJobDetailView {...props({ slots: {
      kind: "loaded",
      rows: [slot(), slot({ roleId: 901, roleCode: "WINCH_TRACTOR", roleLabel: "Winch tractor",
        displayName: "Winch tractor", status: "open", operatorId: null, unitId: null, lastEventId: null })],
      staffing: staffing({ state: "partially_staffed", filled: 1, requiredTotal: 2,
        unfilledRoles: ["Winch tractor"], message: "1 of 2 required roles filled. Outstanding: Winch tractor." }),
      planningState: "partially_staffed", history: [],
    } })} />);

    const open = screen.getByTestId("slot-901");
    expect(open.textContent).toContain("Winch tractor");
    expect(open.textContent).toMatch(/unfilled/i);
    expect(screen.getByTestId("slot-900")).toBeInTheDocument();
  });

  it("shows the ids as the authoritative text and a resolved name as secondary", () => {
    render(<DispatchJobDetailView {...props({ slots: {
      kind: "loaded", rows: [slot({ operatorName: "Dana Whitecalf", unitName: "T-512" })],
      staffing: staffing(), planningState: "staffed", history: [],
    } })} />);
    const s = screen.getByTestId("slot-900").textContent ?? "";
    expect(s).toContain("77");
    expect(s).toContain("512");
    expect(s).toContain("Dana Whitecalf");
  });

  it("says a name was not resolved rather than calling the record unknown", () => {
    render(<DispatchJobDetailView {...props()} />);
    expect(screen.getByTestId("slot-900").textContent).toMatch(/not resolved/i);
    expect(saysUnknown()).toBe(false);
  });

  it("distinguishes a withdrawn slot from one nobody has taken", () => {
    render(<DispatchJobDetailView {...props({ slots: {
      kind: "loaded",
      rows: [slot({ roleId: 902, status: "cancelled", operatorId: null, unitId: null })],
      staffing: staffing({ state: "unstaffed", filled: 0, requiredTotal: 0, unfilledRoles: [], message: "0 of 0 required roles filled. Outstanding: ." }),
      planningState: "direct", history: [],
    } })} />);
    expect(screen.getByTestId("slot-902").textContent).toMatch(/withdrawn/i);
  });

  it("marks a slot required or optional, and never calls an unfilled optional slot a deficiency", () => {
    render(<DispatchJobDetailView {...props({ slots: {
      kind: "loaded",
      rows: [slot(), slot({ roleId: 903, roleLabel: "Standby", displayName: "Standby",
        required: false, status: "open", operatorId: null, unitId: null, lastEventId: null })],
      staffing: staffing(), planningState: "staffed", history: [],
    } })} />);
    expect(screen.getByTestId("slot-900").textContent).toMatch(/required/i);
    const optional = screen.getByTestId("slot-903").textContent ?? "";
    expect(optional).toMatch(/optional/i);
    expect(optional).not.toMatch(/missing|outstanding/i);
  });

  it("states the equipment class a slot requires, where the slot carries one", () => {
    render(<DispatchJobDetailView {...props({ slots: {
      kind: "loaded", rows: [slot({ requiredEquipmentClass: "winch_tractor" })],
      staffing: staffing(), planningState: "staffed", history: [],
    } })} />);
    expect(screen.getByTestId("slot-900").textContent).toContain("winch_tractor");
  });
});

/* ══ I2b. staffing — the precise picture, never merged with the coarse one ═══ */

describe("I2b — the derived staffing result is what the screen shows", () => {
  const withStaffing = (s: StaffingPicture, planningState: string | null) =>
    props({ slots: { kind: "loaded", rows: [slot()], staffing: s, planningState, history: [] } });

  it("shows 0 of 3, which the persisted lifecycle field cannot express", () => {
    render(<DispatchJobDetailView {...withStaffing(staffing({
      state: "unstaffed", filled: 0, requiredTotal: 3,
      unfilledRoles: ["Lead", "Winch tractor", "Bed truck"],
      message: "0 of 3 required roles filled. Outstanding: Lead, Winch tractor, Bed truck.",
    }), "partially_staffed")} />);

    const st = screen.getByTestId("staffing").textContent ?? "";
    expect(st).toContain("0");
    expect(st).toContain("3");
    expect(st).toMatch(/unstaffed/i);
    expect(st).toContain("Lead");
  });

  it("shows 1 of 3 and names what is outstanding", () => {
    render(<DispatchJobDetailView {...withStaffing(staffing({
      state: "partially_staffed", filled: 1, requiredTotal: 3, unfilledRoles: ["Winch tractor", "Bed truck"],
      message: "1 of 3 required roles filled. Outstanding: Winch tractor, Bed truck.",
    }), "partially_staffed")} />);
    const st = screen.getByTestId("staffing").textContent ?? "";
    expect(st).toContain("1");
    expect(st).toContain("Winch tractor");
  });

  it("shows 3 of 3 without implying the job may be dispatched", () => {
    render(<DispatchJobDetailView {...withStaffing(staffing({
      state: "staffed", filled: 3, requiredTotal: 3, unfilledRoles: [], message: "All 3 required roles filled.",
    }), "staffed")} />);
    expect(screen.getByTestId("staffing").textContent).toMatch(/staffed/i);
    expect(pageText()).not.toMatch(/\bReady\b|\bEligible\b|\bCleared\b/);
  });

  /*
   * The zero-of-N case is exactly where the two disagree: `assessStaffing` says `unstaffed`, and the
   * persisted field's only legal backward step from `staffed` is `partially_staffed`. Merging them
   * would mean printing "partially staffed" over a posting with nobody on it.
   */
  it("reports the persisted planning state as itself, separately, and never in place of the derived one", () => {
    render(<DispatchJobDetailView {...withStaffing(staffing({
      state: "unstaffed", filled: 0, requiredTotal: 2, unfilledRoles: ["Lead", "Bed truck"],
      message: "0 of 2 required roles filled. Outstanding: Lead, Bed truck.",
    }), "partially_staffed")} />);

    const planning = screen.getByTestId("planning-state").textContent ?? "";
    expect(planning).toContain("partially_staffed");
    expect(planning).toMatch(/lifecycle|coarse|cannot express|approximation/i);
    // and the authoritative line still says unstaffed
    expect(screen.getByTestId("staffing").textContent).toMatch(/unstaffed/i);
  });

  it("does not hold a posting back for an unfilled optional slot", () => {
    render(<DispatchJobDetailView {...props({ slots: {
      kind: "loaded",
      rows: [slot(), slot({ roleId: 903, roleLabel: "Standby", required: false, status: "open",
        operatorId: null, unitId: null, lastEventId: null })],
      staffing: staffing({ state: "staffed", filled: 1, requiredTotal: 1, unfilledRoles: [], message: "All 1 required roles filled." }),
      planningState: "staffed", history: [],
    } })} />);
    expect(screen.getByTestId("staffing").textContent).toMatch(/staffed/i);
    expect(screen.getByTestId("staffing").textContent).not.toMatch(/Standby/);
  });
});

/* ══ I2c. the controls that replaced the read-only banner ════════════════════ */

describe("I2c — assign, change and unassign", () => {
  it("offers an assign control on an unfilled slot", () => {
    render(<DispatchJobDetailView {...props({ slots: {
      kind: "loaded", rows: [slot({ status: "open", operatorId: null, unitId: null, lastEventId: null })],
      staffing: staffing({ state: "unstaffed", filled: 0, requiredTotal: 1, unfilledRoles: ["Primary unit"], message: "0 of 1 required roles filled. Outstanding: Primary unit." }),
      planningState: "direct", history: [],
    } })} />);
    expect(within(screen.getByTestId("slot-900")).getByRole("button", { name: /assign/i })).toBeInTheDocument();
  });

  it("offers change and unassign on a filled slot, and no assign", () => {
    render(<DispatchJobDetailView {...props()} />);
    const s = within(screen.getByTestId("slot-900"));
    expect(s.getByRole("button", { name: /change/i })).toBeInTheDocument();
    expect(s.getByRole("button", { name: /unassign/i })).toBeInTheDocument();
  });

  it("offers nothing that would award, override or force a dispatch", () => {
    render(<DispatchJobDetailView {...props()} />);
    expect(screen.queryByRole("button", { name: /award|override|force|dispatch now|approve/i })).toBeNull();
  });

  it("offers no control at all to a dispatcher who may read but not assign, and says so", () => {
    render(<DispatchJobDetailView {...props({ canAssign: false })} />);
    const s = within(screen.getByTestId("slot-900"));
    expect(s.queryByRole("button", { name: /assign|change|unassign/i })).toBeNull();
    expect(screen.getByTestId("assign-not-permitted").textContent).toMatch(/permission|not allowed|cannot/i);
  });

  it("carries the slot's own event head when assigning, so a change it did not see is refused", () => {
    const onAssign = vi.fn();
    render(<DispatchJobDetailView {...props({ onAssign })} />);
    fireEvent.click(within(screen.getByTestId("slot-900")).getByRole("button", { name: /change/i }));
    fireEvent.change(screen.getByTestId("assign-operator-900"), { target: { value: "78" } });
    fireEvent.change(screen.getByTestId("assign-unit-900"), { target: { value: "513" } });
    fireEvent.change(screen.getByTestId("assign-reason-900"), { target: { value: "Hours" } });
    fireEvent.click(screen.getByTestId("assign-submit-900"));

    expect(onAssign).toHaveBeenCalledTimes(1);
    expect(onAssign.mock.calls[0][0]).toMatchObject({
      roleId: 900, operatorId: 78, unitId: 513, expectedLastEventId: 4100, reason: "Hours",
    });
  });

  it("sends a null event head for a slot that has no history, rather than inventing one", () => {
    const onAssign = vi.fn();
    render(<DispatchJobDetailView {...props({ onAssign, slots: {
      kind: "loaded", rows: [slot({ status: "open", operatorId: null, unitId: null, lastEventId: null })],
      staffing: staffing({ state: "unstaffed", filled: 0, requiredTotal: 1, unfilledRoles: ["Primary unit"], message: "0 of 1." }),
      planningState: "direct", history: [],
    } })} />);
    fireEvent.click(within(screen.getByTestId("slot-900")).getByRole("button", { name: /assign/i }));
    fireEvent.change(screen.getByTestId("assign-operator-900"), { target: { value: "77" } });
    fireEvent.change(screen.getByTestId("assign-unit-900"), { target: { value: "512" } });
    fireEvent.click(screen.getByTestId("assign-submit-900"));

    expect(onAssign.mock.calls[0][0].expectedLastEventId).toBeNull();
  });

  /*
   * The server requires a reason to reassign a filled slot and does not require one to fill an
   * empty slot — `dispatchRoleService` refuses `assignment_reassigned` without one. The screen has
   * to know the difference, or every crew change is a round trip that comes back rejected.
   */
  it("requires a reason to change the crew on a filled slot, as the server does", () => {
    const onAssign = vi.fn();
    render(<DispatchJobDetailView {...props({ onAssign })} />);
    fireEvent.click(within(screen.getByTestId("slot-900")).getByRole("button", { name: /change/i }));
    fireEvent.change(screen.getByTestId("assign-operator-900"), { target: { value: "78" } });
    fireEvent.click(screen.getByTestId("assign-submit-900"));

    expect(onAssign).not.toHaveBeenCalled();
    expect(screen.getByTestId("assign-required-900").textContent).toMatch(/reason/i);
  });

  it("refuses a whitespace-only reason on a change, for the same reason the server does", () => {
    const onAssign = vi.fn();
    render(<DispatchJobDetailView {...props({ onAssign })} />);
    fireEvent.click(within(screen.getByTestId("slot-900")).getByRole("button", { name: /change/i }));
    fireEvent.change(screen.getByTestId("assign-operator-900"), { target: { value: "78" } });
    fireEvent.change(screen.getByTestId("assign-reason-900"), { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("assign-submit-900"));
    expect(onAssign).not.toHaveBeenCalled();
  });

  it("does not demand a reason to fill a slot nobody was on", () => {
    const onAssign = vi.fn();
    render(<DispatchJobDetailView {...props({ onAssign, slots: {
      kind: "loaded", rows: [slot({ status: "open", operatorId: null, unitId: null, lastEventId: null })],
      staffing: staffing({ state: "unstaffed", filled: 0, requiredTotal: 1, unfilledRoles: ["Primary unit"], message: "0 of 1." }),
      planningState: "direct", history: [],
    } })} />);
    fireEvent.click(within(screen.getByTestId("slot-900")).getByRole("button", { name: /assign/i }));
    fireEvent.change(screen.getByTestId("assign-operator-900"), { target: { value: "77" } });
    fireEvent.click(screen.getByTestId("assign-submit-900"));
    expect(onAssign).toHaveBeenCalledTimes(1);
  });

  it("never offers an eligibility check as something to attach to an assignment", () => {
    render(<DispatchJobDetailView {...props()} />);
    fireEvent.click(within(screen.getByTestId("slot-900")).getByRole("button", { name: /change/i }));
    expect(pageText()).not.toMatch(/eligibility check|eligibilityCheckId/i);
  });
});

/* ══ I2d. unassigning takes a reason, and the screen enforces it ═════════════ */

describe("I2d — a crew is never stood down without a reason", () => {
  const openUnassign = () => {
    fireEvent.click(within(screen.getByTestId("slot-900")).getByRole("button", { name: /unassign/i }));
  };

  it("asks for a reason before it will submit", () => {
    const onUnassign = vi.fn();
    render(<DispatchJobDetailView {...props({ onUnassign })} />);
    openUnassign();
    fireEvent.click(screen.getByTestId("unassign-submit-900"));
    expect(onUnassign).not.toHaveBeenCalled();
    expect(screen.getByTestId("unassign-reason-required-900").textContent).toMatch(/reason/i);
  });

  /*
   * The server refuses a whitespace-only reason, and it took a mutation that survived its own test
   * to discover that the schema's `min(1)` had been doing all the work. The screen refuses it too,
   * so a dispatcher finds out here rather than through a round trip.
   */
  it("refuses a reason that is only whitespace, which a length check alone would let through", () => {
    const onUnassign = vi.fn();
    render(<DispatchJobDetailView {...props({ onUnassign })} />);
    openUnassign();
    fireEvent.change(screen.getByTestId("unassign-reason-900"), { target: { value: "   " } });
    fireEvent.click(screen.getByTestId("unassign-submit-900"));
    expect(onUnassign).not.toHaveBeenCalled();
  });

  it("submits the reason with the event head once one is given", () => {
    const onUnassign = vi.fn();
    render(<DispatchJobDetailView {...props({ onUnassign })} />);
    openUnassign();
    fireEvent.change(screen.getByTestId("unassign-reason-900"), { target: { value: "Driver called off sick" } });
    fireEvent.click(screen.getByTestId("unassign-submit-900"));
    expect(onUnassign).toHaveBeenCalledTimes(1);
    expect(onUnassign.mock.calls[0][0]).toEqual({
      roleId: 900, expectedLastEventId: 4100, reason: "Driver called off sick",
    });
  });
});

/* ══ I2e. a refused write is shown as refused ════════════════════════════════ */

describe("I2e — a conflict is shown, never swallowed", () => {
  /*
   * The worst outcome for an editable screen: the server refused because somebody else moved the
   * slot first, and the dispatcher walks away believing the change landed. The conflict is the one
   * message that must survive all the way to the DOM.
   */
  it("shows a stale-token refusal against the slot it refused", () => {
    render(<DispatchJobDetailView {...props({ mutation: {
      kind: "conflict", roleId: 900,
      message: "This slot changed since you loaded it. Re-read before assigning.",
    } })} />);
    const conflict = screen.getByTestId("slot-conflict-900");
    expect(conflict.textContent).toMatch(/changed since/i);
    expect(conflict.getAttribute("role")).toBe("alert");
  });

  it("does not present a conflict as a completed change", () => {
    render(<DispatchJobDetailView {...props({ mutation: {
      kind: "conflict", roleId: 900, message: "This slot changed since you loaded it.",
    } })} />);
    expect(pageText()).not.toMatch(/saved|assigned successfully|change applied|done/i);
  });

  it("tells the dispatcher to re-read, because the screen's copy of the slot is the stale part", () => {
    render(<DispatchJobDetailView {...props({ mutation: {
      kind: "conflict", roleId: 900, message: "This slot changed since you loaded it.",
    } })} />);
    expect(screen.getByTestId("slot-conflict-900").textContent).toMatch(/re-read|refresh|reload/i);
  });

  it("shows an ordinary failure as a failure too, and attributes it to its slot", () => {
    render(<DispatchJobDetailView {...props({ mutation: {
      kind: "failed", roleId: 900, message: "Operator 78 is already on another slot of this posting",
    } })} />);
    expect(screen.getByTestId("slot-error-900").textContent).toContain("already on another slot");
  });

  it("marks the slot it is writing to as in flight, and only that slot", () => {
    render(<DispatchJobDetailView {...props({
      slots: { kind: "loaded", rows: [slot(), slot({ roleId: 901 })], staffing: staffing(), planningState: "staffed", history: [] },
      mutation: { kind: "pending", roleId: 900 },
    })} />);
    expect(screen.getByTestId("slot-pending-900")).toBeInTheDocument();
    expect(screen.queryByTestId("slot-pending-901")).toBeNull();
  });
});

/* ══ I2f. filling a slot still says nothing about readiness ══════════════════ */

describe("I2f — assignment never implies readiness or an award", () => {
  it("derives no readiness word of its own, on a fully staffed posting", () => {
    render(<DispatchJobDetailView {...props()} />);
    for (const word of ["Ready", "Not ready", "Eligible", "Cleared to dispatch", "Awarded"]) {
      expect(pageText().includes(word), `the detail screen must not say "${word}"`).toBe(false);
    }
  });

  it("renders whatever readiness component it was handed, unmodified", () => {
    render(<DispatchJobDetailView {...props()} />);
    expect(screen.getByTestId("readiness-slot")).toBeInTheDocument();
  });

  it("shows the readiness section even when the job header could not be read", () => {
    render(<DispatchJobDetailView {...props({ job: { kind: "outside_window" } })} />);
    expect(screen.getByTestId("readiness-slot")).toBeInTheDocument();
  });

  it("says outright that a filled slot is not a dispatch decision", () => {
    render(<DispatchJobDetailView {...props()} />);
    expect(screen.getByTestId("assignment-scope-note").textContent)
      .toMatch(/readiness|separate|does not/i);
  });
});

/* ══ I2g. history ════════════════════════════════════════════════════════════ */

describe("I2g — what happened to these slots", () => {
  it("lists the events the server returned, newest information intact", () => {
    render(<DispatchJobDetailView {...props({ slots: {
      kind: "loaded", rows: [slot()], staffing: staffing(), planningState: "staffed",
      history: [
        event({ id: 4101, eventType: "assignment_reassigned", fromOperatorId: 77, toOperatorId: 78, reason: "Swapped for hours" }),
        event(),
      ],
    } })} />);
    const h = screen.getByTestId("history").textContent ?? "";
    expect(h).toContain("Swapped for hours");
    expect(h).toContain("77");
    expect(h).toContain("78");
  });

  it("names the displaced crew on a reassignment rather than only the new one", () => {
    render(<DispatchJobDetailView {...props({ slots: {
      kind: "loaded", rows: [slot()], staffing: staffing(), planningState: "staffed",
      history: [event({ id: 4101, eventType: "assignment_reassigned", fromOperatorId: 77, toOperatorId: 78, reason: "Swapped" })],
    } })} />);
    expect(screen.getByTestId("history-4101").textContent).toMatch(/77/);
  });

  it("says there is no history rather than rendering an empty box", () => {
    render(<DispatchJobDetailView {...props({ slots: {
      kind: "loaded", rows: [slot()], staffing: staffing(), planningState: "staffed", history: [],
    } })} />);
    expect(screen.getByTestId("history-none")).toBeInTheDocument();
  });
});

/* ══ I2h. the states that say less ═══════════════════════════════════════════ */

describe("I2h — failure, loading, and a job with no posting", () => {
  it("shows a failed slot read as a failure and renders no slot data", () => {
    render(<DispatchJobDetailView {...props({ slots: { kind: "failed", message: "Database unavailable" } })} />);
    expect(screen.getAllByRole("alert").map(a => a.textContent).join(" ")).toContain("Database unavailable");
    expect(screen.queryAllByTestId(/^slot-\d+$/)).toHaveLength(0);
    expect(screen.queryByTestId("slots-no-posting")).toBeNull();
  });

  it("shows a failed job read as a failure, not as a job with empty fields", () => {
    render(<DispatchJobDetailView {...props({ job: { kind: "failed", message: "No organization" } })} />);
    expect(screen.getAllByRole("alert").map(a => a.textContent).join(" ")).toContain("No organization");
    expect(screen.queryByTestId("job-header")).toBeNull();
  });

  it("renders nothing readable as data while loading", () => {
    render(<DispatchJobDetailView {...props({ job: { kind: "loading" }, slots: { kind: "loading" } })} />);
    expect(screen.getByTestId("job-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("job-header")).toBeNull();
    expect(screen.queryByTestId("slots-no-posting")).toBeNull();
  });

  /*
   * A job with no dispatch posting is not a job with nobody on it — there is no slot model for it
   * yet at all. Saying "unstaffed" would invent a posting that does not exist.
   */
  it("says a job has no posting rather than showing it as unstaffed", () => {
    render(<DispatchJobDetailView {...props({ slots: { kind: "no_posting" } })} />);
    const m = screen.getByTestId("slots-no-posting").textContent ?? "";
    expect(m).toMatch(/no dispatch posting|not been posted|no posting/i);
    expect(m).not.toMatch(/unstaffed/i);
    expect(screen.queryByTestId("staffing")).toBeNull();
  });

  it("says the job is not among the ones it can read, and renders no header", () => {
    render(<DispatchJobDetailView {...props({ job: { kind: "outside_window" } })} />);
    const m = screen.getByTestId("job-unavailable").textContent ?? "";
    expect(m).toMatch(/not among/i);
    expect(screen.queryByTestId("job-header")).toBeNull();
    expect(saysUnknown()).toBe(false);
  });

  it("does not claim the job does not exist", () => {
    render(<DispatchJobDetailView {...props({ job: { kind: "outside_window" } })} />);
    expect(screen.getByTestId("job-unavailable").textContent).not.toMatch(/does not exist|no such job|deleted/i);
  });
});

/* ══ I2i. what activation removed ════════════════════════════════════════════ */

describe("I2i — the disclosures activation made untrue are gone", () => {
  /*
   * PR #6 had to disclose two things about `jobUnits`: a hundred-row job-blind window, and that
   * trailers were not representable at all. `dispatch.listRoles` is keyed by job and slots carry a
   * trailer, so repeating either would now be the fabrication.
   */
  it("no longer warns about a hundred-row window it no longer reads from", () => {
    render(<DispatchJobDetailView {...props()} />);
    expect(screen.queryByTestId("assignment-window")).toBeNull();
    expect(pageText()).not.toMatch(/most recent 100|hundred/i);
  });

  it("no longer says assignment cannot be changed from here", () => {
    render(<DispatchJobDetailView {...props()} />);
    expect(screen.queryByTestId("assignment-readonly-note")).toBeNull();
    expect(pageText()).not.toMatch(/read-only|cannot be changed/i);
  });

  it("shows a trailer the slot carries instead of saying trailers are unrepresentable", () => {
    render(<DispatchJobDetailView {...props({ slots: {
      kind: "loaded", rows: [slot({ trailerId: 640, trailerName: "TR-640" })],
      staffing: staffing(), planningState: "staffed", history: [],
    } })} />);
    expect(screen.getByTestId("slot-900").textContent).toContain("640");
    expect(screen.queryByTestId("trailer-unsupported")).toBeNull();
  });

  /*
   * But the limitation that is still real stays stated: the server cannot prove an id is a trailer
   * rather than a truck, because `units.vehicleType` is free text nothing reads.
   */
  it("still says the trailer's type is not something the server can vouch for", () => {
    render(<DispatchJobDetailView {...props({ slots: {
      kind: "loaded", rows: [slot({ trailerId: 640, trailerName: "TR-640" })],
      staffing: staffing(), planningState: "staffed", history: [],
    } })} />);
    expect(screen.getByTestId("trailer-typing-note").textContent).toMatch(/not verified|free text|cannot confirm|not checked/i);
  });

  it("offers a re-read, which is still available alongside the new controls", () => {
    render(<DispatchJobDetailView {...props()} />);
    expect(screen.getByTestId("refresh")).toBeInTheDocument();
  });
});
