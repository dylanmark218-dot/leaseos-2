/**
 * LeaseOS Sign & Attest — the vocabularies the client and the server share.
 *
 * SA1 (docs/sign-attest/SIGN_ATTEST_DESIGN.md §3, §7). Everything here is plain data: enumerations
 * a zod schema can validate, the consent sentence a signer agrees to, and the stroke document a pad
 * will produce in SA2. Nothing here touches a database or a network.
 *
 * Vocabularies that must grow without a destructive migration are `varchar` columns validated by the
 * enums below (the `fieldTicketEvents.eventType` precedent). State machines that must not grow are
 * `mysqlEnum` columns in `drizzle/schema.ts` and are restated here only so a client can type them.
 */
import { z } from "zod";

/** What a field asks for. A later attestation type adds a value here, not a column. */
export const ATTEST_FIELD_TYPES = ["signature", "initials", "date_signed", "printed_name", "checkbox", "approval", "comment"] as const;
export type AttestFieldType = (typeof ATTEST_FIELD_TYPES)[number];

/**
 * How a mark was made. `drawn` means strokes exist and are sealed in the vault — a `drawn` mark with
 * no stroke record is refused, because that is exactly the label `fieldTicketSignatures.signatureMethod`
 * carried before Sign & Attest (§1.3). `electronic_ack` is a confirmation without a drawing (a portal
 * click, a PIN, a device-authenticated confirm); `paper_scan` is a sealed scan of a wet signature.
 */
export const ATTEST_MARK_KINDS = ["drawn", "typed_name", "checkbox", "approval", "comment", "date", "electronic_ack", "paper_scan", "adopted_saved"] as const;
export type AttestMarkKind = (typeof ATTEST_MARK_KINDS)[number];

/** Recorded from `PointerEvent.pointerType`, never inferred. A stylus and an Apple Pencil report `pen`. */
export const ATTEST_INPUT_KINDS = ["touch", "pen", "mouse", "keyboard", "none"] as const;
export type AttestInputKind = (typeof ATTEST_INPUT_KINDS)[number];

/**
 * Who the server believes made the mark (§4.2). Separate from the input: `drawn` is not an
 * authentication. The values are the existing `signatureMethod` vocabulary minus `drawn`, plus the
 * ordinary login case.
 */
export const ATTEST_AUTH_METHODS = ["session_login", "device_auth", "portal_link", "witnessed", "paper_scan"] as const;
export type AttestAuthMethod = (typeof ATTEST_AUTH_METHODS)[number];

export const ATTEST_PARTY_KINDS = ["internal_user", "external_identity", "named_witnessed"] as const;
export type AttestPartyKind = (typeof ATTEST_PARTY_KINDS)[number];

export const ATTEST_SUBJECT_TYPES = ["field_ticket_revision", "evidence_record", "commercial_document"] as const;
export type AttestSubjectType = (typeof ATTEST_SUBJECT_TYPES)[number];

export const ATTEST_REVISION_STATES = ["open", "completed", "finalized", "voided", "superseded"] as const;
export type AttestRevisionState = (typeof ATTEST_REVISION_STATES)[number];
export const ATTEST_FIELD_STATES = ["pending", "completed", "declined", "voided"] as const;
export type AttestFieldState = (typeof ATTEST_FIELD_STATES)[number];
export const ATTEST_SIGNER_STATES = ["invited", "active", "completed", "declined", "revoked"] as const;
export type AttestSignerState = (typeof ATTEST_SIGNER_STATES)[number];
export const ATTEST_SESSION_STATES = ["started", "completed", "declined", "abandoned", "rejected"] as const;
export type AttestSessionState = (typeof ATTEST_SESSION_STATES)[number];
export const ATTEST_COMPLETION_RULES = ["all_required_fields", "all_required_fields_in_order"] as const;
export type AttestCompletionRule = (typeof ATTEST_COMPLETION_RULES)[number];

