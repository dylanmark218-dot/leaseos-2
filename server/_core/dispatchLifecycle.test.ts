import { describe, expect, it } from "vitest";
import {
  acknowledgeOfflineBid,
  advanceRotation,
  assessStaffing,
  canAcceptBid,
  canTransitionBid,
  canTransitionInvitation,
  canTransitionPosting,
  checkpointsDue,
  evaluatePreDeparture,
  rateVisibilityFor,
  type RoleStaffing,
} from "./dispatchLifecycle";
import type { DispatchBlocker } from "./dispatchReadiness";

const NOW = new Date(Date.UTC(2026, 7, 31, 6, 0));
const hrs = (h: number) => new Date(NOW.getTime() + h * 3_600_000);

describe("posting lifecycle", () => {
  it("permits the documented happy path", () => {
    expect(canTransitionPosting("draft", "planning")).toBe(true);
    expect(canTransitionPosting("planning", "open_for_bid")).toBe(true);
    expect(canTransitionPosting("open_for_bid", "bid_closed")).toBe(true);
    expect(canTransitionPosting("bid_closed", "awarding")).toBe(true);
    expect(canTransitionPosting("awarding", "partially_staffed")).toBe(true);
    expect(canTransitionPosting("partially_staffed", "staffed")).toBe(true);
    expect(canTransitionPosting("staffed", "dispatched")).toBe(true);
    expect(canTransitionPosting("dispatched", "in_progress")).toBe(true);
    expect(canTransitionPosting("in_progress", "completed")).toBe(true);
  });

  it("allows cancellation from any live state but nothing after it", () => {
    for (const s of [
      "draft",
      "planning",
      "open_for_bid",
      "awarding",
      "staffed",
      "in_progress",
    ] as const) {
      expect(canTransitionPosting(s, "cancelled")).toBe(true);
    }
    expect(canTransitionPosting("cancelled", "open_for_bid")).toBe(false);
    expect(canTransitionPosting("completed", "in_progress")).toBe(false);
  });

  it("refuses a jump straight from draft to dispatched", () => {
    expect(canTransitionPosting("draft", "dispatched")).toBe(false);
  });

  it("allows a staffed posting to fall back to partially staffed after a withdrawal", () => {
    expect(canTransitionPosting("staffed", "partially_staffed")).toBe(true);
  });
});

describe("canAcceptBid", () => {
  it("accepts a bid on an open posting before the deadline", () => {
    expect(canAcceptBid("open_for_bid", hrs(2), NOW).accepted).toBe(true);
  });

  it("refuses after the deadline", () => {
    const r = canAcceptBid("open_for_bid", hrs(-1), NOW);
    expect(r.accepted).toBe(false);
    expect(r.reason).toContain("deadline has passed");
  });

  it("refuses on a cancelled posting", () => {
    expect(canAcceptBid("cancelled", hrs(2), NOW).accepted).toBe(false);
  });

  it("refuses once awarding has begun", () => {
    expect(canAcceptBid("awarding", hrs(2), NOW).accepted).toBe(false);
  });
});

describe("bid and invitation transitions", () => {
  it("cannot award a withdrawn bid", () => {
    expect(canTransitionBid("withdrawn", "awarded")).toBe(false);
  });

  it("cannot award an expired bid", () => {
    expect(canTransitionBid("expired", "awarded")).toBe(false);
  });

  it("allows submitted → shortlisted → awarded", () => {
    expect(canTransitionBid("submitted", "shortlisted")).toBe(true);
    expect(canTransitionBid("shortlisted", "awarded")).toBe(true);
  });

  it("lets an awarded operator still decline", () => {
    expect(canTransitionBid("awarded", "declined")).toBe(true);
  });

  it("tracks invitation delivery through to a bid", () => {
    expect(canTransitionInvitation("queued", "sent")).toBe(true);
    expect(canTransitionInvitation("sent", "delivered")).toBe(true);
    expect(canTransitionInvitation("delivered", "viewed")).toBe(true);
    expect(canTransitionInvitation("viewed", "bid_submitted")).toBe(true);
    expect(canTransitionInvitation("bid_submitted", "awarded")).toBe(true);
  });

  it("cannot mark an unsent invitation as viewed", () => {
    expect(canTransitionInvitation("queued", "viewed")).toBe(false);
  });
});

