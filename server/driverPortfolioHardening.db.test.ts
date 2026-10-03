/**
 * Security hardening of the Driver Portfolio (after #16), through the production router:
 *
 *   - equipment authorizations belong to the organization whose book holds them, in the portfolio
 *     projection and in dispatch readiness alike;
 *   - the wallet's BASELINE MET is not a dispatch authorization;
 *   - public sharing: POST-only redemption, bounded attempts, no durable rows for refusals, at most
 *     one audit row per share per window, an explicit medical exclusion, one credential per share,
 *     and nothing redeemable once the holder belongs to another organization;
 *   - entry provenance: the legacy entry paths write the portfolio's entry row too.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { shareRedeemLimits, SHARE_AUDIT_EVERY_MS } from "./driverPortfolioRouter";
import { shareableType } from "./_core/driverPortfolio";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 316_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const DAY = 86_400_000;
const days = (n: number) => new Date(Date.now() + n * DAY);

beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 4, timezone: "Z" }); });
afterAll(async () => { await pool?.end(); });
beforeEach(() => shareRedeemLimits.reset());

const as = (userId: number, ip = "198.51.100.7") => appRouter.createCaller({ req: { ip } as never, res: {} as never, user: { id: userId, role: "user" } as never });
const pub = (ip = "198.51.100.7") => appRouter.createCaller({ req: { ip } as never, res: {} as never, user: null }).driverPortfolio;

async function org() {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
  return orgRef;
}
async function member(orgRef: string, roles: string[], userId = seq++) {
  await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
async function operator(orgRef: string, userId: number | null, name = `Op ${rnd()}`) {
  const [o] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name, userId, licenseClass, createdAt) VALUES (?, ?, '1', NOW())", [name, userId]);
  await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,'operator',?,1)", [orgRef, o.insertId]);
  return Number(o.insertId);
}
async function credential(operatorId: number, docType: string, o: { status?: "verified" | "needs_review" | "rejected"; privateDetail?: boolean; identifier?: string } = {}) {
  const status = o.status ?? "verified";
  const [r] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, identifier, capturedAt, expiresAt, verificationStatus, verifiedByUserId, verifiedAt, privateDetail, createdAt) VALUES ('operator', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())",
    [operatorId, docType, docType, o.identifier ?? `ID-${rnd()}`, days(-30), days(400), status, status === "verified" ? 1 : null, status === "verified" ? days(-29) : null, o.privateDetail ?? false],
  );
  return Number(r.insertId);
}
/** A book (the employer an equipment authorization belongs to) owned by `orgRef`. */
async function book(orgRef: string | null) {
  const [e] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction, orgRef) VALUES (?, 'Fixture Employer Ltd.', 'corporation', 'CA-AB', ?)", [`FE-${rnd()}${rnd()}`, orgRef]);
  return Number(e.insertId);
}
async function authorization(userId: number, financialEntityId: number, equipmentType = "tri_drive_vac_truck") {
  await pool.execute(
    "INSERT INTO operatorEquipmentAuthorizations (authorizationRef, userId, financialEntityId, equipmentType, status, authorizedByUserId, authorizedAt, createdAt) VALUES (?, ?, ?, ?, 'authorized', 1, ?, NOW())",
    [`OEA-${rnd()}${rnd()}`, userId, financialEntityId, equipmentType, days(-10)],
  );
}
async function job(orgRef: string, customer: string) {
  const [j] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, customer, location, status, orgRef) VALUES (?,?,?,?,'dispatched',?)", [`JOB-${rnd()}`, "Hydrovac", customer, "10-22-045-06-W5", orgRef]);
  return Number(j.insertId);
}
const eventsOf = async (operatorId: number) =>
  (await pool.query<mysql.RowDataPacket[]>("SELECT eventType, actorUserId, credentialId, detail FROM driverPortfolioEvents WHERE operatorId = ? ORDER BY id", [operatorId]))[0];