/** The append-only event vocabulary (§9.1). Past tense where the outbox needs it. */
export const ATTEST_EVENT_TYPES = [
  "document_created", "document_scanned", "document_opened", "fields_placed",
  "signer_assigned", "signer_revoked", "signing_requested", "signing_started",
  "field_initialed", "field_signed", "field_acknowledged", "field_approved", "field_rejected", "field_commented", "field_dated", "field_named",
  "mark_adopted", "signing_completed", "signing_declined", "signing_rejected",
  "document_completed", "document_finalized", "artifact_generated", "document_voided", "document_superseded",
  "artifact_viewed", "artifact_exported", "sync_pending", "sync_completed", "verification_run",
] as const;
export type AttestEventType = (typeof ATTEST_EVENT_TYPES)[number];

/**
 * Why a submission was refused, as a code (§6.5). A device deciding what to do next reads the code,
 * never the sentence. The device and clock codes are the sync refusal codes with the same meaning.
 */
export const ATTEST_REJECTION_CODES = [
  "REVISION_MISMATCH", "DOCUMENT_VOIDED", "DOCUMENT_FINALIZED", "DOCUMENT_SUPERSEDED", "FIELD_ALREADY_COMPLETED", "FIELD_NOT_ASSIGNED",
  "WRONG_SIGNER", "SIGNER_NOT_AUTHENTICATED", "AUTH_METHOD_INSUFFICIENT", "CONSENT_MISSING",
  "DEVICE_NOT_ENROLLED", "DEVICE_NOT_ACTIVE", "KEY_FINGERPRINT_MISMATCH", "SIGNATURE_INVALID", "SIGNATURE_STALE",
  "MARK_NOT_SEALED", "MARK_HASH_MISMATCH", "REPLAY", "CLOCK_SKEW_TOO_LARGE", "MALFORMED",
] as const;
export type AttestRejectionCode = (typeof ATTEST_REJECTION_CODES)[number];

/** The mark kinds that complete each field type. A `signature` field takes a drawing, a scan or an acknowledgement; a `date_signed` field is filled by the server. */
export const MARK_KINDS_FOR_FIELD: Readonly<Record<AttestFieldType, readonly AttestMarkKind[]>> = {
  signature: ["drawn", "paper_scan", "electronic_ack", "adopted_saved"],
  initials: ["drawn", "paper_scan", "electronic_ack", "adopted_saved"],
  printed_name: ["typed_name"],
  date_signed: ["date"],
  checkbox: ["checkbox"],
  approval: ["approval"],
  comment: ["comment"],
};

/** The event a completed field appends (§9.1). */
export const EVENT_FOR_FIELD: Readonly<Record<AttestFieldType, AttestEventType>> = {
  signature: "field_signed",
  initials: "field_initialed",
  printed_name: "field_named",
  date_signed: "field_dated",
  checkbox: "field_acknowledged",
  approval: "field_approved",
  comment: "field_commented",
};

/* ------------------------------------------------------------------ */
/* Consent — the sentence the signer agrees to, versioned (D-04)        */
/* ------------------------------------------------------------------ */

export const CONSENT_VERSION_V1 = "leaseos-esign-consent/1";
export const CONSENT_TEXT_V1 =
  "I agree that my electronic mark on this document is my signature, initials or acknowledgement of the exact document revision shown to me, identified by its fingerprint, and that LeaseOS records the time, the identity I am authenticated as, and the device where available.";
export const CONSENT_TEXTS: Readonly<Record<string, string>> = { [CONSENT_VERSION_V1]: CONSENT_TEXT_V1 };

/* ------------------------------------------------------------------ */
/* The stroke document (§7.1) — produced by the pad in SA2, validated here */
/* ------------------------------------------------------------------ */

export const STROKE_FORMAT_V1 = "leaseos-strokes/1";
export const MAX_STROKE_POINTS = 20_000;
export const MAX_STROKE_BYTES = 512 * 1024;

/** [x, y, t, p]: canvas px (float), ms from the stroke's start (int), pressure 0–1 or null. */
export const strokePointSchema = z.tuple([z.number().finite(), z.number().finite(), z.number().int().nonnegative(), z.number().min(0).max(1).nullable()]);