describe("acknowledgeOfflineBid", () => {
  it("accepts a bid that reaches the server while the posting is still open", () => {
    const r = acknowledgeOfflineBid("open_for_bid", hrs(3), NOW, hrs(1));
    expect(r.accepted).toBe(true);
  });

  it("refuses a bid prepared offline that arrives after the posting closed", () => {
    const r = acknowledgeOfflineBid("awarding", hrs(3), NOW, hrs(1));
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toContain("no longer taking bids");
  });

  it("refuses a bid arriving after the deadline even though it was prepared before", () => {
    const r = acknowledgeOfflineBid("open_for_bid", hrs(1), NOW, hrs(2));
    expect(r.accepted).toBe(false);
    if (!r.accepted) expect(r.reason).toContain("deadline has passed");
  });
});

describe("assessStaffing — multi-role jobs", () => {
  const rigMove: RoleStaffing[] = [
    { roleId: 1, roleLabel: "Lead", required: true, assignedOperatorId: 47 },
    {
      roleId: 2,
      roleLabel: "Winch tractor 1",
      required: true,
      assignedOperatorId: 48,
    },
    {
      roleId: 3,
      roleLabel: "Winch tractor 2",
      required: true,
      assignedOperatorId: null,
    },
    {
      roleId: 4,
      roleLabel: "Bed truck",
      required: true,
      assignedOperatorId: 50,
    },
    {
      roleId: 5,
      roleLabel: "Picker",
      required: true,
      assignedOperatorId: null,
    },
    {
      roleId: 6,
      roleLabel: "Pilot vehicle 1",
      required: true,
      assignedOperatorId: 52,
    },
    {
      roleId: 7,
      roleLabel: "Swamper",
      required: false,
      assignedOperatorId: null,
    },
  ];

  it("stays partially staffed until every required role is filled", () => {
    const s = assessStaffing(rigMove);
    expect(s.state).toBe("partially_staffed");
    expect(s.filled).toBe(4);
    expect(s.requiredTotal).toBe(6);
    expect(s.unfilledRoles).toEqual(["Winch tractor 2", "Picker"]);
  });

  it("does not let an unfilled optional role hold the posting back", () => {
    const filled = rigMove.map(r =>
      r.required ? { ...r, assignedOperatorId: r.assignedOperatorId ?? 99 } : r
    );
    const s = assessStaffing(filled);
    expect(s.state).toBe("staffed");
    expect(s.message).toContain("All 6 required roles filled");
  });

  it("reports unstaffed when nothing is assigned", () => {
    expect(
      assessStaffing(rigMove.map(r => ({ ...r, assignedOperatorId: null })))
        .state
    ).toBe("unstaffed");
  });

  it("names the outstanding roles rather than reporting a count", () => {
    expect(assessStaffing(rigMove).message).toContain(
      "Outstanding: Winch tractor 2, Picker"
    );
  });
});

describe("advanceRotation", () => {
  it("moves to the next position after a decline", () => {
    const r = advanceRotation([
      { operatorId: 47, position: 1, status: "declined" },
      { operatorId: 48, position: 2, status: "scheduled" },
      { operatorId: 49, position: 3, status: "scheduled" },
    ]);
    expect(r.nextOperatorId).toBe(48);
    expect(r.nextPosition).toBe(2);
  });

  it("skips no-response and unavailable operators without ambiguity", () => {
    const r = advanceRotation([
      { operatorId: 47, position: 1, status: "no_response" },
      { operatorId: 48, position: 2, status: "unavailable" },
      { operatorId: 49, position: 3, status: "scheduled" },
    ]);
    expect(r.nextOperatorId).toBe(49);
  });

  it("reports exhaustion instead of silently returning nobody", () => {
    const r = advanceRotation([
      { operatorId: 47, position: 1, status: "declined" },
      { operatorId: 48, position: 2, status: "no_response" },
    ]);
    expect(r.exhausted).toBe(true);
    expect(r.message).toContain("Escalate to dispatch");
  });

  it("respects position order regardless of array order", () => {
    const r = advanceRotation([
      { operatorId: 49, position: 3, status: "scheduled" },
      { operatorId: 48, position: 2, status: "scheduled" },
    ]);
    expect(r.nextOperatorId).toBe(48);
  });
});

