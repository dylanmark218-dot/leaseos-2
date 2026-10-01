/**
 * Sign & Attest, SA1 — against a real database, through the router.
 *
 * What is proven here, in the design's own words (docs/sign-attest/SIGN_ATTEST_DESIGN.md §15):
 * tenant isolation and cross-organization refusal; signer impersonation and wrong-signer refusal;
 * revision mismatch; the mark bound to the revision hash; the finalized revision and the event trail
 * immutable at the database; supersede instead of edit; required and optional fields; seven initials
 * and three roles on one document; device attestation in both directions with a real P-256 key;
 * idempotent resubmission; concurrent finalization; export authorization; and the closeout producer.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { createHash, generateKeyPairSync, sign as cryptoSign } from "node:crypto";
import { appRouter } from "./routers";
import { CONSENT_VERSION_V1, CONSENT_TEXT_V1 } from "../shared/attest";
import { markPayloadHash, sessionPayloadBytes } from "./_core/attest/attestPayload";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 291_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 6 }); });
afterAll(async () => { await pool?.end(); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });
const portalCaller = (token: string) => appRouter.createCaller({ req: { headers: { "x-portal-token": token } } as never, res: {} as never, user: null as never });

async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
async function member(orgRef: string | null, roles: string[]) {
  const userId = seq++;
  if (orgRef) await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
async function jobOwnedBy(orgRef: string | null) {
  const [j] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, customer, location, status, orgRef) VALUES (?,?,?,?,'dispatched',?)", [`JOB-${rnd()}`, "Hydrovac", "Fixture Energy", "10-22-045-06-W5", orgRef]);
  return j.insertId;
}
/** A sealed evidence record on an organization's job: the simplest signable subject. Returns its id and seal hash. */
async function sealedEvidence(orgRef: string | null, bytes = `scan-${rnd()}`) {
  const jobId = await jobOwnedBy(orgRef);
  const contentHash = sha(bytes);
  const [e] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO evidenceRecords (jobId, title, category, mimeType, capturedAt, capturedBy, status, trackingNumber, recordType, sealState, currentVersion) VALUES (?,?,?,?,NOW(),1,'verified',?,'disposal_ticket','sealed',1)", [jobId, "Facility ticket 773621", "disposal", "image/jpeg", `EV-${rnd()}`]);
  await pool.execute("INSERT INTO evidenceSeals (evidenceRecordId, version, canonicalManifest, contentHash, manifestHash, sealedAt, sealedByUserId, verificationResult) VALUES (?,1,'{}',?,?,NOW(),1,'verified')", [e.insertId, contentHash, sha(`manifest-${contentHash}`)]);
  return { evidenceId: e.insertId, contentHash, jobId, subjectRef: `evidence:${e.insertId}` };
}
const box = (i: number) => ({ page: 1, xFrac: 0.1, yFrac: 0.05 + i * 0.1, widthFrac: 0.3, heightFrac: 0.06 });
const ack = (fieldKey: string) => ({ fieldKey, markKind: "electronic_ack" as const, inputKind: "none" as const });
async function rows<T extends mysql.RowDataPacket = mysql.RowDataPacket>(sql: string, params: (string | number | null)[] = []) { const [r] = await pool.execute<T[]>(sql, params); return r; }

