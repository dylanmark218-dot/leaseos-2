/**
 * Sign & Attest SA2 — the stroke engine, the pad's state, and the device-facing refusal handling.
 * Pure: the same fixtures the device seals are the ones the server hashes here.
 */
import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import {
  ATTEST_REJECTION_CODES, assessStrokeDocument, attestRefusalHandling, attestRefusalIsSettled, serializeStrokeDocument, STROKE_FORMAT_V1,
  type AttestSubmitRefusalCode, type StrokeDocument,
} from "../../../shared/attest";
import { MIN_POINT_DISTANCE_PX, normaliseStrokeDocument, num, renderStrokePaths, renderStrokeSvg, toPdfPathOps } from "../../../shared/attestStrokes";
import { verifyDrawnMarkBytes } from "./attestStrokes";
import { inputKindOf, StrokeCapture } from "../../../client/src/attest/strokeCapture";

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

const doc = (over: Partial<StrokeDocument> = {}): StrokeDocument => ({
  format: STROKE_FORMAT_V1,
  canvas: { widthPx: 600, heightPx: 200, devicePixelRatio: 2, orientation: "landscape" },
  field: { fieldRef: "ATF-1", widthFrac: 0.3, heightFrac: 0.08 },
  inputKind: "pen", pressureAvailable: true,
  strokes: [
    { points: [[20, 100, 0, 0.3], [60, 60, 16, 0.5], [120, 120, 33, 0.9], [200, 80, 50, 0.9], [260, 140, 70, 0.4]] },
    { points: [[300, 100, 0, 0.5]] },
  ],
  startedAt: "2026-10-01T12:00:00.000Z", durationMs: 1830,
  ...over,
});
const touchDoc = (): StrokeDocument => doc({ inputKind: "touch", pressureAvailable: false, strokes: doc().strokes.map(s => ({ points: s.points.map(p => [p[0], p[1], p[2], null] as StrokeDocument["strokes"][number]["points"][number]) })) });

describe("normalisation (§7.1)", () => {
  it("coalesces samples closer than half a pixel, keeps every stroke's ends, makes time non-decreasing, and is idempotent", () => {
    const jittery = doc({ strokes: [{ points: [[10, 10, 0, 0.5], [10.2, 10.1, 4, 0.5], [10.3, 10.2, 3, 0.5], [40, 40, 20, 0.5], [40.1, 40.1, 25, 0.5]] }] });
    const n = normaliseStrokeDocument(jittery);
    expect(n.strokes[0]!.points.map(p => [p[0], p[1]])).toEqual([[10, 10], [40, 40], [40.1, 40.1]]);   // the last sample is kept even when close
    expect(n.strokes[0]!.points.map(p => p[2])).toEqual([0, 20, 25]);
    expect(normaliseStrokeDocument(n)).toEqual(n);
    expect(MIN_POINT_DISTANCE_PX).toBe(0.5);
    // Coordinates are never rounded.
    const fine = normaliseStrokeDocument(doc({ strokes: [{ points: [[10.123456, 20.654321, 0, 0.5], [50.5, 60.25, 10, 0.5]] }] }));
    expect(fine.strokes[0]!.points[0]![0]).toBe(10.123456);
  });
});

