/**
 * The analytics dashboard, as a screen.
 *
 * Most of these tests are about the ways a dashboard lies without anyone meaning it to: a missing
 * value read as zero, an incomplete count shown as a whole one, an old number shown as live, a
 * drill-down that does not add up to its tile, and a driver's own page that reads like a ranking.
 */
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AnalyticsDashboardView, type AnalyticsDashboardViewProps, type MetricAnswer, type MetricCard } from "./AnalyticsDashboardView";
import { fieldLabel, fieldValue, formatValue, freshnessOf, lastUpdatedLabel, presentDetermination, rangeText } from "./analyticsPresentation";

afterEach(cleanup);

const NOW = new Date("2026-09-24T15:00:00Z");
const answer = (o: Partial<MetricAnswer> = {}): MetricAnswer => ({
  metricId: "maintenance.defects.open", value: 2, determination: "computed", unknowns: [], basis: 2,
  breakdown: { critical: 1, advisory: 1 }, range: null, computedAt: new Date(NOW.getTime() - 30_000), freshnessSeconds: 120, ...o,
});
const card = (o: Partial<MetricCard> = {}): MetricCard => ({
  id: "maintenance.defects.open", name: "Open defects", family: "maintenance", description: "Defects not yet resolved.",
  formula: "Count of maintenance defects on units in scope with status open or in_progress.", unit: "count",
  unavailable: null, state: { kind: "loaded", answer: answer() }, ...o,
});
const props = (o: Partial<AnalyticsDashboardViewProps> = {}): AnalyticsDashboardViewProps => ({
  mode: "organization", onMode: null, failure: null, loading: false, cards: [card()], hiddenCount: 0, emptyReason: null,
  scope: { derivedFrom: "membership" }, range: "today", onRange: () => {}, zone: "America/Edmonton", now: NOW,
  onRefresh: () => {}, refreshing: false, drill: null, onDrill: () => {}, ...o,
});
const tile = (id = "maintenance.defects.open") => within(screen.getByTestId(`tile-${id}`));

describe("a value is never a quiet zero", () => {
  it("shows a counted zero as 0 and a missing value as words", () => {
    render(<AnalyticsDashboardView {...props({ cards: [
      card({ id: "a.zero", name: "Zero", state: { kind: "loaded", answer: answer({ metricId: "a.zero", value: 0, breakdown: null }) } }),
      card({ id: "a.none", name: "None", unit: "hours", state: { kind: "loaded", answer: answer({ metricId: "a.none", value: null, determination: "not_applicable", breakdown: null }) } }),
    ] })} />);
    expect(tile("a.zero").getByTestId("value").textContent).toBe("0");
    expect(tile("a.none").getByTestId("value").textContent).toBe("No value");
    expect(tile("a.none").getByTestId("determination").textContent).toBe("Nothing to measure");
  });

  it("shows a metric the records cannot support with its reason, and offers no records", () => {
    render(<AnalyticsDashboardView {...props({ cards: [card({ id: "m.overdue", name: "Overdue work orders", unavailable: { determination: "not_derivable", reason: "Work orders carry no due date" } })] })} />);
    expect(tile("m.overdue").getByTestId("value").textContent).toBe("No value");
    expect(tile("m.overdue").getByTestId("unavailable-reason").textContent).toContain("no due date");
    expect(tile("m.overdue").queryByTestId("drill-m.overdue")).toBeNull();
  });

  it("does not show a value for a metric that failed and never answered", () => {
    render(<AnalyticsDashboardView {...props({ cards: [card({ state: { kind: "failed", message: "Database unavailable", last: null } })] })} />);
    expect(tile().getByTestId("tile-failed").textContent).toContain("Database unavailable");
    expect(tile().queryByTestId("value")).toBeNull();
  });
});

