/**
 * B25 — the variant renderers.
 *
 * Presentation only. Every one of these receives a `ContentModel`, which only
 * exists for `ok` and `stale` payloads, so none of them can be handed a state
 * it might misdraw — there is no branch in this file on `payload.state`,
 * because no renderer here ever sees a payload.
 *
 * Kept in one file on purpose: ten renderers of fifteen lines each are easier
 * to compare side by side than ten files, and comparing them is how the board
 * stays coherent.
 */

import type { ContentModel, RowModel } from "./variantContent";

const mono = "400 12px/1.4 'IBM Plex Mono', ui-monospace, monospace";
const label = "400 12px/1.3 'Barlow', sans-serif";

/** The tone colour comes from the shell, so a renderer cannot recolour a state. */
export type RendererProps = { model: ContentModel; tone: string };

const Rows = ({ rows, tone }: { rows: readonly RowModel[]; tone: string }) => (
  <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 4 }}>
    {rows.map((r) => (
      <li key={r.id} style={{
        font: mono, color: r.emphasis === "attention" ? tone : "var(--ink)",
        borderTop: "1px solid var(--line-soft)", paddingTop: 4,
        display: "flex", justifyContent: "space-between", gap: 8,
      }}>
        <span>{r.primary}</span>
        {r.secondary && <span style={{ color: "var(--faint)" }}>{r.secondary}</span>}
      </li>
    ))}
  </ul>
);

const Bar = ({ fraction, tone, label }: { fraction: number | null; tone: string; label: string }) =>
  fraction === null ? null : (
    <div
      role="progressbar"
      // axe caught this in the real DOM: a progressbar with no accessible name
      // announces as "progress bar, 32%" and nothing else. The model tests
      // could not have found it — there was no name to assert, because there
      // was no DOM.
      aria-label={label}
      aria-valuenow={Math.round(fraction * 100)}
      aria-valuemin={0}
      aria-valuemax={100}
      style={{ height: 6, background: "var(--panel2)", borderRadius: 2, overflow: "hidden" }}
    >
      <div style={{ width: `${fraction * 100}%`, height: "100%", background: tone }} />
    </div>
  );

const Truncated = ({ n }: { n: number }) =>
  n > 0 ? <p style={{ margin: 0, font: label, color: "var(--faint)" }}>+{n} more</p> : null;

