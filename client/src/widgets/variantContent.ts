/**
 * B25 — what a variant may draw.
 *
 * Pure. No React.
 *
 * Variants exist so one engine answer can be a number, a dial, a countdown or
 * a list without three engines behind it. The risk is the obvious one: if a
 * renderer decides for itself what the payload means, then `hosRemaining` drawn
 * as a gauge and drawn as a KPI can disagree about whether a driver has hours
 * left, and the board has two truths.
 *
 * So the split is: the shell owns state, provenance, freshness, blockers,
 * actionability and accessibility, all of which come from `presentTile`. A
 * variant gets a `ContentModel` — and only ever gets one when the payload
 * actually carries a value. There is no code path from `unknown`, `blocked`,
 * `offline`, `not_permitted` or `failed` to a content model, so no renderer can
 * invent a dial position for a value nobody has.
 *
 * That is the whole architecture: `contentFor` returns null for every state
 * that is not `ok` or `stale`, and the shell renders its own state block in
 * that case. A renderer cannot opt out of it because it never receives it.
 */

import type { WidgetPayload } from "../../../server/_core/widgetPayload";
import type { WidgetVariant } from "../../../server/_core/widgetRegistry";

/* ------------------------------------------------------------------ */
/* Content models                                                       */
/* ------------------------------------------------------------------ */

export type ProgressModel = {
  /** 0..1, already clamped. Null when the value cannot be scaled. */
  fraction: number | null;
  label: string;
  sublabel?: string;
};

export type RowModel = {
  id: string;
  primary: string;
  secondary?: string;
  /** Presentational emphasis only. Never a safety state. */
  emphasis?: "normal" | "attention";
};

export type ContentModel =
  | { kind: "kpi"; value: string; unit?: string; caption?: string }
  | { kind: "gauge"; progress: ProgressModel }
  | { kind: "countdown"; targetLabel: string; remainingLabel: string; progress: ProgressModel }
  | { kind: "list"; rows: readonly RowModel[]; truncated: number }
  | { kind: "queue"; rows: readonly RowModel[]; truncated: number; pending: number }
  | { kind: "timeline"; steps: readonly { id: string; label: string; at?: string; done: boolean }[] }
  | { kind: "checklist"; items: readonly { id: string; label: string; checked: boolean }[] }
  | { kind: "map"; center: { lat: number; lng: number } | null; pins: number; caption: string }
  | { kind: "form"; fields: readonly { id: string; label: string; kind: "text" | "number" | "choice" }[] }
  | { kind: "approval"; summary: string; lines: readonly RowModel[] }
  | { kind: "status"; text: string }
  | { kind: "detail"; rows: readonly RowModel[] };

/**
 * Shapes a source may hand back.
 *
 * A source that wants a gauge returns `{ current, max }`; one that wants a list
 * returns `{ rows }`. A bare string or number is accepted and drawn as text,
 * which is what makes the twelve existing widgets renderable today without
 * rewriting any of them.
 */
export type ValueShape =
  | string
  | number
  | { current: number; max: number; unit?: string; label?: string }
  | { rows: readonly RowModel[]; pending?: number }
  | { steps: readonly { id: string; label: string; at?: string; done: boolean }[] }
  | { items: readonly { id: string; label: string; checked: boolean }[] }
  | { center?: { lat: number; lng: number }; pins?: number; caption?: string }
  | { fields: readonly { id: string; label: string; kind: "text" | "number" | "choice" }[] }
  | { summary: string; lines?: readonly RowModel[] };

/* ------------------------------------------------------------------ */
/* Selection                                                            */
/* ------------------------------------------------------------------ */

const MAX_ROWS = 6;

const asText = (v: unknown): string =>
  typeof v === "string" ? v : typeof v === "number" ? String(v) : "";

const clamp01 = (n: number): number => (n < 0 ? 0 : n > 1 ? 1 : n);

const progressFrom = (v: ValueShape): ProgressModel => {
  if (typeof v === "object" && v !== null && "current" in v && "max" in v) {
    const g = v as { current: number; max: number; unit?: string; label?: string };
    const fraction = g.max > 0 && Number.isFinite(g.current) ? clamp01(g.current / g.max) : null;
    return {
      fraction,
      label: g.label ?? `${g.current}${g.unit ? ` ${g.unit}` : ""}`,
      ...(g.max > 0 ? { sublabel: `of ${g.max}${g.unit ? ` ${g.unit}` : ""}` } : {}),
    };
  }
  // A source that never declared a scale gets a label and no dial, rather than
  // a dial at a position somebody guessed.
  return { fraction: null, label: asText(v) };
};

