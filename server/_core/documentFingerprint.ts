/**
 * Document fingerprints — recognizing the same document twice.
 *
 * A driver photographs a receipt at the pump and again at the end of the day.
 * The office scans a facility ticket the driver already captured. Two photos,
 * one document; two expenses would be a double-claim, two disposal tickets
 * would make one load look like two.
 *
 * Two fingerprints, because photos differ and documents do not:
 *
 *   content   SHA-256 of the captured bytes. Catches the same file uploaded
 *             twice. Misses a second photo of the same paper.
 *
 *   structured  SHA-256 of a canonical key built from what the document
 *             *says*: vendor + date + total for a receipt, facility + ticket
 *             number + load for a disposal ticket. Catches the second photo.
 *
 * A structured match is a `possible_duplicate`, never an automatic merge. The
 * fields it is built from are the precision-sensitive ones a human confirmed,
 * so the key is only as good as the confirmation — which is exactly why the
 * verdict goes to a person.
 */

import { createHash } from "node:crypto";
import type { DocumentType } from "./documentExtraction";
import { normalizeVendor } from "./documentExtraction";

export type FingerprintInput =
  | {
      documentType: "expense_receipt";
      vendorName: string | null;
      transactionDate: string | null;
      total: number | null;
      currency?: string | null;
    }
  | {
      /**
       * v20.18 — a fuel receipt keys on more than a receipt does. Two fills at
       * the same cardlock on the same day for the same total are plausible;
       * two with the same quantity, card and unit are the same fill.
       */
      documentType: "fuel_receipt";
      vendorName: string | null;
      transactionDate: string | null;
      total: number | null;
      quantity: number | null;
      cardLastFour: string | null;
      unitNumber: string | null;
    }
  | {
      documentType: "disposal_ticket" | "scale_ticket";
      facilityRef: string | null;
      facilityTicketNumber: string | null;
      loadRef: string | null;
      netKg?: number | null;
    }
  | {
      documentType: Exclude<DocumentType, "expense_receipt" | "fuel_receipt" | "disposal_ticket" | "scale_ticket">;
      rawTextHash: string;
    };

