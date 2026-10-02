/**
 * Records & File Manager against a real database.
 *
 * The question these tests answer: can knowing — or guessing — an evidence id,
 * or choosing a folder, a search term or a classification, ever reach another
 * organization's record, or a record outside the caller's category reads? The
 * answer must be no, decided by the server, the same way for a record that
 * belongs to someone else as for one that does not exist.
 *
 * `storageGetSignedUrl` is the one place a storage capability is minted, so it
 * is replaced with a recorder: that is how a test can prove no URL is ever
 * generated for a caller who is refused, which a network error could not.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import mysql from "mysql2/promise";

const signed = vi.hoisted(() => ({ keys: [] as string[] }));
vi.mock("./storage", async importOriginal => ({
  ...(await importOriginal<typeof import("./storage")>()),
  storageGetSignedUrl: async (key: string) => {
    signed.keys.push(key);
    return `https://signed.example/object?sig=short-lived&n=${signed.keys.length}`;
  },
}));

import { appRouter } from "./routers";
import { authorize, permissionsForDomainRole, type DomainRole } from "./_core/recordsAuthorization";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 263_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 2 }); });
afterAll(async () => { await pool?.end(); });
beforeEach(() => { signed.keys.length = 0; });

const callerFor = (userId: number) =>
  appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

async function org() {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
  return orgRef;
}
async function member(orgRef: string | null, roles: string[], scopeRef: string | null = null) {
  const userId = seq++;
  if (orgRef) await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  // B23.1A: grants in the shape 0170 leaves behind — scoped to the organization
  // that issued them, a branch grant naming both its organization and its branch.
  // `global` now means platform-wide authority; a tenant-isolation test that gave
  // every caller that would be testing the wrong thing. A member of nowhere gets
  // the quarantine shape, which authorizes nothing.
  for (const role of roles) {
    await pool.execute(
      "INSERT INTO userRoleAssignments (userId, role, scopeType, orgRef, scopeRef, grantedByUserId, grantedAt) VALUES (?,?,?,?,?,1,NOW())",
      [userId, role, !orgRef ? "unscoped_legacy" : scopeRef ? "branch" : "organization", orgRef, scopeRef]
    );
  }
  return userId;
}
async function job(orgRef: string) {
  const [j] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, customer, location, status, orgRef) VALUES (?,?,?,?,'dispatched',?)", [`JOB-${rnd()}`, "Hydrovac", "Fixture Energy", "Somewhere", orgRef]);
  return j.insertId;
}
/** An evidence row. Captured "tomorrow" so it sits at the head of the newest-first window. */
async function evidence(o: { jobId?: number | null; title: string; recordType?: string; capturedBy?: number | null; storageKey?: string | null; status?: string; legalHold?: boolean }) {
  const [e] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO evidenceRecords (jobId, title, category, storageKey, mimeType, capturedAt, capturedBy, status, recordType, legalHold, createdAt) VALUES (?,?,?,?,?, DATE_ADD(NOW(), INTERVAL 1 DAY), ?,?,?,?, NOW())",
    [o.jobId ?? null, o.title, "fixture", o.storageKey ?? null, o.storageKey ? "application/pdf" : null, o.capturedBy ?? null, o.status ?? "needs_review", o.recordType ?? "other", o.legalHold ? 1 : 0]
  );
  return e.insertId;
}
const listTitles = async (userId: number, input: Record<string, unknown> = {}) =>
  (await callerFor(userId).records.files.list(input as never)).records.map(r => r.title);

