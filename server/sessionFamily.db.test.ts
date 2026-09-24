/**
 * S1-C / S1-D — rotation, reuse detection and revocation, against a real database.
 *
 * The pure rules are pinned in `_core/sessionFamily.test.ts`. What has to be proved here is that the
 * persisted path obeys them: that a verifier really is single-use, that presenting a retired one
 * really does kill the family rather than merely failing, and that logout really revokes rather
 * than clearing a cookie and hoping — which is what the system did before S1.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { hashVerifier, REFRESH_ABSOLUTE_TTL_MS } from "./_core/sessionFamily";
import {
  createSessionFamily,
  redeemRefresh,
  revokeAllForOpenId,
  revokeFamily,
} from "./sessionFamilyService";

const DB_URL = process.env.DATABASE_URL;

describe("session family — preconditions", () => {
  it("runs against a real database", () => {
    expect(DB_URL, "DATABASE_URL must be set: a skipped session suite proves nothing").toBeTruthy();
  });
});

const d = DB_URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 0;
const openId = () => `s1-user-${Date.now()}-${seq++}`;

beforeAll(() => { if (DB_URL) pool = mysql.createPool({ uri: DB_URL, connectionLimit: 4 }); });
afterAll(async () => { await pool?.end(); });

const rowFor = async (familyRef: string) => {
  const [r] = await pool.query<mysql.RowDataPacket[]>(
    "SELECT * FROM sessionFamilies WHERE familyRef = ?", [familyRef]);
  return r[0]!;
};

/* ── C1/C2. rotation ────────────────────────────────────────────────────────── */

d("C1/C2 — a refresh works once and rotates", () => {
  it("C1. redeems a fresh verifier", async () => {
    const f = await createSessionFamily({ openId: openId(), appId: "app-a" });
    const out = await redeemRefresh(f.familyRef, f.verifier, new Date());
    expect(out.kind).toBe("ok");
  });

  it("C2. replaces the verifier and advances the counter", async () => {
    const f = await createSessionFamily({ openId: openId(), appId: "app-a" });
    const before = await rowFor(f.familyRef);
    const out = await redeemRefresh(f.familyRef, f.verifier, new Date());
    if (out.kind !== "ok") throw new Error("expected ok");

    expect(out.verifier).not.toBe(f.verifier);
    const after = await rowFor(f.familyRef);
    expect(after.refreshVerifierHash).not.toBe(before.refreshVerifierHash);
    expect(after.refreshVerifierHash).toBe(hashVerifier(out.verifier));
    expect(after.rotationCounter).toBe(before.rotationCounter + 1);
  });

  it("C2b. never writes the verifier itself", async () => {
    const f = await createSessionFamily({ openId: openId(), appId: "app-a" });
    const row = await rowFor(f.familyRef);
    // Every column, not just the one we expect to hold it.
    expect(JSON.stringify(row).includes(f.verifier)).toBe(false);
    expect(row.refreshVerifierHash).toBe(hashVerifier(f.verifier));
  });
});

/* ── C3/C4. reuse is a theft signal ─────────────────────────────────────────── */

d("C3/C4 — a retired verifier kills the family", () => {
  it("C3. refuses the previous verifier after a rotation", async () => {
    const f = await createSessionFamily({ openId: openId(), appId: "app-a" });
    await redeemRefresh(f.familyRef, f.verifier, new Date());
    const again = await redeemRefresh(f.familyRef, f.verifier, new Date());
    expect(again.kind).toBe("reuse_detected");
  });

  /*
   * The point of rotation. Two parties holding one credential is the signature of a theft, so the
   * family dies — refusing only that request would leave the thief and the user racing for the
   * next rotation.
   */
  it("C4. revokes the whole family on reuse, with the reason recorded", async () => {
    const f = await createSessionFamily({ openId: openId(), appId: "app-a" });
    const first = await redeemRefresh(f.familyRef, f.verifier, new Date());
    if (first.kind !== "ok") throw new Error("expected ok");

    await redeemRefresh(f.familyRef, f.verifier, new Date());   // the stolen, retired one

    const row = await rowFor(f.familyRef);
    expect(row.revokedAt).not.toBeNull();
    expect(row.revokeReason).toBe("reuse_detected");
  });

  it("C4b. the legitimate current verifier stops working once reuse killed the family", async () => {
    const f = await createSessionFamily({ openId: openId(), appId: "app-a" });
    const first = await redeemRefresh(f.familyRef, f.verifier, new Date());
    if (first.kind !== "ok") throw new Error("expected ok");
    await redeemRefresh(f.familyRef, f.verifier, new Date());   // reuse → family dies

    const out = await redeemRefresh(f.familyRef, first.verifier, new Date());
    expect(out.kind).toBe("revoked");
  });
});