describe("pre-departure gate", () => {
  const critical: DispatchBlocker[] = [
    {
      code: "critical_defect",
      label: "VAC-27 developed a critical defect after assignment",
      severity: "blocking",
      subject: "truck",
      overridable: false,
    },
  ];
  const unknownHos: DispatchBlocker[] = [
    {
      code: "hos_unknown",
      label: "Operator HOS state has not been reported",
      severity: "unknown",
      subject: "operator",
      overridable: true,
      overrideAuthority: "manager",
    },
  ];

  it("releases only on the final immediate check", () => {
    const early = evaluatePreDeparture("eligible", [], false);
    const final = evaluatePreDeparture("eligible", [], true);
    expect(early.status).toBe("released");
    expect(early.releasedToDepart).toBe(false);
    expect(early.message).toContain("final revalidation is still required");
    expect(final.releasedToDepart).toBe(true);
  });

  it("blocks departure on a post-award critical defect", () => {
    const r = evaluatePreDeparture("blocked", critical, true);
    expect(r.status).toBe("blocked");
    expect(r.releasedToDepart).toBe(false);
    expect(r.message).toContain("ASSIGNMENT BLOCKED");
  });

  it("moves to at-risk rather than cancelling when a condition becomes unknown", () => {
    const r = evaluatePreDeparture("unknown", unknownHos, true);
    expect(r.status).toBe("at_risk");
    expect(r.releasedToDepart).toBe(false);
    expect(r.message).toContain("ASSIGNMENT AT RISK");
    expect(r.message).toContain("Dispatch notified");
  });

  it("treats a new review condition as at risk, not as released", () => {
    const review: DispatchBlocker[] = [
      {
        code: "route_review",
        label: "Route evaluation returned review",
        severity: "review",
        subject: "route",
        overridable: true,
        overrideAuthority: "manager",
      },
    ];
    expect(evaluatePreDeparture("eligible_review", review, true).status).toBe(
      "at_risk"
    );
  });

  it("never lets an earlier passing check substitute for the final one", () => {
    const at24h = evaluatePreDeparture("eligible", [], false);
    expect(at24h.releasedToDepart).toBe(false);
  });
});

describe("checkpointsDue", () => {
  const departure = hrs(3);

  it("surfaces the 24-hour checkpoint once it is overdue", () => {
    const due = checkpointsDue(departure, NOW);
    expect(due.map(c => c.hoursBefore)).toContain(24);
    expect(due.map(c => c.hoursBefore)).toContain(4);
    expect(due.map(c => c.hoursBefore)).not.toContain(1);
  });

  it("does not repeat a completed checkpoint", () => {
    const due = checkpointsDue(departure, NOW, [24, 4]);
    expect(due).toHaveLength(0);
  });

  it("always makes the immediate pre-departure check mandatory", () => {
    const due = checkpointsDue(departure, hrs(3), [24, 4, 1]);
    expect(due).toHaveLength(1);
    expect(due[0].hoursBefore).toBe(0);
    expect(due[0].mandatory).toBe(true);
  });
});

describe("rateVisibilityFor", () => {
  it("lets an employee see their own compensation but not the customer rate", () => {
    const v = rateVisibilityFor("operator_employee");
    expect(v.ownCompensation).toBe(true);
    expect(v.customerRate).toBe(false);
    expect(v.internalMargin).toBe(false);
    expect(v.maySubmitPrice).toBe(false);
    expect(v.mayAcceptPostedAmount).toBe(true);
  });

  it("lets a contractor submit a price", () => {
    expect(rateVisibilityFor("operator_contractor").maySubmitPrice).toBe(true);
  });

  it("hides the customer rate from every operator", () => {
    expect(rateVisibilityFor("operator_employee").customerRate).toBe(false);
    expect(rateVisibilityFor("operator_contractor").customerRate).toBe(false);
  });

  it("restricts internal margin to office roles, not dispatchers", () => {
    expect(rateVisibilityFor("dispatcher").internalMargin).toBe(false);
    expect(rateVisibilityFor("manager").internalMargin).toBe(true);
    expect(rateVisibilityFor("administrator").internalMargin).toBe(true);
  });
});