async function company() {
  const orgRef = await org();
  const safety = await member(orgRef, ["safety"]);
  const dispatcher = await member(orgRef, ["dispatcher"]);
  const driver = await member(orgRef, ["driver"]);
  const operatorId = await operator(orgRef, driver);
  return { orgRef, safety, dispatcher, driver, operatorId };
}

d("equipment authorizations belong to the organization whose book holds them", () => {
  it("Org A's applies to Org A; Org B's never reaches Org A's portfolio or readiness", async () => {
    const a = await company();
    const orgB = await org();
    // The same person also works for Org B, as an operator there.
    await member(orgB, [], a.driver);
    const opB = await operator(orgB, a.driver);
    const safetyB = await member(orgB, ["safety"]);
    await as(a.safety).driverPortfolio.requirementCreate({ subjectType: "company", subjectCode: "*", requirementKind: "equipment", requirementCode: "tri_drive_vac_truck" });

    // Authorized only by Org B's book.
    await authorization(a.driver, await book(orgB));
    expect((await as(a.safety).driverPortfolio.portfolio({ operatorId: a.operatorId })).equipment).toEqual([]);
    const blocked = await as(a.dispatcher).driverPortfolio.operatorReadiness({ operatorId: a.operatorId });
    expect(blocked.requirements.find(l => /tri.drive/i.test(l.label))).toMatchObject({ ok: false, mandatory: true });
    expect(blocked.verdict).not.toBe("eligible");
    // Org B sees its own.
    expect((await as(safetyB).driverPortfolio.portfolio({ operatorId: opB })).equipment).toHaveLength(1);

    // Now authorized by Org A's own book: unchanged same-org behaviour.
    await authorization(a.driver, await book(a.orgRef));
    expect((await as(a.safety).driverPortfolio.portfolio({ operatorId: a.operatorId })).equipment).toHaveLength(1);
    const ok = await as(a.dispatcher).driverPortfolio.operatorReadiness({ operatorId: a.operatorId });
    expect(ok.requirements.find(l => /tri.drive/i.test(l.label))).toMatchObject({ ok: true });
    // And Org A's does not leak into Org B's either.
    expect((await as(safetyB).driverPortfolio.portfolio({ operatorId: opB })).equipment).toHaveLength(1);
  });

  it("an authorization in a book no organization owns does not count for a tenant operator", async () => {
    const a = await company();
    await as(a.safety).driverPortfolio.requirementCreate({ subjectType: "company", subjectCode: "*", requirementKind: "equipment", requirementCode: "tri_drive_vac_truck" });
    await authorization(a.driver, await book(null));
    expect((await as(a.safety).driverPortfolio.portfolio({ operatorId: a.operatorId })).equipment).toEqual([]);
    expect((await as(a.dispatcher).driverPortfolio.operatorReadiness({ operatorId: a.operatorId })).requirements.find(l => /tri.drive/i.test(l.label))).toMatchObject({ ok: false });
  });
});

d("the wallet is not a dispatch authorization", () => {
  it("reads BASELINE MET with grantsDispatch false while dispatch blocks a job its customer demands more for", async () => {
    const c = await company();
    const customer = `Cust ${rnd()}`;
    await as(c.safety).driverPortfolio.requirementCreate({ subjectType: "company", subjectCode: "*", requirementKind: "credential", requirementCode: "whmis" });
    await as(c.safety).driverPortfolio.requirementCreate({ subjectType: "customer", subjectCode: customer, requirementKind: "credential", requirementCode: "h2s_alive" });
    await credential(c.operatorId, "whmis");
    const w = await as(c.driver).driverPortfolio.myWallet();
    expect(w.status).toBe("BASELINE MET");
    expect(w.grantsDispatch).toBe(false);
    expect(w.notCovered.length).toBeGreaterThan(0);
    const r = await as(c.dispatcher).driverPortfolio.operatorReadiness({ operatorId: c.operatorId, jobId: await job(c.orgRef, customer) });
    expect(r.verdict).not.toBe("eligible");
    expect(r.operatorFindings.some(f => f.code === "driver_credential_h2s_alive_missing")).toBe(true);
    // No procedure accepts the wallet's headline as an input to dispatch.
    const src = readFileSync("server/driverPortfolioRouter.ts", "utf8");
    expect(src).not.toMatch(/canDispatch/);
    expect(readFileSync("server/readinessComposer.ts", "utf8")).not.toMatch(/walletView|BASELINE MET/);
  });
});

