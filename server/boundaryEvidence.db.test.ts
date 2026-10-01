/**
 * Receipt → trip stop → boundary verdict, against a real database.
 *
 * `server/boundaryEvidence.test.ts` proves the chain rule and the resolver without a
 * database. What only a database can prove is the ASSOCIATION: that the query reads
 * the receipts of the stop it was asked about, of that stop only, inside the caller's
 * organization only, and that what the real commit path writes is what the resolver
 * reads. So the cases that matter most here drive the real thing —
 * `executeAssistantCommit` to write a receipt, and the real `tripStops.update` router
 * to edit a stop behind it — rather than hand-building rows that agree with the code
 * by construction.
 *
 * Hand-built receipts are used where the point is a row the commit path cannot
 * produce: a receipt aimed at the wrong table, a broken seal, garbage in a manifest.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { getDb, grantUserRole } from "./db";
import { appRouter } from "./routers";
import { SINGLE_TENANT_ID } from "./_core/actingScope";
import { executeAssistantCommit } from "./_core/assistantCommitService";
import { boundaryConfirmations } from "./_core/boundaryConfirmation";
import { boundaryEvidenceForStop } from "./_core/boundaryEvidence";
import type { DbOrTx } from "./_core/dbTypes";
import { phaseConfirmation } from "./_core/siteBaseline";

const DB_URL = process.env.DATABASE_URL;
const d = DB_URL ? describe : describe.skip;

let pool: mysql.Pool;
let db: DbOrTx;
// User-id band 28M, as in the sibling repository: no other suite here seeds ids in it.
let seq = 28_000_000 + Math.floor(Math.random() * 60_000);
const rnd = () => Math.random().toString(36).slice(2, 10).toUpperCase();
const sha = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

const SINGLE = { tenantId: SINGLE_TENANT_ID };
const COMMIT_AT = new Date("2026-09-01T10:00:00.000Z");
const LATER = new Date("2026-09-01T11:00:00.000Z");
const sql = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

beforeAll(async () => {
  if (!DB_URL) return;
  pool = mysql.createPool({ uri: DB_URL, connectionLimit: 4, timezone: "Z" });
  db = (await getDb()) as unknown as DbOrTx;
});
afterAll(async () => {
  await pool?.end();
});

async function trip(orgRef: string | null = null) {
  const [r] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO trips (tripNumber, orgRef) VALUES (?, ?)",
    [`BC-${rnd()}`, orgRef],
  );
  return Number(r.insertId);
}

/**
 * A stop whose last recorded write was at `updatedAt`, by `updatedBy`. The default writer
 * is user 1, the actor every hand-built receipt below names — so a hand-built stop and its
 * receipts agree unless a case says otherwise.
 */
async function stop(tripId: number, updatedAt: Date | null = COMMIT_AT, updatedBy: number | null = updatedAt ? 1 : null) {
  const [r] = await pool.execute<mysql.ResultSetHeader>(
    "INSERT INTO tripStops (tripId, stopType, sequence, updatedAt, updatedByUserId) VALUES (?, 'unload', 1, ?, ?)",
    [tripId, updatedAt ? sql(updatedAt) : null, updatedBy],
  );
  return Number(r.insertId);
}

