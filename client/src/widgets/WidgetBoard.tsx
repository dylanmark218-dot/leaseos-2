/**
 * B25 — the board.
 *
 * Owns layout and the controls. Every tile is a `WidgetTileShell`, every span
 * comes from `planGrid`, and no state or appearance decision is made here.
 *
 * Reorder stays keyboard and button driven. Drag can be layered on later
 * through the same `move` command, but it must never be the only way: the
 * primary reader is in a cab with gloves on, and a desktop user navigating by
 * keyboard needs the same affordance for a different reason.
 *
 * Offline editing has one explicit policy, stated in the UI rather than
 * implied: changes are staged locally and are not a server layout change until
 * they sync. Telling somebody their board was saved when it is sitting in an
 * outbox is the kind of small lie that costs a morning.
 */

import { useMemo, useRef, useState } from "react";
import { WidgetTileShell } from "./WidgetTileShell";
import { gridStyleFor, gridTemplateFor, planGrid } from "./gridPlan";
import type { WidgetPayload } from "../../../server/_core/widgetPayload";
import type { WidgetVariant } from "../../../server/_core/widgetRegistry";
import type { DeviceClass } from "../../../server/_core/widgetLayoutWrite";

export type BoardTileView = {
  instanceRef: string;
  widgetKey: string;
  title: string;
  variant: WidgetVariant;
  payload: WidgetPayload<unknown>;
  position: number;
  spanColumns?: number | null;
  spanRows?: number | null;
  /** Variants this widget declares, for the per-tile variant picker. */
  variants?: readonly WidgetVariant[];
};

export type SaveState =
  | { kind: "idle" }
  | { kind: "saving" }
  | { kind: "saved"; at: Date }
  | { kind: "staged_offline" }
  | { kind: "rejected"; rejections: readonly { code: string; detail: string; instanceRef?: string }[] }
  | { kind: "failed"; detail: string };

export type WidgetBoardProps = {
  name: string;
  seeded: boolean;
  offline?: boolean;
  deviceClass: DeviceClass;
  tiles: readonly BoardTileView[];
  saveState?: SaveState;
  onSave?: (order: readonly string[]) => void;
  onAddWidget?: () => void;
  onRemove?: (instanceRef: string) => void;
  onVariantChange?: (instanceRef: string, variant: WidgetVariant) => void;
  onRestoreDefault?: () => void;
  onRefresh?: () => void;
  onTileAction?: (instanceRef: string, kind: "open" | "retry") => void;
};

