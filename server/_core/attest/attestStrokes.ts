/**
 * Sign & Attest — what the server checks about a drawn mark's bytes (SA2). Pure.
 *
 * SA1 proved a drawn mark names a sealed stroke record whose seal hash matches the declaration. That
 * proves the bytes were sealed; it does not prove they are strokes, or that the render beside them
 * was drawn from them. This module does: the sealed bytes must be a `leaseos-strokes/1` document in
 * its byte-stable serialization, drawn for the field the mark completes, within the size guards, and
 * `renderStrokeSvg` over them must hash to the declared render. docs/sign-attest/SIGN_ATTEST_DESIGN.md
 * §7.1–7.2, §6.3 step 3.
 */
import { createHash } from "node:crypto";
import { assessStrokeDocument, serializeStrokeDocument, strokeDocumentSchema, type StrokeDocument } from "../../../shared/attest";
import { renderStrokeSvg } from "../../../shared/attestStrokes";

export { normaliseStrokeDocument, renderStrokeSvg, renderStrokePaths, toPdfPathOps, prepareStrokeDocument, STROKE_RENDERER } from "../../../shared/attestStrokes";

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

export type DrawnMarkFacts = {
  strokeHash: string;
  renderedHash: string;
  pointCount: number;
  strokeCount: number;
  durationMs: number;
  canvas: StrokeDocument["canvas"];
  inputKind: StrokeDocument["inputKind"];
  pressureAvailable: boolean;
};

export type DrawnMarkVerdict =
  | { ok: true; facts: DrawnMarkFacts }
  | { ok: false; code: "MARK_HASH_MISMATCH" | "MALFORMED"; reason: string };

/**
 * Verify a drawn mark from the bytes the vault holds. Order: the declared stroke hash against the
 * bytes (a wrong declaration is the cheapest, most specific failure), then shape, then field, then the
 * render — recomputed, never trusted — against the declared render hash and, when the render's own
 * bytes are supplied, against them too.
 */
export function verifyDrawnMarkBytes(args: {
  strokeBytes: Buffer;
  renderedBytes?: Buffer | null;
  declared: {
    strokeHash: string | null;
    renderedHash: string | null;
    fieldRef: string;
    canvas?: StrokeDocument["canvas"] | null;
    pointCount?: number | null;
    strokeCount?: number | null;
    inputKind?: string | null;
  };
}): DrawnMarkVerdict {
  const d = args.declared;
  const strokeHash = sha256(args.strokeBytes);
  if (!d.strokeHash || d.strokeHash !== strokeHash) return { ok: false, code: "MARK_HASH_MISMATCH", reason: "The declared stroke hash is not the hash of the sealed stroke bytes." };
  let parsed: unknown;
  try { parsed = JSON.parse(args.strokeBytes.toString("utf8")); } catch { return { ok: false, code: "MALFORMED", reason: "The sealed stroke record is not JSON." }; }
  const shape = strokeDocumentSchema.safeParse(parsed);
  if (!shape.success) return { ok: false, code: "MALFORMED", reason: `The sealed stroke record is not a leaseos-strokes/1 document: ${shape.error.issues[0]?.message ?? "invalid"}.` };
  const doc = shape.data;
  const verdict = assessStrokeDocument(doc);
  if (!verdict.ok) return { ok: false, code: "MALFORMED", reason: `The sealed stroke record fails the size and shape guards: ${verdict.reason}.` };
  // Byte-stable: a document whose bytes are not its own serialization was written by something other than the pad.
  if (serializeStrokeDocument(doc) !== args.strokeBytes.toString("utf8")) return { ok: false, code: "MALFORMED", reason: "The sealed stroke record is not in the pad's byte-stable serialization." };
  if (doc.field.fieldRef !== d.fieldRef) return { ok: false, code: "MALFORMED", reason: `The strokes were drawn for field ${doc.field.fieldRef}, not for ${d.fieldRef}.` };
  if (d.canvas && (d.canvas.widthPx !== doc.canvas.widthPx || d.canvas.heightPx !== doc.canvas.heightPx || d.canvas.devicePixelRatio !== doc.canvas.devicePixelRatio || d.canvas.orientation !== doc.canvas.orientation)) {
    return { ok: false, code: "MALFORMED", reason: "The mark's canvas facts do not describe the sealed strokes." };
  }
  if ((d.pointCount != null && d.pointCount !== verdict.pointCount) || (d.strokeCount != null && d.strokeCount !== verdict.strokeCount)) {
    return { ok: false, code: "MALFORMED", reason: "The mark's point and stroke counts do not describe the sealed strokes." };
  }
  if (d.inputKind != null && d.inputKind !== doc.inputKind) return { ok: false, code: "MALFORMED", reason: `The mark says ${d.inputKind}; the strokes say ${doc.inputKind}.` };
  const svg = renderStrokeSvg(doc);
  const renderedHash = sha256(svg);
  if (d.renderedHash && d.renderedHash !== renderedHash) return { ok: false, code: "MARK_HASH_MISMATCH", reason: "The declared render is not what these strokes render to." };
  if (args.renderedBytes && sha256(args.renderedBytes) !== renderedHash) return { ok: false, code: "MARK_HASH_MISMATCH", reason: "The sealed render bytes are not what these strokes render to." };
  return { ok: true, facts: { strokeHash, renderedHash, pointCount: verdict.pointCount, strokeCount: verdict.strokeCount, durationMs: doc.durationMs, canvas: doc.canvas, inputKind: doc.inputKind, pressureAvailable: doc.pressureAvailable } };
}