export const strokeDocumentSchema = z.object({
  format: z.literal(STROKE_FORMAT_V1),
  canvas: z.object({
    widthPx: z.number().int().positive(),
    heightPx: z.number().int().positive(),
    devicePixelRatio: z.number().positive(),
    orientation: z.enum(["portrait", "landscape"]),
  }),
  field: z.object({ fieldRef: z.string().min(1).max(64), widthFrac: z.number().positive().max(1), heightFrac: z.number().positive().max(1) }),
  inputKind: z.enum(ATTEST_INPUT_KINDS),
  pressureAvailable: z.boolean(),
  strokes: z.array(z.object({ points: z.array(strokePointSchema).min(1) })).min(1),
  startedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
}).strict();
export type StrokeDocument = z.infer<typeof strokeDocumentSchema>;

/**
 * Byte-stable serialization: the key order is this function's, not the caller's, so a client and
 * the server produce identical bytes for identical strokes and `sha256` of them is the stroke hash.
 * No behavioural features are derived or stored (§7.1): the document is coordinates, time offsets
 * needed to render variable-width strokes, and pressure when the hardware reports it.
 */
export function serializeStrokeDocument(doc: StrokeDocument): string {
  const ordered = {
    format: doc.format,
    canvas: { widthPx: doc.canvas.widthPx, heightPx: doc.canvas.heightPx, devicePixelRatio: doc.canvas.devicePixelRatio, orientation: doc.canvas.orientation },
    field: { fieldRef: doc.field.fieldRef, widthFrac: doc.field.widthFrac, heightFrac: doc.field.heightFrac },
    inputKind: doc.inputKind,
    pressureAvailable: doc.pressureAvailable,
    strokes: doc.strokes.map(s => ({ points: s.points.map(p => [p[0], p[1], p[2], p[3]]) })),
    startedAt: doc.startedAt,
    durationMs: doc.durationMs,
  };
  return JSON.stringify(ordered);
}

export type StrokeDocumentVerdict = { ok: true; pointCount: number; strokeCount: number } | { ok: false; reason: string };

/** Size and shape guards a pad must satisfy before a document is sealed. */
export function assessStrokeDocument(doc: unknown): StrokeDocumentVerdict {
  const parsed = strokeDocumentSchema.safeParse(doc);
  if (!parsed.success) return { ok: false, reason: `not a ${STROKE_FORMAT_V1} document: ${parsed.error.issues[0]?.message ?? "invalid"}` };
  const d = parsed.data;
  const pointCount = d.strokes.reduce((n, s) => n + s.points.length, 0);
  if (pointCount > MAX_STROKE_POINTS) return { ok: false, reason: `${pointCount} points exceeds ${MAX_STROKE_POINTS}` };
  const bytes = serializeStrokeDocument(d).length;
  if (bytes > MAX_STROKE_BYTES) return { ok: false, reason: `${bytes} bytes exceeds ${MAX_STROKE_BYTES}` };
  for (const s of d.strokes) for (const p of s.points) {
    if (p[0] < 0 || p[1] < 0 || p[0] > d.canvas.widthPx || p[1] > d.canvas.heightPx) return { ok: false, reason: "a point lies outside the canvas" };
    if (p[3] !== null && !d.pressureAvailable) return { ok: false, reason: "pressure recorded while pressureAvailable is false" };
  }
  return { ok: true, pointCount, strokeCount: d.strokes.length };
}

/* ------------------------------------------------------------------ */
/* The offline session (§6.2–6.3, SA2) — built by the device, parsed by the server */
/* ------------------------------------------------------------------ */

export const ATTEST_SESSION_FORMAT = "leaseos-attest-session/1";
export const ATTEST_ENVELOPE_FORMAT = "leaseos-attest-envelope/1";
const hex64 = z.string().regex(/^[0-9a-f]{64}$/, "a 64-character sha256 hex digest");
const isoTime = z.string().datetime();

/** One mark as the device recorded it. Server-assigned facts (ids, server time) are absent by construction. */
export const offlineMarkSchema = z.object({
  fieldKey: z.string().min(1).max(80),
  markKind: z.enum(ATTEST_MARK_KINDS),
  inputKind: z.enum(ATTEST_INPUT_KINDS),
  valueText: z.string().max(500).nullable(),
  /** The evidence record ids the device learned when the mark's files synchronized (§6.3 step 1). */
  strokeEvidenceRecordId: z.number().int().positive().nullable(),
  strokeHash: hex64.nullable(),
  renderedEvidenceRecordId: z.number().int().positive().nullable(),
  renderedHash: hex64.nullable(),
  canvas: z.object({ widthPx: z.number().int().positive(), heightPx: z.number().int().positive(), devicePixelRatio: z.number().positive(), orientation: z.enum(["portrait", "landscape"]) }).strict().nullable(),
  pointCount: z.number().int().nonnegative().nullable(),
  strokeCount: z.number().int().nonnegative().nullable(),
  durationMs: z.number().int().nonnegative().nullable(),
  pressureAvailable: z.boolean().nullable(),
}).strict();
export type OfflineAttestMark = z.infer<typeof offlineMarkSchema>;

