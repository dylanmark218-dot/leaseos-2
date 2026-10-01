/**
 * AIL-1B — company intelligence, against a real database.
 *
 * Organization A (a1 a driver, a2 and a3 safety) and organization B (b1 safety). An entry is A's or B's
 * by the session, never by input; it means nothing until a different person approves it; its source
 * is checked; replacing or withdrawing it keeps it. Rules: docs/register/AIL_1B_COMPANY_INTELLIGENCE.md.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 371_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 3 }); });
afterAll(async () => { await pool?.end(); });

const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
const ck = (u: number) => callerFor(u).companyKnowledge;
async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
async function person(orgRefs: string[], roles: string[]) {
  const userId = seq++;
  for (const o of orgRefs) await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, o, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
async function passageOf(tenantId: string | null, o: { basis?: string; superseded?: boolean } = {}) {
  const passageRef = `P-${rnd()}`;
  await pool.execute("INSERT INTO knowledgePassages (passageRef, tenantId, documentRef, documentTitle, body, revision, reproductionBasis, supersededAt) VALUES (?,?,?,?,?,?,?,?)",
    [passageRef, tenantId, "SOP-7", "Yard SOP", "Wash out before returning to yard.", "r1", o.basis ?? "own_document", o.superseded ? new Date() : null]);
  return passageRef;
}
/** A committed record whose sealed manifest holds `fields`. */
async function receiptOf(tenantId: string | null, fields: { key: string; status: string }[], formKey = "fuel_receipt") {
  const proposalId = `PRP-${rnd()}`;
  await pool.execute("INSERT INTO assistantProposals (tenantId, tenantDerivedFrom, proposalId, formKey, formVersion, title, targetRef, createdByUserId, readBack, readBackAcknowledged, commitState) VALUES (?,?,?,?,1,'Fuel','UNIT',1,'rb',1,'committed')",
    [tenantId, tenantId === null ? "legacy_unresolved" : "membership", proposalId, formKey]);
  await pool.execute("INSERT INTO assistantCommitReceipts (proposalId, formKey, action, targetType, targetRecordId, requiredPermission, adapterVersion, fieldManifest, fieldManifestHash, actorUserId, committedAt) VALUES (?,?,'create','fuel_transaction',1,'fuel.record','v1',?,?,1,NOW())",
    [proposalId, formKey, JSON.stringify(fields.map(f => ({ ...f, value: "x", correctedFrom: f.status === "corrected" ? "y" : null }))), "0".repeat(64)]);
  return proposalId;
}
const facilityOf = async (o: { orgRef?: string | null; facilityKey?: string | null }) =>
  (await pool.execute<mysql.ResultSetHeader>("INSERT INTO facilities (name, orgRef, facilityKey) VALUES (?,?,?)", [`F ${rnd()}`, o.orgRef ?? null, o.facilityKey ?? null]))[0].insertId;
const statement = (term: string, meaning: string) => ({ kind: "terminology" as const, term, meaning, sourceKind: "person_statement" as const });