type ManifestField = { key: string; status: string; source?: string };
const manifestJson = (fields: ManifestField[]) =>
  JSON.stringify(
    fields
      .map(f => ({
        key: f.key,
        value: "10:00",
        precision: "exact",
        source: f.source ?? "driver_voice",
        confidence: "high",
        status: f.status,
        sourceUtterance: null,
        correctedFrom: null,
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
  );

/** A receipt row written by hand — only for rows the commit path cannot produce. */
async function rawReceipt(args: {
  targetRecordId: number;
  targetType?: string;
  json: string;
  hash?: string;
  committedAt?: Date;
}) {
  await pool.execute(
    `INSERT INTO assistantCommitReceipts
     (proposalId, formKey, action, targetType, targetRecordId, requiredPermission,
      adapterVersion, fieldManifest, fieldManifestHash, actorUserId, committedAt)
     VALUES (?, 'unload_stop', 'update', ?, ?, 'trip.write', 'test', ?, ?, 1, ?)`,
    [
      `PROP-BC-${rnd()}`,
      args.targetType ?? "trip_stop",
      args.targetRecordId,
      args.json,
      args.hash ?? sha(args.json),
      sql(args.committedAt ?? COMMIT_AT),
    ],
  );
}

const ALL_CONFIRMED: ManifestField[] = [
  { key: "arrivedAt", status: "confirmed" },
  { key: "operationStartedAt", status: "confirmed" },
  { key: "operationCompletedAt", status: "corrected", source: "human_corrected" },
  { key: "departedAt", status: "confirmed" },
];

const verdicts = async (stopId: number, scope = SINGLE) => {
  const found = await boundaryEvidenceForStop(db, stopId, scope);
  return found ? { chain: found.chain, ...boundaryConfirmations(found.evidence) } : null;
};

/* --------------------------------------------------------------------------- */
/* The real commit path                                                         */
/* --------------------------------------------------------------------------- */

type ProposedRow = {
  key: string;
  label: string;
  value: string | number | null;
  status: "proposed" | "confirmed" | "rejected" | "corrected";
  source?: string;
};

/** Commit an unload stop through `executeAssistantCommit`, exactly as the app does. */
async function commitUnload(stopId: number, tripId: number, fields: ProposedRow[], now = COMMIT_AT) {
  const actor = seq++;
  await grantUserRole({ userId: actor, role: "office", scopeType: "global", grantedByUserId: 1, grantedAt: new Date() });
  const proposalId = `PROP-BC-${rnd()}`;
  await pool.execute(
    // AIL-1A: a proposal carries the organization it was drafted in, as a production draft stamps it. The
    // actor here has no membership, so it is the single tenant's; an unstamped (legacy) proposal is
    // committable by nobody.
    `INSERT INTO assistantProposals
     (proposalId, tenantId, tenantDerivedFrom, formKey, formVersion, title, targetRef, targetRecordId,
      eventDateLocal, utcOffsetMinutes, tripId, createdByUserId,
      readBack, readBackAcknowledged, commitState)
     VALUES (?, '${SINGLE_TENANT_ID}', 'single_tenant_fallback', 'unload_stop', 1, 'Unload stop', ?, ?, '2026-09-01', 0,
             ?, ?, 'read back', 1, 'awaiting_readback')`,
    [proposalId, `TRIP-${tripId} unload stop`, stopId, tripId, actor],
  );
  for (const f of fields) {
    await pool.execute(
      `INSERT INTO proposalFields
       (proposalId, fieldKey, label, fieldValue, \`precision\`, source, confidence, status)
       VALUES (?, ?, ?, ?, 'exact', ?, 'high', ?)`,
      [proposalId, f.key, f.label, f.value === null ? null : JSON.stringify(f.value), f.source ?? "driver_voice", f.status],
    );
  }
  const result = await executeAssistantCommit({ proposalId, actorUserId: actor, now });
  if (!result.committed) throw new Error(`commit refused: ${result.refusals.join("; ")}`);
  return { actor, proposalId };
}

const REQUIRED_REST: ProposedRow[] = [
  { key: "quantity", label: "Quantity", value: 8000, status: "confirmed" },
  { key: "measurementMethod", label: "Measured by", value: "Meter", status: "confirmed" },
];

d("what the real commit path writes is what the resolver reads", () => {
  it("confirms the four reachable boundaries and hands siteBaseline operation and total", async () => {
    const t = await trip();
    const s = await stop(t, null);
    await commitUnload(s, t, [
      { key: "arrivedAt", label: "Arrived", value: "10:00", status: "confirmed" },
      { key: "operationStartedAt", label: "Started", value: "10:15", status: "confirmed" },
      { key: "operationCompletedAt", label: "Completed", value: "10:40", status: "corrected", source: "human_corrected" },
      { key: "departedAt", label: "Departed", value: "11:00", status: "confirmed" },
      ...REQUIRED_REST,
    ]);

    const found = await boundaryEvidenceForStop(db, s, SINGLE);
    expect(found?.chain).toBe("intact");
    const boundaries = boundaryConfirmations(found!.evidence);
    expect(boundaries).toEqual({
      arrivedAt: "confirmed",
      setupStartedAt: "unknown",
      operationStartedAt: "confirmed",
      operationCompletedAt: "confirmed",
      departedAt: "confirmed",
    });
    expect(phaseConfirmation(boundaries)).toEqual({
      setup: "unknown",
      operation: "confirmed",
      wait: "unknown",
      total: "confirmed",
    });
  }, 30_000);

  it("keeps a field nobody acted on unconfirmed, not confirmed, after it is committed", async () => {
    // It reached the row under the proposal's read-back, but no one acted on it.
    const t = await trip();
    const s = await stop(t, null);
    await commitUnload(s, t, [
      { key: "arrivedAt", label: "Arrived", value: "10:00", status: "proposed" },
      { key: "operationStartedAt", label: "Started", value: "10:15", status: "confirmed" },
      { key: "operationCompletedAt", label: "Completed", value: "10:40", status: "confirmed" },
      ...REQUIRED_REST,
    ]);
    const v = await verdicts(s);
    expect(v?.arrivedAt).toBe("unconfirmed");
    expect(v?.operationStartedAt).toBe("confirmed");
  }, 30_000);

  it("never lets a rejected field reappear as evidence", async () => {
    const t = await trip();
    const s = await stop(t, null);
    const { proposalId } = await commitUnload(s, t, [
      { key: "arrivedAt", label: "Arrived", value: "10:00", status: "confirmed" },
      { key: "operationStartedAt", label: "Started", value: "10:15", status: "confirmed" },
      { key: "operationCompletedAt", label: "Completed", value: "10:40", status: "confirmed" },
      // A GPS-detected departure the driver rejected. It has a value; it must not land.
      { key: "departedAt", label: "Departed", value: "11:00", status: "rejected", source: "gps" },
      ...REQUIRED_REST,
    ]);

    const [[receipt]] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT fieldManifest FROM assistantCommitReceipts WHERE proposalId = ?",
      [proposalId],
    );
    expect(JSON.parse(receipt.fieldManifest).map((f: { key: string }) => f.key)).not.toContain("departedAt");
    const [[row]] = await pool.execute<mysql.RowDataPacket[]>("SELECT departedAt FROM tripStops WHERE id = ?", [s]);
    expect(row.departedAt).toBeNull();

    const v = await verdicts(s);
    expect(v?.departedAt).toBe("unknown");
    expect(v?.arrivedAt).toBe("confirmed");
  }, 30_000);

  it("never lets a null-valued field reappear as evidence", async () => {
    const t = await trip();
    const s = await stop(t, null);
    const { proposalId } = await commitUnload(s, t, [
      { key: "arrivedAt", label: "Arrived", value: "10:00", status: "confirmed" },
      { key: "operationStartedAt", label: "Started", value: "10:15", status: "confirmed" },
      { key: "operationCompletedAt", label: "Completed", value: "10:40", status: "confirmed" },
      { key: "departedAt", label: "Departed", value: null, status: "confirmed" },
      ...REQUIRED_REST,
    ]);
    const [[receipt]] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT fieldManifest FROM assistantCommitReceipts WHERE proposalId = ?",
      [proposalId],
    );
    expect(JSON.parse(receipt.fieldManifest).map((f: { key: string }) => f.key)).not.toContain("departedAt");
    expect((await verdicts(s))?.departedAt).toBe("unknown");
  }, 30_000);

  it("stops reading receipts once the stop is edited through tripStops.update", async () => {
    // The real router, stamping its own updatedAt after the commit. It records the
    // row it touched and not the field, so every receipt is now in doubt — even
    // though this edit only changed the notes.
    const t = await trip();
    const s = await stop(t, null);
    const { actor } = await commitUnload(s, t, [
      { key: "arrivedAt", label: "Arrived", value: "10:00", status: "confirmed" },
      { key: "operationStartedAt", label: "Started", value: "10:15", status: "confirmed" },
      { key: "operationCompletedAt", label: "Completed", value: "10:40", status: "confirmed" },
      ...REQUIRED_REST,
    ]);
    expect((await verdicts(s))?.arrivedAt).toBe("confirmed");

    const caller = appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: actor, role: "user" } as never });
    await caller.fieldRoute.tripStops.update({ id: s, notes: "edited by hand" });

    const v = await verdicts(s);
    expect(v?.chain).toBe("edited_after_commit");
    expect(v?.arrivedAt).toBe("unknown");
    expect(v?.operationStartedAt).toBe("unknown");
  }, 30_000);

  it("does not let an older commit vouch for a value typed by hand between two commits", async () => {
    // The review finding, exactly as it happens. A driver commits a confirmed departure;
    // the office retypes it through tripStops.update; a later commit corrects the unload
    // times and leaves the optional departure out. That commit re-stamps updatedAt, so
    // nothing on the row shows the edit — and the first receipt must not speak for it.
    const t = await trip();
    const s = await stop(t, null);
    const { actor } = await commitUnload(s, t, [
      { key: "arrivedAt", label: "Arrived", value: "10:00", status: "confirmed" },
      { key: "operationStartedAt", label: "Started", value: "10:15", status: "confirmed" },
      { key: "operationCompletedAt", label: "Completed", value: "10:40", status: "confirmed" },
      { key: "departedAt", label: "Departed", value: "11:00", status: "confirmed" },
      ...REQUIRED_REST,
    ]);
    expect((await verdicts(s))?.departedAt).toBe("confirmed");

    const caller = appRouter.createCaller({ req: {} as never, res: {} as never, user: { id: actor, role: "user" } as never });
    await caller.fieldRoute.tripStops.update({ id: s, departedAt: new Date("2026-09-01T18:30:00.000Z") });
    expect((await verdicts(s))?.departedAt).toBe("unknown");

    await commitUnload(s, t, [
      { key: "arrivedAt", label: "Arrived", value: "10:02", status: "corrected", source: "human_corrected" },
      { key: "operationStartedAt", label: "Started", value: "10:15", status: "confirmed" },
      { key: "operationCompletedAt", label: "Completed", value: "10:40", status: "confirmed" },
      ...REQUIRED_REST,
    ], LATER);

    const [[row]] = await pool.execute<mysql.RowDataPacket[]>("SELECT departedAt FROM tripStops WHERE id = ?", [s]);
    expect(new Date(row.departedAt).toISOString()).toBe("2026-09-01T18:30:00.000Z"); // the hand-typed value survived
    const v = await verdicts(s);
    expect(v?.chain).toBe("intact");
    expect(v?.departedAt).toBe("unknown");
    expect(v?.arrivedAt).toBe("confirmed");
    const phases = phaseConfirmation(boundaryConfirmations((await boundaryEvidenceForStop(db, s, SINGLE))!.evidence));
    expect(phases.total).toBe("unknown"); // arrival to departure: the departure is nobody's committed word
  }, 30_000);

  it("lets a later commit supersede an earlier one on the same stop", async () => {
    const t = await trip();
    const s = await stop(t, null);
    await commitUnload(s, t, [
      { key: "arrivedAt", label: "Arrived", value: "10:00", status: "proposed" },
      { key: "operationStartedAt", label: "Started", value: "10:15", status: "confirmed" },
      { key: "operationCompletedAt", label: "Completed", value: "10:40", status: "confirmed" },
      ...REQUIRED_REST,
    ]);
    await commitUnload(s, t, [
      { key: "arrivedAt", label: "Arrived", value: "10:02", status: "corrected", source: "human_corrected" },
      { key: "operationStartedAt", label: "Started", value: "10:15", status: "proposed" },
      { key: "operationCompletedAt", label: "Completed", value: "10:40", status: "confirmed" },
      ...REQUIRED_REST,
    ], LATER);

    const v = await verdicts(s);
    expect(v?.chain).toBe("intact");
    expect(v?.arrivedAt).toBe("confirmed"); // corrected later
    expect(v?.operationStartedAt).toBe("unconfirmed"); // re-proposed later
  }, 30_000);
});

