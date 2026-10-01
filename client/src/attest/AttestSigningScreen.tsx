/**
 * Sign & Attest — the signing screen (SA2).
 *
 * One signer's fields on one revision: a pad per drawn field, a text box for a printed name, a
 * checkbox, an approval, a comment; the server dates `date_signed` itself. The consent sentence is
 * shown with the revision's fingerprint and must be ticked. "Sign" is enabled only when every
 * required field assigned to this signer carries a mark; optional fields may be left.
 *
 * The screen decides nothing about authority: it hands the marks to the runtime flow
 * (`client/src/runtime/attestSession.ts`), which signs and queues them, and the server refuses what
 * it must. A decline needs a reason and is sent online through `attest.decline`.
 */
import { useEffect, useMemo, useState } from "react";
import { CONSENT_TEXTS, CONSENT_VERSION_V1, type AttestInputKind, type AttestMarkKind, type StrokeDocument } from "@shared/attest";
import type { LocalSignableField, LocalSignableRevision } from "../runtime/contracts";
import { SignaturePad } from "./SignaturePad";

export type ScreenMark = {
  fieldKey: string; fieldRef: string; fieldType: LocalSignableField["fieldType"];
  markKind: AttestMarkKind; inputKind: AttestInputKind; valueText: string | null; strokes: StrokeDocument | null;
};

export type AttestSigningScreenProps = {
  revision: Pick<LocalSignableRevision, "revisionRef" | "revisionHash" | "instanceRef" | "title" | "fields" | "signers">;
  signerRef: string;
  consentVersion?: string;
  onSubmit: (args: { marks: ScreenMark[]; consentVersion: string }) => void | Promise<void>;
  onDecline: (reason: string) => void | Promise<void>;
  busy?: boolean;
  error?: string | null;
  padWidthPx?: number;
};

/** Signing order first, then reading order on the page. */
export function orderFields(fields: readonly LocalSignableField[]): LocalSignableField[] {
  return [...fields].sort((a, b) => (a.signingOrder ?? 1e9) - (b.signingOrder ?? 1e9) || a.page - b.page || a.yFrac - b.yFrac || a.xFrac - b.xFrac);
}

export function AttestSigningScreen(props: AttestSigningScreenProps) {
  const consentVersion = props.consentVersion ?? CONSENT_VERSION_V1;
  const consentText = CONSENT_TEXTS[consentVersion];
  const signer = props.revision.signers.find(s => s.signerRef === props.signerRef) ?? null;
  const mine = useMemo(() => orderFields(props.revision.fields.filter(f => f.signerRef === props.signerRef && f.state === "pending")), [props.revision.fields, props.signerRef]);
  const [marks, setMarks] = useState<Record<string, ScreenMark | undefined>>({});
  const [consented, setConsented] = useState(false);
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState("");

  const put = (f: LocalSignableField, m: Omit<ScreenMark, "fieldKey" | "fieldRef" | "fieldType"> | null) =>
    setMarks(prev => ({ ...prev, [f.fieldKey]: m ? { fieldKey: f.fieldKey, fieldRef: f.fieldRef, fieldType: f.fieldType, ...m } : undefined }));

  const required = mine.filter(f => f.required);
  const requiredDone = required.filter(f => marked(marks[f.fieldKey])).length;
  const ready = !!consentText && consented && requiredDone === required.length && mine.some(f => marked(marks[f.fieldKey])) && !props.busy;

  if (!signer) return <p role="alert">You are not a signer on {props.revision.title}.</p>;
  if (!consentText) return <p role="alert">The consent statement {consentVersion} is not known to this device; update the app before signing.</p>;

  const submit = () => {
    const list: ScreenMark[] = mine.map(f => marks[f.fieldKey]).filter((m): m is ScreenMark => marked(m));
    void props.onSubmit({ marks: list, consentVersion });
  };

  return (
    <section aria-labelledby="attest-signing-title" data-testid="attest-signing-screen">
      <h2 id="attest-signing-title">{props.revision.title}</h2>
      <p>
        Signing as <strong>{signer.displayName}</strong> ({signer.signerRole}). Document {props.revision.instanceRef}, revision {props.revision.revisionRef}.
        <br />
        Fingerprint <code title={props.revision.revisionHash} data-testid="revision-fingerprint">{props.revision.revisionHash.slice(0, 16)}…</code>
      </p>
      {mine.length === 0 ? <p>Nothing is waiting for your mark on this revision.</p> : null}
      <ol>
        {mine.map(f => (
          <li key={f.fieldKey} data-testid={`field-${f.fieldKey}`}>
            <FieldEditor field={f} mark={marks[f.fieldKey]} disabled={!!props.busy} padWidthPx={props.padWidthPx} onMark={m => put(f, m)} />
          </li>
        ))}
      </ol>
      <p data-testid="required-progress">{requiredDone} of {required.length} required field{required.length === 1 ? "" : "s"} marked.</p>
      <label style={{ display: "block" }}>
        <input type="checkbox" checked={consented} onChange={e => setConsented(e.target.checked)} disabled={props.busy} data-testid="consent" />{" "}
        {consentText}
      </label>
      {props.error ? <p role="alert">{props.error}</p> : null}
      <div>
        <button type="button" onClick={submit} disabled={!ready} data-testid="sign">Sign</button>{" "}
        {!declining ? <button type="button" onClick={() => setDeclining(true)} disabled={props.busy}>Decline to sign</button> : null}
      </div>
      {declining ? (
        <div data-testid="decline">
          <label>Why are you declining? <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} /></label>
          <button type="button" disabled={reason.trim().length < 3 || props.busy} onClick={() => void props.onDecline(reason.trim())}>Send decline</button>{" "}
          <button type="button" onClick={() => setDeclining(false)}>Keep signing</button>
          <p style={{ fontSize: "0.85em" }}>A decline is sent to the office when this device is online.</p>
        </div>
      ) : null}
    </section>
  );
}