describe("incomplete says what is missing", () => {
  it("names the records it could not place beside the value", () => {
    render(<AnalyticsDashboardView {...props({ cards: [card({ id: "ops.trips.completed", name: "Trips completed",
      state: { kind: "loaded", answer: answer({ metricId: "ops.trips.completed", value: 1, determination: "partial", breakdown: null, unknowns: [{ reason: "Trips marked complete with no completedAt", count: 3 }, { reason: "nothing", count: 0 }] }) } })] })} />);
    const t = tile("ops.trips.completed");
    expect(t.getByTestId("determination")).toHaveAttribute("data-tone", "incomplete");
    expect(t.getByTestId("unknowns").textContent).toContain("3 not placed: Trips marked complete with no completedAt");
    expect(t.getByTestId("unknowns").textContent).not.toContain("nothing");
  });

  it("shows a determination it does not know as unknown to it, never as complete", () => {
    render(<AnalyticsDashboardView {...props({ cards: [card({ state: { kind: "loaded", answer: answer({ determination: "fully_trusted" }) } })] })} />);
    expect(tile().getByTestId("determination").textContent).toBe("Unrecognized answer");
    expect(tile().getByTestId("determination")).toHaveAttribute("data-tone", "absent");
  });
});

describe("old is not live", () => {
  it("states when each answer was computed", () => {
    render(<AnalyticsDashboardView {...props()} />);
    expect(tile().getByTestId("last-updated").textContent).toBe("Last updated 08:59");
    expect(tile().getByTestId("last-updated")).toHaveAttribute("data-stale", "no");
    expect(tile().queryByTestId("stale")).toBeNull();
  });

  it("marks an answer older than the metric's budget stale", () => {
    render(<AnalyticsDashboardView {...props({ cards: [card({ state: { kind: "loaded", answer: answer({ computedAt: new Date(NOW.getTime() - 600_000) }) } })] })} />);
    expect(tile().getByTestId("stale")).toBeInTheDocument();
  });

  it("keeps the last answer after a failed refresh only as stale, and says the refresh failed", () => {
    render(<AnalyticsDashboardView {...props({ cards: [card({ state: { kind: "failed", message: "network unreachable", last: answer() } })] })} />);
    expect(tile().getByTestId("value").textContent).toBe("2");
    expect(tile().getByTestId("stale")).toBeInTheDocument();
    expect(tile().getByTestId("refresh-failed").textContent).toContain("network unreachable");
    expect(tile().getByTestId("refresh-failed").textContent).toContain("not current");
  });

  it("says which zone its times are in", () => {
    render(<AnalyticsDashboardView {...props()} />);
    expect(screen.getByTestId("zone").textContent).toBe("Times are shown in America/Edmonton.");
  });
});

describe("the drill-down is the tile's records", () => {
  const rows = [
    { key: "defect:1", record: { table: "maintenanceDefects", id: 1, ref: null }, label: "Brake chamber leak", at: new Date("2026-09-20T14:00:00Z"), fields: { unitId: 7, severity: "critical", status: "open" } },
    { key: "defect:2", record: { table: "maintenanceDefects", id: 2, ref: null }, label: "Mirror cracked", at: null, fields: { unitId: 8, severity: "advisory", status: null } },
  ];

  it("lists exactly the records and says they are what the value was computed from", () => {
    render(<AnalyticsDashboardView {...props({ drill: { metricId: "maintenance.defects.open", name: "Open defects", unit: "count", state: { kind: "loaded", answer: answer(), rows, truncated: false } } })} />);
    const panel = within(screen.getByTestId("drill-panel"));
    expect(panel.getAllByTestId("drill-row")).toHaveLength(2);
    expect(panel.getByTestId("drill-summary").textContent).toContain("2 records · value 2");
    expect(panel.getByTestId("drill-summary").textContent).toContain("same question");
    expect(panel.getAllByText("not recorded").length).toBeGreaterThanOrEqual(2);
    expect(panel.getByText("maintenanceDefects #1")).toBeInTheDocument();
  });

  it("says when more records qualify than are listed", () => {
    render(<AnalyticsDashboardView {...props({ drill: { metricId: "maintenance.defects.open", name: "Open defects", unit: "count", state: { kind: "loaded", answer: answer({ determination: "partial" }), rows, truncated: true } } })} />);
    expect(screen.getByTestId("drill-truncated")).toBeInTheDocument();
  });

  it("calls an empty list a counted zero", () => {
    render(<AnalyticsDashboardView {...props({ drill: { metricId: "maintenance.defects.open", name: "Open defects", unit: "count", state: { kind: "loaded", answer: answer({ value: 0 }), rows: [], truncated: false } } })} />);
    expect(screen.getByTestId("drill-empty").textContent).toContain("counted zero");
  });

  it("opens from the tile and closes from the panel", () => {
    const onDrill = vi.fn();
    render(<AnalyticsDashboardView {...props({ onDrill, drill: { metricId: "maintenance.defects.open", name: "Open defects", unit: "count", state: { kind: "loading" } } })} />);
    fireEvent.click(screen.getByTestId("drill-maintenance.defects.open"));
    expect(onDrill).toHaveBeenLastCalledWith("maintenance.defects.open");
    fireEvent.click(screen.getByTestId("drill-close"));
    expect(onDrill).toHaveBeenLastCalledWith(null);
  });
});