d("records.files — tenant isolation", () => {
  it("lists the caller's organization and never another's, whatever folder, search or type is asked for", async () => {
    const A = await org(), B = await org();
    const officeA = await member(A, ["office"]), officeB = await member(B, ["office"]);
    const tag = rnd();
    const jobA = await job(A), jobB = await job(B);
    await evidence({ jobId: jobA, title: `A-ticket ${tag}`, recordType: "load_ticket" });
    const heldB = await evidence({ jobId: jobB, title: `B-ticket ${tag}`, recordType: "load_ticket", legalHold: true });
    const orphanB = await evidence({ jobId: null, title: `B-unfiled ${tag}`, recordType: "photo", capturedBy: officeB });

    expect(await listTitles(officeA, { query: tag })).toEqual([`A-ticket ${tag}`]);
    expect(await listTitles(officeB, { query: tag })).toEqual(expect.arrayContaining([`B-ticket ${tag}`, `B-unfiled ${tag}`]));

    // Folders, search and classification narrow; none of them reaches across.
    for (const folder of ["all", "loads_disposal", "photos", "legal_hold", "needs_filing", "needs_review", "drafts", "other"]) {
      const titles = await listTitles(officeA, { folder, query: tag });
      expect(titles.some(t => t.startsWith("B-")), folder).toBe(false);
    }
    expect(await listTitles(officeA, { query: `B-ticket ${tag}` })).toEqual([]);
    expect(await listTitles(officeA, { query: String(heldB) })).not.toContain(`B-ticket ${tag}`);
    expect(await listTitles(officeA, { query: "load ticket" })).not.toContain(`B-ticket ${tag}`);
    expect(await listTitles(officeA, { folder: "needs_filing" })).not.toContain(`B-unfiled ${tag}`);
    // Counts are over the caller's reach only.
    const res = await callerFor(officeA).records.files.list({ query: tag } as never);
    expect(res.records.every(r => !String(r.title).startsWith("B-"))).toBe(true);
    expect(JSON.stringify(res)).not.toContain(`B-ticket ${tag}`);
    void orphanB;
  }, 60_000);

  it("answers a guessed id identically whether it belongs to another organization or to nobody", async () => {
    const A = await org(), B = await org();
    const officeA = await member(A, ["office"]);
    const theirs = await evidence({ jobId: await job(B), title: `B-secret ${rnd()}`, recordType: "load_ticket", storageKey: `b/${rnd()}.pdf` });
    const [maxRows] = await pool.query<mysql.RowDataPacket[]>("SELECT MAX(id) AS maxId FROM evidenceRecords");
    const nobody = Number(maxRows[0]!.maxId) + 10_000;

    const outcome = async (p: Promise<unknown>) => p.then(() => "resolved", (e: { code?: string; message?: string }) => `${e.code}:${e.message?.replace(/\d+/g, "N")}`);
    const cross = await outcome(callerFor(officeA).records.files.get({ evidenceId: theirs }));
    const none = await outcome(callerFor(officeA).records.files.get({ evidenceId: nobody }));
    expect(cross).toBe("NOT_FOUND:Record N not found");
    expect(none).toBe(cross);

    const crossDl = await outcome(callerFor(officeA).records.files.download({ evidenceId: theirs }));
    const noneDl = await outcome(callerFor(officeA).records.files.download({ evidenceId: nobody }));
    expect(crossDl).toBe("NOT_FOUND:Record N not found");
    expect(noneDl).toBe(crossDl);
    // Nothing was signed, and the refused look left no access row on their record.
    expect(signed.keys).toEqual([]);
    const [events] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM evidenceAccessEvents WHERE evidenceRecordId = ?", [theirs]);
    expect(Number(events[0].n)).toBe(0);
  }, 60_000);

  it("refuses malformed identifiers at the input, before any lookup", async () => {
    const officeA = await member(await org(), ["office"]);
    for (const bad of [0, -1, 1.5, Number.NaN, "7", null, 2 ** 53]) {
      await expect(callerFor(officeA).records.files.get({ evidenceId: bad } as never), String(bad)).rejects.toMatchObject({ code: "BAD_REQUEST" });
      await expect(callerFor(officeA).records.files.download({ evidenceId: bad } as never), String(bad)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    await expect(callerFor(officeA).records.files.download({ evidenceId: 1, version: 0 } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // A storage location is not an input: an unknown key is stripped, never used.
    await expect(callerFor(officeA).records.files.list({ folder: "../../etc" } as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(signed.keys).toEqual([]);
  }, 60_000);
});

d("records.files — who may browse, and what", () => {
  it("refuses a caller with no role, and a branch-confined grant it cannot place", async () => {
    const A = await org();
    const nobody = await member(A, []);
    const branchOffice = await member(A, ["office"], "north");
    await expect(callerFor(nobody).records.files.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(branchOffice).records.files.list()).rejects.toMatchObject({ code: "FORBIDDEN" });
  }, 60_000);

  it("decides each record on its own category read, inside the organization", async () => {
    const A = await org();
    const tag = rnd();
    const jobA = await job(A);
    const mech = await member(A, ["mechanic"]), office = await member(A, ["office"]), hr = await member(A, ["hr"]);
    const workOrder = await evidence({ jobId: jobA, title: `wo ${tag}`, recordType: "work_order" });
    const receipt = await evidence({ jobId: jobA, title: `receipt ${tag}`, recordType: "bill_receipt" });
    const credential = await evidence({ jobId: jobA, title: `licence ${tag}`, recordType: "credential" });
    const unknownType = await evidence({ jobId: jobA, title: `novel ${tag}`, recordType: "brand_new_type" });

    expect((await listTitles(mech, { query: tag })).sort()).toEqual([`wo ${tag}`]);
    expect((await listTitles(office, { query: tag })).sort()).toEqual([`receipt ${tag}`, `wo ${tag}`]);
    expect((await listTitles(hr, { query: tag })).sort()).toEqual([`licence ${tag}`]);

    // The folder does not open a category the role lacks.
    expect(await listTitles(mech, { folder: "billing", query: tag })).toEqual([]);
    expect(await listTitles(office, { folder: "personnel", query: tag })).toEqual([]);

    // By id, a record outside the caller's category is "not found" — the same answer as across tenants.
    await expect(callerFor(mech).records.files.get({ evidenceId: receipt })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(office).records.files.get({ evidenceId: credential })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(office).records.files.download({ evidenceId: credential })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // An unclassified type reaches no category holder.
    await expect(callerFor(office).records.files.get({ evidenceId: unknownType })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(mech).records.files.get({ evidenceId: workOrder })).resolves.toMatchObject({ visibleBecause: "category" });
    expect(signed.keys).toEqual([]);
  }, 60_000);

  it("gives a driver their own records and no one else's", async () => {
    const A = await org();
    const tag = rnd();
    const jobA = await job(A);
    const me = await member(A, ["driver"]), colleague = await member(A, ["driver"]);
    const mine = await evidence({ jobId: jobA, title: `mine ${tag}`, recordType: "load_ticket", capturedBy: me });
    const theirs = await evidence({ jobId: jobA, title: `theirs ${tag}`, recordType: "load_ticket", capturedBy: colleague });
    expect(await listTitles(me, { query: tag })).toEqual([`mine ${tag}`]);
    await expect(callerFor(me).records.files.get({ evidenceId: mine })).resolves.toMatchObject({ visibleBecause: "own", mine: true });
    await expect(callerFor(me).records.files.get({ evidenceId: theirs })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A driver does not see who else opened their record.
    expect((await callerFor(me).records.files.get({ evidenceId: mine })).accessHistory).toBeNull();
  }, 60_000);

  it("evidence.browse adds no read to any role", () => {
    const roles: DomainRole[] = ["driver", "dispatcher", "mechanic", "shop_lead", "safety", "office", "management", "hr", "legal", "auditor", "bookkeeper", "payroll_admin", "tax_preparer", "controller", "external_accountant"];
    for (const role of roles) {
      const perms = permissionsForDomainRole(role);
      expect(perms, role).toContain("evidence.browse");
      // Every procedure browse gates re-decides on these; browse is not one of them.
      expect(authorize({ userId: 1, roles: [role], permission: "evidence.browse" }).allowed).toBe(true);
    }
  });
});

d("records.files — lifecycle, legacy rows and downloads", () => {
  it("projects a legacy evidence row that predates sealing", async () => {
    const A = await org();
    const office = await member(A, ["office"]);
    const jobA = await job(A);
    // The pre-B20 shape: none of the sealing columns named, so every one takes its default.
    const [e] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO evidenceRecords (jobId, title, category, capturedAt, status, createdAt) VALUES (?, ?, 'photo', DATE_ADD(NOW(), INTERVAL 1 DAY), 'verified', NOW())", [jobA, `legacy ${rnd()}`]);
    const got = await callerFor(office).records.files.get({ evidenceId: e.insertId });
    expect(got).toMatchObject({ recordType: "other", folder: "other", sealState: "draft", lifecycle: "draft", integrity: null, retention: null, version: 1, hasContent: false, actions: { download: false } });
    expect(got.legalHold).toEqual({ active: false, holds: [] });
    const row = (await callerFor(office).records.files.list({ folder: "other" } as never)).records.find(r => r.id === e.insertId);
    expect(row).toMatchObject({ lifecycle: "draft", status: "verified" });
  }, 60_000);

  it("derives lifecycle from the stored send package, not from anything the client says", async () => {
    const A = await org();
    const office = await member(A, ["office"]);
    const id = await evidence({ jobId: await job(A), title: `sent ${rnd()}`, recordType: "load_ticket" });
    await pool.execute("UPDATE evidenceRecords SET sealState='sealed' WHERE id=?", [id]);
    const [p] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO syncPackages (packageRef, deviceId, state, itemCount, queuedAt) VALUES (?, 'dev-1', 'server_received', 1, NOW())", [`PKG-${rnd()}`]);
    await pool.execute("INSERT INTO syncPackageItems (syncPackageId, evidenceRecordId, declaredContentHash, declaredManifestHash, state) VALUES (?,?,?,?,'mismatch')", [p.insertId, id, "a".repeat(64), "b".repeat(64)]);
    expect(await callerFor(office).records.files.get({ evidenceId: id })).toMatchObject({ lifecycle: "integrity_failed" });
  }, 60_000);

  it("signs a download only after the record is decided, returns no storage key, and logs it", async () => {
    const A = await org();
    const office = await member(A, ["office"]), mech = await member(A, ["mechanic"]);
    const key = `org/${A}/records/bill/${rnd()}.pdf`;
    const id = await evidence({ jobId: await job(A), title: `bill ${rnd()}`, recordType: "bill_receipt", storageKey: key });

    // The mechanic cannot read billing: refused, nothing signed.
    await expect(callerFor(mech).records.files.download({ evidenceId: id })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(signed.keys).toEqual([]);

    const res = await callerFor(office).records.files.download({ evidenceId: id });
    expect(signed.keys).toEqual([key]);
    expect(Object.keys(res).sort()).toEqual(["mimeType", "url", "version"]);
    expect(JSON.stringify(res)).not.toContain(key);
    // Neither the list nor the inspector carries the key either.
    expect(JSON.stringify(await callerFor(office).records.files.get({ evidenceId: id }))).not.toContain(key);
    expect(JSON.stringify(await callerFor(office).records.files.list({} as never))).not.toContain(key);

    const [events] = await pool.query<mysql.RowDataPacket[]>("SELECT action FROM evidenceAccessEvents WHERE evidenceRecordId = ? ORDER BY id", [id]);
    expect(events.map(e => e.action)).toEqual(["downloaded", "viewed"]);
  }, 60_000);

  it("refuses a version with no stored object rather than serving the current one as it", async () => {
    const A = await org();
    const office = await member(A, ["office"]);
    const id = await evidence({ jobId: await job(A), title: `v ${rnd()}`, recordType: "load_ticket", storageKey: `k/${rnd()}` });
    await pool.execute("UPDATE evidenceRecords SET currentVersion = 2 WHERE id = ?", [id]);
    await expect(callerFor(office).records.files.download({ evidenceId: id, version: 1 })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    const none = await evidence({ jobId: await job(A), title: `meta ${rnd()}`, recordType: "load_ticket" });
    await expect(callerFor(office).records.files.download({ evidenceId: none })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    expect(signed.keys).toEqual([]);
  }, 60_000);
});
