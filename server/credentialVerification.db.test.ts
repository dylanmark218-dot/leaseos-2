/**
 * The one verification door (credentialVerificationService) as a security boundary.
 *
 * Every procedure that can decide a compliance credential is driven through `appRouter.createCaller`
 * — compliance.credentialVerify, fieldRoute.identity.documents.review and
 * driverPortfolio.credentialVerify — and each must refuse the same things: the credential's own
 * subject, whoever recorded it, another organization, a non-reviewable state, and a stale second
 * decision. workforce.trainingVerify and workforce.taskVerify mint verified credentials and apply the
 * same separation-of-duties rule.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 314_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const DAY = 86_400_000;
const days = (n: number) => new Date(Date.now() + n * DAY);

beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 6, timezone: "Z" }); });
afterAll(async () => { await pool?.end(); });

const as = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

async function org() {
  const orgRef = `ORG-${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]);
  return orgRef;
}
async function member(orgRef: string, roles: string[]) {
  const userId = seq++;
  await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
async function operator(orgRef: string, userId: number | null) {
  const [o] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO operators (name, userId, licenseClass, createdAt) VALUES (?, ?, '1', NOW())", [`Op ${rnd()}`, userId]);
  await pool.execute("INSERT INTO coreRecordOwnership (orgRef, recordType, recordId, assignedByUserId) VALUES (?,'operator',?,1)", [orgRef, o.insertId]);
  return Number(o.insertId);
}
const row = async (id: number) =>
  ((await pool.query<mysql.RowDataPacket[]>("SELECT verificationStatus, verifiedByUserId, recordedByUserId FROM complianceDocuments WHERE id = ?", [id]))[0])[0]!;
const decisions = async (credentialId: number) =>
  (await pool.query<mysql.RowDataPacket[]>("SELECT eventType, actorUserId, detail FROM driverPortfolioEvents WHERE credentialId = ? AND eventType IN ('credential_verified','credential_rejected') ORDER BY id", [credentialId]))[0];

/** The refusal as plain values: vitest's rejects.toMatchObject does not enforce a RegExp on an Error's message. */
async function refusal(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try { await p; } catch (e) { const x = e as { code?: string; message?: string }; return { code: String(x.code), message: String(x.message) }; }
  throw new Error("expected a refusal, but the call succeeded");
}

/** An organization with a driver (also holding Safety, the self-verify shape), an office clerk, two Safety reviewers and a dispatcher. */
async function company() {
  const orgRef = await org();
  const driver = await member(orgRef, ["driver", "safety"]);
  const office = await member(orgRef, ["office"]);
  const safety = await member(orgRef, ["safety"]);
  const safety2 = await member(orgRef, ["safety"]);
  const dispatcher = await member(orgRef, ["dispatcher"]);
  const operatorId = await operator(orgRef, driver);
  return { orgRef, driver, office, safety, safety2, dispatcher, operatorId };
}

/** The three procedures that decide a credential, by the same arguments. */
const PATHS = {
  compliance: (u: number, id: number, outcome: "verified" | "rejected") => as(u).compliance.credentialVerify({ credentialId: id, outcome }),
  documents: (u: number, id: number, outcome: "verified" | "rejected") => as(u).fieldRoute.identity.documents.review({ id, status: outcome }),
  portfolio: (u: number, id: number, outcome: "verified" | "rejected") => as(u).driverPortfolio.credentialVerify({ credentialId: id, outcome }),
} as const;

