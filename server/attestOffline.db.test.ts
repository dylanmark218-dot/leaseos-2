/**
 * Sign & Attest SA2 — the pad's output signed offline, synchronized through the real router.
 *
 * docs/sign-attest/SIGN_ATTEST_DESIGN.md §15, the rows SA1 left to SA2: offline signing, offline
 * synchronization, duplicate sync, conflicting offline signatures, voided while offline, device
 * revoked and clock wrong between capture and sync, a witnessed mark on the driver's tablet, the
 * caller who may not witness, and a device that lies about its render. The device side is the memory
 * runtime (the same runtime the field tests prove); the server side is `attest.submitSession`.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The object store is remote; here it keeps exactly the bytes it was given, so the server can read
// the sealed strokes back and recompute the render.
const objects = new Map<string, Buffer>();
vi.mock("./storage", () => ({
  storagePut: async (relKey: string, data: Buffer | Uint8Array | string) => { objects.set(relKey, Buffer.from(data as never)); return { key: relKey, url: `mem://${relKey}` }; },
  storageGet: async (relKey: string) => ({ key: relKey, url: `mem://${relKey}` }),
  storageGetSignedUrl: async (relKey: string) => `mem://${relKey}`,
  storageRead: async (relKey: string) => { const b = objects.get(relKey); if (!b) throw new Error(`no object ${relKey}`); return b; },
}));

import mysql from "mysql2/promise";
import { createHash } from "node:crypto";
import { appRouter } from "./routers";
import { FlagConnectivity, MemoryKeystore, MemoryStore, MemoryVault, SettableClock } from "../client/src/runtime/adapters/memory";
import { SyncEngine } from "../client/src/runtime/syncEngine";
import { AttestSigning } from "../client/src/runtime/attestSession";
import { StrokeCapture } from "../client/src/attest/strokeCapture";
import type { LocalSignableRevision, Transport } from "../client/src/runtime/contracts";
import { serializeStrokeDocument, type AttestSessionSubmitResponse } from "../shared/attest";
import { normaliseStrokeDocument, renderStrokeSvg } from "../shared/attestStrokes";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 293_000_000 + Math.floor(Math.random() * 50_000);
const rnd = () => Math.random().toString(36).slice(2, 9).toUpperCase();
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 6 }); });
afterAll(async () => { await pool?.end(); });
const callerFor = (userId: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: userId, role: "user" } as never });

async function org() { const orgRef = `ORG-${rnd()}`; await pool.execute("INSERT INTO organizations (orgRef, name, status) VALUES (?,?,'active')", [orgRef, `o ${orgRef}`]); return orgRef; }
async function member(orgRef: string, roles: string[]) {
  const userId = seq++;
  await pool.execute("INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId) VALUES (?,?,?,'employee','active','2020-01-01',1)", [`MEM-${rnd()}`, orgRef, userId]);
  for (const role of roles) await pool.execute("INSERT INTO userRoleAssignments (userId, role, scopeType, grantedByUserId, grantedAt) VALUES (?,?,'global',1,NOW())", [userId, role]);
  return userId;
}
async function sealedEvidence(orgRef: string) {
  const [j] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO jobs (jobCode, type, customer, location, status, orgRef) VALUES (?,?,?,?,'dispatched',?)", [`JOB-${rnd()}`, "Hydrovac", "Fixture Energy", "10-22-045-06-W5", orgRef]);
  const jobId = j.insertId;
  const contentHash = sha(`scan-${rnd()}`);
  const [e] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO evidenceRecords (jobId, title, category, mimeType, capturedAt, capturedBy, status, trackingNumber, recordType, sealState, currentVersion) VALUES (?,?,?,?,NOW(),1,'verified',?,'disposal_ticket','sealed',1)", [jobId, "Facility ticket 773621", "disposal", "image/jpeg", `EV-${rnd()}`]);
  await pool.execute("INSERT INTO evidenceSeals (evidenceRecordId, version, canonicalManifest, contentHash, manifestHash, sealedAt, sealedByUserId, verificationResult) VALUES (?,1,'{}',?,?,NOW(),1,'verified')", [e.insertId, contentHash, sha(`manifest-${contentHash}`)]);
  return { evidenceId: e.insertId, contentHash, jobId, subjectRef: `evidence:${e.insertId}` };
}
const box = (i: number) => ({ page: 1, xFrac: 0.1, yFrac: 0.05 + i * 0.1, widthFrac: 0.3, heightFrac: 0.06 });
async function rows<T extends mysql.RowDataPacket = mysql.RowDataPacket>(sql: string, params: (string | number | null)[] = []) { const [r] = await pool.execute<T[]>(sql, params); return r; }

/** The device talks to the real router. `beforeSubmit` is the hand that acts between the marks' arrival and the session's. */
function transportFor(userId: number, hooks: { beforeSubmit?: () => Promise<void>; dropSubmit?: boolean } = {}) {
  const c = callerFor(userId);
  const t = {
    lastEnvelope: null as Parameters<Transport["submitAttestSession"]>[0] | null,
    async enroll(i: Parameters<Transport["enroll"]>[0]) { const r = await c.device.enroll({ platform: i.platform, publicKeySpkiBase64: i.publicKeySpkiBase64, keystoreAttestation: i.keystoreAttestation, displayName: i.displayName ?? null }); return { deviceRef: r.deviceRef, status: r.status }; },
    async activate(i: { deviceRef: string }) { const r = await c.device.activate(i); return { status: r.status }; },
    async rotateKey(i: Parameters<Transport["rotateKey"]>[0]) { const r = await c.device.rotateKey(i); return { status: String((r as { status?: string }).status ?? "rotated") }; },
    async uploadEvidence(i: Parameters<Transport["uploadEvidence"]>[0]) {
      const r = await c.fieldRoute.evidence.upload({ title: i.title, category: i.category, fileName: i.fileName, mimeType: i.mimeType, dataBase64: i.dataBase64, latitude: i.latitude, longitude: i.longitude, notes: i.notes, clientCaptureRef: i.clientCaptureRef, capturedAt: i.capturedAt });
      return { id: Number(r.id), alreadyUploaded: (r as { alreadyUploaded?: boolean }).alreadyUploaded };
    },
    async sealEvidence(i: Parameters<Transport["sealEvidence"]>[0]) {
      try { const r = await c.records.evidence.seal({ evidenceId: i.evidenceId, contentHash: i.contentHash, recordType: i.recordType, relationships: i.relationships as never, deviceId: i.deviceId, devicePlatform: i.devicePlatform }); return { ok: true as const, alreadySealed: false, manifestHash: (r as { manifestHash?: string }).manifestHash ?? null }; }
      catch (e) {
        if (/already (sealed|amended)/i.test(e instanceof Error ? e.message : "")) { const r = await rows("SELECT manifestHash FROM evidenceSeals WHERE evidenceRecordId = ? ORDER BY version DESC LIMIT 1", [i.evidenceId]); return { ok: true as const, alreadySealed: true, manifestHash: r[0] ? String(r[0].manifestHash) : null }; }
        throw e;
      }
    },
    async receivePackage(i: Parameters<Transport["receivePackage"]>[0]) { return c.sync.receivePackage(i) as never; },
    async submitAttestSession(i: Parameters<Transport["submitAttestSession"]>[0]): Promise<AttestSessionSubmitResponse> {
      t.lastEnvelope = i;
      if (hooks.dropSubmit) throw new Error("ECONNRESET: connection dropped before the envelope was sent");
      if (hooks.beforeSubmit) await hooks.beforeSubmit();
      return c.attest.submitSession(i);
    },
  };
  return t satisfies Transport & { lastEnvelope: unknown };
}

