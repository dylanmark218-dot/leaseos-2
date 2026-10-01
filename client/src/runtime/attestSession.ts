/**
 * Sign & Attest on the device — the offline signing flow (SA2).
 *
 * docs/sign-attest/SIGN_ATTEST_DESIGN.md §6.1–6.2. A signer opens a revision this device downloaded,
 * marks the fields assigned to them, and completes. Each drawn mark becomes two `signature` captures
 * in the encrypted vault — the stroke document and the SVG rendered from it, both hashed — so the
 * existing upload → seal → signed-package pipeline carries them exactly as it carries a photograph.
 * At completion the device key signs the session (capture-time binding); the sync engine sends the
 * envelope once every mark file has synchronized (`syncEngine.pushAttestSessions`).
 *
 * The device decides nothing about authority. It records what it observed and whom it believed it
 * was; the server refuses what it must and the refusal comes back as a code.
 */
import {
  CONSENT_TEXTS, CONSENT_VERSION_V1, MARK_KINDS_FOR_FIELD, STROKE_FORMAT_V1, serializeStrokeDocument, sessionSigningObject,
  type AttestInputKind, type AttestMarkKind, type StrokeDocument,
} from "@shared/attest";
import { prepareStrokeDocument, renderStrokeSvg } from "@shared/attestStrokes";
import type { CaptureAuthorizationClaim, Clock, FileVault, Keystore, LocalAttestMark, LocalAttestSession, LocalSignableRevision, LocalStore } from "./contracts";
import { canonicalJson, sha256Hex, sha256HexOfString } from "./crypto";
import { Outbox } from "./outbox";

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
const encode = (s: string) => new TextEncoder().encode(s);

export type ValueMarkKind = Exclude<AttestMarkKind, "drawn" | "paper_scan" | "adopted_saved">;

export class AttestSigning {
  private outbox: Outbox;
  constructor(private deps: { store: LocalStore; vault: FileVault; keystore: Keystore; clock: Clock; outbox?: Outbox }) {
    this.outbox = deps.outbox ?? new Outbox(deps.store, deps.vault, deps.clock);
  }

  /** A revision downloaded while online (`attest.view`), kept with the time it was fetched (§6.1: cached is not current). */
  async cacheRevision(rev: Omit<LocalSignableRevision, "fetchedAt"> & { fetchedAt?: string }): Promise<LocalSignableRevision> {
    const stored: LocalSignableRevision = { ...rev, fetchedAt: rev.fetchedAt ?? this.deps.clock.now().toISOString() };
    await this.deps.store.putSignableRevision(stored);
    return stored;
  }

  /** What this signer can sign on this device right now: cached revisions with a pending field assigned to them. */
  async signableFor(signerMatches: (s: LocalSignableRevision["signers"][number]) => boolean): Promise<{ revision: LocalSignableRevision; signerRef: string; pendingFields: number }[]> {
    const out: { revision: LocalSignableRevision; signerRef: string; pendingFields: number }[] = [];
    for (const revision of await this.deps.store.listSignableRevisions()) {
      for (const s of revision.signers.filter(signerMatches)) {
        const pending = revision.fields.filter(f => f.signerRef === s.signerRef && f.state === "pending").length;
        if (pending > 0) out.push({ revision, signerRef: s.signerRef, pendingFields: pending });
      }
    }
    return out;
  }

