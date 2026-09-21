/**
 * Printed assessment sheet serials, and what happens when one is scanned back.
 *
 * Proposed for checkpoint 0089. Pure and DB-free; the registry reads wrap
 * around it.
 *
 * The serial algorithm here must match the generator that produced the QR codes
 * on the printed stock, byte for byte. A checksum that disagrees between the
 * printer and the resolver fails every scan. Cross-verified against the Python
 * generator over the issued range.
 */

/**
 * Crockford base32 — no I, L, O or U, so a serial hand-copied off a muddy sheet
 * cannot be misread as 1 or 0. Field forms get transcribed by hand more often
 * than anyone plans for.
 */
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** FNV-1a over the payload, folded to 4 Crockford characters (20 bits). */
export function sheetChecksum(payload: string, chars = 4): string {
  // SHA-256 would need a crypto import in every consumer; this runs in the
  // browser, the worker and the print service. Collision resistance is not the
  // job here — catching a single mistyped character is.
  let h1 = 0x811c9dc5, h2 = 0x01000193;
  for (let i = 0; i < payload.length; i++) {
    h1 = Math.imul(h1 ^ payload.charCodeAt(i), 0x01000193) >>> 0;
    h2 = Math.imul(h2 + payload.charCodeAt(i) * (i + 1), 0x85ebca6b) >>> 0;
  }
  const combined = (BigInt(h1) << BigInt(32)) | BigInt(h2);   // BigInt(...) not `32n`: this tsconfig sets no target
  let out = "";
  for (let i = 0; i < chars; i++) {
    out = ALPHABET[Number((combined >> BigInt(5 * i)) & BigInt(31))] + out;
  }
  return out;
}

export function versionSlug(courseVersionRef: string): string {
  return courseVersionRef.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export type TicketClass = "assessment" | "practice";

/** T1/T2/T3 issue-capable; P-prefixed sheets never touch a credential. */
export function ticketClassOf(ticketCode: string): TicketClass {
  return /^P/i.test(ticketCode) ? "practice" : "assessment";
}

export function buildSerial(args: { ticketCode: string; courseVersionRef: string; sequence: number }): string {
  const body = `${args.ticketCode.toUpperCase()}.${versionSlug(args.courseVersionRef)}.${String(args.sequence).padStart(6, "0")}`;
  return `${body}.${sheetChecksum(body)}`;
}

export function parseSerial(serial: string):
  | { ok: true; ticketCode: string; versionSlug: string; sequence: number; checksum: string }
  | { ok: false; reason: "malformed" | "checksum_invalid" } {
  const parts = serial.trim().toUpperCase().split(".");
  if (parts.length !== 4) return { ok: false, reason: "malformed" };
  const [ticketCode, vslug, seq, checksum] = parts;
  if (!/^\d{6}$/.test(seq)) return { ok: false, reason: "malformed" };
  if (sheetChecksum(`${ticketCode}.${vslug}.${seq}`) !== checksum) {
    return { ok: false, reason: "checksum_invalid" };
  }
  return { ok: true, ticketCode, versionSlug: vslug, sequence: Number(seq), checksum };
}

// ---------------------------------------------------------------------------

export type SheetRegistryRow = {
  serial: string;
  ticketCode: string;
  courseVersionRef: string;
  itemSetRef: string;
  /** Draft item sets may be studied and practised with; they cannot support issuance. */
  itemSetReviewStatus: "draft" | "in_review" | "approved" | "retired";
  /** Set when the course version this sheet was printed against is no longer current. */
  courseVersionSupersededAt: Date | null;
  state: "issued" | "printed" | "returned" | "transcribed" | "void";
  voidedReason: string | null;
  /** Populated once a scan has already been filed against this physical sheet. */
  transcribedAt: Date | null;
  transcribedByUserId: number | null;
};

export type SheetScanOutcome = {
  verdict: "accept" | "accept_with_flag" | "reject";
  /** What the transcription may be used for. Never widened by a later step. */
  supports: "certificate_evidence" | "competency_evidence" | "study_record_only" | "nothing";
  code: string;
  message: string;
  flags: string[];
};

/**
 * Decide what a scanned sheet may become.
 *
 * Fails closed in every direction it can: an unrecognised serial is UNKNOWN and
 * not a new record; a duplicate is refused rather than filed twice; a practice
 * sheet can never resolve to anything that touches a credential, whatever the
 * scanner or the operator asks for.
 */
export function resolveSheetScan(args: {
  scanned: string;
  row: SheetRegistryRow | null;
  asOf: Date;
}): SheetScanOutcome {
  const parsed = parseSerial(args.scanned);

  if (!parsed.ok) {
    return parsed.reason === "checksum_invalid"
      ? { verdict: "reject", supports: "nothing", code: "serial_checksum_invalid",
          message: "The serial does not check out — it was mistyped or misread. Re-enter it from the sheet; do not guess the nearest match.",
          flags: [] }
      : { verdict: "reject", supports: "nothing", code: "serial_malformed",
          message: "That is not a LeaseOS sheet serial.", flags: [] };
  }

  if (!args.row) {
    // Well-formed and checksum-valid, but not in the registry. Printed outside
    // the issuance path, or from a registry this instance cannot see.
    return { verdict: "reject", supports: "nothing", code: "serial_unknown",
      message: `Serial ${args.scanned} is not in the sheet registry. It cannot be filed until its origin is established.`,
      flags: [] };
  }

  if (args.row.state === "void") {
    return { verdict: "reject", supports: "nothing", code: "sheet_void",
      message: `This sheet was voided${args.row.voidedReason ? `: ${args.row.voidedReason}` : ""}. Use a current blank.`,
      flags: [] };
  }

  if (args.row.state === "transcribed" || args.row.transcribedAt) {
    const when = args.row.transcribedAt?.toISOString().slice(0, 10) ?? "previously";
    return { verdict: "reject", supports: "nothing", code: "sheet_already_transcribed",
      message: `This physical sheet was already filed on ${when}. Filing it twice would create a second assessment record from one assessment.`,
      flags: [] };
  }

  const flags: string[] = [];

  if (args.row.courseVersionSupersededAt && args.row.courseVersionSupersededAt <= args.asOf) {
    // Blank stock printed in January, filled in June, course version moved on
    // in between. The assessment is real but it is against an old item set.
    flags.push(`Printed against ${args.row.courseVersionRef}, superseded ${args.row.courseVersionSupersededAt.toISOString().slice(0, 10)} — assessed against a version that is no longer current`);
  }

  if (ticketClassOf(args.row.ticketCode) === "practice") {
    return { verdict: flags.length ? "accept_with_flag" : "accept",
      supports: "study_record_only",
      code: "practice_sheet_filed",
      message: "Filed as a study record. Practice sheets do not affect credentials, competencies or dispatch eligibility.",
      flags };
  }

  if (args.row.itemSetReviewStatus !== "approved") {
    // Same rule 0088 applies to source snapshots: unreviewed material can be
    // studied, it cannot issue.
    flags.push(`Item set ${args.row.itemSetRef} is ${args.row.itemSetReviewStatus}, not approved`);
    return { verdict: "accept_with_flag", supports: "competency_evidence",
      code: "item_set_not_approved",
      message: `Filed as internal competency evidence only. ${args.row.itemSetRef} has not been approved by a reviewer, so this assessment cannot support a certificate.`,
      flags };
  }

  return { verdict: flags.length ? "accept_with_flag" : "accept",
    supports: "certificate_evidence",
    code: "sheet_filed",
    message: "Filed as assessment evidence. It supports, but does not itself complete, certificate issuance — the attestation and signatures are recorded separately.",
    flags };
}