export type Fingerprint = {
  documentType: DocumentType;
  /** Human-readable canonical key. Stored so a reviewer can see why two matched. */
  structuredKey: string;
  structuredKeyHash: string;
  /** Null when the key could not be built — a receipt with no total has no key. */
  complete: boolean;
  missing: string[];
};

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function contentHash(bytes: Uint8Array | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Build the structured key. Incomplete inputs produce an incomplete
 * fingerprint that must not be used for matching: a receipt with no total
 * would collide with every other receipt from that vendor that day.
 */
export function buildFingerprint(input: FingerprintInput): Fingerprint {
  const missing: string[] = [];

  if (input.documentType === "fuel_receipt") {
    if (!input.vendorName) missing.push("vendorName");
    if (!input.transactionDate) missing.push("transactionDate");
    if (input.total == null) missing.push("total");
    if (input.quantity == null) missing.push("quantity");
    const key = [
      "fuel",
      normalizeVendor(input.vendorName ?? ""),
      input.transactionDate ?? "",
      input.total == null ? "" : input.total.toFixed(2),
      input.quantity == null ? "" : input.quantity.toFixed(1),
      (input.cardLastFour ?? "").replace(/\D/g, ""),
      (input.unitNumber ?? "").trim().toUpperCase(),
    ].join("|");
    return { documentType: "fuel_receipt", structuredKey: key, structuredKeyHash: sha(key), complete: missing.length === 0, missing };
  }

  if (input.documentType === "expense_receipt") {
    if (!input.vendorName) missing.push("vendorName");
    if (!input.transactionDate) missing.push("transactionDate");
    if (input.total == null) missing.push("total");
    const key = [
      "receipt",
      normalizeVendor(input.vendorName ?? ""),
      input.transactionDate ?? "",
      input.total == null ? "" : input.total.toFixed(2),
      (input.currency ?? "CAD").toUpperCase(),
    ].join("|");
    return {
      documentType: input.documentType,
      structuredKey: key,
      structuredKeyHash: sha(key),
      complete: missing.length === 0,
      missing,
    };
  }

  if (input.documentType === "disposal_ticket" || input.documentType === "scale_ticket") {
    if (!input.facilityRef) missing.push("facilityRef");
    if (!input.facilityTicketNumber) missing.push("facilityTicketNumber");
    // Load is deliberately part of the key: the same facility ticket number
    // legitimately recurs across facilities and years, but not across loads.
    if (!input.loadRef) missing.push("loadRef");
    const key = [
      "disposal",
      (input.facilityRef ?? "").trim().toLowerCase(),
      (input.facilityTicketNumber ?? "").trim().toUpperCase().replace(/\s+/g, ""),
      (input.loadRef ?? "").trim().toUpperCase(),
    ].join("|");
    return {
      documentType: input.documentType,
      structuredKey: key,
      structuredKeyHash: sha(key),
      complete: missing.length === 0,
      missing,
    };
  }

  // Narrowing: only the third member of the union carries rawTextHash.
  const rawTextHash = "rawTextHash" in input ? input.rawTextHash : "";
  const key = ["raw", input.documentType, rawTextHash].join("|");
  return {
    documentType: input.documentType,
    structuredKey: key,
    structuredKeyHash: sha(key),
    complete: true,
    missing,
  };
}

export type PriorCapture = {
  fingerprintRef: string;
  contentSha256: string | null;
  structuredKeyHash: string;
  targetType: string | null;
  targetRecordId: number | null;
  capturedAt: Date;
};

export type DuplicateVerdict =
  | { outcome: "unique"; reason: string }
  | {
      outcome: "exact_duplicate";
      reason: string;
      matches: PriorCapture[];
    }
  | {
      outcome: "possible_duplicate";
      reason: string;
      matches: PriorCapture[];
    }
  | { outcome: "cannot_assess"; reason: string; missing: string[] };

/**
 * Compare a new capture against prior ones.
 *
 * Exact beats structured; an exact match is the same bytes and there is no
 * judgement to make. A structured match without an exact one is a different
 * photo of what looks like the same document — a person decides. An incomplete
 * fingerprint cannot be assessed, and "cannot assess" is reported as such
 * rather than as "unique".
 */
export function assessDuplicate(args: {
  fingerprint: Fingerprint;
  contentSha256?: string | null;
  priors: readonly PriorCapture[];
}): DuplicateVerdict {
  if (args.contentSha256) {
    const exact = args.priors.filter(p => p.contentSha256 === args.contentSha256);
    if (exact.length > 0) {
      return {
        outcome: "exact_duplicate",
        reason: `Identical bytes captured ${exact.length} time(s) before`,
        matches: exact,
      };
    }
  }

  if (!args.fingerprint.complete) {
    return {
      outcome: "cannot_assess",
      reason: "Structured key incomplete — confirm the missing fields before duplicate detection can run",
      missing: args.fingerprint.missing,
    };
  }

  const near = args.priors.filter(
    p => p.structuredKeyHash === args.fingerprint.structuredKeyHash
  );
  if (near.length > 0) {
    const linked = near.filter(p => p.targetRecordId != null);
    return {
      outcome: "possible_duplicate",
      reason:
        linked.length > 0
          ? `Same document key already committed to ${linked[0]!.targetType} #${linked[0]!.targetRecordId}`
          : `Same document key captured before but not yet committed`,
      matches: near,
    };
  }

  return { outcome: "unique", reason: "No prior capture matches by bytes or by document key" };
}

/**
 * Whether a commit may proceed given the verdict. An exact duplicate is
 * refused outright — there is nothing to review, it is the same file. A
 * possible duplicate proceeds only with an explicit human override, recorded.
 */
export function commitPermittedUnder(
  verdict: DuplicateVerdict,
  humanOverride: boolean
): { permitted: boolean; reason: string } {
  switch (verdict.outcome) {
    case "unique":
      return { permitted: true, reason: verdict.reason };
    case "exact_duplicate":
      return { permitted: false, reason: `${verdict.reason} — identical file, nothing to review` };
    case "possible_duplicate":
      return humanOverride
        ? { permitted: true, reason: `Possible duplicate overridden by a person: ${verdict.reason}` }
        : { permitted: false, reason: `${verdict.reason} — a person must confirm this is a different document` };
    case "cannot_assess":
      // Refusing here would block every receipt missing an optional field.
      // The precision-sensitive fields are confirmed before commit anyway, so
      // by commit time the key is complete; reaching this at commit means
      // something upstream skipped a confirmation.
      return { permitted: false, reason: verdict.reason };
  }
}
