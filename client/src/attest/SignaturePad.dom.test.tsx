/**
 * Sign & Attest SA2 — the pad and the signing screen, rendered.
 *
 * Synthetic pointer events: a pen with pressure, a finger, a mouse. What is asserted is what the
 * device will seal — the document the pad emits — and what a signer can see in words: what they drew
 * it with, how many strokes, and why a second kind of pointer was refused.
 */
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { STROKE_FORMAT_V1, type StrokeDocument } from "@shared/attest";
import { SignaturePad } from "./SignaturePad";
import { AttestSigningScreen, orderFields } from "./AttestSigningScreen";
import type { LocalSignableField } from "../runtime/contracts";

afterEach(cleanup);

type Init = { pointerType?: string; pressure?: number; clientX: number; clientY: number; pointerId?: number };
const pointer = (el: Element, type: "pointerdown" | "pointermove" | "pointerup" | "pointercancel", i: Init) => {
  const Ctor = (globalThis as { PointerEvent?: typeof PointerEvent }).PointerEvent;
  const init = { bubbles: true, cancelable: true, pointerId: i.pointerId ?? 1, pointerType: i.pointerType ?? "pen", pressure: i.pressure ?? 0.5, clientX: i.clientX, clientY: i.clientY, button: 0 };
  if (Ctor) { fireEvent(el, new Ctor(type, init)); return; }
  const ev = new MouseEvent(type, init);
  Object.assign(ev, { pointerId: init.pointerId, pointerType: init.pointerType, pressure: init.pressure });
  fireEvent(el, ev);
};
const draw = (el: Element, kind: string, points: [number, number][], pressure = 0.5) => {
  pointer(el, "pointerdown", { pointerType: kind, pressure, clientX: points[0]![0], clientY: points[0]![1] });
  for (const [x, y] of points.slice(1)) pointer(el, "pointermove", { pointerType: kind, pressure, clientX: x, clientY: y });
  const last = points[points.length - 1]!;
  pointer(el, "pointerup", { pointerType: kind, pressure, clientX: last[0], clientY: last[1] });
};

describe("the signature pad", () => {
  it("records a pen stroke with pressure as a stroke document for its field, says so in words, and draws it", () => {
    const onChange = vi.fn<(d: StrokeDocument | null) => void>();
    render(<SignaturePad fieldRef="ATF-9" label="Driver signature" widthFrac={0.3} heightFrac={0.08} widthPx={600} heightPx={200} devicePixelRatio={2} onChange={onChange} clock={() => new Date("2026-10-01T12:00:00Z")} />);
    const surface = screen.getByTestId("signature-pad-surface");
    draw(surface, "pen", [[20, 100], [60, 60], [120, 120], [200, 80]], 0.7);
    const doc = onChange.mock.calls.at(-1)![0]!;
    expect(doc).toMatchObject({ format: STROKE_FORMAT_V1, inputKind: "pen", pressureAvailable: true, field: { fieldRef: "ATF-9", widthFrac: 0.3, heightFrac: 0.08 }, canvas: { widthPx: 600, heightPx: 200, devicePixelRatio: 2, orientation: "landscape" }, startedAt: "2026-10-01T12:00:00.000Z" });
    expect(doc.strokes).toHaveLength(1);
    expect(doc.strokes[0]!.points[0]).toEqual([20, 100, 0, 0.7]);
    expect(doc.strokes[0]!.points.at(-1)!.slice(0, 2)).toEqual([200, 80]);
    expect(screen.getByTestId("signature-pad-status")).toHaveTextContent("Drawn with a pen · 1 stroke · pressure recorded.");
    expect(surface.querySelectorAll("path").length).toBeGreaterThan(0);
  });

  it("records a finger without pressure, refuses a pen on a finger's document, and undoes and clears", () => {
    const onChange = vi.fn<(d: StrokeDocument | null) => void>();
    render(<SignaturePad fieldRef="ATF-9" label="Driver signature" widthFrac={0.3} heightFrac={0.08} onChange={onChange} />);
    const surface = screen.getByTestId("signature-pad-surface");
    draw(surface, "touch", [[10, 10], [40, 50], [80, 20]]);
    draw(surface, "touch", [[100, 100], [140, 120]]);
    let doc = onChange.mock.calls.at(-1)![0]!;
    expect(doc.inputKind).toBe("touch");
    expect(doc.pressureAvailable).toBe(false);
    expect(doc.strokes.flatMap(s => s.points).every(p => p[3] === null)).toBe(true);
    expect(screen.getByTestId("signature-pad-status")).toHaveTextContent("Drawn with a finger · 2 strokes.");
    draw(surface, "pen", [[200, 100], [220, 110]]);
    expect(screen.getByRole("alert")).toHaveTextContent(/started with a finger/);
    expect(onChange.mock.calls.at(-1)![0]!.strokes).toHaveLength(2);   // the pen stroke was not recorded
    fireEvent.click(screen.getByRole("button", { name: "Undo stroke" }));
    doc = onChange.mock.calls.at(-1)![0]!;
    expect(doc.strokes).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(onChange.mock.calls.at(-1)![0]).toBeNull();
    expect(screen.getByTestId("signature-pad-status")).toHaveTextContent("Nothing drawn yet.");
    expect(screen.getByRole("button", { name: "Clear" })).toBeDisabled();
  });

  it("discards a stroke the platform cancels and keeps the ones before it", () => {
    const onChange = vi.fn<(d: StrokeDocument | null) => void>();
    render(<SignaturePad fieldRef="ATF-9" label="Initials" widthFrac={0.1} heightFrac={0.05} onChange={onChange} />);
    const surface = screen.getByTestId("signature-pad-surface");
    draw(surface, "mouse", [[10, 10], [30, 30]]);
    pointer(surface, "pointerdown", { pointerType: "mouse", clientX: 50, clientY: 50 });
    pointer(surface, "pointermove", { pointerType: "mouse", clientX: 60, clientY: 60 });
    pointer(surface, "pointercancel", { pointerType: "mouse", clientX: 60, clientY: 60 });
    const doc = onChange.mock.calls.at(-1)![0]!;
    expect(doc.inputKind).toBe("mouse");
    expect(doc.strokes).toHaveLength(1);
  });
});

