/**
 * LeaseOS Sign & Attest — the stroke engine the pad and the server share (SA2).
 *
 * docs/sign-attest/SIGN_ATTEST_DESIGN.md §7.1–7.2, §7.4. One renderer, three consumers: the pad's
 * live preview, the render the device seals beside the strokes, and the server's recomputation of
 * that render from the sealed stroke bytes. All three must agree byte for byte, which is why nothing
 * here touches a canvas, a font, a clock or a random number: a stroke document in, text out.
 *
 * Nothing here derives a behavioural feature. Velocity is used only to decide nothing; width comes
 * from pressure when the hardware reported it and from a constant otherwise (§7.1: no biometrics).
 */
import { assessStrokeDocument, STROKE_FORMAT_V1, type StrokeDocument, type StrokeDocumentVerdict } from "./attest";

export const STROKE_RENDERER = { rendererKey: "attest-strokes-svg", rendererVersion: "1" } as const;
/** Two samples closer than this are one sample: pointer hardware jitters below half a pixel. */
export const MIN_POINT_DISTANCE_PX = 0.5;

type Point = StrokeDocument["strokes"][number]["points"][number];

/* ------------------------------------------------------------------ */
/* Normalisation (§7.1 — "the pad coalesces points closer than 0.5 px")  */
/* ------------------------------------------------------------------ */

/**
 * Coalesce jitter, keep every stroke's first and last sample, make time offsets non-decreasing and
 * drop strokes that lost every point. Coordinates are never rounded (§7.1). Idempotent: normalising
 * a normalised document returns an equal one, so client and server may both call it.
 */
export function normaliseStrokeDocument(doc: StrokeDocument): StrokeDocument {
  const strokes: StrokeDocument["strokes"] = [];
  for (const s of doc.strokes) {
    if (!s.points.length) continue;
    const kept: Point[] = [s.points[0]!];
    let lastT = s.points[0]![2];
    for (let i = 1; i < s.points.length; i++) {
      const p = s.points[i]!;
      const prev = kept[kept.length - 1]!;
      const isLast = i === s.points.length - 1;
      const t = Math.max(lastT, Math.round(p[2]));
      lastT = t;
      if (!isLast && Math.hypot(p[0] - prev[0], p[1] - prev[1]) < MIN_POINT_DISTANCE_PX) continue;
      kept.push([p[0], p[1], t, p[3]]);
    }
    strokes.push({ points: kept });
  }
  return { ...doc, canvas: { ...doc.canvas }, field: { ...doc.field }, strokes };
}

/* ------------------------------------------------------------------ */
/* Geometry                                                              */
/* ------------------------------------------------------------------ */

/** Fixed-precision, no negative zero, no exponent: the same digits on every engine. */
export function num(n: number): string {
  const s = n.toFixed(2).replace(/\.?0+$/, "");
  return s === "-0" ? "0" : s;
}

export type Cubic = { from: [number, number]; c1: [number, number]; c2: [number, number]; to: [number, number] };

/** Centripetal-free uniform Catmull-Rom through the points, as cubic Béziers (tension 1/6). */
export function catmullRomCubics(points: readonly Point[]): Cubic[] {
  if (points.length < 2) return [];
  const out: Cubic[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)]!, p1 = points[i]!, p2 = points[i + 1]!, p3 = points[Math.min(points.length - 1, i + 2)]!;
    out.push({
      from: [p1[0], p1[1]],
      c1: [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6],
      c2: [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6],
      to: [p2[0], p2[1]],
    });
  }
  return out;
}

/** The base pen width scales with the canvas so a mark reads the same at 300 px and at 1200 px. */
export function baseStrokeWidth(canvas: { widthPx: number; heightPx: number }): number {
  return Math.max(1.5, Math.min(canvas.widthPx, canvas.heightPx) / 120);
}

/** Pressure 0–1 → a width multiplier between 0.5 and 1.5, quantised to tenths so runs are stable. */
export function pressureFactor(p: number | null): number {
  if (p == null) return 1;
  const f = 0.5 + Math.min(1, Math.max(0, p));
  return Math.round(f * 10) / 10;
}

export type StrokeRun = { d: string; width: number };

/**
 * One stroke as path runs: consecutive samples that share a width factor share a path. Without
 * pressure a stroke is one run. A single sample is a dot (a zero-length line under round caps).
 */
export function strokeRuns(points: readonly Point[], canvas: { widthPx: number; heightPx: number }, pressureAvailable: boolean): StrokeRun[] {
  const base = baseStrokeWidth(canvas);
  if (points.length === 0) return [];
  if (points.length === 1) {
    const p = points[0]!;
    return [{ d: `M${num(p[0])} ${num(p[1])}L${num(p[0])} ${num(p[1])}`, width: round2(base * (pressureAvailable ? pressureFactor(p[3]) : 1)) }];
  }
  const cubics = catmullRomCubics(points);
  const runs: StrokeRun[] = [];
  let current: { factor: number; parts: string[] } | null = null;
  for (let i = 0; i < cubics.length; i++) {
    const c = cubics[i]!;
    const factor = pressureAvailable ? pressureFactor(avgPressure(points[i]![3], points[i + 1]![3])) : 1;
    if (!current || current.factor !== factor) {
      if (current) runs.push({ d: current.parts.join(""), width: round2(base * current.factor) });
      current = { factor, parts: [`M${num(c.from[0])} ${num(c.from[1])}`] };
    }
    current.parts.push(`C${num(c.c1[0])} ${num(c.c1[1])} ${num(c.c2[0])} ${num(c.c2[1])} ${num(c.to[0])} ${num(c.to[1])}`);
  }
  if (current) runs.push({ d: current.parts.join(""), width: round2(base * current.factor) });
  return runs;
}