export function WidgetContentRenderer({ model, tone }: RendererProps) {
  switch (model.kind) {
    case "kpi":
      return (
        <div style={{ display: "grid", gap: 2 }}>
          <div style={{ font: "500 26px/1.1 'Barlow Condensed', sans-serif" }}>
            {model.value}
            {model.unit && <span style={{ font: label, color: "var(--dim)", marginLeft: 4 }}>{model.unit}</span>}
          </div>
          {model.caption && <span style={{ font: label, color: "var(--faint)" }}>{model.caption}</span>}
        </div>
      );

    case "gauge":
      return (
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ font: "500 22px/1.1 'Barlow Condensed', sans-serif" }}>{model.progress.label}</div>
          <Bar fraction={model.progress.fraction} tone={tone} label={model.progress.label} />
          {model.progress.sublabel && (
            <span style={{ font: label, color: "var(--faint)" }}>{model.progress.sublabel}</span>
          )}
        </div>
      );

    case "countdown":
      return (
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ font: "500 26px/1.1 'Barlow Condensed', sans-serif", fontVariantNumeric: "tabular-nums" }}>
            {model.remainingLabel}
          </div>
          <Bar fraction={model.progress.fraction} tone={tone} label={model.progress.label} />
          <span style={{ font: label, color: "var(--faint)" }}>{model.targetLabel}</span>
        </div>
      );

    case "list":
      return (
        <div style={{ display: "grid", gap: 4 }}>
          <Rows rows={model.rows} tone={tone} />
          <Truncated n={model.truncated} />
        </div>
      );

    case "queue":
      return (
        <div style={{ display: "grid", gap: 4 }}>
          <div style={{ font: "500 20px/1.1 'Barlow Condensed', sans-serif" }}>{model.pending} pending</div>
          <Rows rows={model.rows} tone={tone} />
          <Truncated n={model.truncated} />
        </div>
      );

    case "timeline":
      return (
        <ol style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 6 }}>
          {model.steps.map((s) => (
            <li key={s.id} style={{ display: "grid", gridTemplateColumns: "12px 1fr auto", gap: 8, alignItems: "center", font: label }}>
              {/* Shape as well as colour: a filled versus hollow marker still
                  reads when the difference is not visible. */}
              <span aria-hidden="true" style={{
                width: 8, height: 8, borderRadius: "50%",
                background: s.done ? tone : "transparent", border: `1px solid ${tone}`,
              }} />
              <span style={{ color: "var(--ink)" }}>{s.label}</span>
              <span style={{ color: "var(--faint)", font: mono }}>{s.at ?? ""}</span>
              <span style={{ position: "absolute", left: -9999 }}>{s.done ? "done" : "not done"}</span>
            </li>
          ))}
        </ol>
      );

    case "checklist":
      return (
        <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 5 }}>
          {model.items.map((i) => (
            <li key={i.id} style={{ display: "flex", gap: 8, alignItems: "center", font: label }}>
              <span aria-hidden="true" style={{
                width: 13, height: 13, borderRadius: 2, border: `1px solid ${tone}`,
                display: "grid", placeItems: "center", color: tone, font: "600 10px/1 sans-serif",
              }}>
                {i.checked ? "✓" : ""}
              </span>
              <span>{i.label}</span>
              <span style={{ position: "absolute", left: -9999 }}>{i.checked ? "checked" : "unchecked"}</span>
            </li>
          ))}
        </ul>
      );

    case "map":
      // An adapter boundary, not a map. Drawing an empty world would imply the
      // tile knows where it is; saying so does not.
      return (
        <div style={{
          display: "grid", gap: 4, padding: "10px 12px", border: "1px dashed var(--line)",
          borderRadius: "var(--r)", background: "var(--panel2)",
        }}>
          <span style={{ font: label, color: "var(--dim)" }}>{model.caption || "map view"}</span>
          <span style={{ font: mono, color: "var(--faint)" }}>
            {model.center ? `${model.center.lat.toFixed(3)}, ${model.center.lng.toFixed(3)}` : "no position"}
            {model.pins > 0 ? ` · ${model.pins} pin${model.pins === 1 ? "" : "s"}` : ""}
          </span>
        </div>
      );

    case "form":
      return (
        <div style={{ display: "grid", gap: 6 }}>
          {model.fields.length === 0 && <span style={{ font: label, color: "var(--faint)" }}>no fields declared</span>}
          {model.fields.map((f) => (
            <label key={f.id} style={{ display: "grid", gap: 3, font: label, color: "var(--dim)" }}>
              {f.label}
              <input
                type={f.kind === "number" ? "number" : "text"}
                style={{
                  background: "var(--panel2)", border: "1px solid var(--line)", borderRadius: "var(--r)",
                  color: "var(--ink)", padding: "8px 10px", font: "400 14px/1 'Barlow', sans-serif", minHeight: 38,
                }}
              />
            </label>
          ))}
        </div>
      );

    case "approval":
      return (
        <div style={{ display: "grid", gap: 6 }}>
          <span style={{ font: "400 14px/1.4 'Barlow', sans-serif" }}>{model.summary}</span>
          {model.lines.length > 0 && <Rows rows={model.lines} tone={tone} />}
          {/* No approve button here. Approval is an action, the shell owns
              actions, and the backend reruns its gate regardless. */}
        </div>
      );

    case "detail":
      return <Rows rows={model.rows} tone={tone} />;

    case "status":
    default:
      return <div style={{ font: "500 18px/1.2 'Barlow Condensed', sans-serif" }}>{model.text}</div>;
  }
}
