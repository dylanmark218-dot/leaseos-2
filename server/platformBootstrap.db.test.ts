/**
 * F1.3 — the zero-organization bootstrap, proven on a database of its own.
 *
 * The shared test database always holds organizations, so it can never show the state this is about. This
 * suite builds an isolated database with the same schema (`CREATE TABLE … LIKE`, the throwaway-database
 * convention of `migrationLedger.db.test.ts`), points the application at it before the router is loaded
 * (vitest gives each file its own module graph, and `getDb()` reads DATABASE_URL on first use), and walks:
 *
 *   zero organizations → an ordinary manager configures the global dispatch mode (BOOTSTRAP)
 *   → the first organization is created → the same manager is refused → a platform admin succeeds
 *   → nothing brings bootstrap back: an ended membership, a suspended or closed organization, a null or
 *     made-up organization id in the input, or a session that claims admin.
 *
 * BOOTSTRAP, exactly: while the `organizations` table has zero rows (any status), the global dispatch mode
 * may be read and set by a caller holding the domain permission (dispatch.enforcement.manage to set,
 * dispatch.read to read). Platform authority works throughout. The first organization row ends bootstrap for
 * every ordinary user; no application path deletes an organization row, so it does not come back.
 *
 * The compliance requirement registry has no bootstrap because it is not platform-governed: it is read per
 * organization (C1b-2), and every proposal is stamped with the proposer's organization — "default" for the
 * single tenant — so no proposal, before or after the first organization, is a row everyone reads.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
const isoName = `leaseos_boot_${Math.random().toString(36).slice(2, 8)}`;
let admin: mysql.Connection, iso: mysql.Connection;
let appRouter: typeof import("./routers").appRouter;

const caller = (userId: number, claimed: "user" | "admin" = "user") => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: claimed } as never });
const grant = (userId: number, role: string) => iso.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?, ?, 'global', 1, NOW())", [userId, role]);
const usersRow = (userId: number, role: "user" | "admin") => iso.execute("INSERT INTO users (id, openId, role) VALUES (?, ?, ?)", [userId, `boot-${userId}`, role]);
const count = async (sqlText: string) => Number(((await iso.query<mysql.RowDataPacket[]>(sqlText))[0][0] as { n: number }).n);
const globalRows = () => count("SELECT COUNT(*) AS n FROM dispatchEnforcementSettings WHERE financialEntityId IS NULL");

beforeAll(async () => {
  if (!URL) return;
  admin = await mysql.createConnection({ uri: URL });
  const source = new globalThis.URL(URL).pathname.slice(1);
  await admin.query(`CREATE DATABASE \`${isoName}\``);
  const [tables] = await admin.query<mysql.RowDataPacket[]>("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'", [source]);
  for (const { t } of tables) await admin.query(`CREATE TABLE \`${isoName}\`.\`${t}\` LIKE \`${source}\`.\`${t}\``);
  const isoUrl = URL.replace(/\/[^/?]+(\?|$)/, `/${isoName}$1`);
  iso = await mysql.createConnection({ uri: isoUrl });
  process.env.DATABASE_URL = isoUrl;             // before the application's first getDb() in this file's module graph
  appRouter = (await import("./routers")).appRouter;
}, 120_000);

afterAll(async () => {
  if (!URL) return;
  const db = await (await import("./db")).getDb();
  await (db as unknown as { $client?: { end?: () => Promise<void> } } | null)?.$client?.end?.();
  process.env.DATABASE_URL = URL;
  await iso.end();
  await admin.query(`DROP DATABASE \`${isoName}\``);
  await admin.end();
});

d("F1.3 — bootstrap: zero organizations, then the first organization ends it", () => {
  const manager = 910_001, reader = 910_002, noRole = 910_003, platformAdmin = 910_004, member = 910_005, controller = 910_006;
  const propose = (who: ReturnType<typeof caller>, key: string) => who.compliance.requirementLoad({
    requirementKey: key, family: "driver_licensing", title: "Bootstrap requirement", subjectType: "operator", jurisdiction: "CA-AB", satisfiedByDocTypes: ["driver_licence"],
    // FIXTURE citation — not a verified reading of any instrument.
    instrumentTitle: "FIXTURE INSTRUMENT — not a real regulation", sourceAuthority: "FIXTURE AUTHORITY", sourceReference: "s. 1(1)",
    sourceUrl: "https://www.alberta.ca/fixture-not-a-real-page", authorityType: "law", effectiveFrom: new Date("2026-01-01T00:00:00Z"),
  });
  const orgOf = async (key: string) => ((await iso.query<mysql.RowDataPacket[]>("SELECT orgRef FROM complianceRequirements WHERE requirementKey = ?", [key]))[0][0] as { orgRef: string | null }).orgRef;

  it("starts from an isolated database with zero organizations", async () => {
    expect(await count("SELECT COUNT(*) AS n FROM organizations")).toBe(0);
    expect(await count(`SELECT COUNT(*) AS n FROM information_schema.TABLES WHERE TABLE_SCHEMA = '${isoName}'`)).toBeGreaterThan(100);
    await usersRow(manager, "user"); await grant(manager, "management");
    await usersRow(reader, "user"); await grant(reader, "dispatcher");
    await usersRow(noRole, "user");
    await usersRow(platformAdmin, "admin");        // no domain role at all
    await usersRow(member, "user"); await grant(member, "management");
    await usersRow(controller, "user"); await grant(controller, "controller");
  });

  it("BOOTSTRAP: with zero organizations, a caller holding the domain permission reads and sets the global mode", async () => {
    expect((await caller(manager).dispatch.enforcementSet({ mode: "advisory", reason: "bootstrap: the single tenant configures its deployment" })).scope).toBe("global");
    expect((await caller(reader).dispatch.enforcementGet()).mode).toBe("advisory");
    expect(await globalRows()).toBe(1);
  });

  it("BOOTSTRAP is not unauthenticated or permission-free: a user without the domain permission is refused even now", async () => {
    await expect(caller(noRole).dispatch.enforcementSet({ mode: "off", reason: "no permission, zero organizations" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(reader).dispatch.enforcementSet({ mode: "off", reason: "read permission only, zero organizations" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await globalRows()).toBe(1);
  });

  it("the requirement registry is not platform-governed and needs no bootstrap: at zero organizations a proposal belongs to the single tenant ('default'), never to everyone", async () => {
    await propose(caller(controller), "boot.req.zero");
    expect(await orgOf("boot.req.zero")).toBe("default");
    expect(await count("SELECT COUNT(*) AS n FROM complianceRequirements WHERE orgRef IS NULL")).toBe(0);
  });

  it("the first organization ends it: the same manager is refused, to set and to read", async () => {
    await iso.execute("INSERT INTO organizations (orgRef, name, status) VALUES ('ORG-FIRST', 'First Co', 'active')");
    await expect(caller(manager).dispatch.enforcementSet({ mode: "off", reason: "the same mutation, one organization later" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(manager).dispatch.enforcementGet()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(reader).dispatch.enforcementGet()).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await globalRows()).toBe(1);
  });

  it("a platform administrator — with no domain role — still reads and sets it", async () => {
    expect((await caller(platformAdmin, "admin").dispatch.enforcementSet({ mode: "enforced", reason: "platform: enforce by default" })).scope).toBe("global");
    expect((await caller(platformAdmin, "admin").dispatch.enforcementGet()).mode).toBe("enforced");
    expect(await globalRows()).toBe(2);
  });

  it("nothing brings bootstrap back: an ended membership, a suspended or closed organization, null or made-up ids, a claimed session", async () => {
    // A member whose membership ends is unaffiliated again — which is not authority once organizations exist.
    await iso.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES ('MEM-BOOT', 'ORG-FIRST', ?, 'employee', 'active', '2020-01-01', 1)", [member]);
    await expect(caller(member).dispatch.enforcementSet({ mode: "off", reason: "as a member of the first organization" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await iso.execute("DELETE FROM organizationMemberships WHERE userId = ?", [member]);
    await expect(caller(member).dispatch.enforcementSet({ mode: "off", reason: "membership deleted, unaffiliated again" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // An organization that is suspended, or closed, still exists: bootstrap is about zero rows, not zero active ones.
    for (const status of ["suspended", "closed"]) {
      await iso.execute("UPDATE organizations SET status = ? WHERE orgRef = 'ORG-FIRST'", [status]);
      await expect(caller(manager).dispatch.enforcementSet({ mode: "off", reason: `the only organization is ${status}` }), status).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    // Null, raw or made-up organization / entity ids in the input.
    await expect(caller(manager).dispatch.enforcementSet({ financialEntityId: null, mode: "off", reason: "explicit null entity" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(manager).dispatch.enforcementSet({ mode: "off", reason: "raw organization fields", orgRef: null, organizationId: 0, tenantId: "default" } as never)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller(manager).dispatch.enforcementSet({ financialEntityId: 999_999, mode: "off", reason: "a made-up entity id" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A session that claims admin over a users row that says user.
    await expect(caller(manager, "admin").dispatch.enforcementSet({ mode: "off", reason: "my session says admin" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await globalRows()).toBe(2);
    expect(((await iso.query<mysql.RowDataPacket[]>("SELECT mode FROM dispatchEnforcementSettings WHERE financialEntityId IS NULL ORDER BY id DESC LIMIT 1"))[0][0] as { mode: string }).mode).toBe("enforced");
  });

  it("and after the first organization, a member's proposal belongs to that organization; still no shared row", async () => {
    await iso.execute("UPDATE organizations SET status = 'active' WHERE orgRef = 'ORG-FIRST'");
    await iso.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES ('MEM-CTL', 'ORG-FIRST', ?, 'employee', 'active', '2020-01-01', 1)", [controller]);
    await propose(caller(controller), "boot.req.after");
    expect(await orgOf("boot.req.after")).toBe("ORG-FIRST");
    expect(await count("SELECT COUNT(*) AS n FROM complianceRequirements WHERE orgRef IS NULL")).toBe(0);
  });
});