const avgPressure = (a: number | null, b: number | null): number | null => (a == null && b == null ? null : ((a ?? b!) + (b ?? a!)) / 2);
const round2 = (n: number) => Math.round(n * 100) / 100;

/* ------------------------------------------------------------------ */
/* SVG (§7.2)                                                            */
/* ------------------------------------------------------------------ */

export type RenderedStroke = { runs: StrokeRun[] };

/** Every stroke's runs, in order — what the pad draws live and what the SVG below serialises. */
export function renderStrokePaths(doc: StrokeDocument): RenderedStroke[] {
  return doc.strokes.map(s => ({ runs: strokeRuns(s.points, doc.canvas, doc.pressureAvailable) }));
}

/**
 * The deterministic SVG. Attribute order, number formatting and whitespace are fixed here and
 * nowhere else; `renderedHash = sha256(renderStrokeSvg(doc))` on the device equals the server's.
 * The field reference and the renderer version travel in the file so a reader of the bytes alone
 * knows what produced them. No name, no identity, no timestamp.
 */
export function renderStrokeSvg(doc: StrokeDocument): string {
  const { widthPx: w, heightPx: h } = doc.canvas;
  const paths = renderStrokePaths(doc)
    .flatMap(s => s.runs)
    .map(r => `<path d="${r.d}" stroke-width="${num(r.width)}"/>`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" data-format="${STROKE_FORMAT_V1}" data-renderer="${STROKE_RENDERER.rendererKey}/${STROKE_RENDERER.rendererVersion}" data-field="${escapeAttr(doc.field.fieldRef)}" data-input="${doc.inputKind}">`
    + `<g fill="none" stroke="#000" stroke-linecap="round" stroke-linejoin="round">${paths}</g></svg>`;
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/* ------------------------------------------------------------------ */
/* PDF path operators (§7.4 — consumed by SA3's renderer, provided here) */
/* ------------------------------------------------------------------ */

/**
 * The strokes as PDF content-stream operators inside a box on a page. Canvas pixels map onto the
 * box, y flipped (PDF's origin is the lower left). Deterministic text; no fonts, no images.
 */
export function toPdfPathOps(doc: StrokeDocument, box: { xPt: number; yPt: number; widthPt: number; heightPt: number }, pageHeightPt: number): string {
  const sx = box.widthPt / doc.canvas.widthPx, sy = box.heightPt / doc.canvas.heightPx;
  const X = (x: number) => num(box.xPt + x * sx);
  const Y = (y: number) => num(pageHeightPt - (box.yPt + y * sy));
  const scale = Math.min(sx, sy);
  const lines: string[] = ["q", "0 0 0 RG", "1 J", "1 j"];
  for (const s of doc.strokes) {
    const pts = s.points;
    if (pts.length === 1) {
      const p = pts[0]!;
      lines.push(`${num(baseStrokeWidth(doc.canvas) * (doc.pressureAvailable ? pressureFactor(p[3]) : 1) * scale)} w`, `${X(p[0])} ${Y(p[1])} m`, `${X(p[0])} ${Y(p[1])} l`, "S");
      continue;
    }
    const cubics = catmullRomCubics(pts);
    let lastFactor: number | null = null;
    for (let i = 0; i < cubics.length; i++) {
      const c = cubics[i]!;
      const factor = doc.pressureAvailable ? pressureFactor(avgPressure(pts[i]![3], pts[i + 1]![3])) : 1;
      if (factor !== lastFactor) {
        if (lastFactor != null) lines.push("S");
        lines.push(`${num(baseStrokeWidth(doc.canvas) * factor * scale)} w`, `${X(c.from[0])} ${Y(c.from[1])} m`);
        lastFactor = factor;
      }
      lines.push(`${X(c.c1[0])} ${Y(c.c1[1])} ${X(c.c2[0])} ${Y(c.c2[1])} ${X(c.to[0])} ${Y(c.to[1])} c`);
    }
    lines.push("S");
  }
  lines.push("Q");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* One verdict for a document about to be sealed                          */
/* ------------------------------------------------------------------ */

/** Normalise, then assess: what the pad does before sealing and the server does before trusting. */
export function prepareStrokeDocument(doc: StrokeDocument): { doc: StrokeDocument; verdict: StrokeDocumentVerdict } {
  const normalised = normaliseStrokeDocument(doc);
  return { doc: normalised, verdict: assessStrokeDocument(normalised) };
}