/* --------------------------------------------------------------------------- */
/* Association: which receipts speak for which stop                             */
/* --------------------------------------------------------------------------- */

d("a receipt speaks only for the stop it names", () => {
  it("does not let stop A's receipt confirm stop B", async () => {
    const t = await trip();
    const a = await stop(t);
    const b = await stop(t);
    await rawReceipt({ targetRecordId: a, json: manifestJson(ALL_CONFIRMED) });

    expect((await verdicts(a))?.arrivedAt).toBe("confirmed");
    const vb = await verdicts(b);
    expect(vb?.chain).toBe("no_receipts");
    expect(vb?.arrivedAt).toBe("unknown");
  });

  it("ignores a receipt for another table that carries the same id", async () => {
    // Ids are per table. A maintenance_defect receipt numbered like this stop is not
    // about this stop.
    const t = await trip();
    const s = await stop(t);
    await rawReceipt({ targetRecordId: s, targetType: "maintenance_defect", json: manifestJson(ALL_CONFIRMED) });
    const v = await verdicts(s);
    expect(v?.chain).toBe("no_receipts");
    expect(v?.arrivedAt).toBe("unknown");
  });

  it("ignores a trip_stop receipt aimed at a different record", async () => {
    const t = await trip();
    const s = await stop(t);
    const other = await stop(t);
    await rawReceipt({ targetRecordId: other, json: manifestJson(ALL_CONFIRMED) });
    expect((await verdicts(s))?.chain).toBe("no_receipts");
  });

  it("gives the same answer whatever order the rows come back in", async () => {
    // Two stops with identical evidence, written in opposite orders, so a primary-key
    // scan returns them reversed. The verdicts must not notice.
    const t = await trip();
    const x = await stop(t, LATER);
    const y = await stop(t, LATER);
    const older = manifestJson([{ key: "arrivedAt", status: "confirmed" }, { key: "departedAt", status: "proposed" }]);
    const newer = manifestJson([{ key: "arrivedAt", status: "proposed" }, { key: "departedAt", status: "corrected", source: "human_corrected" }]);

    await rawReceipt({ targetRecordId: x, json: older, committedAt: COMMIT_AT });
    await rawReceipt({ targetRecordId: x, json: newer, committedAt: LATER });
    await rawReceipt({ targetRecordId: y, json: newer, committedAt: LATER });
    await rawReceipt({ targetRecordId: y, json: older, committedAt: COMMIT_AT });

    const vx = await verdicts(x);
    const vy = await verdicts(y);
    expect(vx).toEqual(vy);
    expect(vx?.arrivedAt).toBe("unconfirmed");
    expect(vx?.departedAt).toBe("confirmed");
  });

  it("breaks an exact tie between two receipts toward the weaker verdict", async () => {
    const t = await trip();
    const s = await stop(t);
    await rawReceipt({ targetRecordId: s, json: manifestJson([{ key: "arrivedAt", status: "confirmed" }]) });
    await rawReceipt({ targetRecordId: s, json: manifestJson([{ key: "arrivedAt", status: "proposed" }]) });
    expect((await verdicts(s))?.arrivedAt).toBe("unconfirmed");
  });

  it("breaks the same tie the same way when the rows come back in the other order", async () => {
    const t = await trip();
    const s = await stop(t);
    await rawReceipt({ targetRecordId: s, json: manifestJson([{ key: "arrivedAt", status: "proposed" }]) });
    await rawReceipt({ targetRecordId: s, json: manifestJson([{ key: "arrivedAt", status: "confirmed" }]) });
    expect((await verdicts(s))?.arrivedAt).toBe("unconfirmed");
  });

  it("refuses a stop someone else wrote in the second its newest commit landed", async () => {
    // A hand edit landing in the commit's second truncates to the same stamp; the writer
    // does not. The receipt's actor is user 1; the row names another.
    const t = await trip();
    const s = await stop(t, COMMIT_AT, 2);
    await rawReceipt({ targetRecordId: s, json: manifestJson(ALL_CONFIRMED) });
    const v = await verdicts(s);
    expect(v?.chain).toBe("written_by_another_actor");
    expect(v?.arrivedAt).toBe("unknown");
  });
});

