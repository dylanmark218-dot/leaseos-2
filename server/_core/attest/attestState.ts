/**
 * Sign & Attest — state machines, completion rule and race verdicts. Pure.
 *
 * docs/sign-attest/SIGN_ATTEST_DESIGN.md §6.5 and §14. Everything a transaction decides about a
 * revision, a field or a session is decided here from plain values, so the rules are tested without
 * a database and the service only carries them out.
 */
import {
  ATTEST_AUTH_METHODS,
  MARK_KINDS_FOR_FIELD,
  type AttestAuthMethod,
  type AttestCompletionRule,
  type AttestFieldState,
  type AttestFieldType,
  type AttestMarkKind,
  type AttestRejectionCode,
  type AttestRevisionState,
} from "../../../shared/attest";

export type RevisionTransition = "complete" | "finalize" | "void" | "supersede";

/** Which revision states each transition may start from (§14). */
const REVISION_TRANSITIONS: Readonly<Record<RevisionTransition, readonly AttestRevisionState[]>> = {
  complete: ["open"],
  finalize: ["completed", "open"],
  // A finalized revision is superseded or amended, never voided (the invoice-void precedent keeps the record).
  void: ["open", "completed"],
  supersede: ["open", "completed", "finalized"],
};

export type TransitionVerdict = { ok: true } | { ok: false; code: AttestRejectionCode; reason: string };

export function revisionTransition(from: AttestRevisionState, to: RevisionTransition): TransitionVerdict {
  if (REVISION_TRANSITIONS[to].includes(from)) return { ok: true };
  return { ok: false, code: codeForState(from), reason: `A ${from} revision cannot ${to}.` };
}

/** The rejection code a revision's state implies for a submission against it (§6.5 races 1, 2, 4). */
export function codeForState(state: AttestRevisionState): AttestRejectionCode {
  switch (state) {
    case "voided": return "DOCUMENT_VOIDED";
    case "finalized": return "DOCUMENT_FINALIZED";
    case "superseded": return "DOCUMENT_SUPERSEDED";
    default: return "REVISION_MISMATCH";
  }
}

/**
 * Whether a session may be committed against a revision. Order is cheapest-and-most-specific first,
 * so the refusal names the real problem (the `checkSignatureAttestation` discipline).
 */
export function bindingVerdict(args: {
  revisionState: AttestRevisionState;
  revisionHash: string;
  revisionHashAtStart: string;
}): TransitionVerdict {
  // `completed` is still signable: an optional field may be filled until finalization, and a second mark on
  // a completed field is refused by the field verdict (FIELD_ALREADY_COMPLETED), not by the binding.
  if (args.revisionState !== "open" && args.revisionState !== "completed") {
    return { ok: false, code: codeForState(args.revisionState), reason: `The document is ${args.revisionState}; nothing more can be signed on this revision.` };
  }
  if (args.revisionHash !== args.revisionHashAtStart) {
    return { ok: false, code: "REVISION_MISMATCH", reason: "The document changed after this copy was opened. The mark is kept as evidence of the attempt; the current revision must be signed afresh." };
  }
  return { ok: true };
}

/** The authentication strength order; a signer's `requiredAuth` is the weakest method accepted. */
const AUTH_RANK: Readonly<Record<AttestAuthMethod, number>> = {
  witnessed: 1,
  paper_scan: 1,
  session_login: 2,
  portal_link: 2,
  device_auth: 3,
};

export function authMethodSatisfies(offered: AttestAuthMethod, required: string): boolean {
  if (!(ATTEST_AUTH_METHODS as readonly string[]).includes(required)) return false;
  // `witnessed` and `paper_scan` are a different kind of proof, not a weaker login: a signer that
  // requires a login is not satisfied by somebody else witnessing, whatever the rank.
  if ((required === "session_login" || required === "portal_link" || required === "device_auth") && (offered === "witnessed" || offered === "paper_scan")) return false;
  return AUTH_RANK[offered] >= AUTH_RANK[required as AttestAuthMethod];
}

export type FieldForVerdict = {
  fieldRef: string;
  fieldType: AttestFieldType;
  state: AttestFieldState;
  assignedSignerRef: string | null;
  signingOrder: number | null;
  required: boolean;
};

