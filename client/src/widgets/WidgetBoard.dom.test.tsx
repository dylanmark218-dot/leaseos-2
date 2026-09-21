// Fixture permissions translated from the engine's scratch vocabulary to the branch's real permission names (B28 port).
/**
 * B26 — the board, rendered at three widths.
 */
// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WidgetBoard, type BoardTileView } from "./WidgetBoard";
import { blocked, ok, unknown, type Provenance } from "../../../server/_core/widgetPayload";
import axe from "axe-core";

afterEach(cleanup);
const NOW = new Date("2026-09-12T14:00:00Z");
const prov: Provenance = { source: "measured", verification: "verified", exact: true, observedAt: NOW };

const tiles: BoardTileView[] = [
  { instanceRef: "a", widgetKey: "myDay", title: "My Day", variant: "list", payload: ok({ rows: [{ id: "1", primary: "3 stops" }] }, prov), position: 0, spanColumns: 2, spanRows: 1, variants: ["list", "detail"] },
  { instanceRef: "b", widgetKey: "exceptions", title: "Exception Centre", variant: "kpi", payload: { state: "not_permitted", permission: "surface.exceptions.read" }, position: 1, spanColumns: 1, spanRows: 1 },
  { instanceRef: "c", widgetKey: "hosRemaining", title: "Hours Remaining", variant: "gauge", payload: ok({ current: 252, max: 780, unit: "min", label: "4h 12m" }, prov), position: 2, spanColumns: 1, spanRows: 2, variants: ["kpi", "gauge", "countdown", "detail"] },
  { instanceRef: "d", widgetKey: "unitReadiness", title: "Unit Readiness", variant: "status", payload: blocked([{ code: "X", detail: "Annual inspection expired 2026-08-14 and the unit may not be dispatched until a mechanic releases it" }]), position: 3, spanColumns: 4, spanRows: 1 },
  { instanceRef: "e", widgetKey: "search", title: "Search", variant: "form", payload: unknown("no verified axle limit loaded"), position: 4 },
];

const board = (o: Partial<Parameters<typeof WidgetBoard>[0]> = {}) => (
  <WidgetBoard name="Yard mornings" seeded={false} deviceClass="desktop" tiles={tiles} {...o} />
);