/* ── C5. the absolute ceiling ───────────────────────────────────────────────── */

d("C5 — thirty days is a ceiling, not a rolling window", () => {
  it("refuses a correct verifier past the absolute expiry", async () => {
    const f = await createSessionFamily({ openId: openId(), appId: "app-a" });
    const later = new Date(Date.now() + REFRESH_ABSOLUTE_TTL_MS + 60_000);
    expect((await redeemRefresh(f.familyRef, f.verifier, later)).kind).toBe("expired");
  });

  it("rotation does not push the ceiling outward", async () => {
    const f = await createSessionFamily({ openId: openId(), appId: "app-a" });
    const before = await rowFor(f.familyRef);
    const out = await redeemRefresh(f.familyRef, f.verifier, new Date());
    if (out.kind !== "ok") throw new Error("expected ok");
    const after = await rowFor(f.familyRef);
    expect(new Date(after.absoluteExpiresAt).getTime())
      .toBe(new Date(before.absoluteExpiresAt).getTime());
  });
});

/* ── D. revocation ──────────────────────────────────────────────────────────── */

d("D — revocation is real, not a cleared cookie", () => {
  it("D1. logout revokes the family, so the refresh is dead", async () => {
    const f = await createSessionFamily({ openId: openId(), appId: "app-a" });
    await revokeFamily(f.familyRef, "logout");
    expect((await redeemRefresh(f.familyRef, f.verifier, new Date())).kind).toBe("revoked");
    expect((await rowFor(f.familyRef)).revokeReason).toBe("logout");
  });

  it("D2. revoke-all kills every family for that account", async () => {
    const who = openId();
    const a = await createSessionFamily({ openId: who, appId: "app-a" });
    const b = await createSessionFamily({ openId: who, appId: "app-a" });
    const other = await createSessionFamily({ openId: openId(), appId: "app-a" });

    await revokeAllForOpenId(who, "revoked_all");

    expect((await redeemRefresh(a.familyRef, a.verifier, new Date())).kind).toBe("revoked");
    expect((await redeemRefresh(b.familyRef, b.verifier, new Date())).kind).toBe("revoked");
    // and nobody else's
    expect((await redeemRefresh(other.familyRef, other.verifier, new Date())).kind).toBe("ok");
  });

  it("D3. revoking one family leaves this account's others alone", async () => {
    const who = openId();
    const a = await createSessionFamily({ openId: who, appId: "app-a" });
    const b = await createSessionFamily({ openId: who, appId: "app-a" });
    await revokeFamily(a.familyRef, "device_revoked");
    expect((await redeemRefresh(b.familyRef, b.verifier, new Date())).kind).toBe("ok");
  });

  it("D4. an unknown family is refused rather than treated as fresh", async () => {
    expect((await redeemRefresh("SF-does-not-exist", "anything", new Date())).kind)
      .toBe("reuse_detected");
  });
});

/* ── F. app binding, carried down to the refresh ────────────────────────────── */

d("F — a family belongs to the surface it was minted for", () => {
  it("F2. a refresh cannot cross appId", async () => {
    const f = await createSessionFamily({ openId: openId(), appId: "app-a" });
    const out = await redeemRefresh(f.familyRef, f.verifier, new Date(), { appId: "app-b" });
    expect(out.kind).toBe("reuse_detected");
  });

  it("F2b. the matching appId still refreshes", async () => {
    const f = await createSessionFamily({ openId: openId(), appId: "app-a" });
    expect((await redeemRefresh(f.familyRef, f.verifier, new Date(), { appId: "app-a" })).kind)
      .toBe("ok");
  });

  it("F3. assurance is recorded at creation and survives rotation", async () => {
    const f = await createSessionFamily({
      openId: openId(), appId: "app-a", authAssurance: "mfa", mfaCompletedAt: new Date(),
    });
    expect((await rowFor(f.familyRef)).authAssurance).toBe("mfa");
    await redeemRefresh(f.familyRef, f.verifier, new Date());
    const after = await rowFor(f.familyRef);
    expect(after.authAssurance).toBe("mfa");
    expect(after.mfaCompletedAt).not.toBeNull();
  });

  it("F3b. a single-factor session is distinguishable from one that did MFA", async () => {
    const f = await createSessionFamily({ openId: openId(), appId: "app-a" });
    expect((await rowFor(f.familyRef)).authAssurance).toBe("single_factor");
    expect((await rowFor(f.familyRef)).mfaCompletedAt).toBeNull();
  });
});