d("one verification door: separation of duties on every path", () => {
  it("the driver cannot verify their own credential through any path", async () => {
    const c = await company();
    const { credentialId } = await as(c.driver).driverPortfolio.submitCredential({ code: "h2s_alive", identifier: "H2S-SELF-1", expiresAt: days(300) });
    expect((await row(credentialId)).recordedByUserId).toBe(c.driver);
    for (const [name, call] of Object.entries(PATHS)) {
      expect(await refusal(call(c.driver, credentialId, "verified")), name).toMatchObject({ code: "FORBIDDEN" });
    }
    expect((await row(credentialId)).verificationStatus).toBe("needs_review");
    expect(await decisions(credentialId)).toEqual([]);
  });

  it("whoever recorded a credential cannot verify it through any path; a different reviewer can", async () => {
    const c = await company();
    const office2 = await member(c.orgRef, ["office"]);
    const rec = await as(c.office).compliance.credentialRecord({ ownerType: "operator", ownerId: c.operatorId, docType: "h2s_alive", title: "H2S", identifier: "H2S-REC-42", expiresAt: days(300) });
    expect((await row(rec.credentialId)).recordedByUserId).toBe(c.office);
    // The office clerk holds compliance.credential.verify too: the permission is not the question.
    expect(await refusal(PATHS.compliance(c.office, rec.credentialId, "verified"))).toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/recorded or submitted/) });
    // A Safety reviewer who also entered a document through documents.create is refused the same way.
    const doc = await as(c.safety).fieldRoute.identity.documents.create({ ownerType: "operator", ownerId: c.operatorId, docType: "whmis", title: "WHMIS", capturedAt: new Date(), expiresAt: days(300) } as never);
    const docId = Number(doc);
    expect((await row(docId)).recordedByUserId).toBe(c.safety);
    for (const [name, call] of Object.entries(PATHS)) {
      expect(await refusal(call(c.safety, docId, "verified")), name).toMatchObject({ code: "FORBIDDEN" });
    }
    // A different authorized person decides each.
    await PATHS.compliance(office2, rec.credentialId, "verified");
    expect(await row(rec.credentialId)).toMatchObject({ verificationStatus: "verified", verifiedByUserId: office2 });
    await PATHS.portfolio(c.safety2, docId, "verified");
    expect(await row(docId)).toMatchObject({ verificationStatus: "verified", verifiedByUserId: c.safety2 });
  });

  it("an unauthorized role cannot verify, and another organization's reviewer finds nothing", async () => {
    const c = await company();
    const other = await company();
    const { credentialId } = await as(c.driver).driverPortfolio.submitCredential({ code: "whmis", expiresAt: days(300) });
    // Permission: a dispatcher has no verify permission at all.
    expect(await refusal(PATHS.compliance(c.dispatcher, credentialId, "verified"))).toMatchObject({ code: "FORBIDDEN" });
    // Tenancy: org B's Safety gets "not found" on every path, the same answer as a missing id.
    expect(await refusal(PATHS.compliance(other.safety, credentialId, "verified"))).toMatchObject({ code: "NOT_FOUND" });
    expect(await refusal(PATHS.documents(other.safety, credentialId, "verified"))).toMatchObject({ code: "NOT_FOUND", message: `Document ${credentialId} not found` });
    expect(await refusal(PATHS.portfolio(other.safety, credentialId, "verified"))).toMatchObject({ code: "NOT_FOUND" });
    expect(await refusal(PATHS.compliance(other.safety, 2_000_000_000, "verified"))).toMatchObject({ code: "NOT_FOUND" });
    expect((await row(credentialId)).verificationStatus).toBe("needs_review");
  });
});

