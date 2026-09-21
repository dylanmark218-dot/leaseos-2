/**
 * B25 — the shell.
 *
 * Owns everything that carries meaning: title, status badge, provenance,
 * freshness, blockers, withheld and failure presentation, action availability,
 * and the accessible description of all of it. The inner renderer gets a
 * content model and a colour, and cannot reach any of this.
 *
 * Two rules hold the safety line:
 *
 * **Status text always exists, in words.** Every state prints a sentence, not a
 * dash. Nine states drawn as "—" would destroy the contract the payload union
 * exists to carry, and colour alone would lose it for anyone who cannot
 * separate amber from green.
 *
 * **A button is not an authorization.** The shell offers an action when the
 * appearance says one is available; pressing it calls the protected procedure,
 * which reruns its own gate. A tile that was eligible five seconds ago is not
 * evidence about now.
 */

import { Component, type ErrorInfo, type ReactNode } from "react";
import { presentTile, TONE_TOKENS } from "./tilePresentation";
import { contentFor } from "./variantContent";
import { WidgetContentRenderer } from "./WidgetContentRenderer";
import type { WidgetPayload } from "../../../server/_core/widgetPayload";
import type { WidgetVariant } from "../../../server/_core/widgetRegistry";

export type WidgetTileShellProps = {
  title: string;
  variant: WidgetVariant;
  payload: WidgetPayload<unknown>;
  /** Rendered when the stored span could not be honoured on this device. */
  spanNote?: string;
  onAction?: (kind: "open" | "retry") => void;
  onRemove?: () => void;
};

/**
 * A screen-reader sentence for the tile.
 *
 * Built here rather than in each renderer so the state a reader hears is the
 * state the engine returned, in every variant.
 */
export function ariaDescription(title: string, view: ReturnType<typeof presentTile>): string {
  const status = {
    confirmed: "verified", provisional: "needs confirmation", approximate: "approximate",
    aged: "out of date", unknown: "cannot determine", blocked: "blocked",
    withheld: "not available at this access level", offline: "unavailable offline",
    fault: "could not load",
  }[view.tone];
  const rows = view.rows.length > 0 ? `. ${view.rows.length} item${view.rows.length === 1 ? "" : "s"}: ${view.rows.join(". ")}` : "";
  return `${title}: ${status}. ${view.detail}${rows}`;
}

export function WidgetTileShell({
  title, variant, payload, spanNote, onAction, onRemove,
}: WidgetTileShellProps) {
  const view = presentTile(payload, title);
  const tone = TONE_TOKENS[view.tone];
  const model = contentFor(variant, payload);

  return (
    <section
      aria-label={ariaDescription(title, view)}
      style={{
        background: "var(--panel)", border: "1px solid var(--line)",
        borderLeft: `3px solid ${tone.fg}`, borderRadius: "var(--r)",
        padding: "12px 14px", display: "grid", gap: 8, alignContent: "start",
        color: "var(--ink)", font: "400 15px/1.4 'Barlow', system-ui, sans-serif",
      }}
    >
      <header style={{ display: "flex", alignItems: "baseline", gap: 8, justifyContent: "space-between" }}>
        <h3 style={{
          margin: 0, font: "500 13px/1 'Barlow Condensed', sans-serif",
          letterSpacing: ".04em", color: "var(--dim)",
        }}>
          {title}
        </h3>
        <span style={{
          font: "400 11px/1 'IBM Plex Mono', ui-monospace, monospace",
          color: tone.fg, background: tone.bg,
          padding: tone.bg === "transparent" ? 0 : "3px 6px",
          borderRadius: "var(--r)", whiteSpace: "nowrap",
        }}>
          {view.badge}
        </span>
      </header>

      {/* Content exists only for ok and stale. Every other state falls through
          to the detail line below, which is never empty. */}
      {model !== null && (
        <ErrorBoundary title={title}>
          <div style={{ display: "grid", gap: 6 }}>
            {view.valuePrefix && (
              <span style={{ font: "400 13px/1 'Barlow', sans-serif", color: "var(--sand)" }}>
                {view.valuePrefix.trim()}
              </span>
            )}
            <WidgetContentRenderer model={model} tone={tone.fg} />
          </div>
        </ErrorBoundary>
      )}

      <p style={{ margin: 0, font: "400 13px/1.45 'Barlow', sans-serif", color: "var(--dim)" }}>
        {view.detail}
      </p>

      {view.rows.length > 0 && model === null && (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 4 }}>
          {view.rows.map((row) => (
            <li key={row} style={{
              font: "400 12px/1.4 'IBM Plex Mono', ui-monospace, monospace",
              color: "var(--ink)", borderTop: "1px solid var(--line-soft)", paddingTop: 4,
            }}>
              {row}
            </li>
          ))}
        </ul>
      )}

      {spanNote && (
        <p style={{ margin: 0, font: "400 12px/1.4 'Barlow', sans-serif", color: "var(--faint)" }}>
          {spanNote}
        </p>
      )}

      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {view.action.kind !== "none" && (
          <button
            type="button"
            onClick={() => view.action.kind !== "none" && onAction?.(view.action.kind)}
            style={{
              background: "transparent", color: tone.fg, border: `1px solid ${tone.fg}`,
              borderRadius: "var(--r)", padding: "6px 10px",
              font: "500 12px/1 'Barlow', sans-serif", cursor: "pointer",
              minHeight: 38, minWidth: 88,
            }}
          >
            {view.action.label}
          </button>
        )}
        {onRemove && (
          <button
            type="button" onClick={onRemove} aria-label={`Remove ${title} from this board`}
            style={{
              background: "transparent", color: "var(--faint)", border: "1px solid var(--line)",
              borderRadius: "var(--r)", padding: "6px 10px",
              font: "500 12px/1 'Barlow', sans-serif", cursor: "pointer", minHeight: 38, minWidth: 72,
            }}
          >
            Remove
          </button>
        )}
      </div>
    </section>
  );
}

/**
 * One tile's renderer, isolated.
 *
 * A malformed map centre or a form field list that is not a list takes out its
 * own tile and nothing else. Without this, `runBoard`'s per-tile failure
 * isolation stops at the network boundary and the board still dies in the
 * renderer.
 */
class ErrorBoundary extends Component<{ title: string; children: ReactNode }, { failed: string | null }> {
  constructor(props: { title: string; children: ReactNode }) {
    super(props);
    this.state = { failed: null };
  }

  static getDerivedStateFromError(error: unknown): { failed: string } {
    return { failed: error instanceof Error ? error.message : "renderer failed" };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Logged with the tile's identity, because "a widget crashed" is not a
    // useful report when a board has forty of them.
    console.error(`[widget:${this.props.title}] renderer failed`, error, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.failed === null) return this.props.children;
    return (
      <p style={{ margin: 0, font: "400 13px/1.4 'Barlow', sans-serif", color: "var(--blocked)" }}>
        Could not draw this widget: {this.state.failed}
      </p>
    );
  }
}