const marked = (m: ScreenMark | undefined): m is ScreenMark => !!m && (m.markKind === "drawn" ? !!m.strokes : m.markKind === "date" || m.markKind === "checkbox" || !!(m.valueText && m.valueText.trim()));

function FieldEditor(props: { field: LocalSignableField; mark: ScreenMark | undefined; disabled: boolean; padWidthPx?: number; onMark: (m: Omit<ScreenMark, "fieldKey" | "fieldRef" | "fieldType"> | null) => void }) {
  const f = props.field;
  const label = `${labelFor(f)}${f.required ? "" : " (optional)"}`;
  switch (f.fieldType) {
    case "signature":
    case "initials": {
      const w = props.padWidthPx ?? (f.fieldType === "initials" ? 240 : 600);
      const h = Math.max(80, Math.round(w * (f.heightFrac / f.widthFrac)));
      return (
        <div>
          <p>{label}</p>
          <SignaturePad fieldRef={f.fieldRef} label={label} widthFrac={f.widthFrac} heightFrac={f.heightFrac} widthPx={w} heightPx={Math.min(h, w)} disabled={props.disabled}
            onChange={doc => props.onMark(doc ? { markKind: "drawn", inputKind: doc.inputKind, valueText: null, strokes: doc } : null)} />
        </div>
      );
    }
    case "printed_name":
      return <label>{label} <input type="text" maxLength={180} disabled={props.disabled} value={props.mark?.valueText ?? ""} onChange={e => props.onMark(e.target.value.trim() ? { markKind: "typed_name", inputKind: "keyboard", valueText: e.target.value, strokes: null } : null)} /></label>;
    case "checkbox":
      return <label><input type="checkbox" disabled={props.disabled} checked={!!props.mark} onChange={e => props.onMark(e.target.checked ? { markKind: "checkbox", inputKind: "keyboard", valueText: "checked", strokes: null } : null)} /> {label}</label>;
    case "approval":
      return (
        <fieldset disabled={props.disabled}>
          <legend>{label}</legend>
          {(["approved", "rejected"] as const).map(v => (
            <label key={v}><input type="radio" name={`approval-${f.fieldKey}`} checked={props.mark?.valueText === v} onChange={() => props.onMark({ markKind: "approval", inputKind: "keyboard", valueText: v, strokes: null })} /> {v}</label>
          ))}
        </fieldset>
      );
    case "comment":
      return <label>{label} <textarea rows={2} maxLength={500} disabled={props.disabled} value={props.mark?.valueText ?? ""} onChange={e => props.onMark(e.target.value.trim() ? { markKind: "comment", inputKind: "keyboard", valueText: e.target.value, strokes: null } : null)} /></label>;
    case "date_signed":
      return <DateField label={label} marked={!!props.mark} onMark={props.onMark} />;
  }
}

/** The server fills the date from the moment of signing; the device only says the field is included. */
function DateField(props: { label: string; marked: boolean; onMark: (m: Omit<ScreenMark, "fieldKey" | "fieldRef" | "fieldType"> | null) => void }) {
  const { marked: isMarked, onMark } = props;
  useEffect(() => { if (!isMarked) onMark({ markKind: "date", inputKind: "none", valueText: null, strokes: null }); }, [isMarked, onMark]);
  return <p>{props.label}: dated by the server when you sign.</p>;
}

function labelFor(f: LocalSignableField): string {
  const base = f.fieldType === "signature" ? "Signature" : f.fieldType === "initials" ? "Initials" : f.fieldType === "printed_name" ? "Printed name" : f.fieldType === "date_signed" ? "Date signed" : f.fieldType === "checkbox" ? "Acknowledge" : f.fieldType === "approval" ? "Approval" : "Comment";
  return f.subjectLineRef ? `${base} — line ${f.subjectLineRef}` : `${base} — ${f.fieldKey}`;
}