const REAL = () => new Date(Math.floor(Date.now() / 1000) * 1000);
/** A tablet: enrolled and activated online, its clock eight hours behind the real one, like `fieldRuntime.test.ts`. */
async function tablet(userId: number, hooks: Parameters<typeof transportFor>[1] = {}) {
  const clock = new SettableClock(new Date(REAL().getTime() - 8 * 3_600_000));
  const keystore = new MemoryKeystore(clock);
  const vault = new MemoryVault(keystore);
  const store = new MemoryStore();
  const net = new FlagConnectivity(true);
  const transport = transportFor(userId, hooks);
  const engine = new SyncEngine({ store, vault, keystore, transport, connectivity: net, clock, platform: "android" });
  const enrolled = await engine.enroll("Tablet");
  await engine.activate();
  const signing = new AttestSigning({ store, vault, keystore, clock });
  return { clock, keystore, vault, store, net, transport, engine, signing, deviceRef: enrolled.deviceRef };
}

/** What a device downloads while online (§6.1): `attest.view`, kept with the job the marks are sealed against. */
async function download(userId: number, revisionRef: string, jobId: number, signing: AttestSigning): Promise<LocalSignableRevision> {
  const v = await callerFor(userId).attest.view({ revisionRef });
  return signing.cacheRevision({
    revisionRef, revisionId: null, revisionHash: v.revision.revisionHash, instanceRef: v.revision.instanceRef, subjectType: v.revision.subjectType, subjectRef: v.revision.subjectRef, title: `Document ${v.revision.instanceRef}`,
    pageCount: v.revision.pageCount, pageGeometry: v.revision.pageGeometry, pageImages: [],
    fields: v.fields.map(f => ({ fieldRef: f.fieldRef, fieldKey: f.fieldKey, fieldType: f.fieldType as never, page: f.page, xFrac: f.xFrac, yFrac: f.yFrac, widthFrac: f.widthFrac, heightFrac: f.heightFrac, signerRef: f.signerRef, required: f.required, signingOrder: f.signingOrder, subjectLineRef: f.subjectLineRef, state: f.state })),
    signers: v.signers.map(s => ({ signerRef: s.signerRef, displayName: s.displayName, partyKind: s.partyKind, signerRole: s.signerRole, requiredAuth: s.requiredAuth, userId: s.userId ?? null, state: s.state })),
    jobId, unitId: null,
  });
}

