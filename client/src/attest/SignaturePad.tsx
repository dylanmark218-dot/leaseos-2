/**
 * Sign & Attest — the finger / stylus / mouse pad (SA2).
 *
 * Pointer Events only: `pointerdown`, `pointermove` (with `getCoalescedEvents` where the browser has
 * it, so a fast stroke keeps every sample the hardware produced), `pointerup`, `pointercancel`.
 * `pointerType` becomes the recorded input kind; pressure is recorded when a pen reports it.
 *
 * The pad draws into an SVG, not a canvas, and draws exactly what `renderStrokeSvg` will seal: the
 * preview a signer sees is the evidence the office keeps, with no raster in between. That is also
 * what makes the pad testable where there is no canvas (jsdom).
 *
 * The pad records a drawn mark and nothing else. A signer who cannot draw is offered the typed name
 * or the acknowledgement the signing screen provides for those field types — a keyboard on this pad
 * would record a drawing nobody drew.
 */
import { useCallback, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { StrokeDocument } from "@shared/attest";
import { num } from "@shared/attestStrokes";
import { StrokeCapture } from "./strokeCapture";

export type SignaturePadProps = {
  /** The field this pad draws for — recorded in the document so the strokes cannot be filed on another field. */
  fieldRef: string;
  label: string;
  widthFrac: number;
  heightFrac: number;
  /** CSS pixels. The canvas the strokes are recorded in; the element may be scaled by layout. */
  widthPx?: number;
  heightPx?: number;
  devicePixelRatio?: number;
  disabled?: boolean;
  /** Called with the normalised document after every completed stroke, undo or clear; null when empty. */
  onChange?: (doc: StrokeDocument | null) => void;
  clock?: () => Date;
};

type PointerLike = { clientX: number; clientY: number; pressure: number; timeStamp: number; pointerType: string };

export function SignaturePad(props: SignaturePadProps) {
  const widthPx = props.widthPx ?? 600;
  const heightPx = props.heightPx ?? 200;
  const dpr = props.devicePixelRatio ?? (typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1);
  const capture = useMemo(
    () => new StrokeCapture({ widthPx, heightPx, devicePixelRatio: dpr, fieldRef: props.fieldRef, widthFrac: props.widthFrac, heightFrac: props.heightFrac }, props.clock),
    // A new field or canvas is a new document; the previous strokes belong to the old one.
    [props.fieldRef, widthPx, heightPx, dpr, props.widthFrac, props.heightFrac, props.clock],
  );
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [version, setVersion] = useState(0);
  const [refusal, setRefusal] = useState<string | null>(null);
  const drawing = useRef(false);

  const redraw = useCallback(() => setVersion(v => v + 1), []);
  const emit = useCallback(() => { props.onChange?.(capture.document()); }, [capture, props]);

  /** Client coordinates → canvas pixels. A scaled element maps back onto the recorded canvas. */
  const toCanvas = useCallback((p: { clientX: number; clientY: number }): [number, number] => {
    const r = svgRef.current?.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) return [p.clientX, p.clientY];
    return [(p.clientX - r.left) * (widthPx / r.width), (p.clientY - r.top) * (heightPx / r.height)];
  }, [widthPx, heightPx]);

  const samplesOf = (e: ReactPointerEvent<SVGSVGElement>): PointerLike[] => {
    const native = e.nativeEvent as PointerEvent & { getCoalescedEvents?: () => PointerEvent[] };
    const coalesced = typeof native.getCoalescedEvents === "function" ? native.getCoalescedEvents() : [];
    const list: PointerLike[] = (coalesced.length ? coalesced : [native]).map(ev => ({ clientX: ev.clientX, clientY: ev.clientY, pressure: ev.pressure, timeStamp: ev.timeStamp, pointerType: ev.pointerType }));
    return list;
  };

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (props.disabled) return;
    if (e.button != null && e.button !== 0 && e.pointerType === "mouse") return;
    const [x, y] = toCanvas(e);
    const verdict = capture.begin(e.pointerType, x, y, e.pressure, e.timeStamp);
    if (!verdict.ok) { setRefusal(verdict.reason); return; }
    setRefusal(null);
    drawing.current = true;
    try { (e.currentTarget as SVGSVGElement & { setPointerCapture?: (id: number) => void }).setPointerCapture?.(e.pointerId); } catch { /* not every environment captures */ }
    redraw();
  };
  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drawing.current || props.disabled) return;
    for (const s of samplesOf(e)) { const [x, y] = toCanvas(s); capture.extend(x, y, s.pressure, s.timeStamp); }
    redraw();
  };
  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!drawing.current) return;
    const [x, y] = toCanvas(e);
    capture.extend(x, y, e.pressure, e.timeStamp);
    capture.end();
    drawing.current = false;
    redraw(); emit();
  };
  const onPointerCancel = () => {
    if (!drawing.current) return;
    capture.cancel();
    drawing.current = false;
    redraw(); emit();
  };
  const undo = () => { if (capture.undo()) { drawing.current = false; redraw(); emit(); } };
  const clear = () => { capture.clear(); drawing.current = false; setRefusal(null); redraw(); emit(); };

  void version;
  const paths = capture.paths();
  const kind = capture.kind;
  const status = capture.isEmpty()
    ? "Nothing drawn yet."
    : `Drawn with ${kind === "pen" ? "a pen" : kind === "touch" ? "a finger" : "a mouse"} · ${capture.strokeCount()} stroke${capture.strokeCount() === 1 ? "" : "s"}${kind === "pen" ? " · pressure recorded" : ""}.`;

  return (
    <div role="group" aria-label={`Signature pad — ${props.label}`} data-testid="signature-pad">
      <svg
        ref={svgRef}
        role="img"
        aria-label={`${props.label}: draw with a finger, a pen or a mouse`}
        data-testid="signature-pad-surface"
        data-field={props.fieldRef}
        viewBox={`0 0 ${widthPx} ${heightPx}`}
        width={widthPx}
        height={heightPx}
        style={{ touchAction: "none", userSelect: "none", border: "1px solid #999", background: "#fff", display: "block", maxWidth: "100%", height: "auto", cursor: props.disabled ? "not-allowed" : "crosshair" }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onPointerLeave={(e) => { if (drawing.current && !(e.currentTarget as SVGSVGElement & { hasPointerCapture?: (id: number) => boolean }).hasPointerCapture?.(e.pointerId)) onPointerUp(e); }}
      >
        <line x1={num(widthPx * 0.06)} y1={num(heightPx * 0.78)} x2={num(widthPx * 0.94)} y2={num(heightPx * 0.78)} stroke="#bbb" strokeDasharray="4 4" />
        <g fill="none" stroke="#000" strokeLinecap="round" strokeLinejoin="round">
          {paths.map((s, i) => s.runs.map((r, j) => <path key={`${i}-${j}`} d={r.d} strokeWidth={num(r.width)} />))}
        </g>
      </svg>
      <p data-testid="signature-pad-status" aria-live="polite">{status}</p>
      {refusal ? <p role="alert" data-testid="signature-pad-refusal">{refusal}</p> : null}
      <div>
        <button type="button" onClick={undo} disabled={props.disabled || capture.isEmpty()}>Undo stroke</button>{" "}
        <button type="button" onClick={clear} disabled={props.disabled || capture.isEmpty()}>Clear</button>
      </div>
      <p style={{ fontSize: "0.85em", color: "#555" }}>This pad records a drawn mark only. If you cannot draw, the printed-name and acknowledgement fields take a keyboard.</p>
    </div>
  );
}
