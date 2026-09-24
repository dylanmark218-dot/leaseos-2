/**
 * The role-type catalog, against a real database.
 *
 * Everything here is about the *database* refusing, not the application. The reason is specific and
 * the repository has been here before: `drizzle/0021_active_role_uniqueness.sql` replaced a
 * `UNIQUE(userId, role, scopeRef, revokedAt)` that was inert for exactly the rows it was written to
 * protect, because MariaDB permits unlimited NULLs in a unique index. Its comment is the rule this
 * file enforces — *"Application-level duplicate checks are not a substitute — two concurrent grants
 * would both pass a read-then-write check."*
 *
 * So `UNIQUE(orgRef, roleCode)` would not protect the global catalog, and the tests below fail
 * against it. Uniqueness lives on a PERSISTENT generated key instead.
 *
 * The second thing pinned here is subtler. `orgRef IS NULL` in LeaseOS ordinarily means "the
 * historical single tenant" (`server/db.ts:154-164`), and `orgScopeWhere` for a real tenant emits
 * `eq(orgRef, tenantId)` — which excludes NULL rows. A catalog read through that helper would show
 * a member of any real organization an empty catalog. The catalog is shared vocabulary, not an
 * owned record, and test C7 is what stops someone reaching for the familiar helper.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { resolveRoleType, visibleRoleTypes, type RoleType } from "./_core/dispatchRoleCatalog";

const DB_URL = process.env.DATABASE_URL;

describe("dispatch role catalog — preconditions", () => {
  it("runs against a real database", () => {
    expect(DB_URL, "DATABASE_URL must be set: a skipped catalog suite proves nothing").toBeTruthy();
  });
});

const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();

beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 4 }); });
afterAll(async () => { await pool?.end(); });

const insertType = (orgRef: string | null, roleCode: string, displayName = "X", active = true) =>
  pool.execute(
    "INSERT INTO dispatchRoleTypes (orgRef, roleCode, displayName, active, createdByUserId) VALUES (?,?,?,?,1)",
    [orgRef, roleCode, displayName, active ? 1 : 0]);

/** Every row the catalog holds for this tenant's view: globals plus its own. */
async function catalogFor(tenantId: string): Promise<RoleType[]> {
  // Deliberately NOT orgScopeWhere: a global row must be visible to every tenant.
  const [rows] = await pool.execute<mysql.RowDataPacket[]>(
    "SELECT orgRef, roleCode, displayName, description, defaultEquipmentClass, defaultTrailerClass, active FROM dispatchRoleTypes WHERE orgRef IS NULL OR orgRef = ?",
    [tenantId]);
  return rows.map(r => ({
    orgRef: r.orgRef as string | null, roleCode: r.roleCode as string, displayName: r.displayName as string,
    description: (r.description ?? null) as string | null,
    defaultEquipmentClass: (r.defaultEquipmentClass ?? null) as string | null,
    defaultTrailerClass: (r.defaultTrailerClass ?? null) as string | null,
    active: Boolean(r.active),
  }));
}

const refused = async (p: Promise<unknown>) => {
  try { await p; return false; } catch { return true; }
};

/* ================================================================== */
/* The database enforces uniqueness — all four properties              */
/* ================================================================== */

d("catalog uniqueness is enforced by the database, not by the application", () => {
  it("C1. a duplicate GLOBAL role code is refused", async () => {
    const code = `T_${rnd()}`;
    await insertType(null, code);
    expect(await refused(insertType(null, code)),
      "MariaDB permits unlimited NULLs in a unique index, so a nullable composite would accept this").toBe(true);
  });

  it("C2. a duplicate role code inside ONE tenant is refused", async () => {
    const code = `T_${rnd()}`, org = `ORG-${rnd()}`;
    await insertType(org, code);
    expect(await refused(insertType(org, code))).toBe(true);
  });

  it("C3. the same role code in DIFFERENT tenants is allowed", async () => {
    const code = `T_${rnd()}`;
    await insertType(`ORG-${rnd()}`, code);
    expect(await refused(insertType(`ORG-${rnd()}`, code))).toBe(false);
  });

  it("C4. a tenant type may coexist with a GLOBAL type of the same code, so tenant-first resolution stays possible", async () => {
    const code = `T_${rnd()}`, org = `ORG-${rnd()}`;
    await insertType(null, code, "global");
    expect(await refused(insertType(org, code, "tenant"))).toBe(false);
  });
});

