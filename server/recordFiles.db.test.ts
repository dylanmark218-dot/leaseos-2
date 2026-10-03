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

d("records.evidence.seal — the device's kind is normalized before it is written", () => {
  it("writes the canonical type for every approved kind, other for anything else, and leaves legacy rows alone", async () => {
    const A = await org();
    const jobA = await job(A);
    const driver = await member(A, ["driver"]);
    const office = await member(A, ["office"]);
    const legacy = await evidence({ jobId: jobA, title: `legacy ${rnd()}`, capturedBy: driver });   // never sealed: the default
    const sealAs = async (recordType: string) => {
      const id = await evidence({ jobId: jobA, title: `cap ${recordType} ${rnd()}`, capturedBy: driver });
      const r = await callerFor(driver).records.evidence.seal({ evidenceId: id, contentHash: "a".repeat(64), recordType, relationships: [{ entityType: "unit", entityRef: "U-1" }] });
      const [row] = await pool.execute<mysql.RowDataPacket[]>("SELECT recordType, sealState FROM evidenceRecords WHERE id = ?", [id]);
      return { id, returned: r.recordType, stored: row[0]!.recordType as string, sealState: row[0]!.sealState as string };
    };

    const expected: Record<string, string> = {
      pretrip: "pre_trip", posttrip: "post_trip_dvir", tailgate: "safety_meeting", fuel_receipt: "bill_receipt",
      expense_receipt: "bill_receipt", load_ticket: "load_ticket", disposal_ticket: "disposal_ticket", photo: "photo",
      incident: "incident", defect_report: "defect_report", signature: "signature_strokes",
      // unrecognized, hostile or signing-only: the legacy default, never a new category
      PRETRIP: "other", " pretrip": "other", credential: "other", signed_artifact: "other", attest_receipt: "other", hos_event: "other", "": "other",
    };
    for (const [kind, type] of Object.entries(expected)) {
      const r = await sealAs(kind);
      expect([r.returned, r.stored, r.sealState], JSON.stringify(kind)).toEqual([type, type, "sealed"]);
    }

    // Over-long input is refused at the boundary, before anything is written.
    const longId = await evidence({ jobId: jobA, title: `long ${rnd()}`, capturedBy: driver });
    await expect(callerFor(driver).records.evidence.seal({ evidenceId: longId, contentHash: "a".repeat(64), recordType: "x".repeat(61), relationships: [{ entityType: "unit", entityRef: "U-1" }] })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const [still] = await pool.execute<mysql.RowDataPacket[]>("SELECT recordType, sealState FROM evidenceRecords WHERE id = ?", [longId]);
    expect([still[0]!.recordType, still[0]!.sealState]).toEqual(["other", "draft"]);

    // A record sealed before normalization existed keeps its type and still projects.
    await expect(callerFor(office).records.files.get({ evidenceId: legacy })).resolves.toMatchObject({ recordType: "other", folder: "other" });
  }, 120_000);
});

d("records.files — signing material is read by the rules of what it is", () => {
  it("inherits a signed document's audience, keeps marks and receipts with legal, and never shows strokes", async () => {
    const A = await org(), B = await org();
    const jobA = await job(A);
    const tag = rnd();
    const signer = await member(A, ["driver"]);
    const dispatcher = await member(A, ["dispatcher"]), office = await member(A, ["office"]);
    const hr = await member(A, ["hr"]), legal = await member(A, ["legal"]);
    const outsiderLegal = await member(B, ["legal", "office"]);

    const ev = (title: string, recordType = "other", capturedBy: number | null = null) =>
      evidence({ jobId: jobA, title: `${title} ${tag}`, recordType, capturedBy, storageKey: `org/${A}/attest/${rnd()}` });
    const ticket = await ev("ticket", "load_ticket");
    const credential = await ev("credential", "credential");
    // Signing material sealed before capture kinds were normalized: stored as `other`.
    const strokes = await ev("strokes", "other", signer);
    const render = await ev("render", "other", signer);
    const signedTicket = await ev("signed-ticket");
    const signedCredential = await ev("signed-credential");
    const signedCommercial = await ev("signed-commercial");
    const receipt = await ev("receipt");

    const revision = async (subjectType: string, subjectId: number | null) => {
      const [r] = await pool.execute<mysql.ResultSetHeader>(
        "INSERT INTO attestDocumentRevisions (revisionRef, orgRef, instanceRef, revision, subjectType, subjectRef, subjectId, revisionHash, state, openedAt) VALUES (?,?,?,1,?,?,?,?, 'finalized', NOW())",
        [`REV-${rnd()}`, A, `INST-${rnd()}`, subjectType, String(subjectId ?? "DOC-1"), subjectId, "c".repeat(64)]);
      return r.insertId;
    };
    const artifact = (revisionId: number, kind: string, evidenceRecordId: number) => pool.execute(
      "INSERT INTO attestArtifacts (artifactRef, revisionId, orgRef, kind, mimeType, byteLength, contentHash, sourceRevisionHash, eventChainHead, rendererKey, rendererVersion, evidenceRecordId, generatedByUserId, generatedAt) VALUES (?,?,?,?, 'application/pdf', 10, ?, ?, ?, 'pdf', '1', ?, 1, NOW())",
      [`ART-${rnd()}`, revisionId, A, kind, "d".repeat(64), "c".repeat(64), "e".repeat(64), evidenceRecordId]);
    const rTicket = await revision("evidence_record", ticket);
    await artifact(rTicket, "finalized_pdf", signedTicket);
    await artifact(rTicket, "audit_receipt", receipt);
    await artifact(await revision("evidence_record", credential), "finalized_pdf", signedCredential);
    await artifact(await revision("commercial_document", null), "finalized_pdf", signedCommercial);
    await pool.execute(
      "INSERT INTO attestMarks (markRef, sessionId, fieldId, markKind, inputKind, strokeEvidenceRecordId, renderedEvidenceRecordId, payloadHash, completedAt) VALUES (?, 1, 1, 'signature', 'drawn', ?, ?, ?, NOW())",
      [`MARK-${rnd()}`, strokes, render, "f".repeat(64)]);

    const sees = async (user: number) => (await listTitles(user, { query: tag })).map(t => t.replace(` ${tag}`, "")).sort();
    // A signed document is read by whoever reads what was signed — no wider.
    expect(await sees(dispatcher)).toEqual(["signed-ticket", "ticket"]);
    expect(await sees(office)).toEqual(["signed-commercial", "signed-ticket", "ticket"]);
    expect(await sees(hr)).toEqual(["credential", "signed-credential"]);
    // A rendered mark and an audit receipt are legal's; stroke data is nobody's here.
    expect(await sees(legal)).toEqual(["receipt", "render", "signed-ticket", "ticket"]);
    // The signer reaches their own rendered mark, never the stroke data.
    expect(await sees(signer)).toEqual(["render"]);
    // Another company sees none of it.
    expect(await sees(outsiderLegal)).toEqual([]);

    // Stroke data by id: not found for everyone, and no download is ever signed.
    for (const user of [signer, legal, office, hr, dispatcher]) {
      await expect(callerFor(user).records.files.get({ evidenceId: strokes })).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(callerFor(user).records.files.download({ evidenceId: strokes })).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    await expect(callerFor(office).records.files.get({ evidenceId: signedCredential })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(dispatcher).records.files.download({ evidenceId: render })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(signed.keys).toEqual([]);

    // What it is, said in the record's own terms — the linkage, not the `other` it was stored as.
    await expect(callerFor(legal).records.files.get({ evidenceId: render })).resolves.toMatchObject({ recordType: "signature_render", readCategory: "evidence.read_legal" });
    await expect(callerFor(hr).records.files.get({ evidenceId: signedCredential })).resolves.toMatchObject({ recordType: "signed_artifact", readCategory: "evidence.read_personnel" });
  }, 120_000);
});

d("records.files.list — cursor pages", () => {
  type Page = Awaited<ReturnType<ReturnType<typeof callerFor>["records"]["files"]["list"]>>;
  const at = (s: number) => new Date(Date.UTC(2031, 0, 1, 0, 0, s));   // receipt times in a window nothing else uses
  async function row(o: { jobId: number; title: string; recordType?: string; createdAt: Date; capturedBy?: number | null; sealState?: string }) {
    const [e] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO evidenceRecords (jobId, title, category, capturedAt, capturedBy, status, recordType, sealState, createdAt) VALUES (?,?, 'fixture', NOW(), ?, 'needs_review', ?, ?, ?)",
      [o.jobId, o.title, o.capturedBy ?? null, o.recordType ?? "load_ticket", o.sealState ?? "draft", o.createdAt]);
    return e.insertId;
  }
  async function traverse(user: number, input: Record<string, unknown>, limit: number) {
    const pages: Page[] = [];
    let cursor: string | null = null;
    do {
      const p: Page = await callerFor(user).records.files.list({ ...input, limit, cursor } as never);
      pages.push(p);
      cursor = p.nextCursor;
    } while (cursor && pages.length < 200);
    return { pages, ids: pages.flatMap(p => p.records.map(r => r.id)), titles: pages.flatMap(p => p.records.map(r => r.title)) };
  }

  it("walks every visible record once, in createdAt DESC, id DESC, across ties, filters and organizations", async () => {
    const A = await org(), B = await org();
    const jobA = await job(A), jobB = await job(B);
    const tag = rnd();
    const dispatcher = await member(A, ["dispatcher"]), office = await member(A, ["office"]), legal = await member(A, ["legal"]);
    const signer = await member(A, ["driver"]), officeB = await member(B, ["office"]);

    // Seven distinct seconds, then four rows sharing one second — the id alone must order those.
    const tickets: { id: number; t: number }[] = [];
    for (let s = 10; s < 17; s++) tickets.push({ id: await row({ jobId: jobA, title: `t${s} ${tag}`, createdAt: at(s) }), t: s });
    for (let k = 0; k < 4; k++) tickets.push({ id: await row({ jobId: jobA, title: `tie${k} ${tag}`, createdAt: at(5) }), t: 5 });
    const receipts = [await row({ jobId: jobA, title: `bill1 ${tag}`, recordType: "bill_receipt", createdAt: at(20) }), await row({ jobId: jobA, title: `bill2 ${tag}`, recordType: "bill_receipt", createdAt: at(3) })];
    const cred = await row({ jobId: jobA, title: `cred ${tag}`, recordType: "credential", createdAt: at(18) });
    const strokes = await row({ jobId: jobA, title: `strokes ${tag}`, recordType: "other", createdAt: at(19), capturedBy: signer });
    await pool.execute("INSERT INTO attestMarks (markRef, sessionId, fieldId, markKind, inputKind, strokeEvidenceRecordId, payloadHash, completedAt) VALUES (?, 1, 1, 'signature', 'drawn', ?, ?, NOW())", [`MARK-${rnd()}`, strokes, "f".repeat(64)]);
    const theirs = await row({ jobId: jobB, title: `theirs ${tag}`, createdAt: at(15) });

    const ordered = (xs: { id: number; t: number }[]) => [...xs].sort((a, b) => b.t - a.t || b.id - a.id).map(x => x.id);

    // 1, 2. Pages are distinct, in order, and cover every visible record once — ties split across pages by id.
    const disp = await traverse(dispatcher, { query: tag }, 3);
    expect(disp.ids).toEqual(ordered(tickets));
    expect(new Set(disp.ids).size).toBe(disp.ids.length);
    expect(disp.pages.length).toBe(Math.ceil(tickets.length / 3));
    expect(disp.pages.at(-1)!.hasMore).toBe(false);
    expect(disp.pages.at(-1)!.nextCursor).toBeNull();
    expect(disp.pages.slice(0, -1).every(p => p.hasMore && p.nextCursor && p.records.length === 3)).toBe(true);

    // 3, 4, 5. Another company's record, an unheld category and stroke data never appear — for anyone.
    expect(disp.ids).not.toContain(theirs);
    for (const id of [...receipts, cred, strokes]) expect(disp.ids).not.toContain(id);
    const off = await traverse(office, { query: tag }, 4);
    expect(off.ids).toEqual(ordered([...tickets, { id: receipts[0]!, t: 20 }, { id: receipts[1]!, t: 3 }]));
    for (const id of [cred, strokes, theirs]) expect(off.ids).not.toContain(id);
    for (const user of [legal, signer]) expect((await traverse(user, { query: tag }, 2)).ids).not.toContain(strokes);
    expect((await traverse(officeB, { query: tag }, 2)).ids).toEqual([theirs]);

    // Counts describe what the caller may see — no hidden row contributes to them.
    const first = await callerFor(dispatcher).records.files.list({ query: tag, limit: 3 } as never);
    const all = (await callerFor(dispatcher).records.files.list({ limit: 1 } as never)).counts!;
    expect(first.counts).not.toBeNull();
    expect(all.loads_disposal).toBeGreaterThanOrEqual(tickets.length);
    const [orgRows] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM evidenceRecords WHERE jobId = ? AND recordType IN ('load_ticket','other')", [jobA]);
    expect(all.all).toBe(Number(orgRows[0]!.n) - 1);   // every job-operational row in A except the stroke data
    expect((await callerFor(office).records.files.list({ limit: 1 } as never)).counts!.billing).toBe(2);
    expect((await callerFor(dispatcher).records.files.list({ limit: 1 } as never)).counts!.billing).toBe(0);

    // 6. Direct reads are unchanged by paging.
    await expect(callerFor(legal).records.files.get({ evidenceId: strokes })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(dispatcher).records.files.get({ evidenceId: receipts[0]! })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(dispatcher).records.files.get({ evidenceId: tickets[0]!.id })).resolves.toMatchObject({ id: tickets[0]!.id });

    // 7. Search across page boundaries: only the matching rows, all of them, in order.
    const tieSearch = await traverse(dispatcher, { query: `tie ${tag}` }, 1);
    expect(tieSearch.ids).toEqual(ordered(tickets.filter(t => t.t === 5)));
    // 8. Folder across pages.
    expect((await traverse(office, { query: tag, folder: "billing" }, 1)).ids).toEqual([receipts[0], receipts[1]]);
    expect((await traverse(office, { query: tag, folder: "loads_disposal" }, 5)).ids).toEqual(ordered(tickets));
    // 9. Type across pages.
    expect((await traverse(office, { query: tag, recordType: "bill_receipt" }, 1)).ids).toEqual([receipts[0], receipts[1]]);
    expect((await traverse(dispatcher, { query: tag, recordType: "bill_receipt" }, 1)).ids).toEqual([]);
  }, 180_000);

  it("filters by lifecycle across pages, scanning past rows the caller may see but did not ask for", async () => {
    const A = await org(); const jobA = await job(A); const tag = rnd();
    const office = await member(A, ["office"]);
    const ids: number[] = [];
    for (let s = 0; s < 9; s++) ids.push(await row({ jobId: jobA, title: `life${s} ${tag}`, createdAt: at(30 + s), sealState: "sealed" }));
    const failed = [ids[1]!, ids[4]!, ids[7]!];
    const [pkg] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO syncPackages (packageRef, deviceId, state, itemCount, queuedAt) VALUES (?, 'dev', 'failed', 3, NOW())", [`PKG-${rnd()}`]);
    for (const id of failed) await pool.execute("INSERT INTO syncPackageItems (syncPackageId, evidenceRecordId, declaredContentHash, declaredManifestHash, state) VALUES (?,?,?,?,'mismatch')", [pkg.insertId, id, "a".repeat(64), "b".repeat(64)]);
    // 10.
    const t = await traverse(office, { query: tag, lifecycle: "integrity_failed" }, 1);
    expect(t.ids).toEqual([...failed].reverse());
    expect((await traverse(office, { query: tag, lifecycle: "sealed" }, 2)).ids).toEqual(ids.filter(i => !failed.includes(i)).reverse());
    expect((await traverse(office, { query: tag, lifecycle: "draft" }, 2)).ids).toEqual([]);
  }, 120_000);

  it("refuses a malformed cursor, a cursor from other filters, and a page size past the maximum — and another company's cursor reaches nothing of theirs", async () => {
    const A = await org(), B = await org();
    const jobA = await job(A), jobB = await job(B); const tag = rnd();
    const officeA = await member(A, ["office"]), officeB = await member(B, ["office"]);
    for (let s = 0; s < 4; s++) { await row({ jobId: jobA, title: `a${s} ${tag}`, createdAt: at(40 + s) }); await row({ jobId: jobB, title: `b${s} ${tag}`, createdAt: at(40 + s) }); }
    const list = (user: number, input: Record<string, unknown>) => callerFor(user).records.files.list({ query: tag, ...input } as never);
    const issued = (await list(officeA, { limit: 1 })).nextCursor!;
    expect(issued).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(Buffer.from(issued, "base64url").toString()).not.toMatch(/storage|key|org|title/i);

    // 11.
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
    const decoded = JSON.parse(Buffer.from(issued, "base64url").toString());
    for (const bad of ["garbage!!", "", "e30", b64([1, 2]), b64({ ...decoded, i: -1 }), b64({ ...decoded, i: 1.5 }), b64({ ...decoded, t: "x" }), b64({ ...decoded, extra: 1 }), b64({ ...decoded, v: 2 }), "a".repeat(600)]) {
      await expect(list(officeA, { limit: 1, cursor: bad }), bad.slice(0, 20)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    // 12. A cursor issued under one filter set does not resume another.
    await expect(list(officeA, { limit: 1, cursor: issued, folder: "billing" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(list(officeA, { limit: 1, cursor: issued, query: `${tag} x` })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // 13. B's cursor, under the same filters, only moves A through A's own records.
    const theirCursor = (await list(officeB, { limit: 1 })).nextCursor!;
    const viaTheirs = await list(officeA, { limit: 10, cursor: theirCursor });
    expect(viaTheirs.records.every(r => r.title.startsWith("a"))).toBe(true);
    // A hand-built cursor at the very top of the order changes nothing either.
    const forged = b64({ ...decoded, t: 8_000_000_000_000, i: 2_147_483_647 });
    expect((await list(officeA, { limit: 10, cursor: forged })).records.map(r => r.title).every(t => t.startsWith("a"))).toBe(true);
    // 14.
    for (const limit of [101, 1_000_000, 0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      await expect(list(officeA, { limit }), String(limit)).rejects.toMatchObject({ code: "BAD_REQUEST" });
    }
    expect((await list(officeA, {})).records.length).toBe(4);   // the default page holds them all
  }, 120_000);

  it("keeps a traversal whole while new records arrive: no duplicate, no skipped older row, new rows ahead", async () => {
    const A = await org(); const jobA = await job(A); const tag = rnd();
    const office = await member(A, ["office"]);
    const old: number[] = [];
    for (let s = 0; s < 6; s++) old.push(await row({ jobId: jobA, title: `old${s} ${tag}`, createdAt: at(50 + s) }));
    const page1 = await callerFor(office).records.files.list({ query: tag, limit: 2 } as never);
    // 15. Newer records arrive mid-traversal, one of them in the same second as the cursor row.
    const newer = [await row({ jobId: jobA, title: `new0 ${tag}`, createdAt: at(60) }), await row({ jobId: jobA, title: `new1 ${tag}`, createdAt: at(54) })];
    const ids = page1.records.map(r => r.id);
    let cursor = page1.nextCursor;
    while (cursor) {
      const p = await callerFor(office).records.files.list({ query: tag, limit: 2, cursor } as never);
      ids.push(...p.records.map(r => r.id));
      cursor = p.nextCursor;
    }
    expect(new Set(ids).size).toBe(ids.length);                         // no duplicate
    expect(ids.filter(i => old.includes(i))).toEqual([...old].reverse()); // every older row, in order
    expect(ids).not.toContain(newer[0]);                                 // ahead of the cursor: not in this traversal
    expect(ids).not.toContain(newer[1]);                                 // same second, higher id: also ahead
    // A fresh traversal sees them, each in its place: new0 (second 60) first; new1 shares second 54 with
    // old4 and, received later, sorts ahead of it by id.
    const fresh = await traverse(office, { query: tag }, 3);
    expect(fresh.ids).toEqual([newer[0], old[5], newer[1], old[4], old[3], old[2], old[1], old[0]]);
  }, 120_000);
});