/** A pen signature drawn on the pad for a field. */
function drawn(rev: LocalSignableRevision, fieldKey: string, clock: SettableClock, kind: "pen" | "touch" = "pen") {
  const f = rev.fields.find(x => x.fieldKey === fieldKey)!;
  const pad = new StrokeCapture({ widthPx: 600, heightPx: 200, devicePixelRatio: 2, fieldRef: f.fieldRef, widthFrac: f.widthFrac, heightFrac: f.heightFrac }, () => clock.now());
  pad.begin(kind, 20, 100, 0.4, 0); pad.extend(60, 60, 0.5, 16); pad.extend(120, 120, 0.9, 33); pad.extend(200, 80, 0.8, 50); pad.end();
  pad.begin(kind, 240, 110, 0.5, 400); pad.extend(300, 90, 0.6, 420); pad.end();
  return pad.document()!;
}

d("a driver signs a field ticket offline on a tablet, and the office receives the signature exactly once", () => {
  it("captures strokes and a typed name offline, syncs marks then the session, binds everything to the revision hash, and answers a duplicate idempotently", async () => {
    const A = await org();
    const office = await member(A, ["office"]), driver = await member(A, ["driver"]);
    const ev = await sealedEvidence(A);
    const opened = await callerFor(office).attest.open({
      subjectType: "evidence_record", subjectRef: ev.subjectRef,
      fields: [
        { fieldKey: "driver_sig", fieldType: "signature", ...box(0), signerRole: "driver" },
        { fieldKey: "driver_name", fieldType: "printed_name", ...box(1), signerRole: "driver" },
        { fieldKey: "signed_on", fieldType: "date_signed", ...box(2), signerRole: "driver" },
      ],
      signers: [{ partyKind: "internal_user", userId: driver, displayName: "Dana Driver", signerRole: "driver", requiredAuth: "device_auth", fieldKeys: ["driver_sig", "driver_name", "signed_on"] }],
    });
    const signerRef = opened.signers[0]!.signerRef;
    const T = await tablet(driver);
    const rev = await download(driver, opened.revisionRef, ev.jobId, T.signing);
    expect(rev.fields.filter(f => f.signerRef === signerRef)).toHaveLength(3);

    // Out of coverage for the day.
    T.net.isOnline = false;
    await expect(T.signing.start({ revisionRef: "ATR-NOT-HERE", signerRef })).rejects.toThrow(/not on this device/);
    const s = await T.signing.start({ revisionRef: rev.revisionRef, signerRef, gps: { latitude: 53.5, longitude: -113.4 } });
    expect(s.sessionRef).toBe(`${T.deviceRef}:${s.localId}`);
    const doc = drawn(rev, "driver_sig", T.clock);
    const mark = await T.signing.addDrawnMark(s.localId, "driver_sig", doc, "authorized");
    expect(mark).toMatchObject({ markKind: "drawn", inputKind: "pen", pressureAvailable: true, strokeCount: 2, pointCount: 6 });
    expect(mark.strokeHash).toBe(sha(serializeStrokeDocument(normaliseStrokeDocument(doc))));
    expect(mark.renderedHash).toBe(sha(renderStrokeSvg(normaliseStrokeDocument(doc))));
    await expect(T.signing.complete(s.localId)).rejects.toThrow(/driver_name/);   // required, not yet marked
    await T.signing.addValueMark(s.localId, "driver_name", "typed_name", "Dana Driver");
    await T.signing.addValueMark(s.localId, "signed_on", "date", null, "none");
    T.clock.set(new Date(T.clock.now().getTime() + 90_000));
    const done = await T.signing.complete(s.localId);
    expect(done.state).toBe("queued");
    expect(done.deviceSignature?.keyFingerprint).toBe(await T.keystore.fingerprint());
    await expect(T.signing.addValueMark(s.localId, "driver_name", "typed_name", "Somebody Else")).rejects.toThrow(/signed and cannot change/);
    const off = await T.engine.syncOnce();
    expect(off.attempted).toBe(false);
    expect(off.reason).toContain("Offline");
    expect(await T.signing.status()).toMatchObject({ queued: 1 });

    // Signal returns. Marks first, then the session — one pass.
    T.net.isOnline = true;
    T.clock.set(REAL());
    const on = await T.engine.syncOnce();
    expect(on.synchronized, JSON.stringify(on)).toBe(2);
    expect(on.sessions).toEqual({ sent: 1, accepted: 1, rejected: 0, waiting: 0 });
    const local = (await T.store.getAttestSession(s.localId))!;
    expect(local.state).toBe("synchronized");
    expect((local.serverResult as AttestSessionSubmitResponse).state).toBe("accepted");

    // The server's rows: the session names the device, the method, the skew, and that it was captured offline; the mark names its sealed strokes.
    const [sess] = await rows("SELECT authMethod, state, capturedOffline, deviceRef, keyFingerprint, clockSkewMs, deviceClockAt, actorUserId, completedAt FROM attestSigningSessions WHERE sessionRef = ?", [s.sessionRef]);
    expect(sess).toMatchObject({ authMethod: "device_auth", state: "completed", capturedOffline: 1, deviceRef: T.deviceRef, keyFingerprint: await T.keystore.fingerprint(), actorUserId: driver });
    expect(sess!.deviceClockAt).not.toBeNull();
    expect(Math.abs(Number(sess!.clockSkewMs))).toBeLessThan(60_000);
    expect(Math.abs(new Date(sess!.completedAt).getTime() - new Date(done.completedAt!).getTime())).toBeLessThan(1000);   // the device's time, not the server's
    const marks = await rows("SELECT f.fieldKey, m.markKind, m.inputKind, m.strokeHash, m.renderedHash, m.strokeEvidenceRecordId, m.renderedEvidenceRecordId, m.pointCount, m.strokeCount, m.pressureAvailable, m.canvasWidthPx, m.valueText FROM attestMarks m JOIN attestFields f ON f.id = m.fieldId JOIN attestSigningSessions s ON s.id = m.sessionId WHERE s.sessionRef = ? ORDER BY f.fieldKey", [s.sessionRef]);
    expect(marks.map(m => [m.fieldKey, m.markKind, m.inputKind])).toEqual([["driver_name", "typed_name", "keyboard"], ["driver_sig", "drawn", "pen"], ["signed_on", "date", "none"]]);
    const sig = marks.find(m => m.fieldKey === "driver_sig")!;
    expect(sig).toMatchObject({ strokeHash: mark.strokeHash, renderedHash: mark.renderedHash, pointCount: 6, strokeCount: 2, pressureAvailable: 1, canvasWidthPx: 600 });
    expect(sig.strokeEvidenceRecordId).not.toBeNull();
    expect(sig.renderedEvidenceRecordId).not.toBeNull();
    const evs = await rows("SELECT id, clientCaptureRef, sealState, mimeType FROM evidenceRecords WHERE id IN (?, ?)", [sig.strokeEvidenceRecordId, sig.renderedEvidenceRecordId]);
    expect(evs.every(e => e.sealState === "sealed" && String(e.clientCaptureRef).startsWith(`${T.deviceRef}:`))).toBe(true);
    expect(evs.map(e => e.mimeType).sort()).toEqual(["application/json", "image/svg+xml"]);
    expect(marks.find(m => m.fieldKey === "driver_name")!.valueText).toBe("Dana Driver");
    const events = await rows("SELECT e.eventType, e.clockSource, e.deviceRef FROM attestEvents e JOIN attestDocumentRevisions r ON r.id = e.revisionId WHERE r.revisionRef = ? ORDER BY e.sequence", [opened.revisionRef]);
    expect(events.filter(e => e.eventType === "field_signed")).toMatchObject([{ clockSource: "device", deviceRef: T.deviceRef }]);
    expect(events.map(e => e.eventType)).toContain("document_completed");
    const view = await callerFor(office).attest.view({ revisionRef: opened.revisionRef });
    expect(view.revision.state).toBe("completed");
    expect(view.fields.every(f => f.state === "completed")).toBe(true);
    expect((await callerFor(office).attest.verify({ revisionRef: opened.revisionRef })).verified).toBe(true);

    // Duplicate sync: the device never saw the answer, so it sends the session again with a fresh nonce — one act, no second row.
    await T.store.putAttestSession({ ...local, state: "queued" });
    const again = await T.engine.syncOnce();
    expect(again.sessions).toMatchObject({ sent: 1, accepted: 1 });
    expect(((await T.store.getAttestSession(s.localId))!.serverResult as AttestSessionSubmitResponse).state).toBe("already_recorded");
    // The very same bytes, replayed: the nonce is spent and the answer is still the recorded session.
    const replayed = await T.transport.submitAttestSession(T.transport.lastEnvelope!);
    expect(replayed.state).toBe("already_recorded");
    expect(Number((await rows("SELECT COUNT(*) AS n FROM attestSigningSessions WHERE sessionRef = ?", [s.sessionRef]))[0]!.n)).toBe(1);
    expect(Number((await rows("SELECT COUNT(*) AS n FROM attestMarks m JOIN attestSigningSessions s ON s.id = m.sessionId WHERE s.sessionRef = ?", [s.sessionRef]))[0]!.n)).toBe(3);

    // The office finalizes; the receipt says the session was captured offline, with the skew.
    const fin = await callerFor(office).attest.finalize({ revisionRef: opened.revisionRef });
    const receipt = JSON.parse((await callerFor(office).attest.exportReceipt({ revisionRef: opened.revisionRef })).manifestJson) as { sessions: { sessionRef: string; capturedOffline: boolean; clockSkewMs: number | null; authMethod: string }[] };
    expect(fin.state).toBe("finalized");
    expect(receipt.sessions.find(x => x.sessionRef === s.sessionRef)).toMatchObject({ capturedOffline: true, authMethod: "device_auth" });
  }, 180_000);
});