d("one verification door: the state machine", () => {
  it("a rejected credential is never flipped to verified; resubmission is a new version that can be reviewed", async () => {
    const c = await company();
    const { credentialId } = await as(c.driver).driverPortfolio.submitCredential({ code: "first_aid_cpr", expiresAt: days(300) });
    await PATHS.compliance(c.safety, credentialId, "rejected");
    for (const [name, call] of Object.entries(PATHS)) {
      expect(await refusal(call(c.safety2, credentialId, "verified")), name).toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/submits it again/) });
      expect(await refusal(call(c.safety2, credentialId, "rejected")), name).toMatchObject({ code: "PRECONDITION_FAILED" });
    }
    expect((await row(credentialId)).verificationStatus).toBe("rejected");
    // Resubmission: the driver uploads it again — a new row awaiting review — and a reviewer decides that one.
    const again = await as(c.driver).driverPortfolio.submitCredential({ code: "first_aid_cpr", expiresAt: days(300) });
    expect((await row(again.credentialId)).verificationStatus).toBe("needs_review");
    await PATHS.documents(c.safety2, again.credentialId, "verified");
    expect((await row(again.credentialId)).verificationStatus).toBe("verified");
    expect((await row(credentialId)).verificationStatus).toBe("rejected");   // the rejection stays on the record
    // And a verified credential is not decided again either.
    expect(await refusal(PATHS.compliance(c.safety, again.credentialId, "rejected"))).toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringMatching(/already verified/) });
  });

  it("two reviewers deciding at once through different paths: exactly one decision lands, one audit row", async () => {
    const c = await company();
    for (let round = 0; round < 3; round++) {
      const { credentialId } = await as(c.driver).driverPortfolio.submitCredential({ code: "whmis", expiresAt: days(300) });
      const settled = await Promise.allSettled([
        PATHS.compliance(c.safety, credentialId, "verified"),
        PATHS.portfolio(c.safety2, credentialId, "rejected"),
        PATHS.documents(c.office, credentialId, "verified"),
      ]);
      expect(settled.filter(s => s.status === "fulfilled"), `round ${round}`).toHaveLength(1);
      for (const s of settled.filter((x): x is PromiseRejectedResult => x.status === "rejected")) expect(s.reason).toMatchObject({ code: "PRECONDITION_FAILED" });
      const ev = await decisions(credentialId);
      expect(ev).toHaveLength(1);
      const final = await row(credentialId);
      expect(ev[0]!.eventType).toBe(final.verificationStatus === "verified" ? "credential_verified" : "credential_rejected");
      expect(ev[0]!.actorUserId).toBe(final.verifiedByUserId);
    }
  });

  it("every path writes the same audit row, naming the reviewer and the path, never the document's identifier", async () => {
    const c = await company();
    const ids: Record<string, number> = {};
    for (const name of Object.keys(PATHS)) {
      ids[name] = (await as(c.driver).driverPortfolio.submitCredential({ code: "tdg_certificate", identifier: `SECRET-CERT-${name}`, expiresAt: days(300) })).credentialId;
    }
    await PATHS.compliance(c.safety, ids.compliance!, "verified");
    await PATHS.documents(c.safety, ids.documents!, "verified");
    await PATHS.portfolio(c.safety, ids.portfolio!, "verified");
    const paths = { compliance: "compliance.credentialVerify", documents: "documents.review", portfolio: "driverPortfolio.credentialVerify" } as const;
    for (const [name, id] of Object.entries(ids)) {
      const ev = await decisions(id);
      expect(ev, name).toHaveLength(1);
      expect(ev[0]).toMatchObject({ eventType: "credential_verified", actorUserId: c.safety });
      expect(String(ev[0]!.detail)).toContain(`via ${paths[name as keyof typeof paths]}`);
      expect(String(ev[0]!.detail)).not.toContain("SECRET-CERT");
    }
  });
});

d("historical credentials with no recorder on file", () => {
  it("are never back-filled: the subject is still refused, and another reviewer may decide them", async () => {
    const c = await company();
    const [r] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO complianceDocuments (ownerType, ownerId, docType, title, capturedAt, expiresAt, verificationStatus, createdAt) VALUES ('operator', ?, 'whmis', 'WHMIS (legacy)', NOW(), ?, 'needs_review', NOW())",
      [c.operatorId, days(300)]);
    const id = Number(r.insertId);
    expect((await row(id)).recordedByUserId).toBeNull();
    expect(await refusal(PATHS.compliance(c.driver, id, "verified"))).toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/your own credential/) });
    await PATHS.compliance(c.safety, id, "verified");
    expect(await row(id)).toMatchObject({ verificationStatus: "verified", verifiedByUserId: c.safety, recordedByUserId: null });
  });
});

d("credentials minted verified by training and onboarding follow the same rule", () => {
  it("the person trained may not verify their own training, nor may its recorder; another verifier can", async () => {
    const orgRef = await org();
    const trainee = await member(orgRef, ["hr"]);
    const recorder = await member(orgRef, ["hr"]);
    const verifier = await member(orgRef, ["hr"]);
    const [ev] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO evidenceRecords (title, category, capturedAt, capturedBy) VALUES ('TDG card', 'training', NOW(), ?)", [recorder]);
    const trn = await as(recorder).workforce.trainingRecord({ userId: trainee, courseCode: "TDG_GROUND", title: "TDG Ground", completedAt: new Date(), evidenceRecordId: Number(ev.insertId) } as never);
    expect(await refusal(as(trainee).workforce.trainingVerify({ trainingRef: trn.trainingRef, decision: "verified" } as never))).toMatchObject({ code: "FORBIDDEN", message: expect.stringMatching(/your own credential/) });
    expect(await refusal(as(recorder).workforce.trainingVerify({ trainingRef: trn.trainingRef, decision: "verified" } as never))).toMatchObject({ code: "FORBIDDEN" });
    const ok = await as(verifier).workforce.trainingVerify({ trainingRef: trn.trainingRef, decision: "verified" } as never) as { complianceDocumentId: number | null };
    if (ok.complianceDocumentId) expect(await row(ok.complianceDocumentId)).toMatchObject({ verificationStatus: "verified", verifiedByUserId: verifier, recordedByUserId: recorder });
  });
});
