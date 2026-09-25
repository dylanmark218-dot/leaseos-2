/**
 * F1.3 — platform authority: the right to change something that spans every organization.
 *
 * LeaseOS has one platform-level authority already: `users.role = "admin"` (the same one
 * `adminProcedure` and `records.roles.bootstrapManagement` use). It is not a domain role and not an
 * organization membership. This module does not add a second hierarchy; it only reads that one.
 *
 * It is read from the `users` row at the moment of the change, not from the session: a demotion takes
 * effect on the next call, a session minted before the demotion carries no authority, and nothing in a
 * request (input fields, a role claimed on the context) can stand in for it. No row, no database, or
 * any other doubt answers false — fail closed.
 */
import { eq } from "drizzle-orm";
import { getDb } from "./db";
import { users } from "../drizzle/schema";

export async function platformAuthorityProven(userId: number): Promise<boolean> {
  try {
    const db = await getDb();
    if (!db) return false;
    const row = (await db.select({ role: users.role }).from(users).where(eq(users.id, userId)).limit(1))[0];
    return row?.role === "admin";
  } catch {
    return false;
  }
}