const rowsFrom = (v: ValueShape): { rows: readonly RowModel[]; truncated: number; pending: number } => {
  if (typeof v === "object" && v !== null && "rows" in v) {
    const r = v as { rows: readonly RowModel[]; pending?: number };
    return {
      rows: r.rows.slice(0, MAX_ROWS),
      truncated: Math.max(0, r.rows.length - MAX_ROWS),
      pending: r.pending ?? r.rows.length,
    };
  }
  const text = asText(v);
  return text
    ? { rows: [{ id: "0", primary: text }], truncated: 0, pending: 1 }
    : { rows: [], truncated: 0, pending: 0 };
};

/**
 * Build the content model for a tile, or null.
 *
 * Null is the answer for every state that does not carry a value. The shell
 * then renders the state itself, using `presentTile`, which is the only place
 * status is decided.
 */
export function contentFor(
  variant: WidgetVariant,
  payload: WidgetPayload<unknown>,
): ContentModel | null {
  if (payload.state !== "ok" && payload.state !== "stale") return null;
  const v = payload.value as ValueShape;

  switch (variant) {
    case "kpi": {
      if (typeof v === "object" && v !== null && "current" in v) {
        const g = v as { current: number; max: number; unit?: string };
        return { kind: "kpi", value: String(g.current), ...(g.unit ? { unit: g.unit } : {}), caption: `of ${g.max}` };
      }
      return { kind: "kpi", value: asText(v) };
    }

    case "gauge":
      return { kind: "gauge", progress: progressFrom(v) };

    case "countdown": {
      const progress = progressFrom(v);
      return {
        kind: "countdown",
        targetLabel: progress.sublabel ?? "remaining",
        remainingLabel: progress.label,
        progress,
      };
    }

    case "list": {
      const { rows, truncated } = rowsFrom(v);
      return { kind: "list", rows, truncated };
    }

    case "queue": {
      const { rows, truncated, pending } = rowsFrom(v);
      return { kind: "queue", rows, truncated, pending };
    }

    case "timeline": {
      if (typeof v === "object" && v !== null && "steps" in v) {
        // B27: this read `steps: (v as …) as never`, which handed the whole
        // value object to the renderer as its step list — so `model.steps.map`
        // threw and the timeline tile died inside its error boundary. The cast
        // was meaningless and silenced the type error that would have caught
        // it. No test had passed a `{steps}` payload through this variant;
        // Chromium found it on the first board that had one.
        const s = v as { steps: readonly { id: string; label: string; at?: string; done: boolean }[] };
        return { kind: "timeline", steps: Array.isArray(s.steps) ? s.steps.slice(0, 12) : [] };
      }
      const { rows } = rowsFrom(v);
      return { kind: "timeline", steps: rows.map((r, i) => ({ id: r.id || String(i), label: r.primary, done: false })) };
    }

    case "checklist": {
      if (typeof v === "object" && v !== null && "items" in v) {
        const c = v as { items: readonly { id: string; label: string; checked: boolean }[] };
        return { kind: "checklist", items: c.items.slice(0, 12) };
      }
      const { rows } = rowsFrom(v);
      return { kind: "checklist", items: rows.map((r, i) => ({ id: r.id || String(i), label: r.primary, checked: false })) };
    }

    case "map": {
      const m = (typeof v === "object" && v !== null ? v : {}) as
        { center?: { lat: number; lng: number }; pins?: number; caption?: string };
      // A shell, not a map. The real tile adapter comes with P0 spatial; until
      // then this says what it would show rather than drawing an empty world.
      return {
        kind: "map",
        center: m.center ?? null,
        pins: m.pins ?? 0,
        caption: m.caption ?? asText(v) ?? "",
      };
    }

    case "form": {
      if (typeof v === "object" && v !== null && "fields" in v) {
        const f = v as { fields: readonly { id: string; label: string; kind: "text" | "number" | "choice" }[] };
        return { kind: "form", fields: f.fields.slice(0, 12) };
      }
      return { kind: "form", fields: [] };
    }

    case "approval": {
      if (typeof v === "object" && v !== null && "summary" in v) {
        const a = v as { summary: string; lines?: readonly RowModel[] };
        return { kind: "approval", summary: a.summary, lines: (a.lines ?? []).slice(0, MAX_ROWS) };
      }
      return { kind: "approval", summary: asText(v), lines: [] };
    }

    case "detail": {
      const { rows } = rowsFrom(v);
      return { kind: "detail", rows };
    }

    case "status":
    default:
      return { kind: "status", text: asText(v) };
  }
}

/** Every variant the content layer can build. Used by the coverage test. */
export const RENDERABLE_VARIANTS: readonly WidgetVariant[] = [
  "kpi", "gauge", "countdown", "list", "queue", "timeline",
  "checklist", "map", "form", "approval", "status", "detail",
];