export function WidgetBoard({
  name, seeded, offline = false, deviceClass, tiles, saveState = { kind: "idle" },
  onSave, onAddWidget, onRemove, onVariantChange, onRestoreDefault, onRefresh, onTileAction,
}: WidgetBoardProps) {
  const [order, setOrder] = useState<readonly string[]>(() =>
    [...tiles].sort((a, b) => a.position - b.position).map((t) => t.instanceRef));
  const [dirty, setDirty] = useState(false);

  const byRef = useMemo(() => new Map(tiles.map((t) => [t.instanceRef, t])), [tiles]);

  const move = (ref: string, by: -1 | 1) => {
    // Moves apply to what is on screen, which includes tiles appended since
    // mount; using `order` here would silently ignore them.
    const current = effectiveOrderRef.current;
    const i = current.indexOf(ref);
    const j = i + by;
    if (i < 0 || j < 0 || j >= current.length) return;
    const next = [...current];
    const held = next[i] as string;
    next[i] = next[j] as string;
    next[j] = held;
    setOrder(next);
    setDirty(true);
  };

  /**
   * The order actually rendered.
   *
   * `order` is local state seeded from props once, so a tile added after mount
   * — by the picker, by a reconnect, by restore-default — was absent from it
   * and never reached the grid. Chromium caught it: adding a widget left the
   * board at eight tiles. jsdom never did, because no test had added a tile to
   * an already-mounted board.
   *
   * Derived during render rather than synced in an effect: an effect would
   * paint one frame without the new tile, and a board that flickers a widget
   * into place is a board somebody will report as losing widgets.
   */
  const effectiveOrder = useMemo(() => {
    const known = order.filter((ref) => byRef.has(ref));
    const seen = new Set(known);
    const appended = [...tiles]
      .sort((a, b) => a.position - b.position)
      .map((t) => t.instanceRef)
      .filter((ref) => !seen.has(ref));
    return [...known, ...appended];
  }, [order, byRef, tiles]);

  // `move` needs the current rendered order without re-creating itself on
  // every render; a ref keeps the two in step without a dependency cycle.
  const effectiveOrderRef = useRef<readonly string[]>(effectiveOrder);
  effectiveOrderRef.current = effectiveOrder;

  // Order is the user's; spans are the device's. Kept apart so a wide tile
  // never pulls a later one forward to fill the gap beside it.
  const grid = planGrid(
    effectiveOrder.flatMap((ref, index) => {
      const t = byRef.get(ref);
      return t ? [{ instanceRef: ref, position: index, spanColumns: t.spanColumns ?? null, spanRows: t.spanRows ?? null }] : [];
    }),
    deviceClass,
  );

  return (
    <div style={{ display: "grid", gap: 12, maxWidth: grid.columns > 1 ? 1120 : 420 }}>
      <header style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap", justifyContent: "space-between" }}>
        <h2 style={{ margin: 0, font: "500 15px/1 'Barlow Condensed', sans-serif", letterSpacing: ".06em", color: "var(--dim)" }}>
          {name}
        </h2>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {onRefresh && <button type="button" onClick={onRefresh} style={control}>Refresh</button>}
          {onAddWidget && <button type="button" onClick={onAddWidget} style={control}>Add widget</button>}
          {onRestoreDefault && <button type="button" onClick={onRestoreDefault} style={control}>Restore default</button>}
        </div>
      </header>

      {offline && (
        <Banner tone="var(--faint)">
          Offline. Values are the last ones this device held, and anything you change here is staged
          on the device until it syncs.
        </Banner>
      )}

      {seeded && !offline && (
        <Banner tone="var(--dim)">
          This is a starting board, not one you arranged. Rearrange it and save to keep it.
        </Banner>
      )}

      {grid.normalized > 0 && (
        <Banner tone="var(--faint)">
          {grid.normalized} tile{grid.normalized === 1 ? "" : "s"} narrowed to fit this screen.
        </Banner>
      )}

      <div style={{ display: "grid", gap: 10, gridTemplateColumns: gridTemplateFor(grid) }}>
        {grid.tiles.map((placed, index) => {
          const t = byRef.get(placed.instanceRef);
          if (!t) return null;
          return (
            <div key={placed.instanceRef} style={{ ...gridStyleFor(placed), display: "grid", gap: 4 }}>
              <WidgetTileShell
                title={t.title}
                variant={t.variant}
                payload={t.payload}
                {...(placed.normalizedFrom ? { spanNote: `Narrowed: ${placed.normalizedFrom.reason}` } : {})}
                {...(onTileAction ? { onAction: (kind: "open" | "retry") => onTileAction(t.instanceRef, kind) } : {})}
                {...(onRemove ? { onRemove: () => onRemove(t.instanceRef) } : {})}
              />
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <button
                  type="button" style={nudge} onClick={() => move(placed.instanceRef, -1)}
                  disabled={index === 0} aria-label={`Move ${t.title} earlier`}
                >
                  Up
                </button>
                <button
                  type="button" style={nudge} onClick={() => move(placed.instanceRef, 1)}
                  disabled={index === grid.tiles.length - 1} aria-label={`Move ${t.title} later`}
                >
                  Down
                </button>
                {onVariantChange && t.variants && t.variants.length > 1 && (
                  <label style={{ display: "flex", alignItems: "center", gap: 4, font: "400 11px/1 'Barlow', sans-serif", color: "var(--faint)" }}>
                    <span>View</span>
                    <select
                      value={t.variant}
                      aria-label={`How to draw ${t.title}`}
                      onChange={(e) => onVariantChange(t.instanceRef, e.target.value as WidgetVariant)}
                      style={{
                        background: "var(--panel2)", color: "var(--ink)", border: "1px solid var(--line)",
                        borderRadius: "var(--r)", padding: "6px 8px", minHeight: 34,
                        font: "400 11px/1 'Barlow', sans-serif",
                      }}
                    >
                      {t.variants.map((v) => <option key={v} value={v}>{v}</option>)}
                    </select>
                  </label>
                )}
              </div>
            </div>
          );
        })}
      </div>

      <div aria-live="polite" style={{ display: "grid", gap: 6 }}>
        {saveState.kind === "saving" && <Banner tone="var(--dim)">Saving…</Banner>}
        {saveState.kind === "saved" && <Banner tone="var(--verified)">Board saved.</Banner>}
        {saveState.kind === "staged_offline" && (
          <Banner tone="var(--amber)">
            Staged on this device. Not saved to the server until it syncs.
          </Banner>
        )}
        {saveState.kind === "failed" && <Banner tone="var(--blocked)">Could not save: {saveState.detail}</Banner>}
        {saveState.kind === "rejected" && (
          <Banner tone="var(--blocked)">
            <ul style={{ margin: "4px 0 0", paddingLeft: 16 }}>
              {saveState.rejections.map((r) => (
                <li key={`${r.code}:${r.instanceRef ?? ""}`} style={{ font: "400 12px/1.4 'Barlow', sans-serif" }}>
                  {r.detail}
                </li>
              ))}
            </ul>
          </Banner>
        )}
      </div>

      {dirty && onSave && (
        <button
          type="button"
          onClick={() => { onSave(effectiveOrder); setDirty(false); }}
          style={{ ...control, borderColor: "var(--verified)", color: "var(--verified)", minHeight: 42, minWidth: 130 }}
        >
          {offline ? "Stage this board" : "Save this board"}
        </button>
      )}
    </div>
  );
}

/**
 * A div, not a p. The rejected-save banner carries a <ul> of the rejections, and HTML forbids a
 * list inside a paragraph: the browser closes the <p> early, so the parsed DOM stops matching
 * React's tree and hydration mismatches. React warns about exactly this. A save banner is a live
 * region anyway, so role="status" is the accurate element as well as the valid one — a screen
 * reader announces the outcome instead of a person having to go looking for it.
 */
const Banner = ({ tone, children }: { tone: string; children: React.ReactNode }) => (
  <div role="status" style={{
    margin: 0, padding: "8px 10px", background: "var(--panel2)",
    border: "1px solid var(--line)", borderLeft: `3px solid ${tone}`, borderRadius: "var(--r)",
    font: "400 13px/1.45 'Barlow', sans-serif", color: "var(--dim)",
  }}>
    {children}
  </div>
);

const control = {
  background: "transparent", color: "var(--dim)",
  // Longhand, deliberately. A caller that overrides only borderColor against a `border`
  // shorthand makes React warn that a conflicting property is being updated during
  // rerender, and the resulting border is whichever the style object happened to apply
  // last. Three longhand properties compose; a shorthand plus one longhand does not.
  borderWidth: 1, borderStyle: "solid", borderColor: "var(--line)",
  borderRadius: "var(--r)", padding: "8px 11px",
  font: "500 12px/1 'Barlow', sans-serif", cursor: "pointer", minHeight: 38,
} as const;

const nudge = { ...control, minWidth: 60, padding: "7px 9px" } as const;