  /**
   * Start a session. Refused when the revision is not on the device, the signer is not on the
   * revision, the device is not enrolled (nothing could sign the session), or the revision relates to
   * no job or unit (its marks could not be sealed).
   */
  async start(args: { revisionRef: string; signerRef: string; authMethod?: "device_auth" | "witnessed"; consentVersion?: string; gps?: { latitude: number; longitude: number } | null }): Promise<LocalAttestSession> {
    const rev = await this.deps.store.getSignableRevision(args.revisionRef);
    if (!rev) throw new Error(`Revision ${args.revisionRef} is not on this device — it cannot be signed offline. Download it while online.`);
    const signer = rev.signers.find(s => s.signerRef === args.signerRef);
    if (!signer) throw new Error(`${args.signerRef} is not a signer on ${rev.revisionRef}`);
    if (signer.state === "declined" || signer.state === "revoked" || signer.state === "completed") throw new Error(`Signer ${signer.displayName} is ${signer.state} on this revision`);
    const deviceRef = await this.deps.store.getMeta("deviceRef");
    if (!deviceRef) throw new Error("Enroll this device before signing offline — the session is signed by the device key, and there is none");
    if (rev.jobId == null && rev.unitId == null) throw new Error(`Revision ${rev.revisionRef} relates to no job or unit; its marks could not be sealed on the server`);
    const consentVersion = args.consentVersion ?? CONSENT_VERSION_V1;
    if (!CONSENT_TEXTS[consentVersion]) throw new Error(`Consent statement ${consentVersion} is not known to this device`);
    const authMethod = args.authMethod ?? (signer.partyKind === "named_witnessed" ? "witnessed" : "device_auth");
    if (authMethod === "device_auth" && signer.partyKind !== "internal_user") throw new Error(`${signer.displayName} has no account on this device; their mark is witnessed, not device-authenticated`);
    if (authMethod === "witnessed" && signer.partyKind !== "named_witnessed") throw new Error(`${signer.displayName} has their own account; they sign themselves, nobody witnesses for them`);
    const now = this.deps.clock.now().toISOString();
    const localId = uid();
    const s: LocalAttestSession = {
      localId, sessionRef: `${deviceRef}:${localId}`, revisionRef: rev.revisionRef, revisionHashAtStart: rev.revisionHash, signerRef: signer.signerRef, authMethod, consentVersion,
      marks: [], startedAt: now, completedAt: null, gps: args.gps ?? null, deviceSignature: null, state: "started", attempts: 0, lastError: null, lastCode: null, serverResult: null, createdAt: now, updatedAt: now,
    };
    await this.deps.store.putAttestSession(s);
    return s;
  }

  /** A drawn mark: the stroke document is normalised, assessed, serialized and rendered; both files go to the vault as `signature` captures. */
  async addDrawnMark(localId: string, fieldKey: string, doc: StrokeDocument, claim: CaptureAuthorizationClaim = "unknown"): Promise<LocalAttestMark> {
    const { session: s, rev, field } = await this.open(localId, fieldKey);
    if (!MARK_KINDS_FOR_FIELD[field.fieldType].includes("drawn")) throw new Error(`A ${field.fieldType} field does not take a drawing`);
    const prepared = prepareStrokeDocument(doc);
    if (!prepared.verdict.ok) throw new Error(`The drawing cannot be sealed: ${prepared.verdict.reason}`);
    if (prepared.doc.field.fieldRef !== field.fieldRef) throw new Error(`The drawing was made for ${prepared.doc.field.fieldRef}, not for ${field.fieldRef}`);
    const strokesJson = serializeStrokeDocument(prepared.doc);
    const svg = renderStrokeSvg(prepared.doc);
    const capturedAt = this.deps.clock.now();
    const base = { kind: "signature" as const, formKey: null, category: "signature", jobId: rev.jobId, unitId: rev.unitId, capturedAt, captureAuthorizationClaim: claim };
    const attest = { sessionRef: s.sessionRef, revisionRef: rev.revisionRef, revisionHash: rev.revisionHash, fieldRef: field.fieldRef, fieldKey, format: STROKE_FORMAT_V1 };
    const strokeCap = await this.outbox.saveDraft({ ...base, title: `Signature strokes — ${rev.instanceRef} ${fieldKey}`, fields: { attest: { ...attest, part: "strokes" } }, files: [{ bytes: encode(strokesJson), fileName: `${safe(fieldKey)}.strokes.json`, mimeType: "application/json" }] });
    const renderCap = await this.outbox.saveDraft({ ...base, title: `Signature render — ${rev.instanceRef} ${fieldKey}`, fields: { attest: { ...attest, part: "render", strokeHash: strokeCap.files[0]!.contentHash } }, files: [{ bytes: encode(svg), fileName: `${safe(fieldKey)}.render.svg`, mimeType: "image/svg+xml" }] });
    const verdict = prepared.verdict;
    const mark: LocalAttestMark = {
      fieldKey, fieldRef: field.fieldRef, fieldType: field.fieldType, markKind: "drawn", inputKind: prepared.doc.inputKind, valueText: null,
      strokeCaptureId: strokeCap.localId, strokeHash: strokeCap.files[0]!.contentHash, renderCaptureId: renderCap.localId, renderedHash: renderCap.files[0]!.contentHash,
      canvas: { ...prepared.doc.canvas }, pointCount: verdict.pointCount, strokeCount: verdict.strokeCount, durationMs: prepared.doc.durationMs, pressureAvailable: prepared.doc.pressureAvailable,
      recordedAt: capturedAt.toISOString(),
    };
    // The hash the vault computed is the hash of the bytes it holds — the same bytes the server will hash.
    if (mark.strokeHash !== (await sha256Hex(encode(strokesJson)))) throw new Error("The vault's stroke hash does not match the serialized document");
    await this.putMark(s, mark);
    return mark;
  }