d("evidence that cannot be trusted confirms nothing", () => {
  it("refuses a manifest altered after it was sealed", async () => {
    const t = await trip();
    const s = await stop(t);
    await rawReceipt({ targetRecordId: s, json: manifestJson(ALL_CONFIRMED), hash: sha("what was sealed") });
    const v = await verdicts(s);
    expect(v?.chain).toBe("seal_mismatch");
    expect(v?.arrivedAt).toBe("unknown");
  });

  it("refuses a malformed manifest, and does not fall back to an older good one", async () => {
    const t = await trip();
    const s = await stop(t, LATER);
    await rawReceipt({ targetRecordId: s, json: manifestJson(ALL_CONFIRMED), committedAt: COMMIT_AT });
    await rawReceipt({ targetRecordId: s, json: "not json", committedAt: LATER });
    const v = await verdicts(s);
    expect(v?.chain).toBe("unreadable_manifest");
    expect(v?.arrivedAt).toBe("unknown");
    expect(v?.departedAt).toBe("unknown");
  });

  it("keeps setupStartedAt unknown even when a manifest claims to confirm it", async () => {
    const t = await trip();
    const s = await stop(t);
    await rawReceipt({
      targetRecordId: s,
      json: manifestJson([{ key: "setupStartedAt", status: "confirmed" }, { key: "arrivedAt", status: "confirmed" }]),
    });
    const v = await verdicts(s);
    expect(v?.chain).toBe("intact");
    expect(v?.setupStartedAt).toBe("unknown");
    expect(v?.arrivedAt).toBe("confirmed");
  });

  it("refuses a stop whose row recorded no write — written before 0169", async () => {
    const t = await trip();
    const s = await stop(t, null);
    await rawReceipt({ targetRecordId: s, json: manifestJson(ALL_CONFIRMED) });
    const v = await verdicts(s);
    expect(v?.chain).toBe("no_write_recorded");
    expect(v?.arrivedAt).toBe("unknown");
  });
});