let A: string, B: string, a1: number, a2: number, a3: number, b1: number;
d("AIL-1B: company intelligence is the organization's, governed, and checked", () => {
  beforeAll(async () => {
    A = await org(); B = await org();
    a1 = await person([A], ["driver"]); a2 = await person([A], ["safety"]); a3 = await person([A], ["safety"]); b1 = await person([B], ["safety"]);
  });

  it("means nothing until a different person approves it, and then only to its own organization", async () => {
    const term = `Bluebird ${rnd()}`;
    const p = await ck(a1).propose(statement(term, "Bluebird #4 Battery"));
    expect(p.state).toBe("proposed");
    expect((await ck(a2).lookup({ term })).organization).toEqual([]);
    await ck(a2).review({ entryRef: p.entryRef, decision: "approve", note: "confirmed with dispatch" });
    const forA = await ck(a1).lookup({ term: term.toUpperCase() });
    expect(forA.organization.map(e => e.entryRef)).toEqual([p.entryRef]);
    expect(forA.organization[0]).toMatchObject({ scope: "ORGANIZATION", meaning: "Bluebird #4 Battery", state: "approved", reviewedByUserId: a2 });
    expect((await ck(b1).lookup({ term })).organization).toEqual([]);
    expect((await ck(b1).list()).some(e => e.entryRef === p.entryRef)).toBe(false);
  });

  it("lets the same word mean different things in two organizations", async () => {
    const term = `BB-${rnd()}`;
    const pa = await ck(a1).propose(statement(term, "A's battery")); await ck(a2).review({ entryRef: pa.entryRef, decision: "approve", note: "ok for A" });
    const b2 = await person([B], ["safety"]);
    const pb = await ck(b2).propose(statement(term, "B's booster")); await ck(b1).review({ entryRef: pb.entryRef, decision: "approve", note: "ok for B" });
    expect((await ck(a1).lookup({ term })).organization.map(e => e.meaning)).toEqual(["A's battery"]);
    expect((await ck(b1).lookup({ term })).organization.map(e => e.meaning)).toEqual(["B's booster"]);
  });

  it("refuses self-approval, a reviewer without the permission, and another organization's reviewer", async () => {
    const own = await ck(a2).propose(statement(`self ${rnd()}`, "x"));
    await expect(ck(a2).review({ entryRef: own.entryRef, decision: "approve", note: "my own" })).rejects.toThrow(/cannot review/);
    const p = await ck(a1).propose(statement(`perm ${rnd()}`, "x"));
    await expect(ck(a1).review({ entryRef: p.entryRef, decision: "approve", note: "driver" })).rejects.toThrow();
    await expect(ck(b1).review({ entryRef: p.entryRef, decision: "approve", note: "other org" })).rejects.toThrow(/not found/);
    await expect(ck(b1).retire({ entryRef: p.entryRef, reason: "other org" })).rejects.toThrow(/not found/);
    expect((await ck(a2).list({ states: ["proposed"] })).find(e => e.entryRef === p.entryRef)?.state).toBe("proposed");
  });

  it("refuses an organization, a state or a reviewer named in the request", async () => {
    for (const forged of [{ tenantId: B }, { orgRef: B }, { state: "approved" }, { reviewedByUserId: a2 }, { proposedByUserId: a2 }]) {
      await expect(ck(a1).propose({ ...statement(`f ${rnd()}`, "x"), ...forged } as never)).rejects.toThrow();
    }
    await expect(ck(a1).lookup({ term: "x", tenantId: B } as never)).rejects.toThrow();
  });

  it("supersedes the old meaning when a new one is approved, and keeps both", async () => {
    const term = `Gate ${rnd()}`;
    const first = await ck(a1).propose(statement(term, "code 1234")); await ck(a2).review({ entryRef: first.entryRef, decision: "approve", note: "first" });
    const second = await ck(a1).propose(statement(term, "code 9876")); await ck(a3).review({ entryRef: second.entryRef, decision: "approve", note: "changed" });
    expect((await ck(a1).lookup({ term })).organization.map(e => e.meaning)).toEqual(["code 9876"]);
    const old = (await ck(a2).list({ states: ["superseded"] })).find(e => e.entryRef === first.entryRef);
    expect(old).toMatchObject({ state: "superseded", supersededByEntryRef: second.entryRef });
  });

  it("retires an approved entry with who and why, and nothing returns from a final state", async () => {
    const term = `Retire ${rnd()}`;
    const p = await ck(a1).propose(statement(term, "old shorthand")); await ck(a2).review({ entryRef: p.entryRef, decision: "approve", note: "checked" });
    await ck(a3).retire({ entryRef: p.entryRef, reason: "no longer used" });
    expect((await ck(a1).lookup({ term })).organization).toEqual([]);
    await expect(ck(a3).retire({ entryRef: p.entryRef, reason: "again" })).rejects.toThrow(/retired/);
    await expect(ck(a3).review({ entryRef: p.entryRef, decision: "approve", note: "revive" })).rejects.toThrow(/retired/);
    const r = await ck(a1).propose(statement(`Reject ${rnd()}`, "nope")); await ck(a2).review({ entryRef: r.entryRef, decision: "reject", note: "wrong" });
    await expect(ck(a3).review({ entryRef: r.entryRef, decision: "approve", note: "second try" })).rejects.toThrow(/rejected/);
    await expect(ck(a3).retire({ entryRef: r.entryRef, reason: "never approved" })).rejects.toThrow(/rejected/);
  });

  it("takes an SOP only from the organization's own current company document", async () => {
    const sop = (sourceRef: string) => ck(a1).propose({ kind: "sop", term: `washout ${rnd()}`, meaning: "Wash out before the yard", sourceKind: "company_document", sourceRef });
    expect((await sop(await passageOf(A))).state).toBe("proposed");
    await expect(sop(await passageOf(B))).rejects.toThrow(/not found/);
    await expect(sop(await passageOf(null))).rejects.toThrow(/not found/);
    await expect(sop(await passageOf(A, { superseded: true }))).rejects.toThrow(/not found/);
    await expect(sop(await passageOf(A, { basis: "licensed_source" }))).rejects.toThrow(/not found/);
  });

  it("takes a verified correction only from a field a person corrected on this organization's committed record", async () => {
    const correction = (sourceRef: string, subjectRef = "fuel_receipt.vendor") =>
      ck(a1).propose({ kind: "verified_correction", term: "Bluebird", meaning: "On fuel receipts 'Bluebird' is the Bluebird #4 cardlock", subjectType: "form_field", subjectRef, sourceKind: "verified_correction", sourceRef });
    const fields = [{ key: "vendor", status: "corrected" }, { key: "litres", status: "confirmed" }];
    expect((await correction(await receiptOf(A, fields))).state).toBe("proposed");
    await expect(correction(await receiptOf(A, fields), "fuel_receipt.litres")).rejects.toThrow(/no person's correction/);
    await expect(correction(await receiptOf(A, fields), "expense_receipt.vendor")).rejects.toThrow(/no person's correction/);
    await expect(correction(await receiptOf(B, fields))).rejects.toThrow(/not found/);
    await expect(correction(await receiptOf(null, fields))).rejects.toThrow(/not found/);
    await expect(correction(`PRP-MISSING-${rnd()}`)).rejects.toThrow(/not found/);
  });

  it("names a facility only if it is public or the organization's own", async () => {
    const conv = (id: number) => ck(a1).propose({ kind: "facility_convention", term: "call ahead", meaning: "Call the scale 30 min out", subjectType: "facility", subjectRef: String(id), sourceKind: "person_statement" });
    expect((await conv(await facilityOf({ facilityKey: `pub-${rnd()}` }))).state).toBe("proposed");
    expect((await conv(await facilityOf({ orgRef: A }))).state).toBe("proposed");
    await expect(conv(await facilityOf({ orgRef: B }))).rejects.toThrow(/not found/);
    await expect(conv(999_999_999)).rejects.toThrow(/not found/);
  });

  it("keeps the public directory's aliases GLOBAL and apart from the organization's answer", async () => {
    const alias = `Pub Alias ${rnd()}`;
    const f = await facilityOf({ facilityKey: `pub-${rnd()}` });
    await pool.execute("INSERT INTO facilityAliases (facilityId, alias, relationship) VALUES (?,?,'source_brief_name')", [f, alias]);
    const p = await ck(a1).propose(statement(alias, "our name for it")); await ck(a2).review({ entryRef: p.entryRef, decision: "approve", note: "checked" });
    const forA = await ck(a1).lookup({ term: alias }), forB = await ck(b1).lookup({ term: alias });
    expect(forA.global.map(g => g.scope)).toEqual(["GLOBAL"]);
    expect(forB.global.map(g => g.scope)).toEqual(["GLOBAL"]);
    expect(forA.organization.map(e => e.meaning)).toEqual(["our name for it"]);
    expect(forB.organization).toEqual([]);
    // A private facility's alias is not public naming.
    const priv = await facilityOf({ orgRef: B }), privAlias = `Priv ${rnd()}`;
    await pool.execute("INSERT INTO facilityAliases (facilityId, alias, relationship) VALUES (?,?,'contact_note')", [priv, privAlias]);
    expect((await ck(a1).lookup({ term: privAlias })).global).toEqual([]);
  });

  it("gives a person in two organizations nothing until which one they act for is established", async () => {
    const both = await person([A, B], ["safety"]);
    await expect(ck(both).list()).rejects.toThrow(/organization/);
    await expect(ck(both).propose(statement(`m ${rnd()}`, "x"))).rejects.toThrow(/organization/);
  });

  it("is enforced by the database too: no unreviewed approval, no self-review, no empty owner", async () => {
    const insert = (o: { tenantId?: string; state?: string; proposer?: number; reviewer?: number | null }) => pool.execute(
      "INSERT INTO organizationKnowledgeEntries (entryRef, tenantId, tenantDerivedFrom, kind, term, termKey, meaning, sourceKind, state, proposedByUserId, proposedAt, reviewedByUserId, reviewedAt) VALUES (?,?,'membership','terminology','t','t','m','person_statement',?,?,NOW(),?,NOW())",
      [`OKN-T-${rnd()}`, o.tenantId ?? A, o.state ?? "approved", o.proposer ?? 1, o.reviewer === undefined ? 2 : o.reviewer]);
    await expect(insert({ reviewer: null })).rejects.toThrow(/CONSTRAINT/);
    await expect(insert({ proposer: 5, reviewer: 5 })).rejects.toThrow(/CONSTRAINT/);
    await expect(insert({ tenantId: "" })).rejects.toThrow(/CONSTRAINT/);
    await expect(insert({ state: "proposed", reviewer: 2 })).rejects.toThrow(/CONSTRAINT/);
    await expect(insert({})).resolves.toBeDefined();
  });
});