/** Whether a mark may complete a field, for this signer, with this kind (§6.5 race 3; §13). */
export function fieldVerdict(args: { field: FieldForVerdict; signerRef: string; markKind: AttestMarkKind; earlierPending: boolean; rule: AttestCompletionRule }): TransitionVerdict {
  const f = args.field;
  if (f.state === "completed") return { ok: false, code: "FIELD_ALREADY_COMPLETED", reason: `Field ${f.fieldRef} is already completed; a second mark is kept as evidence but completes nothing.` };
  if (f.state !== "pending") return { ok: false, code: "REVISION_MISMATCH", reason: `Field ${f.fieldRef} is ${f.state}.` };
  if (f.assignedSignerRef !== args.signerRef) return { ok: false, code: f.assignedSignerRef ? "WRONG_SIGNER" : "FIELD_NOT_ASSIGNED", reason: f.assignedSignerRef ? `Field ${f.fieldRef} is assigned to another signer.` : `Field ${f.fieldRef} is not assigned to anyone yet.` };
  if (!MARK_KINDS_FOR_FIELD[f.fieldType].includes(args.markKind)) return { ok: false, code: "MALFORMED", reason: `A ${f.fieldType} field does not take a ${args.markKind} mark.` };
  if (args.rule === "all_required_fields_in_order" && args.earlierPending) return { ok: false, code: "MALFORMED", reason: `Field ${f.fieldRef} must wait for the fields ordered before it.` };
  return { ok: true };
}

export type CompletionVerdict = { complete: boolean; pendingRequired: string[]; pendingOptional: string[] };

/** The completion rule (§14): every required field completed; optional fields may stay pending. */
export function completionVerdict(fields: readonly Pick<FieldForVerdict, "fieldRef" | "state" | "required">[]): CompletionVerdict {
  const pendingRequired = fields.filter(f => f.required && f.state !== "completed").map(f => f.fieldRef);
  const pendingOptional = fields.filter(f => !f.required && f.state !== "completed").map(f => f.fieldRef);
  return { complete: pendingRequired.length === 0, pendingRequired, pendingOptional };
}

/** True when a field with a lower signing order on the same revision is still pending. */
export function earlierOrderPending(target: FieldForVerdict, all: readonly FieldForVerdict[]): boolean {
  if (target.signingOrder == null) return false;
  return all.some(f => f.fieldRef !== target.fieldRef && f.signingOrder != null && f.signingOrder < target.signingOrder! && f.state === "pending");
}

/** A `drawn` mark with no sealed stroke record is the label this subsystem exists to end (§1.3). */
export function markShapeVerdict(mark: { markKind: AttestMarkKind; strokeEvidenceRecordId: number | null; strokeHash: string | null; renderedEvidenceRecordId: number | null; valueText: string | null }): TransitionVerdict {
  const HEX = /^[0-9a-f]{64}$/;
  switch (mark.markKind) {
    case "drawn":
      if (mark.strokeEvidenceRecordId == null || !mark.strokeHash || !HEX.test(mark.strokeHash)) return { ok: false, code: "MARK_NOT_SEALED", reason: "A drawn mark must name its sealed stroke record and hash; without them it is a label." };
      return { ok: true };
    case "paper_scan":
      if (mark.renderedEvidenceRecordId == null) return { ok: false, code: "MARK_NOT_SEALED", reason: "A paper signature needs the scan in the evidence vault." };
      return { ok: true };
    case "typed_name":
    case "comment":
    case "approval":
      if (!mark.valueText || !mark.valueText.trim()) return { ok: false, code: "MALFORMED", reason: `A ${mark.markKind} mark carries a value.` };
      if (mark.markKind === "approval" && !["approved", "rejected"].includes(mark.valueText)) return { ok: false, code: "MALFORMED", reason: "An approval is 'approved' or 'rejected'." };
      return { ok: true };
    case "adopted_saved":
      return { ok: false, code: "MALFORMED", reason: "Saved marks are not supported yet (SA4)." };
    default:
      return { ok: true };
  }
}