/* ================================================================== */
/* Resolution, against rows that really came from the database         */
/* ================================================================== */

d("resolution over real rows", () => {
  it("C5. a tenant's own definition resolves ahead of the global one", async () => {
    const code = `T_${rnd()}`, org = `ORG-${rnd()}`;
    await insertType(null, code, "global name");
    await insertType(org, code, "tenant name");
    expect(resolveRoleType(code, org, await catalogFor(org))?.displayName).toBe("tenant name");
  });

  it("C6. the global type resolves when the tenant has no override", async () => {
    const code = `T_${rnd()}`, org = `ORG-${rnd()}`;
    await insertType(null, code, "global name");
    expect(resolveRoleType(code, org, await catalogFor(org))?.displayName).toBe("global name");
  });

  /*
   * The silent failure this whole read exists to avoid. `orgScopeWhere` for a real tenant is
   * `eq(orgRef, tenantId)`, which matches no NULL row, so a member of ORG-A would see an empty
   * catalog and every seeded code would read as unknown.
   */
  it("C7. a member of a real organization sees every seeded global type", async () => {
    const org = `ORG-${rnd()}`;
    const seeded = ["LEAD", "WINCH_TRACTOR", "BED_TRUCK", "PICKER", "PILOT_VEHICLE", "PRIMARY_UNIT", "SUPPORT_UNIT", "STANDBY"];
    const visible = visibleRoleTypes(org, await catalogFor(org)).map(t => t.roleCode);
    for (const code of seeded) {
      expect(visible, `a tenant member must be able to use the seeded global type ${code}`).toContain(code);
    }
  });

  it("C8. another tenant's type is invisible and unresolvable", async () => {
    const code = `T_${rnd()}`, a = `ORG-${rnd()}`, b = `ORG-${rnd()}`;
    await insertType(a, code, "A only");
    expect(resolveRoleType(code, b, await catalogFor(b))).toBeNull();
    expect(visibleRoleTypes(b, await catalogFor(b)).some(t => t.roleCode === code)).toBe(false);
  });

  it("C9. a deactivated type cannot be resolved for new use", async () => {
    const code = `T_${rnd()}`, org = `ORG-${rnd()}`;
    await insertType(null, code, "retired", false);
    expect(resolveRoleType(code, org, await catalogFor(org))).toBeNull();
  });
});

/* ================================================================== */
/* The seed, and the role table's new column                           */
/* ================================================================== */

d("what the migration establishes", () => {
  it("C10. the eight evidenced role types are seeded globally, and nothing else is", async () => {
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT roleCode FROM dispatchRoleTypes WHERE orgRef IS NULL AND roleCode NOT LIKE 'T\\_%' ORDER BY roleCode");
    expect(rows.map(r => r.roleCode)).toEqual(
      ["BED_TRUCK", "LEAD", "PICKER", "PILOT_VEHICLE", "PRIMARY_UNIT", "STANDBY", "SUPPORT_UNIT", "WINCH_TRACTOR"]);
  });

  it("C11. dispatchRoles.required exists and defaults to true, preserving today's behaviour", async () => {
    const [cols] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COLUMN_NAME, IS_NULLABLE, COLUMN_DEFAULT FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'dispatchRoles' AND column_name = 'required'");
    expect(cols).toHaveLength(1);
    expect(cols[0]!.IS_NULLABLE).toBe("NO");
    // Existing roles become required, because that is what the staffing logic already assumed
    // (dispatchTransaction.ts hardcoded `required: true`). Optional history is not inferred.
    expect(String(cols[0]!.COLUMN_DEFAULT)).toMatch(/1|true/i);
  });

  it("C12. the uniqueness key is a generated column the application never writes", async () => {
    const [cols] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT EXTRA FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'dispatchRoleTypes' AND column_name = 'roleTypeKey'");
    expect(cols, "roleTypeKey must exist").toHaveLength(1);
    expect(String(cols[0]!.EXTRA).toUpperCase(), "it must be database-derived, not application-written").toContain("GENERATED");
  });
});
