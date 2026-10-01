/**
 * Sign & Attest — the pad's state, without the DOM (SA2).
 *
 * `SignaturePad.tsx` is a thin wrapper around this: pointer events in, a stroke document out. Keeping
 * the state here means the coalescing rule, the input-kind rule and the clamping are tested in Node
 * with the same fixtures the server hashes, and the React component only has to forward events.
 *
 * What is recorded is what the hardware reported (docs/sign-attest/SIGN_ATTEST_DESIGN.md §7.1):
 * coordinates in canvas pixels, unrounded; the time offset from the stroke's start, for variable-width
 * rendering; pressure only when a pen reported it. Nothing is derived from the hand that drew it.
 */
import { STROKE_FORMAT_V1, type AttestInputKind, type StrokeDocument } from "@shared/attest";
import { normaliseStrokeDocument, renderStrokePaths, type RenderedStroke } from "@shared/attestStrokes";

export type CaptureGeometry = {
  widthPx: number;
  heightPx: number;
  devicePixelRatio: number;
  fieldRef: string;
  widthFrac: number;
  heightFrac: number;
};

type Point = StrokeDocument["strokes"][number]["points"][number];

/**
 * `PointerEvent.pointerType` → the recorded input kind. Recorded, never inferred: a stylus and an
 * Apple Pencil both say `pen`; a browser that cannot tell reports an empty string, which is the
 * legacy mouse case.
 */
export function inputKindOf(pointerType: string): AttestInputKind {
  switch (pointerType) {
    case "pen": return "pen";
    case "touch": return "touch";
    default: return "mouse";
  }
}

/**
 * Only a pen reports pressure. A mouse and a finger report the spec's constant 0.5 while pressed,
 * which is not a measurement, so recording it would claim hardware the device does not have.
 */
export const pressureReported = (kind: AttestInputKind): boolean => kind === "pen";

export type BeginVerdict = { ok: true } | { ok: false; reason: string };

export class StrokeCapture {
  private strokes: { points: Point[] }[] = [];
  private active: { points: Point[]; startedAtMs: number } | null = null;
  private inputKind: AttestInputKind | null = null;
  private startedAt: string | null = null;
  private firstStrokeAtMs: number | null = null;
  private lastSampleAtMs: number | null = null;

  constructor(private geometry: CaptureGeometry, private clock: () => Date = () => new Date()) {}

  get kind(): AttestInputKind | null { return this.inputKind; }
  isEmpty(): boolean { return this.strokes.length === 0 && !this.active; }
  strokeCount(): number { return this.strokes.length + (this.active ? 1 : 0); }
  pointCount(): number { return this.strokes.reduce((n, s) => n + s.points.length, 0) + (this.active?.points.length ?? 0); }

  /** A pointer went down. Refused when a second kind of pointer joins a document another kind started. */
  begin(pointerType: string, x: number, y: number, pressure: number, timeStampMs: number): BeginVerdict {
    const kind = inputKindOf(pointerType);
    if (this.inputKind && this.inputKind !== kind && !this.isEmpty()) {
      return { ok: false, reason: `This signature was started with a ${this.inputKind === "pen" ? "pen" : this.inputKind === "touch" ? "finger" : "mouse"}; finish it the same way, or clear and start again.` };
    }
    if (this.active) this.end();
    this.inputKind = kind;
    if (this.startedAt == null) { this.startedAt = this.clock().toISOString(); this.firstStrokeAtMs = timeStampMs; }
    this.active = { points: [this.sample(x, y, pressure, 0)], startedAtMs: timeStampMs };
    this.lastSampleAtMs = timeStampMs;
    return { ok: true };
  }

  /** A pointer moved. Ignored when nothing is down. Coalesced samples arrive here in order, each with its own time. */
  extend(x: number, y: number, pressure: number, timeStampMs: number): void {
    if (!this.active) return;
    const t = Math.max(0, Math.round(timeStampMs - this.active.startedAtMs));
    this.active.points.push(this.sample(x, y, pressure, t));
    this.lastSampleAtMs = Math.max(this.lastSampleAtMs ?? timeStampMs, timeStampMs);
  }

  /** The pointer came up: the stroke is kept. */
  end(): void {
    if (!this.active) return;
    this.strokes.push({ points: this.active.points });
    this.active = null;
  }

  /** The pointer was cancelled by the platform (a palm, a system gesture): the partial stroke is discarded. */
  cancel(): void { this.active = null; if (this.strokes.length === 0) this.resetOrigin(); }

  undo(): boolean {
    if (this.active) { this.active = null; return true; }
    if (!this.strokes.length) return false;
    this.strokes.pop();
    if (!this.strokes.length) this.resetOrigin();
    return true;
  }

  clear(): void { this.strokes = []; this.active = null; this.resetOrigin(); }

  /** The strokes to draw now, the stroke in progress included. */
  paths(): RenderedStroke[] {
    const doc = this.draft();
    return doc ? renderStrokePaths(doc) : [];
  }

  /** The finished, normalised document — or null when nothing was drawn. A stroke still in progress is not included. */
  document(): StrokeDocument | null {
    if (!this.strokes.length || !this.inputKind || !this.startedAt) return null;
    return normaliseStrokeDocument(this.build(this.strokes));
  }

  private draft(): StrokeDocument | null {
    const strokes = this.active ? [...this.strokes, { points: this.active.points }] : this.strokes;
    if (!strokes.length || !this.inputKind) return null;
    return this.build(strokes);
  }

  private build(strokes: { points: Point[] }[]): StrokeDocument {
    const g = this.geometry;
    return {
      format: STROKE_FORMAT_V1,
      canvas: { widthPx: g.widthPx, heightPx: g.heightPx, devicePixelRatio: g.devicePixelRatio, orientation: g.widthPx >= g.heightPx ? "landscape" : "portrait" },
      field: { fieldRef: g.fieldRef, widthFrac: g.widthFrac, heightFrac: g.heightFrac },
      inputKind: this.inputKind!,
      pressureAvailable: pressureReported(this.inputKind!),
      strokes,
      startedAt: this.startedAt ?? this.clock().toISOString(),
      durationMs: Math.max(0, Math.round((this.lastSampleAtMs ?? 0) - (this.firstStrokeAtMs ?? 0))),
    };
  }

  /** Clamp into the canvas: a captured pointer keeps reporting after it leaves the element, and a point outside the canvas is refused at sealing. */
  private sample(x: number, y: number, pressure: number, t: number): Point {
    const cx = Math.min(this.geometry.widthPx, Math.max(0, x));
    const cy = Math.min(this.geometry.heightPx, Math.max(0, y));
    const p = this.inputKind && pressureReported(this.inputKind) ? Math.min(1, Math.max(0, pressure)) : null;
    return [cx, cy, t, p];
  }

  private resetOrigin(): void { this.inputKind = null; this.startedAt = null; this.firstStrokeAtMs = null; this.lastSampleAtMs = null; }
}
