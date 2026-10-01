/**
 * F1.1 — records whose owner cannot be proven.
 *
 * Some tables were built before LeaseOS had organizations and carry no owner at all: shop parts, bins
 * and stock movements; the tire registry; serialized tools; warranty policies and claims; customer
 * insurance requirements (keyed by free-text customer name); compliance documents for "equipment"
 * (there is no equipment table). A row there says nothing about which company it belongs to.
 *
 * UNKNOWN OWNERSHIP IS NOT GLOBAL ACCESS. The only state in which such a row provably belongs to the
 * caller is the one `actingScope` already names: no organization has been created yet, so the
 * deployment is one ownership domain and everything in it is the historical single tenant's. The
 * moment any organization exists, rows written by its members cannot be told apart from anyone
 * else's — including the single tenant's — so these operations are refused for everyone, with a
 * domain error that says why, until the owning checkpoint (F4 for inventory) gives the rows an owner.
 *
 * Deliberately not an input, a setting or a role: nothing a caller can say makes an unowned row theirs.
 */
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { getDb } from "./db";

/** True only while no organization exists — the deployment is provably one ownership domain. */
export async function singleOwnershipDomain(): Promise<boolean> {
  const db = await getDb();
  if (!db) return false;
  const [rows] = (await db.execute(sql`SELECT EXISTS (SELECT 1 FROM organizations) AS anyOrg`)) as unknown as [{ anyOrg: number | string }[]];
  return Number(rows[0]?.anyOrg ?? 1) === 0;
}

export const OWNERSHIP_UNRESOLVED = "OWNERSHIP_UNRESOLVED";

/**
 * Refuse, unless the deployment is one ownership domain. `what` names the capability; `until` names
 * the checkpoint that gives the rows an owner.
 */
export async function requireProvableOwnership(what: string, until: string): Promise<void> {
  if (await singleOwnershipDomain()) return;
  throw new TRPCError({
    code: "PRECONDITION_FAILED",
    message: `${OWNERSHIP_UNRESOLVED}: ${what} is unavailable — these records carry no organization, and with organizations present LeaseOS cannot prove whose they are. Nothing was read or changed. Available again once ${until}.`,
  });
}
