/**
 * B26 — the Add Widget picker.
 *
 * Renders exactly what `widgets.offerable` returned and nothing else. There is
 * no client-side permission table here, and deliberately no registry import:
 * a picker that knew the full registry could decide for itself what to show,
 * and the first time that judgement differed from the server's a driver would
 * be offered a tile that resolves to `not_permitted` the moment they place it.
 *
 * So the props are the offers. If a widget is absent from them, this component
 * has no way to render it.
 */

import { useMemo, useState } from "react";

export type PickerOffer = {
  widgetKey: string;
  title: string;
  category: string;
  variants: readonly string[];
  defaultVariant: string;
  recommended: boolean;
};

export type AddWidgetPickerProps = {
  offers: readonly PickerOffer[];
  /** Widget keys already on the board, shown as such rather than hidden. */
  alreadyAdded: readonly string[];
  onAdd: (widgetKey: string, variant: string) => void;
  onClose?: () => void;
};

export function AddWidgetPicker({ offers, alreadyAdded, onAdd, onClose }: AddWidgetPickerProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [variants, setVariants] = useState<Record<string, string>>({});

  const categories = useMemo(
    () => ["all", ...Array.from(new Set(offers.map((o) => o.category))).sort()],
    [offers],
  );

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return offers
      .filter((o) => (category === "all" || o.category === category))
      .filter((o) => q === "" || o.title.toLowerCase().includes(q) || o.category.toLowerCase().includes(q))
      // Recommended first, then alphabetical. Recommendation is ordering, not
      // access: an unrecommended widget is still perfectly addable.
      .sort((a, b) => Number(b.recommended) - Number(a.recommended) || a.title.localeCompare(b.title));
  }, [offers, query, category]);

  return (
    <div role="dialog" aria-label="Add a widget" style={{
      display: "grid", gap: 10, padding: 14, background: "var(--panel)",
      border: "1px solid var(--line)", borderRadius: "var(--r)", maxWidth: 460,
    }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8 }}>
        <h2 style={{ margin: 0, font: "500 14px/1 'Barlow Condensed', sans-serif", letterSpacing: ".05em", color: "var(--dim)" }}>
          Add a widget
        </h2>
        {onClose && <button type="button" onClick={onClose} style={btn} aria-label="Close the widget picker">Close</button>}
      </header>

      <label style={{ display: "grid", gap: 4, font: "400 12px/1 'Barlow', sans-serif", color: "var(--faint)" }}>
        Search widgets
        <input
          type="search" value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Search"
          style={{
            background: "var(--panel2)", border: "1px solid var(--line)", borderRadius: "var(--r)",
            color: "var(--ink)", padding: "9px 10px", minHeight: 40, font: "400 14px/1 'Barlow', sans-serif",
          }}
        />
      </label>

      <div role="group" aria-label="Filter by category" style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {categories.map((c) => (
          <button
            key={c} type="button" onClick={() => setCategory(c)}
            aria-pressed={category === c}
            style={{ ...btn, ...(category === c ? { color: "var(--ink)", borderColor: "var(--dim)" } : {}) }}
          >
            {c}
          </button>
        ))}
      </div>

      {shown.length === 0 && (
        <p style={{ margin: 0, font: "400 13px/1.4 'Barlow', sans-serif", color: "var(--faint)" }}>
          No widgets match. Widgets you are not able to view are not listed.
        </p>
      )}

      <ul style={{ margin: 0, padding: 0, listStyle: "none", display: "grid", gap: 8 }}>
        {shown.map((o) => {
          const added = alreadyAdded.includes(o.widgetKey);
          const chosen = variants[o.widgetKey] ?? o.defaultVariant;
          return (
            <li key={o.widgetKey} style={{
              display: "grid", gap: 6, padding: "10px 12px", border: "1px solid var(--line-soft)",
              borderRadius: "var(--r)", background: "var(--panel2)",
            }}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 8, alignItems: "baseline" }}>
                <span style={{ font: "500 14px/1.2 'Barlow', sans-serif" }}>{o.title}</span>
                <span style={{ font: "400 11px/1 'IBM Plex Mono', monospace", color: "var(--faint)" }}>{o.category}</span>
              </div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
                {o.recommended && (
                  <span style={{ font: "400 11px/1 'Barlow', sans-serif", color: "var(--verified)" }}>Recommended</span>
                )}
                {added && (
                  /* Shown rather than hidden: a widget missing from the list
                     because it is already on the board reads as unavailable. */
                  <span style={{ font: "400 11px/1 'Barlow', sans-serif", color: "var(--dim)" }}>Already on this board</span>
                )}
                {o.variants.length > 1 && (
                  <label style={{ display: "flex", alignItems: "center", gap: 4, font: "400 11px/1 'Barlow', sans-serif", color: "var(--faint)" }}>
                    View
                    <select
                      aria-label={`How to draw ${o.title}`} value={chosen}
                      onChange={(e) => setVariants((v) => ({ ...v, [o.widgetKey]: e.target.value }))}
                      style={{
                        background: "var(--panel)", color: "var(--ink)", border: "1px solid var(--line)",
                        borderRadius: "var(--r)", padding: "6px 8px", minHeight: 38,
                      }}
                    >
                      {o.variants.map((v) => <option key={v} value={v}>{v}</option>)}
                    </select>
                  </label>
                )}
                <button
                  type="button" style={{ ...btn, marginLeft: "auto" }}
                  aria-label={`Add ${o.title} to this board`}
                  onClick={() => onAdd(o.widgetKey, chosen)}
                >
                  {added ? "Add another" : "Add"}
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

const btn = {
  background: "transparent", color: "var(--dim)", border: "1px solid var(--line)",
  borderRadius: "var(--r)", padding: "8px 11px",
  font: "500 12px/1 'Barlow', sans-serif", cursor: "pointer", minHeight: 38,
} as const;