/**
 * The session the device signed at completion (capture-time binding). `authMethod` is the signer's
 * own device key (`device_auth`) or the witness's (`witnessed`); nothing else signs offline.
 */
export const offlineSessionSchema = z.object({
  format: z.literal(ATTEST_SESSION_FORMAT),
  /** Device-relative: `${deviceRef}:${localId}` (§3, `attestSigningSessions.sessionRef`). */
  sessionRef: z.string().min(8).max(120),
  revisionRef: z.string().min(3).max(120),
  revisionHashAtStart: hex64,
  signerRef: z.string().min(3).max(120),
  authMethod: z.enum(["device_auth", "witnessed"]),
  consentVersion: z.string().min(1).max(40),
  marks: z.array(offlineMarkSchema).min(1).max(200),
  startedAt: isoTime,
  completedAt: isoTime,
  gps: z.object({ latitude: z.number(), longitude: z.number() }).strict().nullable(),
  capturedOffline: z.boolean(),
  deviceSignature: z.object({ keyFingerprint: z.string().min(16).max(80), signatureP1363Base64: z.string().min(80).max(128), signedAt: isoTime }).strict(),
}).strict();
export type OfflineAttestSession = z.infer<typeof offlineSessionSchema>;

/** The envelope the device signs at send time, with a fresh nonce and its own clock (§6.3 step 2). */
export const attestEnvelopeSchema = z.object({
  format: z.literal(ATTEST_ENVELOPE_FORMAT),
  deviceRef: z.string().min(1).max(64),
  nonce: z.string().min(16).max(120),
  signedAt: isoTime,
  deviceClockAt: isoTime,
  session: offlineSessionSchema,
}).strict();
export type AttestEnvelope = z.infer<typeof attestEnvelopeSchema>;

export type SessionSigningMark = { fieldKey: string; markKind: string; strokeHash: string | null; renderedHash: string | null; valueText: string | null };
/**
 * The one object a device signs for a session, and the one the server hashes to verify it
 * (`server/_core/attest/attestPayload.sessionPayloadBytes` canonicalises exactly this). Everything in
 * it is known to the device before it signs; nothing server-assigned is in it.
 */
export function sessionSigningObject(s: { sessionRef: string; revisionRef: string; revisionHash: string; signerRef: string; marks: readonly SessionSigningMark[]; consentTextHash: string; signedAt: string }) {
  return {
    v: 1 as const, sessionRef: s.sessionRef, revisionRef: s.revisionRef, revisionHash: s.revisionHash, signerRef: s.signerRef,
    marks: s.marks.map(m => ({ fieldKey: m.fieldKey, markKind: m.markKind, strokeHash: m.strokeHash, renderedHash: m.renderedHash, valueText: m.valueText })),
    consentTextHash: s.consentTextHash, signedAt: s.signedAt,
  };
}

/** What `attest.submitSession` answers. A rejection is an answer with a code the device acts on, never a thrown error the outbox would retry. */
export type AttestSubmitRefusalCode = AttestRejectionCode | "NO_DEVICE_CLOCK";
export type AttestSessionSubmitResponse =
  | { state: "accepted" | "already_recorded"; sessionRef: string; revisionState: AttestRevisionState; signerState: string; marks: { fieldKey: string; fieldRef: string; markRef: string; payloadHash: string }[]; clockSkewMs: number | null }
  | { state: "rejected"; sessionRef: string; code: AttestSubmitRefusalCode; reason: string; handling: AttestRefusalHandling; serverTimeIso: string; skewMs: number | null };

/**
 * What the device should DO about a refusal (the `handleSyncRefusal` shape, §6.3 step 4). Retrying
 * cannot change a superseded document or a wrong clock; a device that retried those would show
 * "syncing" for ever over a signature the office will never receive.
 */