const field = (over: Partial<LocalSignableField> & Pick<LocalSignableField, "fieldKey" | "fieldType">): LocalSignableField => ({
  fieldRef: `ATF-${over.fieldKey}`, page: 1, xFrac: 0.1, yFrac: 0.1, widthFrac: 0.3, heightFrac: 0.08, signerRef: "ATS-1", required: true, signingOrder: null, subjectLineRef: null, state: "pending", ...over,
});
const REVISION = {
  revisionRef: "ATR-77", revisionHash: "ab".repeat(32), instanceRef: "FT-2026-000812", title: "Field ticket FT-2026-000812",
  fields: [
    field({ fieldKey: "driver_sig", fieldType: "signature" }),
    field({ fieldKey: "driver_name", fieldType: "printed_name", yFrac: 0.2 }),
    field({ fieldKey: "note", fieldType: "comment", required: false, yFrac: 0.3 }),
    field({ fieldKey: "dated", fieldType: "date_signed", yFrac: 0.4 }),
    field({ fieldKey: "consultant_sig", fieldType: "signature", signerRef: "ATS-2" }),
  ],
  signers: [
    { signerRef: "ATS-1", displayName: "Dana Driver", partyKind: "internal_user", signerRole: "driver", requiredAuth: "device_auth", userId: 7, state: "active" },
    { signerRef: "ATS-2", displayName: "M. Johnson", partyKind: "named_witnessed", signerRole: "consultant", requiredAuth: "witnessed", userId: null, state: "invited" },
  ],
};

describe("the signing screen", () => {
  it("shows only this signer's pending fields, enables Sign only when the required marks and the consent are there, and hands over the marks", async () => {
    const onSubmit = vi.fn();
    render(<AttestSigningScreen revision={REVISION} signerRef="ATS-1" onSubmit={onSubmit} onDecline={vi.fn()} />);
    expect(screen.getByText(/Signing as/)).toHaveTextContent("Dana Driver");
    expect(screen.getByTestId("revision-fingerprint")).toHaveTextContent("abababababababab…");
    expect(screen.queryByTestId("field-consultant_sig")).toBeNull();
    expect(screen.getByTestId("required-progress")).toHaveTextContent("1 of 3 required fields marked.");   // the date is the server's
    const sign = screen.getByTestId("sign");
    expect(sign).toBeDisabled();
    const pad = within(screen.getByTestId("field-driver_sig")).getByTestId("signature-pad-surface");
    draw(pad, "pen", [[20, 60], [80, 20], [140, 70]], 0.6);
    fireEvent.change(within(screen.getByTestId("field-driver_name")).getByRole("textbox"), { target: { value: "Dana Driver" } });
    expect(screen.getByTestId("required-progress")).toHaveTextContent("3 of 3 required fields marked.");
    expect(sign).toBeDisabled();   // consent is not a formality
    fireEvent.click(screen.getByTestId("consent"));
    expect(sign).toBeEnabled();
    fireEvent.click(sign);
    const { marks, consentVersion } = onSubmit.mock.calls[0]![0] as { marks: { fieldKey: string; markKind: string; inputKind: string; valueText: string | null; strokes: StrokeDocument | null }[]; consentVersion: string };
    expect(consentVersion).toBe("leaseos-esign-consent/1");
    expect(marks.map(m => [m.fieldKey, m.markKind, m.inputKind])).toEqual([["driver_sig", "drawn", "pen"], ["driver_name", "typed_name", "keyboard"], ["dated", "date", "none"]]);
    expect(marks[0]!.strokes!.field.fieldRef).toBe("ATF-driver_sig");
    expect(marks[1]!.valueText).toBe("Dana Driver");
  });

  it("needs a reason to decline, and says the decline goes when the device is online", () => {
    const onDecline = vi.fn();
    render(<AttestSigningScreen revision={REVISION} signerRef="ATS-1" onSubmit={vi.fn()} onDecline={onDecline} />);
    fireEvent.click(screen.getByRole("button", { name: "Decline to sign" }));
    const box = screen.getByTestId("decline");
    const send = within(box).getByRole("button", { name: "Send decline" });
    expect(send).toBeDisabled();
    fireEvent.change(within(box).getByRole("textbox"), { target: { value: "The hours on line 3 are not what I worked" } });
    expect(send).toBeEnabled();
    fireEvent.click(send);
    expect(onDecline).toHaveBeenCalledWith("The hours on line 3 are not what I worked");
    expect(box).toHaveTextContent(/when this device is online/);
  });

  it("refuses a person who is not a signer, and orders fields by signing order then page position", () => {
    render(<AttestSigningScreen revision={REVISION} signerRef="ATS-9" onSubmit={vi.fn()} onDecline={vi.fn()} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/not a signer/);
    const ordered = orderFields([field({ fieldKey: "b", fieldType: "initials", page: 2 }), field({ fieldKey: "a", fieldType: "initials", page: 1, yFrac: 0.9 }), field({ fieldKey: "first", fieldType: "signature", signingOrder: 1, page: 3 })]);
    expect(ordered.map(f => f.fieldKey)).toEqual(["first", "a", "b"]);
  });
});
