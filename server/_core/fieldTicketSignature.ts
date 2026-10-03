/**
 * SPINE item 2 — the one answer to "does this field ticket's current revision carry the signature it
 * needs?".
 *
 * The site sign-off (`closeoutRouter.recordSignature`) is the owning workflow. It writes ONE signature
 * row for the ticket, on revision 1, together with the frozen `site_signed` revision whose snapshot hash
 * the signature's payload hash names, and copies the result onto `fieldTickets.signatureStatus`. Later
 * revisions are post-site supplements the signer pre-authorized at signing ("the consultant signs the
 * billing basis, not a future number"); they do not make the signature stale.
 *
 * Before this module every consumer decided for itself, from a different fact:
 *
 *   invoicing   any accepted/partially-accepted signature row, on any revision      (row exists)
 *   closeout    the newest signature row exists, and is not "refused"               (row exists)
 *   portal      the ticket's denormalized signatureStatus column                    (column)
 *
 * They agree only while the records agree. A signature row on a revision that was never frozen, one
 * whose payload no longer matches the frozen snapshot, an amendment after signing, two signatures, or a
 * column that disagrees with its row each produced different answers in different places. This decides
 * once, from all of them, and a raw signature row is evidence, never the verdict on its own.
 *
 * States are the ones the workflow actually records. There is no "signature not required" or waiver
 * state: no workflow in this tree produces one, and "no signature found" is never read as one.
 *
 *   signed                 accepted, on the frozen revision, consistent             satisfies
 *   signed_with_refusals   partially accepted (an authority was refused at signing)  satisfies
 *   unsigned               nothing signed, and nothing claims otherwise              does not
 *   refused                the representative refused                                does not
 *   no_representative      nobody was there to sign                                  does not
 *   stale                  the signature does not describe the current revision      does not
 *   unknown                the records disagree, so it cannot be established         does not
 */

export type SignatureResult = "accepted" | "partially_accepted" | "refused" | "no_representative";

export type SignatureRow = { revision: number; result: SignatureResult; payloadHash: string | null; capturedAt: Date; signerName: string | null };
export type RevisionRow = { revision: number; kind: "site_signed" | "post_site_supplement" | "final" | "amendment"; snapshotHash: string };
export type TicketFacts = {
  status: string;
  signatureStatus: "unsigned" | SignatureResult;
};

export type SignatureVerdictState = "signed" | "signed_with_refusals" | "unsigned" | "refused" | "no_representative" | "stale" | "unknown";

export type SignatureVerdict = {
  state: SignatureVerdictState;
  /** True only for `signed` and `signed_with_refusals`: the prerequisite billing and closeout read. */
  satisfied: boolean;
  /** The signature the verdict stands on, when there is exactly one. Evidence, not the verdict. */
  signature: SignatureRow | null;
  reason: string;
};

/** Revision kinds that may follow the signed revision without making it stale (pre-authorized at signing). */
const PRE_AUTHORIZED_AFTER_SIGNING: ReadonlySet<RevisionRow["kind"]> = new Set<RevisionRow["kind"]>(["post_site_supplement"]);

export function fieldTicketSignatureVerdict(args: { ticket: TicketFacts; signatures: readonly SignatureRow[]; revisions: readonly RevisionRow[] }): SignatureVerdict {
  const { ticket, signatures, revisions } = args;
  const no = (state: SignatureVerdictState, reason: string, signature: SignatureRow | null = null): SignatureVerdict => ({ state, satisfied: false, signature, reason });

  if (signatures.length === 0) {
    return ticket.signatureStatus === "unsigned"
      ? no("unsigned", "Ticket is not signed")
      : no("unknown", `The ticket records "${ticket.signatureStatus}" but no signature is on file`);
  }
  if (signatures.length > 1) {
    return no("unknown", `${signatures.length} signatures are on file for one ticket; which one governs is not established`);
  }
  const sig = signatures[0]!;
  if (ticket.signatureStatus !== sig.result) {
    return no("unknown", `The signature records "${sig.result}" but the ticket records "${ticket.signatureStatus}"`, sig);
  }
  if (sig.result === "refused") return no("refused", "The customer representative refused the site ticket", sig);
  if (sig.result === "no_representative") return no("no_representative", "No customer representative signed the site ticket", sig);

  const frozen = revisions.find(r => r.revision === sig.revision && r.kind === "site_signed");
  if (!frozen) return no("stale", `The signature is on revision ${sig.revision}, which is not a frozen site-signed revision`, sig);
  if (!sig.payloadHash || sig.payloadHash !== frozen.snapshotHash) {
    return no("stale", `The signature does not describe revision ${frozen.revision} as frozen — its payload hash differs from the snapshot`, sig);
  }
  if (ticket.status === "amended_after_signature") return no("stale", "The ticket was amended after signature — re-present it", sig);
  const after = revisions.find(r => r.revision > sig.revision && !PRE_AUTHORIZED_AFTER_SIGNING.has(r.kind));
  if (after) return no("stale", `Revision ${after.revision} (${after.kind}) came after the signature and was not authorized by it`, sig);

  return sig.result === "accepted"
    ? { state: "signed", satisfied: true, signature: sig, reason: "Signed on the frozen revision" }
    : { state: "signed_with_refusals", satisfied: true, signature: sig, reason: "Signed on the frozen revision, with an authority refused at signing" };
}
