/**
 * v22.20 (0099) — a message points at a record without carrying it, and without
 * carrying the sender's authority to every reader.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import { MESSAGE_ATTACHMENT_AUTHORIZERS, supportedKinds } from "./_core/attachmentAuthorizers";
import { NEVER_ATTACHABLE } from "./_core/attachmentAuthorization";
import type { DomainRole } from "./_core/recordsAuthorization";

describe("the registry is honest about what it can answer", () => {
  it("ships only kinds with a resolver, and refuses the rest by omission", () => {
    expect(supportedKinds().sort()).toEqual(["defect", "job", "unit"]);
    // Financial records want a real row-level rule, not an existence check.
    expect(supportedKinds()).not.toContain("invoice");
  });

  it("states the scope of each kind rather than implying one", () => {
    MESSAGE_ATTACHMENT_AUTHORIZERS.forEach(a => {
      expect(a.scopeNote).toContain("organization column");
      expect(a.authorizerClass).toBe("partial");
    });
  });

  it("keeps the never-attachable kinds out of the registry entirely", () => {
    for (const kind of NEVER_ATTACHABLE) expect(MESSAGE_ATTACHMENT_AUTHORIZERS.has(kind)).toBe(false);
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 21_000_000 + Math.floor(Math.random() * 60_000);
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });
const caller = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });
async function withRole(role: DomainRole) { const id = seq++; await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }
const rnd = () => Math.random().toString(36).slice(2, 8).toUpperCase();
const NOW = () => new Date();

async function aJob() {
  const [r] = await pool.execute<mysql.ResultSetHeader>(
    `INSERT INTO jobs (jobCode, type, mode, customer, location, status, progress, createdAt, updatedAt)
     VALUES (?, 'vac', 'hydrovac', 'ACME', 'LSD', 'dispatched', 0, NOW(), NOW())`, [`J-${rnd()}`]);
  return String(r.insertId);
}
async function channelFor(user: number) {
  return (await caller(user).board.createChannel({ type: "dispatch", name: `D ${rnd()}` })).channelRef;
}

d("the sender must be able to open what they attach", () => {
  it("attaches a job the sender can read", async () => {
    const dispatcher = await withRole("dispatcher");
    const ch = await channelFor(dispatcher);
    const job = await aJob();
    const p = await caller(dispatcher).board.post({ channelRef: ch, body: "see job", deviceCreatedAt: NOW(), attachments: [{ kind: "job", objectRef: job }] });
    const read = await caller(dispatcher).board.read({ channelRef: ch });
    const m = read.messages.find(x => x.messageRef === p.messageRef)!;
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments[0]).toMatchObject({ visible: true, kind: "job", objectRef: job });
    expect(m.attachments[0].deepLink).toBe(`/job/${job}`);
  });

  it("refuses a record that does not exist, in the same words as one they cannot open", async () => {
    const dispatcher = await withRole("dispatcher");
    const ch = await channelFor(dispatcher);
    await expect(caller(dispatcher).board.post({ channelRef: ch, body: "x", deviceCreatedAt: NOW(), attachments: [{ kind: "job", objectRef: "9999999" }] }))
      .rejects.toThrow(/No such job/);
  });

  it("refuses a kind nobody can resolve rather than guessing a permission", async () => {
    const dispatcher = await withRole("dispatcher");
    const ch = await channelFor(dispatcher);
    await expect(caller(dispatcher).board.post({ channelRef: ch, body: "x", deviceCreatedAt: NOW(), attachments: [{ kind: "trailer", objectRef: "1" }] }))
      .rejects.toThrow(/not string construction/);
  });

  it("refuses a payroll document even from somebody who could open one", async () => {
    const manager = await withRole("management");
    const ch = await channelFor(manager);
    await expect(caller(manager).board.post({ channelRef: ch, body: "x", deviceCreatedAt: NOW(), attachments: [{ kind: "payrollDocument", objectRef: "1" }] }))
      .rejects.toThrow(/not how this record is shared/);
  });

  it("refuses attachments on a client channel entirely", async () => {
    const dispatcher = await withRole("dispatcher");
    const ch = (await caller(dispatcher).board.createChannel({ type: "client", name: `C ${rnd()}`, clientRef: "CUST-9" })).channelRef;
    const job = await aJob();
    await expect(caller(dispatcher).board.post({ channelRef: ch, body: "x", deviceCreatedAt: NOW(), attachments: [{ kind: "job", objectRef: job }] }))
      .rejects.toThrow(/no client-side authorization path/);
  });
});

d("every reader is checked again", () => {
  /**
   * The reader-stub path is exercised directly against the projection, because
   * every domain role in this deployment holds job.read and fleet.read — there
   * is no role that can reach the board and cannot open a job. That is a fact
   * about the permission model rather than about attachments, and pretending
   * otherwise with a contrived role would test nothing real.
   */
  it("gives a stub, naming the kind and withholding the reference", async () => {
    const { viewFor } = await import("./_core/attachmentAuthorizers");
    const { getDb } = await import("./db");
    const db = await getDb();
    const job = await aJob();

    const allowed = await viewFor(db!, { kind: "job", objectRef: job, heldPermissions: ["job.read"] });
    expect(allowed).toMatchObject({ visible: true, objectRef: job });
    expect(allowed.deepLink).toBe(`/job/${job}`);

    const denied = await viewFor(db!, { kind: "job", objectRef: job, heldPermissions: [] });
    expect(denied.visible).toBe(false);
    expect(denied.kind).toBe("job");
    expect(denied.note).toContain("is not visible to you");
    // The conversation still reads; the reference stays closed.
    expect(JSON.stringify(denied)).not.toContain(job);
  });

  it("is evaluated now, so a revoked permission closes it later", async () => {
    const { viewFor } = await import("./_core/attachmentAuthorizers");
    const { getDb } = await import("./db");
    const db = await getDb();
    const job = await aJob();
    // Same stored reference, two different readers, two different answers —
    // which a copied record could never do.
    expect((await viewFor(db!, { kind: "job", objectRef: job, heldPermissions: ["job.read"] })).visible).toBe(true);
    expect((await viewFor(db!, { kind: "job", objectRef: job, heldPermissions: ["fleet.read"] })).visible).toBe(false);
  });

  it("answers a missing record and an unauthorized one identically", async () => {
    const { viewFor } = await import("./_core/attachmentAuthorizers");
    const { getDb } = await import("./db");
    const db = await getDb();
    const missing = await viewFor(db!, { kind: "job", objectRef: "9999999", heldPermissions: ["job.read"] });
    const forbidden = await viewFor(db!, { kind: "job", objectRef: await aJob(), heldPermissions: [] });
    expect(missing.visible).toBe(false);
    expect(forbidden.visible).toBe(false);
    expect(missing.note).toBe(forbidden.note);
  });
});

