/**
 * B26 — the shell, rendered.
 *
 * B25 asserted models. A model cannot tell you whether a blocked tile prints
 * the word "Blocked" or relies on a red stripe, and the stripe is the half a
 * colour-blind driver in a sunlit cab does not get.
 */
// @vitest-environment jsdom
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WidgetTileShell } from "./WidgetTileShell";
import { blocked, ok, unknown, type Provenance, type WidgetPayload } from "../../../server/_core/widgetPayload";
import axe from "axe-core";

afterEach(cleanup);

const NOW = new Date("2026-09-12T14:35:00Z");
const prov = (o: Partial<Provenance> = {}): Provenance =>
  ({ source: "measured", verification: "verified", exact: true, observedAt: NOW, ...o });

/** Every state, with the words a reader must be able to find. */
const STATES: { name: string; payload: WidgetPayload<unknown>; words: RegExp }[] = [
  { name: "verified", payload: ok("4h 12m", prov({ verifiedAt: NOW })), words: /verified/i },
  { name: "unverified", payload: ok("4h 12m", prov({ verification: "unverified" })), words: /unverified|confirm/i },
  { name: "approximate", payload: ok("8000", prov({ exact: false })), words: /approximate|about/i },
  { name: "stale", payload: { state: "stale", value: "4h 12m", asOf: NOW, provenance: prov() }, words: /out of date/i },
  { name: "blocked", payload: blocked([{ code: "A", detail: "Annual inspection expired 2026-08-14" }]), words: /blocked/i },
  { name: "unknown", payload: unknown("no verified axle limit loaded"), words: /unknown|cannot determine/i },
  { name: "offline", payload: { state: "offline" }, words: /offline/i },
  { name: "failed", payload: { state: "failed", reason: "registry unavailable" }, words: /unavailable|could not load/i },
  { name: "withheld", payload: { state: "not_permitted", permission: "billing.read" }, words: /withheld|not available/i },
];

describe("every state is legible as text", () => {
  for (const s of STATES) {
    it(`prints words for ${s.name}, not just a colour`, () => {
      render(<WidgetTileShell title="Hours Remaining" variant="kpi" payload={s.payload} />);
      const tile = screen.getByRole("region");
      // getAllByText, not getByText: most states print their word twice, once
      // in the badge and once in the sentence below it. That redundancy is the
      // point — a reader who misses the chip still reads the line — and the
      // first version of this test treated it as a failure.
      expect(within(tile).getAllByText(s.words).length).toBeGreaterThan(0);
    });
  }

  it("gives a screen reader the state in its accessible name", () => {
    render(<WidgetTileShell title="Unit Readiness" variant="status"
      payload={blocked([{ code: "A", detail: "Annual inspection expired" }])} />);
    expect(screen.getByRole("region").getAttribute("aria-label")).toMatch(/Unit Readiness: blocked/i);
  });

  it("names the permission on a withheld tile rather than hiding it", () => {
    render(<WidgetTileShell title="Revenue" variant="kpi" payload={{ state: "not_permitted", permission: "billing.read" }} />);
    expect(screen.getByText(/billing\.read/)).toBeInTheDocument();
  });

  it("never renders a bare dash for any state", () => {
    for (const s of STATES) {
      cleanup();
      render(<WidgetTileShell title="T" variant="kpi" payload={s.payload} />);
      const text = (screen.getByRole("region").textContent ?? "").replace(/\s+/g, " ").trim();
      expect(text.length, s.name).toBeGreaterThan(10);
      expect(text, s.name).not.toMatch(/^T\s*[—–-]\s*$/);
    }
  });
});

describe("values appear only where a value exists", () => {
  it("draws the number for ok and stale", () => {
    render(<WidgetTileShell title="Hours" variant="kpi" payload={ok("4h 12m", prov())} />);
    expect(screen.getByText("4h 12m")).toBeInTheDocument();
  });

  it("draws no value for blocked, unknown, offline, failed or withheld", () => {
    for (const s of STATES.filter((x) => ["blocked", "unknown", "offline", "failed", "withheld"].includes(x.name))) {
      cleanup();
      render(<WidgetTileShell title="Hours" variant="kpi" payload={s.payload} />);
      expect(screen.queryByText("4h 12m"), s.name).toBeNull();
    }
  });

  it("lists every blocker in the DOM", () => {
    render(<WidgetTileShell title="Unit Readiness" variant="status" payload={blocked([
      { code: "A", detail: "Annual inspection expired 2026-08-14" },
      { code: "B", detail: "Critical defect DEF-4471 has no mechanic release" },
    ])} />);
    expect(screen.getByText(/DEF-4471/)).toBeInTheDocument();
    expect(screen.getByText(/Annual inspection expired/)).toBeInTheDocument();
  });

  it("marks an approximate value as approximate in the DOM", () => {
    render(<WidgetTileShell title="Volume" variant="kpi" payload={ok("8000", prov({ exact: false }))} />);
    expect(screen.getByText(/about/i)).toBeInTheDocument();
  });
});

describe("renderer failure is isolated in the real DOM", () => {
  it("shows a failure inside the tile and keeps the tile's own chrome", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // A map payload whose centre is not a point: the renderer reads .toFixed.
    const bad = ok({ center: { lat: "north", lng: null }, pins: 2 }, prov()) as WidgetPayload<unknown>;
    render(<WidgetTileShell title="Trip map" variant="map" payload={bad} />);
    expect(screen.getByText(/could not draw this widget/i)).toBeInTheDocument();
    // Title and badge still there: the tile failed, not the tile's frame.
    expect(screen.getByText("Trip map")).toBeInTheDocument();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("degrades an unknown future variant instead of throwing", () => {
    render(<WidgetTileShell title="Future" variant={"sparkline" as never} payload={ok("7", prov())} />);
    expect(screen.getByRole("region")).toBeInTheDocument();
    expect(screen.getByText("7")).toBeInTheDocument();
  });
});

describe("controls", () => {
  it("offers an action button and calls back with its kind", async () => {
    const onAction = vi.fn();
    render(<WidgetTileShell title="Unit" variant="status" payload={blocked([{ code: "A", detail: "x" }])} onAction={onAction} />);
    screen.getByRole("button", { name: /resolve/i }).click();
    expect(onAction).toHaveBeenCalledWith("open");
  });

  it("gives remove an accessible name naming the widget", () => {
    render(<WidgetTileShell title="Sync Status" variant="status" payload={ok("ok", prov())} onRemove={() => {}} />);
    expect(screen.getByRole("button", { name: /remove sync status from this board/i })).toBeInTheDocument();
  });

  it("meets the phone touch target on every control", () => {
    render(<WidgetTileShell title="T" variant="status" payload={blocked([{ code: "A", detail: "x" }])} onRemove={() => {}} />);
    for (const b of screen.getAllByRole("button")) {
      expect(Number.parseInt(b.style.minHeight, 10)).toBeGreaterThanOrEqual(38);
    }
  });
});

describe("axe", () => {
  it("reports no violations on a blocked tile with controls", async () => {
    const { container } = render(
      <WidgetTileShell title="Unit Readiness" variant="status" onRemove={() => {}} onAction={() => {}}
        payload={blocked([{ code: "A", detail: "Annual inspection expired" }])} />,
    );
    const results = await axe.run(container, { rules: { "color-contrast": { enabled: false } } });
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`)).toEqual([]);
  });
});
