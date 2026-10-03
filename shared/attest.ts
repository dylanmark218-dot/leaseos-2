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

/** A field's box, as fractions of the unrotated page (D-03). */
export const fieldBoxSchema = z.object({
  page: z.number().int().positive(),
  xFrac: z.number().min(0).max(1),
  yFrac: z.number().min(0).max(1),
  widthFrac: z.number().positive().max(1),
  heightFrac: z.number().positive().max(1),
}).refine(b => b.xFrac + b.widthFrac <= 1.000001 && b.yFrac + b.heightFrac <= 1.000001, { message: "the box must lie within the page" });
