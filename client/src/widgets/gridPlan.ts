/**
 * B25 — spans, and the grid they land in.
 *
 * Pure. No React, no CSS.
 *
 * B24 validated `spanColumns` and `spanRows` on save, stored them, and
 * round-tripped them through the database — and then `WidgetBoard` ignored
 * both. A field that survives persistence and dies at the renderer is worse
 * than one that was never stored: it reads as supported.
 *
 * The rule that keeps this safe is the separation between logical order and
 * visual packing. `position` is the order the user chose and is the order tiles
 * are emitted in, always. A span changes how much room a tile takes, never
 * where it sits in the sequence — so a two-column tile on a tablet may leave a
 * gap beside it rather than pulling a later tile forward to fill it. Reflowing
 * would be prettier and would mean the board a driver arranged is not the board
 * they read.
 */

import type { DeviceClass } from "../../../server/_core/widgetLayoutWrite";

/** Columns the board offers, by device. Phone stays one. */
export const GRID_COLUMNS: Record<DeviceClass, number> = { phone: 1, tablet: 2, desktop: 4 };

/** Widest span allowed, by device. Matches the write-side ceiling. */
export const MAX_SPAN_COLUMNS: Record<DeviceClass, number> = { phone: 1, tablet: 2, desktop: 4 };
export const MAX_SPAN_ROWS = 3;

export type SpannedItem = {
  instanceRef: string;
  position: number;
  spanColumns?: number | null;
  spanRows?: number | null;
};

export type PlacedTile = {
  instanceRef: string;
  /** Emission order. Always the saved order, densified. */
  order: number;
  spanColumns: number;
  spanRows: number;
  /**
   * Why the span differs from what was stored, when it does. Surfaced so a
   * board that quietly shrank a tile can say it did.
   */
  normalizedFrom?: { spanColumns?: number | null; spanRows?: number | null; reason: string };
};

export type GridPlan = {
  deviceClass: DeviceClass;
  columns: number;
  tiles: readonly PlacedTile[];
  /** Count of tiles whose stored span could not be honoured as written. */
  normalized: number;
};

/**
 * Place tiles on the device's grid.
 *
 * Read-side policy is normalize, not refuse: the row already exists, the person
 * is looking at the board, and a legacy or impossible span is the product's
 * problem rather than theirs. The write path still refuses the same values, so
 * nothing new enters the table this way — `prepareLayoutSave` is where a bad
 * span gets a named rejection.
 */
export function planGrid(items: readonly SpannedItem[], deviceClass: DeviceClass): GridPlan {
  const columns = GRID_COLUMNS[deviceClass];
  const maxColumns = MAX_SPAN_COLUMNS[deviceClass];

  const tiles = [...items]
    .sort((a, b) => a.position - b.position)
    .map((item, order): PlacedTile => {
      const rawCols = item.spanColumns;
      const rawRows = item.spanRows;

      const cols = normalizeSpan(rawCols, maxColumns);
      const rows = normalizeSpan(rawRows, MAX_SPAN_ROWS);

      const reasons: string[] = [];
      if (cols.changed) {
        reasons.push(
          rawCols == null
            ? "no stored column span"
            : `${rawCols} columns exceeds the ${maxColumns} this ${deviceClass} board allows`,
        );
      }
      if (rows.changed) {
        reasons.push(rawRows == null ? "no stored row span" : `${rawRows} rows is outside 1 to ${MAX_SPAN_ROWS}`);
      }

      const base: PlacedTile = {
        instanceRef: item.instanceRef, order,
        spanColumns: cols.value, spanRows: rows.value,
      };
      // Only a span that was stored and could not be honoured is worth
      // reporting. An absent span defaulting to 1 is not a normalization.
      const substantive = (cols.changed && rawCols != null) || (rows.changed && rawRows != null);
      return substantive
        ? { ...base, normalizedFrom: { spanColumns: rawCols ?? null, spanRows: rawRows ?? null, reason: reasons.join("; ") } }
        : base;
    });

  return {
    deviceClass, columns, tiles,
    normalized: tiles.filter((t) => t.normalizedFrom !== undefined).length,
  };
}

function normalizeSpan(raw: number | null | undefined, max: number): { value: number; changed: boolean } {
  if (raw == null || !Number.isInteger(raw) || raw < 1) return { value: 1, changed: raw != null && raw !== 1 };
  if (raw > max) return { value: max, changed: true };
  return { value: raw, changed: false };
}

/**
 * The CSS a tile needs, as data.
 *
 * Returned rather than applied so the grid rules are testable without a DOM,
 * and so the component cannot invent a different span than the plan computed.
 */
export const gridStyleFor = (tile: PlacedTile): { gridColumn: string; gridRow: string } => ({
  gridColumn: `span ${tile.spanColumns}`,
  gridRow: `span ${tile.spanRows}`,
});

export const gridTemplateFor = (plan: GridPlan): string =>
  `repeat(${plan.columns}, minmax(0, 1fr))`;