d("the post is one fact", () => {
  it("saves no message when one of several attachments is forbidden", async () => {
    const dispatcher = await withRole("dispatcher");
    const ch = await channelFor(dispatcher);
    const job = await aJob();
    const [before] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM boardMessages WHERE channelRef = ?", [ch]);

    await expect(caller(dispatcher).board.post({
      channelRef: ch, body: "mixed", deviceCreatedAt: NOW(),
      attachments: [{ kind: "job", objectRef: job }, { kind: "payrollDocument", objectRef: "1" }],
    })).rejects.toThrow();

    const [after] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM boardMessages WHERE channelRef = ?", [ch]);
    expect(Number(after[0].n)).toBe(Number(before[0].n));
    const [atts] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM messageAttachments WHERE kind = 'job' AND objectRef = ?", [job]);
    expect(Number(atts[0].n)).toBe(0);
  });

  it("bounds how many one message may carry", async () => {
    const dispatcher = await withRole("dispatcher");
    const ch = await channelFor(dispatcher);
    const many = Array.from({ length: 11 }, () => ({ kind: "job", objectRef: "1" }));
    await expect(caller(dispatcher).board.post({ channelRef: ch, body: "x", deviceCreatedAt: NOW(), attachments: many })).rejects.toThrow();
  });

  it("leaves attachments untouched when the body is edited or withdrawn", async () => {
    const dispatcher = await withRole("dispatcher");
    const ch = await channelFor(dispatcher);
    const job = await aJob();
    const p = await caller(dispatcher).board.post({ channelRef: ch, body: "first", deviceCreatedAt: NOW(), attachments: [{ kind: "job", objectRef: job }] });
    await caller(dispatcher).board.edit({ messageRef: p.messageRef, body: "second" });
    await caller(dispatcher).board.withdraw({ messageRef: p.messageRef });
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT COUNT(*) AS n FROM messageAttachments WHERE messageRef = ?", [p.messageRef]);
    // A body revision is not an attachment revision, and withdrawal is not erasure.
    expect(Number(rows[0].n)).toBe(1);
  });
});