  /** A typed, ticked, approved, commented, dated or acknowledged mark. */
  async addValueMark(localId: string, fieldKey: string, markKind: ValueMarkKind, valueText: string | null, inputKind: AttestInputKind = "keyboard"): Promise<LocalAttestMark> {
    const { session: s, field } = await this.open(localId, fieldKey);
    if (!MARK_KINDS_FOR_FIELD[field.fieldType].includes(markKind)) throw new Error(`A ${field.fieldType} field does not take a ${markKind} mark`);
    if ((markKind === "typed_name" || markKind === "comment" || markKind === "approval") && !(valueText && valueText.trim())) throw new Error(`A ${markKind} mark carries a value`);
    const mark: LocalAttestMark = {
      fieldKey, fieldRef: field.fieldRef, fieldType: field.fieldType, markKind, inputKind, valueText: markKind === "date" ? null : valueText,
      strokeCaptureId: null, strokeHash: null, renderCaptureId: null, renderedHash: null, canvas: null, pointCount: null, strokeCount: null, durationMs: null, pressureAvailable: null,
      recordedAt: this.deps.clock.now().toISOString(),
    };
    await this.putMark(s, mark);
    return mark;
  }

  /** Take a mark back before completion. A drawn mark's files leave the vault; the capture rows remain as drafts that were never queued. */
  async removeMark(localId: string, fieldKey: string): Promise<void> {
    const s = await this.must(localId);
    if (s.state !== "started") throw new Error(`Session ${localId} is ${s.state}; a completed session is signed and cannot change`);
    const m = s.marks.find(x => x.fieldKey === fieldKey);
    if (!m) return;
    for (const id of [m.strokeCaptureId, m.renderCaptureId]) {
      if (!id) continue;
      const c = await this.deps.store.getCapture(id);
      for (const f of c?.files ?? []) if (f.vaultRef) await this.deps.vault.delete(f.vaultRef);
      if (c) await this.deps.store.putCapture({ ...c, files: c.files.map(f => ({ ...f, vaultRef: "" })), lastError: "Replaced before the session completed", updatedAt: this.deps.clock.now().toISOString() });
    }
    s.marks = s.marks.filter(x => x.fieldKey !== fieldKey);
    s.updatedAt = this.deps.clock.now().toISOString();
    await this.deps.store.putAttestSession(s);
  }