describe("whose numbers, and who may see them", () => {
  it("tells a driver these are their own records and that nobody is ranked", () => {
    render(<AnalyticsDashboardView {...props({ mode: "mine" })} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("My numbers");
    expect(screen.getByTestId("mine-note").textContent).toContain("Nobody is ranked or scored");
  });

  it("says why there are no numbers rather than showing an empty page", () => {
    render(<AnalyticsDashboardView {...props({ mode: "mine", cards: [], emptyReason: "No operator record is linked to your login" })} />);
    expect(screen.getByTestId("empty-reason").textContent).toBe("No operator record is linked to your login");
  });

  it("counts the metrics a role may not read without naming them", () => {
    render(<AnalyticsDashboardView {...props({ hiddenCount: 3 })} />);
    expect(screen.getByTestId("hidden-count").textContent).toContain("3 further metrics are not shown");
  });

  it("says when the numbers cover the records that belong to no organization", () => {
    render(<AnalyticsDashboardView {...props({ scope: { derivedFrom: "single_tenant_fallback" } })} />);
    expect(screen.getByTestId("scope-note")).toBeInTheDocument();
  });

  it("switches between the organization and the caller's own numbers when both are open", () => {
    const onMode = vi.fn();
    render(<AnalyticsDashboardView {...props({ onMode })} />);
    expect(screen.getByTestId("mode-organization")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByTestId("mode-mine"));
    expect(onMode).toHaveBeenCalledWith("mine");
  });

  it("shows nothing at all, and reuses nothing, when analytics could not be read", () => {
    render(<AnalyticsDashboardView {...props({ failure: "Database unavailable" })} />);
    expect(screen.getByRole("alert").textContent).toContain("Database unavailable");
    expect(screen.queryByTestId("tile-maintenance.defects.open")).toBeNull();
  });

  it("offers every range the server answers, and hands the choice back", () => {
    const onRange = vi.fn();
    render(<AnalyticsDashboardView {...props({ onRange })} />);
    fireEvent.change(screen.getByTestId("range-select"), { target: { value: "month_to_date" } });
    expect(onRange).toHaveBeenCalledWith("month_to_date");
  });
});

describe("the words", () => {
  it("formats durations and counts without inventing a zero", () => {
    expect(formatValue(195, "minutes")).toBe("3 h 15 min");
    expect(formatValue(45, "minutes")).toBe("45 min");
    expect(formatValue(10.5, "hours")).toBe("10.5 h");
    expect(formatValue(1234, "count")).toBe("1,234");
    expect(formatValue(null, "count")).toBe("No value");
  });
  it("judges age against the metric's own budget, and a clock behind the server's as age zero", () => {
    expect(freshnessOf(new Date(NOW.getTime() - 121_000), 120, NOW)).toEqual({ stale: true, ageSeconds: 121 });
    expect(freshnessOf(new Date(NOW.getTime() + 5_000), 120, NOW)).toEqual({ stale: false, ageSeconds: 0 });
  });
  it("dates an answer that is not from today", () => {
    expect(lastUpdatedLabel(new Date("2026-09-22T15:00:00Z"), NOW, "America/Edmonton")).toBe("Last updated Sep 22, 09:00");
  });
  it("describes a range as the instants it covered, end excluded", () => {
    expect(rangeText(null, "UTC")).toBe("Current state");
    expect(rangeText({ from: new Date("2026-09-24T06:00:00Z"), to: new Date("2026-09-25T06:00:00Z") }, "America/Edmonton")).toBe("Sep 24, 00:00 up to Sep 25, 00:00");
  });
  it("names fields and empty values for a person", () => {
    expect(fieldLabel("daysRemaining")).toBe("Days remaining");
    expect(fieldValue(null)).toBe("not recorded");
    expect(fieldValue(false)).toBe("no");
    expect(presentDetermination("computed").label).toBe("Complete");
  });
});