describe("the deterministic SVG (§7.2)", () => {
  it("renders the same bytes for the same document, whatever key order it arrived in, and different bytes for a different drawing", () => {
    const a = renderStrokeSvg(doc());
    const reparsed = JSON.parse(serializeStrokeDocument(doc())) as StrokeDocument;
    const shuffled = JSON.parse(JSON.stringify({ durationMs: doc().durationMs, strokes: doc().strokes, startedAt: doc().startedAt, pressureAvailable: true, inputKind: "pen", field: doc().field, canvas: doc().canvas, format: STROKE_FORMAT_V1 })) as StrokeDocument;
    expect(renderStrokeSvg(reparsed)).toBe(a);
    expect(renderStrokeSvg(shuffled)).toBe(a);
    const moved = doc(); moved.strokes[0]!.points[2] = [121, 120, 33, 0.9];
    expect(renderStrokeSvg(moved)).not.toBe(a);
    expect(a.startsWith(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 600 200" width="600" height="200" data-format="${STROKE_FORMAT_V1}" data-renderer="attest-strokes-svg/1" data-field="ATF-1" data-input="pen">`)).toBe(true);
    // Fixed-precision numbers: no exponent, at most two decimals, no negative zero.
    expect(a).not.toMatch(/\d\.\d{3}/);
    expect(a).not.toMatch(/e-\d/);
    expect(num(-0.001)).toBe("0");
    expect(num(12.5)).toBe("12.5");
    expect(num(3)).toBe("3");
  });
  it("draws one path per stroke without pressure, several runs when pressure varies, and a dot for a single sample", () => {
    const flat = renderStrokePaths(touchDoc());
    expect(flat[0]!.runs).toHaveLength(1);
    expect(flat[0]!.runs[0]!.d.startsWith("M20 100C")).toBe(true);
    expect(flat[1]!.runs[0]!.d).toBe("M300 100L300 100");   // a dot under round caps
    const pressured = renderStrokePaths(doc());
    expect(pressured[0]!.runs.length).toBeGreaterThan(1);
    const widths = new Set(pressured[0]!.runs.map(r => r.width));
    expect(widths.size).toBeGreaterThan(1);
    // Width scales with the canvas, so a mark reads the same at 300 px and at 1200 px.
    const small = renderStrokePaths(touchDoc())[0]!.runs[0]!.width;
    const big = renderStrokePaths(doc({ ...touchDoc(), canvas: { widthPx: 2400, heightPx: 800, devicePixelRatio: 1, orientation: "landscape" } }))[0]!.runs[0]!.width;
    expect(big).toBeGreaterThan(small);
  });
  it("a finger and a pen drawing the same line render the same geometry and differ only where the hardware differed", () => {
    const pen = renderStrokeSvg(doc({ pressureAvailable: false, strokes: touchDoc().strokes }));
    const touch = renderStrokeSvg(touchDoc());
    expect(pen.replace('data-input="pen"', "")).toBe(touch.replace('data-input="touch"', ""));
    expect(sha(pen)).not.toBe(sha(touch));
  });
});

describe("PDF path operators (§7.4, for SA3)", () => {
  it("emits a saved graphics state, Bézier segments, strokes, and flips y into PDF space", () => {
    const ops = toPdfPathOps(touchDoc(), { xPt: 100, yPt: 500, widthPt: 300, heightPt: 100 }, 792);
    const lines = ops.split("\n");
    expect(lines[0]).toBe("q");
    expect(lines[lines.length - 1]).toBe("Q");
    expect(lines.filter(l => l.endsWith(" c")).length).toBe(4);
    expect(lines.filter(l => l === "S").length).toBe(2);
    expect(lines.some(l => l.endsWith(" w"))).toBe(true);
    // Canvas (20,100) on a 600×200 canvas → box x 100+20*0.5 = 110, y 792-(500+100*0.5) = 242.
    expect(lines).toContain("110 242 m");
  });
});

describe("the server's check of a drawn mark's bytes (§6.3 step 3)", () => {
  const good = () => { const d = normaliseStrokeDocument(doc()); const bytes = Buffer.from(serializeStrokeDocument(d), "utf8"); const svg = renderStrokeSvg(d); return { d, bytes, svg, declared: { strokeHash: sha(bytes), renderedHash: sha(svg), fieldRef: "ATF-1", canvas: d.canvas, pointCount: 6, strokeCount: 2, inputKind: "pen" } }; };
  it("accepts the pad's own bytes and recomputes the render; refuses a wrong hash, another field, a hand-edited file, a wrong render and a wrong description", () => {
    const g = good();
    const ok = verifyDrawnMarkBytes({ strokeBytes: g.bytes, renderedBytes: Buffer.from(g.svg), declared: g.declared });
    expect(ok).toMatchObject({ ok: true, facts: { strokeHash: g.declared.strokeHash, renderedHash: g.declared.renderedHash, pointCount: 6, strokeCount: 2, inputKind: "pen", pressureAvailable: true } });
    expect(verifyDrawnMarkBytes({ strokeBytes: g.bytes, declared: { ...g.declared, strokeHash: "0".repeat(64) } })).toMatchObject({ ok: false, code: "MARK_HASH_MISMATCH" });
    expect(verifyDrawnMarkBytes({ strokeBytes: g.bytes, declared: { ...g.declared, fieldRef: "ATF-2" } })).toMatchObject({ ok: false, code: "MALFORMED", reason: expect.stringContaining("ATF-1") });
    const pretty = Buffer.from(JSON.stringify(g.d, null, 2));
    expect(verifyDrawnMarkBytes({ strokeBytes: pretty, declared: { ...g.declared, strokeHash: sha(pretty) } })).toMatchObject({ ok: false, code: "MALFORMED", reason: expect.stringContaining("byte-stable") });
    expect(verifyDrawnMarkBytes({ strokeBytes: g.bytes, declared: { ...g.declared, renderedHash: sha("other") } })).toMatchObject({ ok: false, code: "MARK_HASH_MISMATCH" });
    expect(verifyDrawnMarkBytes({ strokeBytes: g.bytes, renderedBytes: Buffer.from(g.svg + " "), declared: g.declared })).toMatchObject({ ok: false, code: "MARK_HASH_MISMATCH" });
    expect(verifyDrawnMarkBytes({ strokeBytes: g.bytes, declared: { ...g.declared, pointCount: 5 } })).toMatchObject({ ok: false, code: "MALFORMED" });
    expect(verifyDrawnMarkBytes({ strokeBytes: g.bytes, declared: { ...g.declared, inputKind: "touch" } })).toMatchObject({ ok: false, code: "MALFORMED" });
    const notJson = Buffer.from("\xff\xd8\xff");
    expect(verifyDrawnMarkBytes({ strokeBytes: notJson, declared: { ...g.declared, strokeHash: sha(notJson) } })).toMatchObject({ ok: false, code: "MALFORMED" });
    const extra = Buffer.from(JSON.stringify({ ...JSON.parse(g.bytes.toString()), tempoCurve: [1] }));
    expect(verifyDrawnMarkBytes({ strokeBytes: extra, declared: { ...g.declared, strokeHash: sha(extra) } })).toMatchObject({ ok: false, code: "MALFORMED" });
  });
});

describe("the pad's state (client/src/attest/strokeCapture.ts)", () => {
  const geometry = { widthPx: 600, heightPx: 200, devicePixelRatio: 2, fieldRef: "ATF-1", widthFrac: 0.3, heightFrac: 0.08 };
  const clock = () => new Date("2026-10-01T12:00:00.000Z");
  it("records a pen with pressure, a finger without, maps an unknown pointer to the mouse, and refuses to mix them", () => {
    const pen = new StrokeCapture(geometry, clock);
    expect(pen.begin("pen", 10, 10, 0.3, 1000)).toEqual({ ok: true });
    pen.extend(50, 40, 0.6, 1016); pen.extend(90, 90, 0.9, 1033); pen.end();
    const d = pen.document()!;
    expect(d).toMatchObject({ format: STROKE_FORMAT_V1, inputKind: "pen", pressureAvailable: true, canvas: { widthPx: 600, heightPx: 200, devicePixelRatio: 2, orientation: "landscape" }, field: { fieldRef: "ATF-1" }, startedAt: "2026-10-01T12:00:00.000Z", durationMs: 33 });
    expect(d.strokes[0]!.points).toEqual([[10, 10, 0, 0.3], [50, 40, 16, 0.6], [90, 90, 33, 0.9]]);
    expect(assessStrokeDocument(d)).toMatchObject({ ok: true, pointCount: 3, strokeCount: 1 });
    expect(pen.begin("touch", 10, 10, 0.5, 2000)).toMatchObject({ ok: false, reason: expect.stringContaining("pen") });
    const touch = new StrokeCapture(geometry, clock);
    touch.begin("touch", 10, 10, 0.5, 0); touch.extend(30, 30, 0.5, 10); touch.end();
    expect(touch.document()!.strokes[0]!.points.every(p => p[3] === null)).toBe(true);
    expect(touch.document()!.pressureAvailable).toBe(false);
    expect(inputKindOf("")).toBe("mouse");
    expect(inputKindOf("mouse")).toBe("mouse");
  });
  it("clamps a captured pointer that leaves the canvas, undoes a stroke, clears, and reports a document only when something was drawn", () => {
    const c = new StrokeCapture(geometry, clock);
    expect(c.document()).toBeNull();
    expect(c.isEmpty()).toBe(true);
    c.begin("mouse", -5, 300, 0.5, 0); c.extend(700, 50, 0.5, 5); c.end();
    const p = c.document()!.strokes[0]!.points;
    expect(p[0]!.slice(0, 2)).toEqual([0, 200]);
    expect(p[1]!.slice(0, 2)).toEqual([600, 50]);
    c.begin("mouse", 10, 10, 0.5, 100); c.extend(20, 20, 0.5, 110); c.end();
    expect(c.strokeCount()).toBe(2);
    expect(c.undo()).toBe(true);
    expect(c.strokeCount()).toBe(1);
    expect(c.paths()).toHaveLength(1);
    c.clear();
    expect(c.document()).toBeNull();
    expect(c.kind).toBeNull();
    expect(c.undo()).toBe(false);
  });
  it("produces bytes the server hashes identically after a round trip through JSON", () => {
    const c = new StrokeCapture(geometry, clock);
    c.begin("pen", 10.25, 10.5, 0.31, 0); c.extend(10.3, 10.6, 0.32, 2); c.extend(50.125, 40.875, 0.6, 16); c.end();
    const serialized = serializeStrokeDocument(c.document()!);
    expect(serializeStrokeDocument(JSON.parse(serialized) as StrokeDocument)).toBe(serialized);
    expect(sha(serialized)).toBe(sha(Buffer.from(serialized, "utf8")));
    expect(c.document()!.strokes[0]!.points).toHaveLength(2);   // the 0.1 px jitter sample is gone
  });
});

describe("what a device does with a refusal (§6.3 step 4)", () => {
  it("names an action for every code, settles only a replay, and holds the queue for a wrong clock", () => {
    const codes: AttestSubmitRefusalCode[] = [...ATTEST_REJECTION_CODES, "NO_DEVICE_CLOCK"];
    for (const code of codes) {
      const h = attestRefusalHandling({ code, skewMs: -7_200_000, serverTimeIso: "2026-10-01T12:00:00.000Z" });
      expect(["move_on", "stop_and_prompt", "stop_and_escalate"]).toContain(h.action);
      expect(attestRefusalIsSettled(code)).toBe(code === "REPLAY");
    }
    expect(attestRefusalHandling({ code: "CLOCK_SKEW_TOO_LARGE", skewMs: -7_200_000, serverTimeIso: "2026-10-01T12:00:00.000Z" })).toMatchObject({ action: "stop_and_prompt", instruction: expect.stringContaining("2 hour(s) ahead of the server") });
    expect(attestRefusalHandling({ code: "REVISION_MISMATCH" }).action).toBe("stop_and_escalate");
    expect(attestRefusalHandling({ code: "FIELD_ALREADY_COMPLETED" }).action).toBe("stop_and_escalate");
    expect(attestRefusalHandling({ code: "DEVICE_NOT_ACTIVE" }).action).toBe("stop_and_escalate");
  });
});