d("a receipt cannot manufacture a stop", () => {
  it("answers nothing for a stop id that does not exist, however many receipts name it", async () => {
    // A receipt row aimed at an id no tripStops row carries. There is nothing to read
    // confirmation about, and the answer is the same as for a stop outside scope.
    const ghost = 2_147_000_500 + Math.floor(Math.random() * 400);
    await rawReceipt({ targetRecordId: ghost, json: manifestJson(ALL_CONFIRMED) });
    expect(await boundaryEvidenceForStop(db, ghost, SINGLE)).toBeNull();
  });

  it("answers nothing once the stop itself is gone, though its receipt remains", async () => {
    const t = await trip();
    const s = await stop(t);
    await rawReceipt({ targetRecordId: s, json: manifestJson(ALL_CONFIRMED) });
    expect((await verdicts(s))?.arrivedAt).toBe("confirmed");
    await pool.execute("DELETE FROM tripStops WHERE id = ?", [s]);
    expect(await boundaryEvidenceForStop(db, s, SINGLE)).toBeNull();
  });
});

d("the stop is read inside the caller's organization only", () => {
  it("does not let organization A read confirmation from organization B's receipt, even with the stop id in hand", async () => {
    // The receipt is real and intact; the stop is B's. A knows the id. The id is only
    // ever looked up inside A's scope, so A gets the not-found answer, not B's verdicts.
    const orgA = `ORG-BC-${rnd()}`;
    const orgB = `ORG-BC-${rnd()}`;
    const s = await stop(await trip(orgB));
    await rawReceipt({ targetRecordId: s, json: manifestJson(ALL_CONFIRMED) });
    expect((await verdicts(s, { tenantId: orgB }))?.arrivedAt).toBe("confirmed");
    expect(await boundaryEvidenceForStop(db, s, { tenantId: orgA })).toBeNull();
  });

  it("reads an organization's stop for that organization", async () => {
    const org = `ORG-BC-${rnd()}`;
    const s = await stop(await trip(org));
    await rawReceipt({ targetRecordId: s, json: manifestJson(ALL_CONFIRMED) });
    expect((await verdicts(s, { tenantId: org }))?.arrivedAt).toBe("confirmed");
  });

  it("refuses the same stop to a different organization", async () => {
    const org = `ORG-BC-${rnd()}`;
    const s = await stop(await trip(org));
    await rawReceipt({ targetRecordId: s, json: manifestJson(ALL_CONFIRMED) });
    expect(await boundaryEvidenceForStop(db, s, { tenantId: `ORG-BC-${rnd()}` })).toBeNull();
  });

  it("refuses an organization's stop to the historical single tenant", async () => {
    const org = `ORG-BC-${rnd()}`;
    const s = await stop(await trip(org));
    await rawReceipt({ targetRecordId: s, json: manifestJson(ALL_CONFIRMED) });
    expect(await boundaryEvidenceForStop(db, s, SINGLE)).toBeNull();
  });

  it("reads a trip stamped with the single tenant's own id, as tripInScope does", async () => {
    // orgScopeWhere admits NULL and the literal SINGLE_TENANT_ID alike for the single tenant.
    const s = await stop(await trip(SINGLE_TENANT_ID));
    await rawReceipt({ targetRecordId: s, json: manifestJson(ALL_CONFIRMED) });
    expect((await verdicts(s))?.arrivedAt).toBe("confirmed");
    expect(await boundaryEvidenceForStop(db, s, { tenantId: `ORG-BC-${rnd()}` })).toBeNull();
  });

  it("refuses a stop whose trip does not exist — no trip, no organization, no answer", async () => {
    // tripStops.tripId has no foreign key. An orphan stop belongs to no one.
    const s = await stop(2_147_000_000);
    await rawReceipt({ targetRecordId: s, json: manifestJson(ALL_CONFIRMED) });
    expect(await boundaryEvidenceForStop(db, s, SINGLE)).toBeNull();
  });

  it("answers a stop in another organization exactly as it answers one that does not exist", async () => {
    const org = `ORG-BC-${rnd()}`;
    const s = await stop(await trip(org));
    const outside = await boundaryEvidenceForStop(db, s, { tenantId: `ORG-BC-${rnd()}` });
    const missing = await boundaryEvidenceForStop(db, 2_147_000_000, { tenantId: org });
    expect(outside).toEqual(missing);
  });
});