  /**
   * Complete: every required field assigned to this signer is marked, the device key signs the
   * session (the very object the server hashes), the mark files are queued. From here the session
   * waits for its marks to synchronize and for a connection; nothing on it changes again.
   */
  async complete(localId: string): Promise<LocalAttestSession> {
    const s = await this.must(localId);
    if (s.state !== "started") throw new Error(`Session ${localId} is ${s.state}`);
    const rev = await this.deps.store.getSignableRevision(s.revisionRef);
    if (!rev) throw new Error(`Revision ${s.revisionRef} is no longer on this device`);
    const mine = rev.fields.filter(f => f.signerRef === s.signerRef && f.state === "pending");
    const missing = mine.filter(f => f.required && !s.marks.some(m => m.fieldKey === f.fieldKey)).map(f => f.fieldKey);
    if (missing.length) throw new Error(`Required field(s) not marked: ${missing.join(", ")}`);
    if (!s.marks.length) throw new Error("A session carries at least one mark");
    const consentTextHash = await sha256HexOfString(CONSENT_TEXTS[s.consentVersion]!);
    const signedAt = this.deps.clock.now().toISOString();
    const payload = canonicalJson(sessionSigningObject({
      sessionRef: s.sessionRef, revisionRef: s.revisionRef, revisionHash: s.revisionHashAtStart, signerRef: s.signerRef,
      marks: s.marks.map(m => ({ fieldKey: m.fieldKey, markKind: m.markKind, strokeHash: m.strokeHash, renderedHash: m.renderedHash, valueText: m.markKind === "date" ? null : m.valueText })),
      consentTextHash, signedAt,
    }));
    const signatureP1363Base64 = await this.deps.keystore.signP1363(encode(payload));
    const keyFingerprint = await this.deps.keystore.fingerprint();
    for (const m of s.marks) for (const id of [m.strokeCaptureId, m.renderCaptureId]) if (id) await this.outbox.queue(id);
    const done: LocalAttestSession = { ...s, deviceSignature: { keyFingerprint, signatureP1363Base64, signedAt }, completedAt: signedAt, state: "queued", updatedAt: signedAt };
    await this.deps.store.putAttestSession(done);
    return done;
  }

  async status(): Promise<Record<LocalAttestSession["state"], number>> {
    const counts: Record<LocalAttestSession["state"], number> = { started: 0, queued: 0, syncing: 0, synchronized: 0, failed: 0 };
    for (const s of await this.deps.store.listAttestSessions()) counts[s.state]++;
    return counts;
  }

  private async open(localId: string, fieldKey: string) {
    const session = await this.must(localId);
    if (session.state !== "started") throw new Error(`Session ${localId} is ${session.state}; a completed session is signed and cannot change`);
    const rev = await this.deps.store.getSignableRevision(session.revisionRef);
    if (!rev) throw new Error(`Revision ${session.revisionRef} is no longer on this device`);
    const field = rev.fields.find(f => f.fieldKey === fieldKey);
    if (!field) throw new Error(`No field ${fieldKey} on ${rev.revisionRef}`);
    if (field.signerRef !== session.signerRef) throw new Error(`Field ${fieldKey} is assigned to another signer`);
    if (field.state !== "pending") throw new Error(`Field ${fieldKey} is ${field.state}`);
    if (session.marks.some(m => m.fieldKey === fieldKey)) throw new Error(`Field ${fieldKey} already carries a mark in this session; remove it first`);
    return { session, rev, field };
  }

  private async putMark(s: LocalAttestSession, mark: LocalAttestMark) {
    s.marks = [...s.marks, mark];
    s.updatedAt = this.deps.clock.now().toISOString();
    await this.deps.store.putAttestSession(s);
  }

  private async must(localId: string): Promise<LocalAttestSession> {
    const s = await this.deps.store.getAttestSession(localId);
    if (!s) throw new Error(`No signing session ${localId}`);
    return s;
  }
}

const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "-");
