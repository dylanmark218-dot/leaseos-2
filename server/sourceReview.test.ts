/**
 * v22.20 — clearing a source is an act, and the attribution barrier is real.
 *
 * Nothing in this file asserts that any licence says anything. It asserts that
 * a person's review is recorded, that the barrier holds, and that the gate
 * moves only when a person moves it.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole, seedExternalDataSources } from "./db";
import { SENSITIVE_PERMISSIONS, type DomainRole } from "./_core/recordsAuthorization";

describe("clearing a source is a sensitive determination", () => {
  it("fails closed", () => {
    expect(SENSITIVE_PERMISSIONS).toContain("geo.source.review");
  });
});

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 7_800_000 + Math.floor(Math.random() * 60_000);
beforeAll(async () => {
  if (!URL) return;
  pool = mysql.createPool({ uri: URL, connectionLimit: 4 });
  // Establish the registry rather than assume some other test seeded it.
  await seedExternalDataSources();
});
const caller = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });
async function withRole(role: DomainRole) { const id = seq++; await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() }); return id; }

d("the licence review", () => {
  it("refuses to clear a source whose required attribution nobody has recorded", async () => {
    const controller = await withRole("controller");
    await pool.execute("UPDATE externalDataSources SET status='unverified', attributionText=NULL WHERE sourceKey='statcan_boundaries'");
    await expect(caller(controller).geo.sourceReview({
      sourceKey: "statcan_boundaries", decision: "clear",
      licenceName: "a licence the reviewer read",
      reviewNote: "Read the terms on the publisher's page and recorded them here.",
    })).rejects.toThrow(/requires attribution and none is recorded/i);

    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT status FROM externalDataSources WHERE sourceKey='statcan_boundaries'");
    expect(rows[0].status).toBe("unverified");
  });

  it("clears it once a person records the attribution and the licence, and says who and when", async () => {
    const controller = await withRole("controller");
    await pool.execute("UPDATE externalDataSources SET status='unverified', attributionText=NULL, reviewedByUserId=NULL WHERE sourceKey='statcan_boundaries'");
    const r = await caller(controller).geo.sourceReview({
      sourceKey: "statcan_boundaries", decision: "clear",
      licenceName: "the licence named on the publisher's page",
      licenceUrl: "https://example.invalid/terms",
      attributionText: "the attribution string the publisher requires",
      commercialUsePermitted: "yes", redistributionPermitted: "yes",
      reviewNote: "Opened the publisher's licence page, recorded its attribution requirement verbatim.",
    });
    expect(r).toMatchObject({ status: "verified", commercialUsePermitted: "yes" });
    expect(r.note).toContain("not a statement that the data is correct");

    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT status, reviewedByUserId, reviewNote, attributionText, verifiedAt FROM externalDataSources WHERE sourceKey='statcan_boundaries'");
    expect(rows[0]).toMatchObject({ status: "verified", reviewedByUserId: controller });
    expect(rows[0].attributionText).toBe("the attribution string the publisher requires");
    expect(rows[0].reviewNote).toContain("recorded its attribution requirement");
    expect(rows[0].verifiedAt).toBeTruthy();
  });

  it("records a refusal as a review too, so 'nobody has looked' and 'somebody looked and said no' are different", async () => {
    const controller = await withRole("controller");
    const r = await caller(controller).geo.sourceReview({
      sourceKey: "ised_b1_western", decision: "refuse",
      reviewNote: "Page-specific reuse terms are not stated; not cleared for redistribution.",
    });
    expect(r.status).toBe("unverified");
    const [rows] = await pool.execute<mysql.RowDataPacket[]>("SELECT reviewedByUserId, reviewNote FROM externalDataSources WHERE sourceKey='ised_b1_western'");
    expect(rows[0].reviewedByUserId).toBe(controller);
    expect(rows[0].reviewNote).toContain("not stated");
  });

  it("refuses a source nobody registered, rather than creating one on the way past", async () => {
    const controller = await withRole("controller");
    await expect(caller(controller).geo.sourceReview({ sourceKey: "not_a_source", decision: "clear", reviewNote: "some note that is long enough" }))
      .rejects.toThrow(/No source not_a_source/i);
  });

  it("is refused to a dispatcher, who may read the registry and not decide it", async () => {
    const dispatcher = await withRole("dispatcher");
    await expect(caller(dispatcher).geo.sourceReview({ sourceKey: "statcan_boundaries", decision: "refuse", reviewNote: "a note that is long enough to pass" }))
      .rejects.toThrow();
  });
});
