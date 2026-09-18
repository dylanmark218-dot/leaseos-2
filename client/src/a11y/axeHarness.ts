/**
 * P5.3 — running the real axe rules against our real components, under jsdom.
 *
 * What this is honest about: jsdom has no CSS layout or paint engine. Rules that need computed
 * geometry or rendered colour — contrast, target size, reflow — cannot be decided here, and a
 * suite that ran them and reported nothing would be claiming coverage it does not have. They are
 * named in NEEDS_A_RENDERER, excluded from the run, and reported back so a green result reads as
 * "everything a renderer-free environment can check", never as "accessible".
 *
 * The viewport width here is what components read in JavaScript. CSS media queries do not apply
 * in jsdom, so a width exercises viewport-dependent *code* branches, not layout.
 */
import axe, { type AxeResults, type Result } from "axe-core";

/** WCAG 2.0/2.1 A and AA — the standard the register names. */
export const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] as const;

/** Rules that need a rendering engine; they stay for a Chromium run and are never silently passed. */
export const NEEDS_A_RENDERER = ["color-contrast", "color-contrast-enhanced", "target-size", "meta-viewport", "meta-viewport-large", "scrollable-region-focusable"] as const;

export type A11yRun = {
  violations: { id: string; impact: string | null; help: string; nodes: string[] }[];
  /** Rules axe could not decide here — reported, not swallowed. */
  incomplete: string[];
  /** Rules we excluded because this environment cannot decide them. */
  notEvaluated: readonly string[];
  passes: number;
};

const shorten = (n: { html: string }) => n.html.replace(/\s+/g, " ").slice(0, 120);

export async function runAxe(container: Element): Promise<A11yRun> {
  const results = (await axe.run(container, {
    runOnly: { type: "tag", values: [...TAGS] },
    rules: Object.fromEntries(NEEDS_A_RENDERER.map(id => [id, { enabled: false }])),
    resultTypes: ["violations", "incomplete"],
  })) as AxeResults;
  return {
    violations: results.violations.map((v: Result) => ({ id: v.id, impact: v.impact ?? null, help: v.help, nodes: v.nodes.map(shorten) })),
    incomplete: Array.from(new Set(results.incomplete.map(r => r.id))).sort(),
    notEvaluated: NEEDS_A_RENDERER,
    passes: results.passes.length,
  };
}

/** A one-line account of a run, for a failure message that says what actually happened. */
export const describeRun = (r: A11yRun): string =>
  `${r.violations.length} violation${r.violations.length === 1 ? "" : "s"}` +
  (r.violations.length ? `: ${r.violations.map(v => `${v.id} (${v.impact ?? "no impact"}) — ${v.nodes[0]}`).join(" | ")}` : "") +
  `; ${r.passes} rules passed; ${r.incomplete.length} undecided here (${r.incomplete.join(", ") || "none"}); ` +
  `${r.notEvaluated.length} need a renderer and were not evaluated (${r.notEvaluated.join(", ")})`;

/** The widths the suite runs at. jsdom applies no media queries; this drives JavaScript that reads the width. */
export const VIEWPORTS = [
  { name: "phone", width: 390, height: 844 },
  { name: "tablet", width: 820, height: 1180 },
  { name: "desktop", width: 1440, height: 900 },
] as const;

export function setViewport(v: { width: number; height: number }): void {
  Object.defineProperty(window, "innerWidth", { configurable: true, writable: true, value: v.width });
  Object.defineProperty(window, "innerHeight", { configurable: true, writable: true, value: v.height });
  window.dispatchEvent(new Event("resize"));
}