d("public sharing", () => {
  it("is a POST: shareRedeem is a mutation, so the token never rides in a URL", () => {
    const procedures = appRouter._def.procedures as unknown as Record<string, { _def: { type: string } } | undefined>;
    expect(procedures["driverPortfolio.shareRedeem"]?._def.type).toBe("mutation");
  });

  it("never shares medical fitness — not by its flag, not when the flag is flipped, not under another code", async () => {
    const c = await company();
    const me = as(c.driver).driverPortfolio;
    const flagged = await credential(c.operatorId, "medical_fitness", { privateDetail: true });
    const flipped = await credential(c.operatorId, "medical_fitness", { privateDetail: false });
    for (const id of [flagged, flipped]) await expect(me.shareIssue({ credentialId: id, audience: "Gate" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    // A share row forged to point at the medical record under an allowed code shows nothing.
    const allowed = await credential(c.operatorId, "h2s_alive");
    const share = await me.shareIssue({ credentialId: allowed, audience: "Gate" });
    expect(await pub().shareRedeem({ token: share.token })).toMatchObject({ valid: true });
    await pool.execute("UPDATE driverCredentialShares SET credentialId = ? WHERE shareRef = ?", [flipped, share.shareRef]);
    expect(await pub().shareRedeem({ token: share.token })).toEqual({ valid: false, reason: "unavailable" });
    // The portfolio never projects it either, and counts it as withheld.
    const p = await as(c.safety).driverPortfolio.portfolio({ operatorId: c.operatorId });
    expect(JSON.stringify(p.credentials)).not.toContain("medical");
    expect(p.privateCredentialsWithheld).toBe(2);
    // The rule itself.
    expect(shareableType("medical_fitness", false)).toBeNull();
    expect(shareableType("drug_alcohol_test", false)).toBeNull();
    expect(shareableType("h2s_alive", true)).toBeNull();
    expect(shareableType("h2s_certificate", false)?.code).toBe("h2s_alive");
    expect(shareableType("orientation:site:christina_lake", false)?.category).toBe("orientation");
    expect(shareableType("orientation:client:health_screening", false)).toBeNull();
  });

  it("one credential per share: a share names its credential and its code, and no procedure changes either", async () => {
    const c = await company();
    const me = as(c.driver).driverPortfolio;
    const h2s = await credential(c.operatorId, "h2s_alive");
    const whmis = await credential(c.operatorId, "whmis");
    const share = await me.shareIssue({ credentialId: h2s, audience: "Gate" });
    // Pointing the share at the holder's other credential (a different code) shows nothing.
    await pool.execute("UPDATE driverCredentialShares SET credentialId = ? WHERE shareRef = ?", [whmis, share.shareRef]);
    expect(await pub().shareRedeem({ token: share.token })).toEqual({ valid: false, reason: "unavailable" });
    // The only update the application makes to a share is its revocation.
    const src = readFileSync("server/driverPortfolioRouter.ts", "utf8");
    const updates = [...src.matchAll(/update\(driverCredentialShares\)\.set\(\{([^}]*)\}/g)].map(m => m[1]!.trim());
    expect(updates).toEqual(["revokedAt: now, revokedByUserId: ctx.user.id"]);
  });

  it("another organization's credential cannot be redeemed: a holder moved to another organization shows nothing", async () => {
    const c = await company();
    const h2s = await credential(c.operatorId, "h2s_alive");
    const share = await as(c.driver).driverPortfolio.shareIssue({ credentialId: h2s, audience: "Gate" });
    expect(await pub().shareRedeem({ token: share.token })).toMatchObject({ valid: true });
    await pool.execute("UPDATE coreRecordOwnership SET orgRef = ? WHERE recordType = 'operator' AND recordId = ?", [await org(), c.operatorId]);
    expect(await pub().shareRedeem({ token: share.token })).toEqual({ valid: false, reason: "unavailable" });
  });

  it("refusals write nothing durable, repeated successes write one row per window, and no row carries the token", async () => {
    const c = await company();
    const h2s = await credential(c.operatorId, "h2s_alive", { identifier: "H2S-SECRET-4411" });
    const share = await as(c.driver).driverPortfolio.shareIssue({ credentialId: h2s, audience: "Gate" });
    for (let i = 0; i < 5; i++) expect(await pub(`203.0.113.${i}`).shareRedeem({ token: `bogus-${rnd()}-${"x".repeat(30)}` })).toEqual({ valid: false, reason: "not_found" });
    // The refusal path is a log line, never an audit row (the append-only table cannot be filled by guessing).
    const src = readFileSync("server/driverPortfolioRouter.ts", "utf8");
    const refuse = src.slice(src.indexOf("const refuse = "), src.indexOf("const s = (await db.select().from(driverCredentialShares).where(eq(driverCredentialShares.tokenHash"));
    expect(refuse).toContain("console.warn");
    expect(refuse).not.toMatch(/recordPortfolio|insert\(/);

    for (let i = 0; i < 6; i++) expect(await pub().shareRedeem({ token: share.token })).toMatchObject({ valid: true });
    const ev = await eventsOf(c.operatorId);
    expect(ev.filter(e => e.eventType === "share_verified")).toHaveLength(1);
    expect(SHARE_AUDIT_EVERY_MS).toBe(15 * 60_000);
    for (const e of ev) {
      expect(e.detail).not.toContain(share.token);
      expect(e.detail).not.toContain("H2S-SECRET");
    }
    const [[stored]] = await pool.query<mysql.RowDataPacket[]>("SELECT tokenHash FROM driverCredentialShares WHERE shareRef = ?", [share.shareRef]) as unknown as [[{ tokenHash: string }]];
    expect(stored.tokenHash).not.toContain(share.token);

    // Revoked: refused, still nothing durable beyond the revocation itself.
    await as(c.driver).driverPortfolio.shareRevoke({ shareRef: share.shareRef });
    expect(await pub().shareRedeem({ token: share.token })).toEqual({ valid: false, reason: "revoked" });
    expect((await eventsOf(c.operatorId)).map(e => e.eventType).filter(t => t.startsWith("share_"))).toEqual(["share_verified", "share_revoked"]);
  });

  it("bounds attempts: refusals per address, attempts per address, and redemptions per share", async () => {
    const c = await company();
    const h2s = await credential(c.operatorId, "h2s_alive");
    const share = await as(c.driver).driverPortfolio.shareIssue({ credentialId: h2s, audience: "Gate" });
    const guesser = pub("192.0.2.66");
    for (let i = 0; i < 15; i++) await guesser.shareRedeem({ token: `guess-${i}-${"y".repeat(30)}` });
    // Over the refusal budget: even a good token from that address is refused until the window ends.
    await expect(guesser.shareRedeem({ token: share.token })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    // Another address is unaffected.
    expect(await pub("192.0.2.67").shareRedeem({ token: share.token })).toMatchObject({ valid: true });

    // One share redeemed again and again, from many addresses, is capped.
    shareRedeemLimits.reset();
    let refused = 0;
    for (let i = 0; i < 32; i++) {
      try { await pub(`10.9.${i}.1`).shareRedeem({ token: share.token }); } catch (e) { expect(e).toMatchObject({ code: "TOO_MANY_REQUESTS" }); refused++; }
    }
    expect(refused).toBe(2);
  });
});

d("entry provenance is the same whichever path recorded the credential", () => {
  it("compliance.credentialRecord and documents.create write the portfolio's entry row, naming the recorder", async () => {
    const c = await company();
    const office = await member(c.orgRef, ["office"]);
    const viaCompliance = await as(c.safety).compliance.credentialRecord({ ownerType: "operator", ownerId: c.operatorId, docType: "whmis", title: "WHMIS", identifier: "W-SECRET-1" });
    const viaDocuments = await as(office).fieldRoute.identity.documents.create({ ownerType: "operator", ownerId: c.operatorId, docType: "first_aid_cpr", title: "First aid", capturedAt: new Date() } as never);
    const viaPortfolio = await as(c.driver).driverPortfolio.submitCredential({ code: "h2s_alive", expiresAt: days(300) });
    const entries = (await eventsOf(c.operatorId)).filter(e => e.eventType === "credential_uploaded");
    expect(entries.map(e => [e.credentialId, e.actorUserId])).toEqual([
      [viaCompliance.credentialId, c.safety],
      [Number(viaDocuments), office],
      [viaPortfolio.credentialId, c.driver],
    ]);
    expect(entries[0]!.detail).toMatch(/via compliance\.credentialRecord/);
    expect(entries[1]!.detail).toMatch(/via documents\.create/);
    for (const e of entries) expect(e.detail).not.toContain("SECRET");
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT id, recordedByUserId FROM complianceDocuments WHERE ownerType = 'operator' AND ownerId = ? ORDER BY id", [c.operatorId]);
    expect(rows.map(r => r.recordedByUserId)).toEqual([c.safety, office, c.driver]);
  });

  it("a medical record filed by the generic path is private and writes no portfolio row", async () => {
    const c = await company();
    const office = await member(c.orgRef, ["office"]);
    const id = await as(office).fieldRoute.identity.documents.create({ ownerType: "operator", ownerId: c.operatorId, docType: "medical_fitness", title: "Medical", capturedAt: new Date() } as never);
    const [[row]] = await pool.query<mysql.RowDataPacket[]>("SELECT privateDetail, recordedByUserId FROM complianceDocuments WHERE id = ?", [id]) as unknown as [[{ privateDetail: number; recordedByUserId: number }]];
    expect(row).toMatchObject({ privateDetail: 1, recordedByUserId: office });
    expect(await eventsOf(c.operatorId)).toEqual([]);
  });

  it("a resubmission after a rejection says so, enters needs_review, and a different reviewer decides it", async () => {
    const c = await company();
    const me = as(c.driver).driverPortfolio;
    const first = await me.submitCredential({ code: "whmis", expiresAt: days(300) });
    await as(c.safety).driverPortfolio.credentialVerify({ credentialId: first.credentialId, outcome: "rejected", note: "illegible" });
    const again = await me.submitCredential({ code: "whmis", expiresAt: days(300) });
    expect(again.verificationStatus).toBe("needs_review");
    const entry = (await eventsOf(c.operatorId)).filter(e => e.eventType === "credential_uploaded").at(-1)!;
    expect(entry.detail).toContain(`resubmitted after credential ${first.credentialId} was rejected`);
    await expect(me.credentialVerify({ credentialId: again.credentialId, outcome: "verified" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await as(c.safety).driverPortfolio.credentialVerify({ credentialId: again.credentialId, outcome: "verified" })).toMatchObject({ verificationStatus: "verified" });
  });
});

d("credentials minted by workforce (independent review H1, M1)", () => {
  async function training(orgRef: string, trainee: number) {
    const recorder = await member(orgRef, ["hr"]);
    const [ev] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO evidenceRecords (title, category, capturedAt, capturedBy) VALUES ('H2S card', 'training', NOW(), ?)", [recorder]);
    const trn = await as(recorder).workforce.trainingRecord({ userId: trainee, courseCode: "H2S_ALIVE", title: "H2S Alive", completedAt: new Date(), evidenceRecordId: Number(ev.insertId) } as never) as { trainingRef: string };
    return { recorder, trainingRef: trn.trainingRef };
  }
  const docsFor = async (operatorId: number) =>
    (await pool.query<mysql.RowDataPacket[]>("SELECT id, verificationStatus FROM complianceDocuments WHERE ownerType = 'operator' AND ownerId = ?", [operatorId]))[0];

  it("lands on the operator record in the verifier's organization, never another organization's, and is audited there", async () => {
    // The person drives for Org B first (the older operator row), then for Org A.
    const orgB = await org();
    const person = await member(orgB, ["driver"]);
    const opB = await operator(orgB, person);
    const a = await org();
    await member(a, [], person);
    const opA = await operator(a, person);
    const { recorder, trainingRef } = await training(a, person);
    const verifier = await member(a, ["hr"]);
    const ok = await as(verifier).workforce.trainingVerify({ trainingRef, decision: "verified" } as never) as { complianceDocumentId: number };
    expect(await docsFor(opB)).toEqual([]);
    expect((await docsFor(opA)).map(r => r.id)).toEqual([ok.complianceDocumentId]);
    expect((await eventsOf(opA)).map(e => [e.eventType, e.actorUserId])).toEqual([["credential_uploaded", recorder], ["credential_verified", verifier]]);
    expect(await eventsOf(opB)).toEqual([]);
  });

  it("a concurrent reject and verify: one decision lands, and a rejected training mints nothing", async () => {
    for (let round = 0; round < 3; round++) {
      const c = await company();
      const { trainingRef } = await training(c.orgRef, c.driver);
      const [v1, v2, v3] = [await member(c.orgRef, ["hr"]), await member(c.orgRef, ["hr"]), await member(c.orgRef, ["hr"])];
      const results = await Promise.allSettled([
        as(v1).workforce.trainingVerify({ trainingRef, decision: "verified" } as never),
        as(v2).workforce.trainingVerify({ trainingRef, decision: "rejected" } as never),
        as(v3).workforce.trainingVerify({ trainingRef, decision: "verified" } as never),
      ]);
      expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ code: "PRECONDITION_FAILED" });
      const [[tr]] = await pool.query<mysql.RowDataPacket[]>("SELECT verificationStatus FROM trainingRecords WHERE trainingRef = ?", [trainingRef]) as unknown as [[{ verificationStatus: string }]];
      const docs = await docsFor(c.operatorId);
      expect(docs).toHaveLength(tr.verificationStatus === "verified" ? 1 : 0);
    }
  });
});

d("equipment authorization (independent review M2)", () => {
  it("nobody authorizes themselves on equipment", async () => {
    const orgRef = await org();
    const safety = await member(orgRef, ["safety"]);
    const entityId = await book(orgRef);
    await expect(as(safety).requirement.authorize({ userId: safety, financialEntityId: entityId, equipmentType: "hydrovac" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const other = await member(orgRef, ["driver"]);
    expect(await as(safety).requirement.authorize({ userId: other, financialEntityId: entityId, equipmentType: "hydrovac" })).toMatchObject({ status: "pending" });
  });
});

d("medical records by any spelling (independent review L1)", () => {
  it("'Medical_Fitness ' filed by either legacy path is private and never projected", async () => {
    const c = await company();
    const office = await member(c.orgRef, ["office"]);
    const id1 = await as(office).fieldRoute.identity.documents.create({ ownerType: "operator", ownerId: c.operatorId, docType: "Medical_Fitness ", title: "Medical", capturedAt: new Date() } as never);
    const r2 = await as(c.safety).compliance.credentialRecord({ ownerType: "operator", ownerId: c.operatorId, docType: "medical-fitness", title: "Medical", identifier: "MED-SECRET-9" });
    const [rows] = await pool.query<mysql.RowDataPacket[]>("SELECT privateDetail FROM complianceDocuments WHERE id IN (?, ?)", [id1, r2.credentialId]);
    expect(rows.map(r => r.privateDetail)).toEqual([1, 1]);
    const p = await as(c.safety).driverPortfolio.portfolio({ operatorId: c.operatorId });
    expect(JSON.stringify(p.credentials) + JSON.stringify(p.unrecognisedCredentials)).not.toMatch(/medical|MED-SECRET/i);
    expect(p.privateCredentialsWithheld).toBe(2);
    expect((await eventsOf(c.operatorId)).filter(e => e.eventType === "credential_uploaded")).toEqual([]);
  });
});