d("tenant isolation — a signing revision belongs to the organization that owns its subject", () => {
  it("answers not-found to another organization and to the single tenant, lists nothing of theirs, and refuses to open their evidence", async () => {
    const A = await org(), B = await org();
    const officeA = await member(A, ["office"]), officeB = await member(B, ["office"]), legacy = await member(null, ["office"]);
    const ev = await sealedEvidence(A);
    const opened = await callerFor(officeA).attest.open({ subjectType: "evidence_record", subjectRef: ev.subjectRef, fields: [{ fieldKey: "sig", fieldType: "signature", ...box(0), signerRole: "consultant" }] });
    expect(opened.revisionHash).toBe(ev.contentHash);
    expect(opened.instanceRef).toMatch(/^EV-/);
    await expect(callerFor(officeB).attest.view({ revisionRef: opened.revisionRef })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(legacy).attest.view({ revisionRef: opened.revisionRef })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(officeB).attest.open({ subjectType: "evidence_record", subjectRef: ev.subjectRef })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(officeB).attest.finalize({ revisionRef: opened.revisionRef })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(callerFor(officeB).attest.void({ revisionRef: opened.revisionRef, reason: "not my document at all" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await callerFor(officeB).attest.list()).some(r => r.revisionRef === opened.revisionRef)).toBe(false);
    expect((await callerFor(officeA).attest.list()).some(r => r.revisionRef === opened.revisionRef)).toBe(true);
    // The subject's organization is derived from the job, never from the request: B's evidence under A's book is not found either.
    const evB = await sealedEvidence(B);
    await expect(callerFor(officeA).attest.open({ subjectType: "evidence_record", subjectRef: evB.subjectRef })).rejects.toMatchObject({ code: "NOT_FOUND" });
  }, 60_000);
});

d("who may sign — the signer row names the person, and nobody signs for somebody else", () => {
  it("refuses another user, records the attempt as a rejected session with a code, and leaves the field pending", async () => {
    const A = await org();
    const office = await member(A, ["office"]), driver1 = await member(A, ["driver"]), driver2 = await member(A, ["driver"]);
    const ev = await sealedEvidence(A);
    const opened = await callerFor(office).attest.open({ subjectType: "evidence_record", subjectRef: ev.subjectRef, fields: [{ fieldKey: "sig", fieldType: "signature", ...box(0), signerRole: "driver" }], signers: [{ partyKind: "internal_user", userId: driver1, displayName: "Driver One", signerRole: "driver", fieldKeys: ["sig"] }] });
    const signerRef = opened.signers[0]!.signerRef;
    await expect(callerFor(driver2).attest.sign({ revisionRef: opened.revisionRef, signerRef, revisionHashAtStart: opened.revisionHash, marks: [ack("sig")] })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("WRONG_SIGNER") });
    // The office holds every attest permission except signing for others: it cannot use the universal sign on a field that is not its own either.
    await expect(callerFor(office).attest.sign({ revisionRef: opened.revisionRef, signerRef, revisionHashAtStart: opened.revisionHash, marks: [ack("sig")] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const sessions = await rows("SELECT s.state, s.rejectionCode, s.actorUserId FROM attestSigningSessions s JOIN attestDocumentRevisions r ON r.id = s.revisionId WHERE r.revisionRef = ? ORDER BY s.id", [opened.revisionRef]);
    expect(sessions.map(s => [s.state, s.rejectionCode, Number(s.actorUserId)])).toEqual([["rejected", "WRONG_SIGNER", driver2], ["rejected", "WRONG_SIGNER", office]]);
    const view = await callerFor(office).attest.view({ revisionRef: opened.revisionRef });
    expect(view.fields[0]!.state).toBe("pending");
    expect(view.events.filter(e => e.eventType === "signing_rejected")).toHaveLength(2);
    // A stale copy: the hash the device opened is not the revision's hash.
    await expect(callerFor(driver1).attest.sign({ revisionRef: opened.revisionRef, signerRef, revisionHashAtStart: "0".repeat(64), marks: [ack("sig")] })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("REVISION_MISMATCH") });
    // A drawn mark with no sealed stroke record is the label this subsystem ends.
    await expect(callerFor(driver1).attest.sign({ revisionRef: opened.revisionRef, signerRef, revisionHashAtStart: opened.revisionHash, marks: [{ fieldKey: "sig", markKind: "drawn", inputKind: "pen" }] })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("MARK_NOT_SEALED") });
    // The right person, the right hash: the mark is bound to the revision hash and the payload hash recomputes from the rows.
    const signed = await callerFor(driver1).attest.sign({ revisionRef: opened.revisionRef, signerRef, revisionHashAtStart: opened.revisionHash, marks: [ack("sig")] });
    expect(signed).toMatchObject({ state: "completed", alreadyRecorded: false, revisionState: "completed", signerState: "completed" });
    const [m] = await rows("SELECT m.payloadHash, m.completedAt, f.fieldRef, f.fieldKey, f.fieldType FROM attestMarks m JOIN attestFields f ON f.id = m.fieldId WHERE m.markRef = ?", [signed.marks[0]!.markRef]);
    const recomputed = markPayloadHash({ revisionRef: opened.revisionRef, revisionHash: opened.revisionHash, instanceRef: opened.instanceRef, fieldRef: m!.fieldRef, fieldKey: m!.fieldKey, fieldType: m!.fieldType, signerRef, signerIdentity: `user:${driver1}`, markKind: "electronic_ack", strokeHash: null, renderedHash: null, valueText: null, consentTextHash: sha(CONSENT_TEXT_V1), completedAt: new Date(m!.completedAt) });
    expect(recomputed).toBe(m!.payloadHash);
    // Signing it again is a second completion: refused, and the attempt is a row.
    await expect(callerFor(driver1).attest.sign({ revisionRef: opened.revisionRef, signerRef, revisionHashAtStart: opened.revisionHash, marks: [ack("sig")] })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("FIELD_ALREADY_COMPLETED") });
    // The same submission retried with its own sessionRef is one act.
    const ev2 = await sealedEvidence(A);
    const o2 = await callerFor(office).attest.open({ subjectType: "evidence_record", subjectRef: ev2.subjectRef, fields: [{ fieldKey: "sig", fieldType: "signature", ...box(0), signerRole: "driver" }], signers: [{ partyKind: "internal_user", userId: driver1, displayName: "Driver One", signerRole: "driver", fieldKeys: ["sig"] }] });
    const sessionRef = `retry-${rnd()}-${rnd()}`;
    const first = await callerFor(driver1).attest.sign({ revisionRef: o2.revisionRef, signerRef: o2.signers[0]!.signerRef, revisionHashAtStart: o2.revisionHash, marks: [ack("sig")], sessionRef });
    const again = await callerFor(driver1).attest.sign({ revisionRef: o2.revisionRef, signerRef: o2.signers[0]!.signerRef, revisionHashAtStart: o2.revisionHash, marks: [ack("sig")], sessionRef });
    expect(again).toMatchObject({ sessionRef, alreadyRecorded: true, marks: first.marks });
    expect(Number((await rows("SELECT COUNT(*) AS n FROM attestSigningSessions WHERE sessionRef = ?", [sessionRef]))[0]!.n)).toBe(1);
  }, 90_000);
});

d("seven initials, three roles, one document — and what the database refuses afterwards", () => {
  it("completes, finalizes with optional fields pending, proves the acknowledged lines, and keeps the finalized revision and its trail immutable", async () => {
    const A = await org();
    const office = await member(A, ["office"]), office2 = await member(A, ["office"]), driver = await member(A, ["driver"]), supervisor = await member(A, ["safety"]), auditor = await member(A, ["auditor"]);
    const ev = await sealedEvidence(A);
    const lines = [1, 2, 3, 4, 5, 6, 7];
    const opened = await callerFor(office).attest.open({
      subjectType: "evidence_record", subjectRef: ev.subjectRef, pageCount: 2,
      fields: [
        ...lines.map(i => ({ fieldKey: `line_${i}`, fieldType: "initials" as const, ...box(i - 1), signerRole: "consultant", subjectLineRef: `FTL-${i}` })),
        { fieldKey: "consultant_sig", fieldType: "signature", page: 2, xFrac: 0.1, yFrac: 0.8, widthFrac: 0.4, heightFrac: 0.08, signerRole: "consultant" },
        { fieldKey: "driver_sig", fieldType: "signature", page: 2, xFrac: 0.55, yFrac: 0.8, widthFrac: 0.4, heightFrac: 0.08, signerRole: "driver" },
        { fieldKey: "supervisor_ok", fieldType: "approval", page: 2, xFrac: 0.1, yFrac: 0.9, widthFrac: 0.2, heightFrac: 0.05, signerRole: "supervisor" },
        { fieldKey: "supervisor_note", fieldType: "comment", page: 2, xFrac: 0.4, yFrac: 0.9, widthFrac: 0.5, heightFrac: 0.05, signerRole: "supervisor", required: false },
      ],
      signers: [
        { partyKind: "named_witnessed", displayName: "M. Johnson", company: "ABC Energy", signerRole: "consultant", fieldKeys: [...lines.map(i => `line_${i}`), "consultant_sig"] },
        { partyKind: "internal_user", userId: driver, displayName: "Driver", signerRole: "driver", fieldKeys: ["driver_sig"] },
        { partyKind: "internal_user", userId: supervisor, displayName: "Supervisor", signerRole: "supervisor", fieldKeys: ["supervisor_ok", "supervisor_note"] },
      ],
    });
    const [consultant, driverSigner, supSigner] = opened.signers.map(s => s.signerRef) as [string, string, string];
    // The driver cannot witness the consultant's fields through the universal sign, and a driver may not sign the supervisor's approval.
    await expect(callerFor(driver).attest.sign({ revisionRef: opened.revisionRef, signerRef: consultant, revisionHashAtStart: opened.revisionHash, marks: [ack("line_1")] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(driver).attest.sign({ revisionRef: opened.revisionRef, signerRef: supSigner, revisionHashAtStart: opened.revisionHash, marks: [{ fieldKey: "supervisor_ok", markKind: "approval", inputKind: "mouse", valueText: "approved" }] })).rejects.toMatchObject({ code: "FORBIDDEN" });
    // Finalizing early names what is missing.
    await expect(callerFor(office).attest.finalize({ revisionRef: opened.revisionRef })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("line_1") });
    // The driver witnesses the consultant: seven initials and the signature, one session.
    const witnessed = await callerFor(driver).attest.witness({ revisionRef: opened.revisionRef, signerRef: consultant, revisionHashAtStart: opened.revisionHash, marks: [...lines.map(i => ({ fieldKey: `line_${i}`, markKind: "electronic_ack" as const, inputKind: "touch" as const })), { fieldKey: "consultant_sig", markKind: "electronic_ack", inputKind: "touch" }] });
    expect(witnessed.marks).toHaveLength(8);
    expect(witnessed.signerState).toBe("completed");
    expect(witnessed.revisionState).toBe("open");
    await callerFor(driver).attest.sign({ revisionRef: opened.revisionRef, signerRef: driverSigner, revisionHashAtStart: opened.revisionHash, marks: [ack("driver_sig")] });
    const sup = await callerFor(supervisor).attest.sign({ revisionRef: opened.revisionRef, signerRef: supSigner, revisionHashAtStart: opened.revisionHash, marks: [{ fieldKey: "supervisor_ok", markKind: "approval", inputKind: "mouse", valueText: "approved" }] });
    expect(sup.revisionState).toBe("completed");   // the optional comment stays pending
    const view = await callerFor(office).attest.view({ revisionRef: opened.revisionRef });
    expect(view.events.filter(e => e.eventType === "field_initialed")).toHaveLength(7);
    expect(view.events.map(e => e.eventType)).toContain("document_completed");
    // Finalize: once, idempotently, and concurrently by two people yields one artifact.
    const [f1, f2] = await Promise.all([callerFor(office).attest.finalize({ revisionRef: opened.revisionRef }), callerFor(office2).attest.finalize({ revisionRef: opened.revisionRef })]);
    expect([f1.alreadyFinalized, f2.alreadyFinalized].sort()).toEqual([false, true]);
    expect(f1.artifactRef).toBe(f2.artifactRef);
    expect(Number((await rows("SELECT COUNT(*) AS n FROM attestArtifacts a JOIN attestDocumentRevisions r ON r.id = a.revisionId WHERE r.revisionRef = ?", [opened.revisionRef]))[0]!.n)).toBe(1);
    // The proof billing reads: seven lines acknowledged by the consultant on this hash, witnessed.
    const proof = await callerFor(office).attest.proof({ subjectType: "evidence_record", subjectRef: `evidence:${ev.evidenceId}:v1` });
    expect(proof).toMatchObject({ state: "finalized", revisionHash: ev.contentHash, receiptHash: f1.receiptHash });
    expect(proof!.acknowledgedLines.map(l => l.subjectLineRef).sort()).toEqual(lines.map(i => `FTL-${i}`));
    expect(new Set(proof!.acknowledgedLines.map(l => l.signerRef))).toEqual(new Set([consultant]));
    expect(proof!.signatures.find(s => s.fieldKey === "consultant_sig")!.authMethod).toBe("witnessed");
    expect(proof!.signatures.find(s => s.fieldKey === "driver_sig")!.authMethod).toBe("session_login");
    // The receipt lists the optional field left pending; verify walks the chain and recomputes the receipt.
    const receipt = JSON.parse((await callerFor(office).attest.exportReceipt({ revisionRef: opened.revisionRef })).manifestJson);
    expect(receipt.notCompletedOptional).toEqual([view.fields.find(f => f.fieldKey === "supervisor_note")!.fieldRef]);
    expect(JSON.stringify(receipt)).not.toMatch(/@/);
    await expect(callerFor(driver).attest.exportReceipt({ revisionRef: opened.revisionRef })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const verified = await callerFor(auditor).attest.verify({ revisionRef: opened.revisionRef });
    expect(verified).toMatchObject({ verified: true, chain: { ok: true }, receipt: { matches: true }, head: { matches: true } });
    // The database refuses an edit to the finalized revision, and any edit or deletion of the trail.
    await expect(pool.execute("UPDATE attestDocumentRevisions SET revisionHash = ? WHERE revisionRef = ?", ["0".repeat(64), opened.revisionRef])).rejects.toMatchObject({ sqlState: "45000" });
    await expect(pool.execute("UPDATE attestDocumentRevisions SET state = 'open' WHERE revisionRef = ?", [opened.revisionRef])).rejects.toMatchObject({ sqlState: "45000" });
    await expect(pool.execute("UPDATE attestEvents SET detailJson = '{}' WHERE revisionId = (SELECT id FROM attestDocumentRevisions WHERE revisionRef = ?) LIMIT 1", [opened.revisionRef])).rejects.toMatchObject({ sqlState: "45000" });
    await expect(pool.execute("DELETE FROM attestEvents WHERE revisionId = (SELECT id FROM attestDocumentRevisions WHERE revisionRef = ?) LIMIT 1", [opened.revisionRef])).rejects.toMatchObject({ sqlState: "45000" });
    // Nothing more may be signed on it; a void is refused; a second revision cannot be opened on the same hash.
    await expect(callerFor(supervisor).attest.sign({ revisionRef: opened.revisionRef, signerRef: supSigner, revisionHashAtStart: opened.revisionHash, marks: [{ fieldKey: "supervisor_note", markKind: "comment", inputKind: "keyboard", valueText: "late" }] })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("DOCUMENT_FINALIZED") });
    await expect(callerFor(office).attest.void({ revisionRef: opened.revisionRef, reason: "trying to void a finalized document" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(callerFor(office).attest.open({ subjectType: "evidence_record", subjectRef: ev.subjectRef })).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining("superseding") });
    // Supersede: the finalizer may not; a second person may, but only with a changed document; the old row is untouched byte for byte.
    const before = (await rows("SELECT revisionHash, receiptHash, eventChainHead, finalizedAt FROM attestDocumentRevisions WHERE revisionRef = ?", [opened.revisionRef]))[0]!;
    await expect(callerFor(office).attest.supersede({ revisionRef: opened.revisionRef, reason: "corrected the facility ticket number" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callerFor(office2).attest.supersede({ revisionRef: opened.revisionRef, reason: "corrected the facility ticket number" })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("Nothing changed") });
    const v2Hash = sha(`rescan-${rnd()}`);
    await pool.execute("UPDATE evidenceRecords SET currentVersion = 2, sealState = 'amended' WHERE id = ?", [ev.evidenceId]);
    await pool.execute("INSERT INTO evidenceSeals (evidenceRecordId, version, canonicalManifest, contentHash, manifestHash, sealedAt, sealedByUserId, verificationResult) VALUES (?,2,'{}',?,?,NOW(),1,'verified')", [ev.evidenceId, v2Hash, sha(`m-${v2Hash}`)]);
    const next = await callerFor(office2).attest.supersede({ revisionRef: opened.revisionRef, reason: "corrected the facility ticket number" });
    expect(next).toMatchObject({ revision: 2, revisionHash: v2Hash, state: "open", supersedes: opened.revisionRef });
    expect(next.fields.map(f => f.fieldKey).sort()).toEqual(view.fields.map(f => f.fieldKey).sort());
    expect(next.signers).toHaveLength(3);
    const after = (await rows("SELECT state, revisionHash, receiptHash, eventChainHead, finalizedAt, supersededByRevisionId FROM attestDocumentRevisions WHERE revisionRef = ?", [opened.revisionRef]))[0]!;
    expect(after.state).toBe("superseded");
    expect([after.revisionHash, after.receiptHash, after.eventChainHead, String(after.finalizedAt)]).toEqual([before.revisionHash, before.receiptHash, before.eventChainHead, String(before.finalizedAt)]);
    expect(after.supersededByRevisionId).not.toBeNull();
    expect(Number((await rows("SELECT COUNT(*) AS n FROM attestMarks m JOIN attestSigningSessions s ON s.id = m.sessionId JOIN attestDocumentRevisions r ON r.id = s.revisionId WHERE r.revisionRef = ?", [next.revisionRef]))[0]!.n)).toBe(0);
    // Voiding an open revision; then nothing may be signed on it.
    const voided = await callerFor(office2).attest.void({ revisionRef: next.revisionRef, reason: "rescanned a third time" });
    expect(voided.state).toBe("voided");
    await expect(callerFor(driver).attest.sign({ revisionRef: next.revisionRef, signerRef: next.signers.find(s => s.displayName === "Driver")!.signerRef, revisionHashAtStart: v2Hash, marks: [ack("driver_sig")] })).rejects.toMatchObject({ code: "PRECONDITION_FAILED", message: expect.stringContaining("DOCUMENT_VOIDED") });
  }, 120_000);
});

d("device attestation — a device_auth session proves the device, in both directions", () => {
  it("refuses a claim without proof and a proof under another method, accepts a real P-256 signature over the session payload, and refuses a tampered one", async () => {
    const A = await org();
    const office = await member(A, ["office"]), driver = await member(A, ["driver"]);
    const ev = await sealedEvidence(A);
    const opened = await callerFor(office).attest.open({ subjectType: "evidence_record", subjectRef: ev.subjectRef, fields: [{ fieldKey: "sig", fieldType: "signature", ...box(0), signerRole: "driver" }], signers: [{ partyKind: "internal_user", userId: driver, displayName: "Driver", signerRole: "driver", requiredAuth: "device_auth", fieldKeys: ["sig"] }] });
    const signerRef = opened.signers[0]!.signerRef;
    // A login is not enough for a signer who must prove a device.
    await expect(callerFor(driver).attest.sign({ revisionRef: opened.revisionRef, signerRef, revisionHashAtStart: opened.revisionHash, marks: [ack("sig")] })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("AUTH_METHOD_INSUFFICIENT") });
    await expect(callerFor(driver).attest.sign({ revisionRef: opened.revisionRef, signerRef, revisionHashAtStart: opened.revisionHash, authMethod: "device_auth", marks: [ack("sig")] })).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("attestation") });
    const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
    const keyFingerprint = createHash("sha256").update(spki).digest("hex");
    const deviceRef = `DEV-${rnd()}`;
    await pool.execute("INSERT INTO fieldDevices (deviceRef, userId, orgRef, platform, keyFingerprint, publicKeySpkiBase64, keystoreAttestation, status, enrolledAt, enrolledByUserId, activatedAt) VALUES (?,?,?,'android',?,?,'hardware','active',NOW(),?,NOW())", [deviceRef, driver, A, keyFingerprint, spki.toString("base64"), office]);
    const signedAt = new Date();
    const sessionRef = `${deviceRef}:${rnd()}`;
    const payload = sessionPayloadBytes({ sessionRef, revisionRef: opened.revisionRef, revisionHash: opened.revisionHash, signerRef, marks: [{ fieldKey: "sig", markKind: "electronic_ack", strokeHash: null, renderedHash: null, valueText: null }], consentTextHash: sha(CONSENT_TEXT_V1), signedAt });
    const signature = cryptoSign("sha256", payload, { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64");
    const attestation = { deviceRef, keyFingerprint, signatureP1363Base64: signature, signedAt };
    await expect(callerFor(driver).attest.sign({ revisionRef: opened.revisionRef, signerRef, revisionHashAtStart: opened.revisionHash, marks: [ack("sig")], deviceAttestation: attestation })).rejects.toMatchObject({ code: "BAD_REQUEST" });   // a proof under session_login is misfiled
    // The payload the device signed is not the payload submitted (a different session ref): refused, and the refusal is a row under ITS ref.
    const tamperedRef = `${sessionRef}-tampered`;
    await expect(callerFor(driver).attest.sign({ revisionRef: opened.revisionRef, signerRef, revisionHashAtStart: opened.revisionHash, authMethod: "device_auth", sessionRef: tamperedRef, marks: [ack("sig")], deviceAttestation: attestation })).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("SIGNATURE_INVALID") });
    expect((await rows("SELECT state, rejectionCode FROM attestSigningSessions WHERE sessionRef = ?", [tamperedRef]))[0]).toMatchObject({ state: "rejected", rejectionCode: "SIGNATURE_INVALID" });
    const ok = await callerFor(driver).attest.sign({ revisionRef: opened.revisionRef, signerRef, revisionHashAtStart: opened.revisionHash, authMethod: "device_auth", sessionRef, marks: [ack("sig")], deviceAttestation: attestation });
    expect(ok).toMatchObject({ sessionRef, state: "completed", revisionState: "completed" });
    const [s] = await rows("SELECT authMethod, deviceRef, keyFingerprint, fieldDeviceId FROM attestSigningSessions WHERE sessionRef = ?", [sessionRef]);
    expect(s).toMatchObject({ authMethod: "device_auth", deviceRef, keyFingerprint });
    expect(s!.fieldDeviceId).not.toBeNull();
  }, 60_000);
});

d("the portal — a customer identity signs its own field and nobody else's", () => {
  it("lists and views only revisions that name the identity, signs its own field, and is refused on another identity's field", async () => {
    const A = await org();
    const office = await member(A, ["office"]), controller = await member(A, ["controller"]);
    // The book belongs to A (financialEntities.orgRef): that is what lets A's controller invite a customer identity on it.
    const entityId = Number((await pool.execute<mysql.ResultSetHeader>("INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction, orgRef) VALUES (?, 'Fixture Books Ltd.', 'corporation', 'CA-AB', ?)", [`FE-${rnd()}`, A]))[0].insertId);
    const acctRef = `CUST-${rnd()}`;
    await pool.execute("INSERT INTO customerAccounts (accountRef, financialEntityId, name, orgRef) VALUES (?, ?, 'ABC Energy', ?)", [acctRef, entityId, A]);
    const inv1 = await callerFor(controller).portalAdmin.identityInvite({ kind: "customer", accountRef: acctRef, email: `mj-${rnd()}@abc.example`, displayName: "M. Johnson" });
    const tok1 = (await portalCaller(inv1.invitationToken).portal.invitationAccept()).token;
    const inv2 = await callerFor(controller).portalAdmin.identityInvite({ kind: "customer", accountRef: acctRef, email: `kb-${rnd()}@abc.example`, displayName: "K. Brown" });
    const tok2 = (await portalCaller(inv2.invitationToken).portal.invitationAccept()).token;
    const id1 = Number((await rows("SELECT id FROM externalIdentities WHERE identityRef = ?", [inv1.identityRef]))[0]!.id);
    const ev = await sealedEvidence(A);
    const opened = await callerFor(office).attest.open({ subjectType: "evidence_record", subjectRef: ev.subjectRef, fields: [{ fieldKey: "sig", fieldType: "signature", ...box(0), signerRole: "customer_representative" }], signers: [{ partyKind: "external_identity", externalIdentityId: id1, displayName: "M. Johnson", company: "ABC Energy", signerRole: "customer_representative", fieldKeys: ["sig"] }] });
    const signerRef = opened.signers[0]!.signerRef;
    expect((await portalCaller(tok1).portal.attestList()).map(r => r.revisionRef)).toContain(opened.revisionRef);
    expect((await portalCaller(tok2).portal.attestList()).map(r => r.revisionRef)).not.toContain(opened.revisionRef);
    await expect(portalCaller(tok2).portal.attestView({ revisionRef: opened.revisionRef })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(portalCaller(tok2).portal.attestSign({ revisionRef: opened.revisionRef, signerRef, revisionHashAtStart: opened.revisionHash, marks: [ack("sig")] })).rejects.toMatchObject({ code: "NOT_FOUND" });
    const view = await portalCaller(tok1).portal.attestView({ revisionRef: opened.revisionRef });
    expect(view.signers[0]!.externalIdentityId).toBeNull();   // the portal never sees account identifiers
    const signed = await portalCaller(tok1).portal.attestSign({ revisionRef: opened.revisionRef, signerRef, revisionHashAtStart: opened.revisionHash, marks: [ack("sig")] });
    expect(signed).toMatchObject({ state: "completed", revisionState: "completed" });
    const [s] = await rows("SELECT authMethod, actorExternalIdentityId FROM attestSigningSessions WHERE sessionRef = ?", [signed.sessionRef]);
    expect(s).toMatchObject({ authMethod: "portal_link", actorExternalIdentityId: id1 });
    expect((await rows("SELECT action, recordRef FROM externalAccessLog WHERE externalIdentityId = ? AND action = 'sign' ORDER BY id DESC LIMIT 1", [id1]))[0]).toMatchObject({ action: "sign", recordRef: opened.revisionRef });
  }, 90_000);
});