d("what the server refuses when the world moved while the tablet was offline", () => {
  it("keeps both marks and completes the field once when two devices sign it; refuses a voided document; names a revoked device; holds the queue for a wrong clock", async () => {
    const A = await org();
    const office = await member(A, ["office"]), driver = await member(A, ["driver"]);
    const openFor = async () => {
      const ev = await sealedEvidence(A);
      const o = await callerFor(office).attest.open({ subjectType: "evidence_record", subjectRef: ev.subjectRef, fields: [{ fieldKey: "sig", fieldType: "signature", ...box(0), signerRole: "driver" }], signers: [{ partyKind: "internal_user", userId: driver, displayName: "Dana Driver", signerRole: "driver", fieldKeys: ["sig"] }] });
      return { ...o, jobId: ev.jobId, signerRef: o.signers[0]!.signerRef };
    };
    const signOffline = async (T: Awaited<ReturnType<typeof tablet>>, o: Awaited<ReturnType<typeof openFor>>) => {
      const rev = await download(driver, o.revisionRef, o.jobId, T.signing);
      T.net.isOnline = false;
      const s = await T.signing.start({ revisionRef: rev.revisionRef, signerRef: o.signerRef });
      await T.signing.addDrawnMark(s.localId, "sig", drawn(rev, "sig", T.clock, "touch"));
      return T.signing.complete(s.localId);
    };
    const sync = async (T: Awaited<ReturnType<typeof tablet>>) => { T.net.isOnline = true; T.clock.set(REAL()); return T.engine.syncOnce(); };

    // 1. The same field, signed independently on two tablets (§6.5 race 3).
    const race = await openFor();
    const T1 = await tablet(driver), T2 = await tablet(driver);
    const s1 = await signOffline(T1, race), s2 = await signOffline(T2, race);
    expect((await sync(T1)).sessions).toMatchObject({ accepted: 1 });
    const second = await sync(T2);
    expect(second.synchronized).toBe(2);   // the marks are evidence of the attempt and are kept
    expect(second.sessions).toMatchObject({ sent: 1, rejected: 1 });
    const l2 = (await T2.store.getAttestSession(s2.localId))!;
    expect(l2).toMatchObject({ state: "failed", lastCode: "FIELD_ALREADY_COMPLETED" });
    expect((l2.serverResult as AttestSessionSubmitResponse & { state: "rejected" }).handling.action).toBe("stop_and_escalate");
    const sessions = await rows("SELECT sessionRef, state, rejectionCode FROM attestSigningSessions WHERE sessionRef IN (?, ?) ORDER BY id", [s1.sessionRef, s2.sessionRef]);
    expect(sessions.map(s => [s.state, s.rejectionCode])).toEqual([["completed", null], ["rejected", "FIELD_ALREADY_COMPLETED"]]);
    const view = await callerFor(office).attest.view({ revisionRef: race.revisionRef });
    expect(view.fields[0]!.mark?.strokeHash).toBe(s1.marks[0]!.strokeHash);

    // 2. Voided while the tablet was out of coverage (§6.5 race 2).
    const voided = await openFor();
    const T3 = await tablet(driver);
    const s3 = await signOffline(T3, voided);
    await callerFor(office).attest.void({ revisionRef: voided.revisionRef, reason: "Ticket raised against the wrong well; a new one follows" });
    const r3 = await sync(T3);
    expect(r3.sessions).toMatchObject({ rejected: 1 });
    expect(await T3.store.getAttestSession(s3.localId)).toMatchObject({ state: "failed", lastCode: "DOCUMENT_VOIDED" });
    expect((await rows("SELECT rejectionCode FROM attestSigningSessions WHERE sessionRef = ?", [s3.sessionRef]))[0]).toMatchObject({ rejectionCode: "DOCUMENT_VOIDED" });

    // 3. The device was revoked after its marks arrived and before its session did (§6.5 race 8).
    const revokedRev = await openFor();
    let T4: Awaited<ReturnType<typeof tablet>>;
    T4 = await tablet(driver, { beforeSubmit: async () => { await pool.execute("UPDATE fieldDevices SET status = 'revoked', revokedAt = NOW() WHERE deviceRef = ?", [T4.deviceRef]); } });
    const s4 = await signOffline(T4, revokedRev);
    const r4 = await sync(T4);
    expect(r4.synchronized).toBe(2);
    expect(r4.sessions).toMatchObject({ rejected: 1 });
    expect(await T4.store.getAttestSession(s4.localId)).toMatchObject({ state: "failed", lastCode: "DEVICE_NOT_ACTIVE" });
    expect(await T4.store.getMeta("deviceStatus")).toBe("revoked");
    expect((await rows("SELECT COUNT(*) AS n FROM attestSigningSessions WHERE sessionRef = ?", [s4.sessionRef]))[0]!.n).toBe(0);   // a device refusal is not a session row
    expect((await sync(T4)).deviceStatus).toBe("revoked");

    // 4. A wrong clock at send time holds the queue with the instruction; a fixed clock sends the same session (§6.5 race 9).
    const clockRev = await openFor();
    const T5 = await tablet(driver, { dropSubmit: true });
    const s5 = await signOffline(T5, clockRev);
    const dropped = await sync(T5);   // marks land; the envelope's connection drops
    expect(dropped.synchronized).toBe(2);
    expect(dropped.sessions).toMatchObject({ sent: 0 });
    expect(await T5.store.getAttestSession(s5.localId)).toMatchObject({ state: "queued", lastError: expect.stringContaining("ECONNRESET") });
    const T5b = new SyncEngine({ store: T5.store, vault: T5.vault, keystore: T5.keystore, transport: transportFor(driver), connectivity: T5.net, clock: T5.clock, platform: "android" });
    T5.clock.set(new Date(REAL().getTime() + 2 * 86_400_000));
    const skewed = await T5b.syncOnce();
    expect(skewed.sessions).toMatchObject({ sent: 1, rejected: 1 });
    const held = (await T5.store.getAttestSession(s5.localId))!;
    expect(held).toMatchObject({ state: "queued", lastCode: "CLOCK_SKEW_TOO_LARGE" });
    expect((held.serverResult as AttestSessionSubmitResponse & { state: "rejected" }).handling).toMatchObject({ action: "stop_and_prompt", title: "This device's clock is wrong" });
    expect((await rows("SELECT COUNT(*) AS n FROM attestSigningSessions WHERE sessionRef = ?", [s5.sessionRef]))[0]!.n).toBe(0);
    T5.clock.set(REAL());
    expect((await T5b.syncOnce()).sessions).toMatchObject({ accepted: 1 });
    expect((await rows("SELECT state, clockSkewMs FROM attestSigningSessions WHERE sessionRef = ?", [s5.sessionRef]))[0]).toMatchObject({ state: "completed" });
  }, 300_000);
});

