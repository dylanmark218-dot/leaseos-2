/**
 * SEC-1 item 3 — the one projection a list of compliance documents passes through.
 *
 * `PRIVATE_CREDENTIAL_FIELDS_NEVER_PROJECTED` already names what a private credential must never
 * expose beyond HR, and the passport honoured it. The general document list did not: it returned
 * the whole row, so a medical certificate's title, identifier and storage key reached every holder
 * of `compliance.read`. A row is private when its flag says so OR its type says so — rows created
 * through `documents.create` before this fix carry `privateDetail = false` whatever their type.
 *
 * Kept: id, owner, type, dates and verification state — what the validity verdict, the expiry tile
 * and dispatch need. Expiry is administrative; the document's content is not.
 */
import { isMedicalDocType, PRIVATE_CREDENTIAL_FIELDS_NEVER_PROJECTED } from "./compliancePassport";

/**
 * Document types that are private by nature, whatever flag a row was stored with. This is
 * compliancePassport's `isMedicalDocType` — the rule creation and credential recording already use —
 * so the list, the creation path and the projection cannot disagree about what is medical.
 */
export function isPrivateDocType(docType: string): boolean {
  return isMedicalDocType(docType);
}

type Projectable = { docType: string; privateDetail?: boolean | number | null } & Partial<Record<(typeof PRIVATE_CREDENTIAL_FIELDS_NEVER_PROJECTED)[number], unknown>>;

/** The row with its never-projected fields nulled when it is private; a copy, never the row itself. */
export function projectComplianceDocument<T extends Projectable>(row: T): T {
  if (!row.privateDetail && !isPrivateDocType(row.docType)) return row;
  const out: Record<string, unknown> = { ...row };
  for (const f of PRIVATE_CREDENTIAL_FIELDS_NEVER_PROJECTED) if (f in out) out[f] = null;
  return out as T;
}
