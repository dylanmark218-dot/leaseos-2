import { and, eq } from "drizzle-orm";
import { coreRecordOwnership } from "../../drizzle/schema";
import type { DbOrTx } from "./dbTypes";
import { SINGLE_TENANT_ID } from "./actingScope";

export type OwnedRecordType = "unit" | "operator" | "load" | "financial_entity";

/**
 * Legacy rows may be unowned only while operating in the historical `default`
 * organization. A real organization must have an explicit ownership row.
 */
export async function recordBelongsToOrganization(
  db: DbOrTx,
  orgRef: string,
  recordType: OwnedRecordType,
  recordId: number,
): Promise<boolean> {
  const row = (await db.select({ orgRef: coreRecordOwnership.orgRef })
    .from(coreRecordOwnership)
    .where(and(eq(coreRecordOwnership.recordType, recordType), eq(coreRecordOwnership.recordId, recordId)))
    .limit(1))[0];
  if (row) return row.orgRef === orgRef;
  return orgRef === SINGLE_TENANT_ID;
}

export async function assignRecordOwner(
  db: DbOrTx,
  input: { orgRef: string; recordType: OwnedRecordType; recordId: number; assignedByUserId: number },
): Promise<"assigned" | "already_owned"> {
  const row = (await db.select({ orgRef: coreRecordOwnership.orgRef })
    .from(coreRecordOwnership)
    .where(and(eq(coreRecordOwnership.recordType, input.recordType), eq(coreRecordOwnership.recordId, input.recordId)))
    .limit(1))[0];
  if (row) {
    if (row.orgRef !== input.orgRef) throw new Error("RECORD_OWNED_BY_ANOTHER_ORGANIZATION");
    return "already_owned";
  }
  await db.insert(coreRecordOwnership).values(input);
  return "assigned";
}