export type AttestRefusalHandling =
  | { action: "move_on"; reason: string }
  | { action: "stop_and_prompt"; title: string; instruction: string }
  | { action: "stop_and_escalate"; title: string; instruction: string };

export function attestRefusalHandling(args: { code: AttestSubmitRefusalCode; skewMs?: number | null; serverTimeIso?: string }): AttestRefusalHandling {
  const server = args.serverTimeIso ? ` The server's time is ${args.serverTimeIso}.` : "";
  switch (args.code) {
    case "REPLAY":
      return { action: "move_on", reason: "The server already holds this session; the device records it as synchronized and moves on." };
    case "CLOCK_SKEW_TOO_LARGE": {
      const minutes = args.skewMs == null ? null : Math.round(args.skewMs / 60_000);
      const by = minutes == null ? "" : ` by about ${Math.abs(Math.round(minutes / 60))} hour(s)${minutes > 0 ? " behind" : " ahead of"} the server`;
      return { action: "stop_and_prompt", title: "This device's clock is wrong", instruction: `Your device's date and time are off${by}.${server} Set the device to network time, then sync again. The signature is held on the device and is not lost.` };
    }
    case "SIGNATURE_STALE":
    case "NO_DEVICE_CLOCK":
      return { action: "stop_and_prompt", title: "This device's clock is wrong", instruction: `The envelope was signed too long ago for the server to accept it.${server} Set the device to network time and sync again; the signature is held on the device.` };
    case "DEVICE_NOT_ENROLLED":
    case "DEVICE_NOT_ACTIVE":
    case "KEY_FINGERPRINT_MISMATCH":
      return { action: "stop_and_escalate", title: "This device cannot submit signatures", instruction: "This device is not enrolled, was suspended or revoked, or signs with a key the office never enrolled. The signature is held on the device and is not lost; the office has to re-enrol the device. Retrying will not change the answer." };
    case "SIGNATURE_INVALID":
    case "MALFORMED":
    case "MARK_NOT_SEALED":
    case "MARK_HASH_MISMATCH":
      return { action: "stop_and_escalate", title: "The office has to look at this signature", instruction: "The server could not verify this session against the sealed strokes. It is held on the device and is not lost; retrying will not change the result, so tell the office rather than waiting." };
    case "REVISION_MISMATCH":
    case "DOCUMENT_VOIDED":
    case "DOCUMENT_FINALIZED":
    case "DOCUMENT_SUPERSEDED":
      return { action: "stop_and_escalate", title: "The document changed before this signature arrived", instruction: "The document was amended, voided, finalized or superseded after this copy was signed. The strokes are kept as evidence of the attempt; the current revision has to be signed afresh. Retrying cannot change this." };
    case "FIELD_ALREADY_COMPLETED":
      return { action: "stop_and_escalate", title: "Somebody already signed this field", instruction: "Another device's signature for the same field reached the office first. Both are kept; the office decides. Retrying cannot change this." };
    case "WRONG_SIGNER":
    case "SIGNER_NOT_AUTHENTICATED":
    case "AUTH_METHOD_INSUFFICIENT":
    case "FIELD_NOT_ASSIGNED":
    case "CONSENT_MISSING":
      return { action: "stop_and_escalate", title: "This signature is not accepted from this signer", instruction: "The field is assigned to somebody else, the signer was revoked, the method is not strong enough for this signer, or the consent statement is unknown. The office has to re-request the signature; retrying will not change the answer." };
  }
}

/** True when the device should mark the session synchronized rather than failed. */
export const attestRefusalIsSettled = (code: AttestSubmitRefusalCode): boolean => attestRefusalHandling({ code }).action === "move_on";

/** A field's box, as fractions of the unrotated page (D-03). */
export const fieldBoxSchema = z.object({
  page: z.number().int().positive(),
  xFrac: z.number().min(0).max(1),
  yFrac: z.number().min(0).max(1),
  widthFrac: z.number().positive().max(1),
  heightFrac: z.number().positive().max(1),
}).refine(b => b.xFrac + b.widthFrac <= 1.000001 && b.yFrac + b.heightFrac <= 1.000001, { message: "the box must lie within the page" });
