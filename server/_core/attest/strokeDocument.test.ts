import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { assessStrokeDocument, serializeStrokeDocument, STROKE_FORMAT_V1, type StrokeDocument } from "../../../shared/attest";

const doc = (inputKind: StrokeDocument["inputKind"], pressure: boolean): StrokeDocument => ({
  format: STROKE_FORMAT_V1,
  canvas: { widthPx: 1200, heightPx: 400, devicePixelRatio: 2, orientation: "landscape" },
  field: { fieldRef: "ATF-1", widthFrac: 0.3, heightFrac: 0.08 },
  inputKind, pressureAvailable: pressure,
  strokes: [{ points: [[10.5, 20.25, 0, pressure ? 0.4 : null], [30.125, 40.5, 16, pressure ? 0.6 : null]] }, { points: [[50, 60, 0, pressure ? 0.5 : null]] }],
  startedAt: "2026-10-01T12:00:00.000Z", durationMs: 1830,
});

describe("finger, stylus and mouse strokes serialize identically (§7.1)", () => {
  it("produces byte-stable JSON whose hash does not depend on key order or the device kind beyond its recorded value", () => {
    const pen = doc("pen", true), touch = doc("touch", false), mouse = doc("mouse", false);
    for (const d of [pen, touch, mouse]) {
      const a = serializeStrokeDocument(d);
      const shuffled = JSON.parse(JSON.stringify({ durationMs: d.durationMs, strokes: d.strokes, startedAt: d.startedAt, pressureAvailable: d.pressureAvailable, inputKind: d.inputKind, field: d.field, canvas: d.canvas, format: d.format })) as StrokeDocument;
      expect(serializeStrokeDocument(shuffled)).toBe(a);
      expect(createHash("sha256").update(a).digest("hex")).toHaveLength(64);
      expect(assessStrokeDocument(d)).toEqual({ ok: true, pointCount: 3, strokeCount: 2 });
    }
    expect(serializeStrokeDocument(pen)).toContain('"inputKind":"pen"');
    expect(serializeStrokeDocument(touch)).toContain('"inputKind":"touch"');
  });
  it("refuses a point outside the canvas, pressure without hardware, and a document of the wrong shape", () => {
    const outside = doc("touch", false); outside.strokes[0]!.points[0] = [1300, 10, 0, null];
    expect(assessStrokeDocument(outside)).toMatchObject({ ok: false, reason: "a point lies outside the canvas" });
    const fakePressure = doc("touch", false); fakePressure.strokes[0]!.points[0] = [10, 10, 0, 0.5];
    expect(assessStrokeDocument(fakePressure)).toMatchObject({ ok: false });
    expect(assessStrokeDocument({ ...doc("pen", true), tempoCurve: [1, 2] })).toMatchObject({ ok: false });   // the schema is strict: an unknown key is refused
    expect(assessStrokeDocument(null)).toMatchObject({ ok: false });
  });
});