describe("responsive grid", () => {
  const gridOf = (container: HTMLElement) =>
    Array.from(container.querySelectorAll("div")).find((d) => d.style.gridTemplateColumns) as HTMLElement;

  it("renders one column on a phone and collapses every span", () => {
    const { container } = render(board({ deviceClass: "phone" }));
    expect(gridOf(container).style.gridTemplateColumns).toBe("repeat(1, minmax(0, 1fr))");
    const spans = Array.from(container.querySelectorAll("[style*='grid-column']"))
      .map((el) => (el as HTMLElement).style.gridColumn);
    expect(new Set(spans)).toEqual(new Set(["span 1"]));
  });

  it("renders two columns on a tablet and narrows the four-wide tile", () => {
    const { container } = render(board({ deviceClass: "tablet" }));
    expect(gridOf(container).style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
    expect(screen.getByText(/narrowed to fit this screen/i)).toBeInTheDocument();
  });

  it("honours declared spans on a desktop", () => {
    const { container } = render(board({ deviceClass: "desktop" }));
    const spans = Array.from(container.querySelectorAll("[style*='grid-column']"))
      .map((el) => (el as HTMLElement).style.gridColumn);
    expect(spans).toEqual(["span 2", "span 1", "span 1", "span 4", "span 1"]);
    expect(screen.queryByText(/narrowed to fit/i)).toBeNull();
  });

  it("keeps logical order at every width", () => {
    for (const dc of ["phone", "tablet", "desktop"] as const) {
      cleanup();
      render(board({ deviceClass: dc }));
      const titles = screen.getAllByRole("region").map((r) => within(r).getAllByRole("heading")[0]?.textContent);
      expect(titles, dc).toEqual(["My Day", "Exception Centre", "Hours Remaining", "Unit Readiness", "Search"]);
    }
  });

  it("wraps long blocker text rather than forcing horizontal overflow", () => {
    const { container } = render(board({ deviceClass: "phone" }));
    // minmax(0, 1fr) is what stops a long token from widening the track; a
    // bare 1fr would let the blocker sentence push the board sideways.
    expect(gridOf(container).style.gridTemplateColumns).toContain("minmax(0, 1fr)");
    // Printed twice on purpose — once as the tile's sentence, once in the
    // blocker list — so getAllByText, as elsewhere.
    expect(screen.getAllByText(/may not be dispatched until a mechanic releases it/).length).toBeGreaterThan(0);
  });
});

describe("a withheld tile is visible on the board", () => {
  it("keeps its saved position and says it is withheld", () => {
    render(board({ deviceClass: "desktop" }));
    const regions = screen.getAllByRole("region");
    expect(within(regions[1] as HTMLElement).getAllByText(/withheld/i).length).toBeGreaterThan(0);
  });
});

describe("controls", () => {
  it("reorders by button and emits the new order on save", async () => {
    const onSave = vi.fn();
    const user = userEvent.setup();
    render(board({ onSave }));
    await user.click(screen.getByRole("button", { name: /move hours remaining earlier/i }));
    await user.click(screen.getByRole("button", { name: /save this board/i }));
    expect(onSave).toHaveBeenCalledWith(["a", "c", "b", "d", "e"]);
  });

  it("disables moving the first tile up and the last tile down", () => {
    render(board());
    expect(screen.getByRole("button", { name: /move my day earlier/i })).toBeDisabled();
    expect(screen.getByRole("button", { name: /move search later/i })).toBeDisabled();
  });

  it("changes a variant through the per-tile selector", async () => {
    const onVariantChange = vi.fn();
    const user = userEvent.setup();
    render(board({ onVariantChange }));
    await user.selectOptions(screen.getByRole("combobox", { name: /how to draw hours remaining/i }), "countdown");
    expect(onVariantChange).toHaveBeenCalledWith("c", "countdown");
  });

  it("removes a widget", async () => {
    const onRemove = vi.fn();
    const user = userEvent.setup();
    render(board({ onRemove }));
    await user.click(screen.getByRole("button", { name: /remove my day from this board/i }));
    expect(onRemove).toHaveBeenCalledWith("a");
  });

  it("offers restore default and refresh", () => {
    render(board({ onRestoreDefault: () => {}, onRefresh: () => {} }));
    expect(screen.getByRole("button", { name: /restore default/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /refresh/i })).toBeInTheDocument();
  });
});

describe("offline editing says what it is", () => {
  it("labels the save control as staging and warns the change is local", async () => {
    const user = userEvent.setup();
    render(board({ offline: true, onSave: () => {} }));
    expect(screen.getByText(/staged on the device until it syncs/i)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /move hours remaining earlier/i }));
    // Never "Save" while offline: claiming a server save that did not happen.
    expect(screen.getByRole("button", { name: /stage this board/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^save this board$/i })).toBeNull();
  });

  it("reports a staged save as pending sync, not saved", () => {
    render(board({ saveState: { kind: "staged_offline" } }));
    expect(screen.getByText(/not saved to the server until it syncs/i)).toBeInTheDocument();
  });

  it("lists every validation rejection", () => {
    render(board({ saveState: { kind: "rejected", rejections: [
      { code: "WIDGET_NOT_PERMITTED", detail: "Exception Centre needs surface.exceptions.read" },
      { code: "VARIANT_UNSUPPORTED", detail: "Hours Remaining cannot be drawn as map" },
    ] } }));
    // The withheld tile also names this permission, so two matches is correct.
    expect(screen.getAllByText(/surface\.exceptions\.read/).length).toBeGreaterThan(1);
    expect(screen.getByText(/cannot be drawn as map/)).toBeInTheDocument();
  });

  it("announces save outcomes politely rather than on every refresh", () => {
    const { container } = render(board({ saveState: { kind: "saved", at: NOW } }));
    const live = container.querySelector("[aria-live]");
    expect(live?.getAttribute("aria-live")).toBe("polite");
    expect(within(live as HTMLElement).getByText(/board saved/i)).toBeInTheDocument();
  });
});

describe("accessibility", () => {
  it("reports no axe violations on a full board with controls", async () => {
    const { container } = render(board({
      onSave: () => {}, onRemove: () => {}, onVariantChange: () => {},
      onRestoreDefault: () => {}, onRefresh: () => {},
    }));
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations.map((v) => v.id)).toEqual([]);
  });

  it("gives every control a touch target of at least 34px", () => {
    render(board({ onSave: () => {}, onRemove: () => {}, onRestoreDefault: () => {} }));
    for (const b of screen.getAllByRole("button")) {
      expect(Number.parseInt(b.style.minHeight || "0", 10)).toBeGreaterThanOrEqual(34);
    }
  });
});