d("a witnessed mark on the driver's tablet, the caller who may not witness, and a device that lies", () => {
  it("accepts the consultant's drawing witnessed by the driver, refuses it from a mechanic, and refuses a session whose declared render is not what the strokes render to", async () => {
    const A = await org();
    const office = await member(A, ["office"]), driver = await member(A, ["driver"]), mechanic = await member(A, ["mechanic"]);
    const openWitnessed = async () => {
      const ev = await sealedEvidence(A);
      const o = await callerFor(office).attest.open({ subjectType: "evidence_record", subjectRef: ev.subjectRef, fields: [{ fieldKey: "consultant_sig", fieldType: "signature", ...box(0), signerRole: "consultant" }], signers: [{ partyKind: "named_witnessed", displayName: "M. Johnson", company: "ABC Energy", signerRole: "consultant", fieldKeys: ["consultant_sig"] }] });
      return { ...o, jobId: ev.jobId, signerRef: o.signers[0]!.signerRef };
    };
    // The office puts the revision on the tablet (a mechanic holds no attest.read); whose device it is decides nothing about who may witness.
    const witnessOffline = async (T: Awaited<ReturnType<typeof tablet>>, o: Awaited<ReturnType<typeof openWitnessed>>, mark: "drawn" | "ack" = "drawn") => {
      const rev = await download(office, o.revisionRef, o.jobId, T.signing);
      T.net.isOnline = false;
      const s = await T.signing.start({ revisionRef: rev.revisionRef, signerRef: o.signerRef });
      expect(s.authMethod).toBe("witnessed");   // a named signer with no account: witnessed, never device-authenticated
      if (mark === "drawn") await T.signing.addDrawnMark(s.localId, "consultant_sig", drawn(rev, "consultant_sig", T.clock));
      else await T.signing.addValueMark(s.localId, "consultant_sig", "electronic_ack", null, "none");
      return T.signing.complete(s.localId);
    };
    const sync = async (T: Awaited<ReturnType<typeof tablet>>) => { T.net.isOnline = true; T.clock.set(REAL()); return T.engine.syncOnce(); };

    const o1 = await openWitnessed();
    const T1 = await tablet(driver);
    const s1 = await witnessOffline(T1, o1);
    expect((await sync(T1)).sessions).toMatchObject({ accepted: 1 });
    expect((await rows("SELECT authMethod, witnessedByUserId, actorUserId, deviceRef, capturedOffline FROM attestSigningSessions WHERE sessionRef = ?", [s1.sessionRef]))[0]).toMatchObject({ authMethod: "witnessed", witnessedByUserId: driver, actorUserId: driver, deviceRef: T1.deviceRef, capturedOffline: 1 });

    // A mechanic holds no attest.witness: the envelope is refused, and the refusal is a row. (An
    // acknowledgement rather than a drawing, because a mechanic cannot seal evidence either — the
    // rule under test is the witness rule, not the vault's.)
    const o2 = await openWitnessed();
    const T2 = await tablet(mechanic);
    const s2 = await witnessOffline(T2, o2, "ack");
    const r2 = await sync(T2);
    expect(r2.sessions).toMatchObject({ rejected: 1 });
    expect(await T2.store.getAttestSession(s2.localId)).toMatchObject({ state: "failed", lastCode: "AUTH_METHOD_INSUFFICIENT" });
    expect((await rows("SELECT state, rejectionCode FROM attestSigningSessions WHERE sessionRef = ?", [s2.sessionRef]))[0]).toMatchObject({ state: "rejected", rejectionCode: "AUTH_METHOD_INSUFFICIENT" });
    expect((await callerFor(office).attest.view({ revisionRef: o2.revisionRef })).fields[0]!.state).toBe("pending");

    // A device that edits its session after signing it: the capture-time signature no longer verifies.
    const o3 = await openWitnessed();
    const T3 = await tablet(driver);
    const s3 = await witnessOffline(T3, o3);
    await T3.store.putAttestSession({ ...s3, marks: s3.marks.map(m => ({ ...m, renderedHash: sha("a different render") })) });
    const r3 = await sync(T3);
    expect(r3.sessions).toMatchObject({ rejected: 1 });
    expect(await T3.store.getAttestSession(s3.localId)).toMatchObject({ state: "failed", lastCode: "SIGNATURE_INVALID" });
    expect((await rows("SELECT rejectionCode FROM attestSigningSessions WHERE sessionRef = ?", [s3.sessionRef]))[0]).toMatchObject({ rejectionCode: "SIGNATURE_INVALID" });

    // A vault whose stored stroke bytes are not the sealed ones: the server recomputes and refuses.
    const o4 = await openWitnessed();
    let T4: Awaited<ReturnType<typeof tablet>>;
    T4 = await tablet(driver, { beforeSubmit: async () => {
      const env = JSON.parse(T4.transport.lastEnvelope!.signedPayloadJson) as { session: { marks: { strokeEvidenceRecordId: number }[] } };
      const [rec] = await rows("SELECT storageKey FROM evidenceRecords WHERE id = ?", [env.session.marks[0]!.strokeEvidenceRecordId]);
      objects.set(String(rec!.storageKey), Buffer.from(objects.get(String(rec!.storageKey))!.toString("utf8").replace('"durationMs"', '"durationMs"').replace("[20,100,0,", "[21,100,0,")));
    } });
    const s4 = await witnessOffline(T4, o4);
    const r4 = await sync(T4);
    expect(r4.sessions).toMatchObject({ rejected: 1 });
    expect(await T4.store.getAttestSession(s4.localId)).toMatchObject({ state: "failed", lastCode: "MARK_HASH_MISMATCH" });
    expect((await callerFor(office).attest.view({ revisionRef: o4.revisionRef })).fields[0]!.state).toBe("pending");
  }, 300_000);
});
