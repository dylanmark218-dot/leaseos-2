/**
 * v23.28 — the scanning surface through the real router: who may call it, which organization it
 * answers for, and what it refuses to decide.
 *
 * The pure engines are exercised in `documentScanner.test.ts`. What only a real caller can prove
 * is the part the device cannot be trusted with: that authorization is enforced server-side, that
 * a caller acting for two organizations is refused rather than resolved, and that the tracking
 * formats come from the office's own configuration rather than from the request.
 */
import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { appRouter } from "./routers";
import { grantUserRole } from "./db";
import type { DomainRole } from "./_core/recordsAuthorization";
import { DEFAULT_FORMAT, formatTrackingNumber } from "./_core/trackingNumbers";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 41_000_000 + Math.floor(Math.random() * 60_000);
beforeAll(async () => { if (!URL) return; pool = mysql.createPool({ uri: URL, connectionLimit: 4 }); });

const caller = (id: number) => appRouter.createCaller({ req: {} as never, res: {} as never, user: { id, role: "user" } as never });
async function withRole(role: DomainRole) {
  const id = seq++;
  await grantUserRole({ userId: id, role, scopeType: "global", grantedByUserId: 1, grantedAt: new Date() });
  return id;
}
const rnd = () => Math.random().toString(36).slice(2, 8).toUpperCase();

/** One configured sequence, as the office would have it. */
async function sequenceRow(sequenceType: string, prefix: string, over: Partial<{ sequenceDigits: number; separator: string; yearDigits: number }> = {}) {
  await pool.execute(
    `INSERT INTO trackingSequences (sequenceType, branch, periodKey, nextNumber, prefix, \`separator\`, yearDigits, includeMonth, sequenceDigits, resetPeriod, updatedAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,NOW())`,
    [sequenceType, null, "2026", 1, prefix, over.separator ?? "-", over.yearDigits ?? 4, 0, over.sequenceDigits ?? 6, "yearly"],
  );
}

async function organization(name: string) {
  const ref = `ORG-${rnd()}${rnd()}`;
  await pool.execute("INSERT INTO organizations (orgRef, name, status, createdAt) VALUES (?,?,?,NOW())", [ref, name, "active"]);
  return ref;
}
async function membership(userId: number, orgRef: string) {
  await pool.execute(
    `INSERT INTO organizationMemberships (membershipRef, orgRef, userId, membershipType, status, effectiveFrom, createdByUserId, createdAt)
     VALUES (?,?,?,?,?,NOW(),?,NOW())`,
    [`MEM-${rnd()}${rnd()}`, orgRef, userId, "employee", "active", 1],
  );
}

const PAGE = {
  pageIndex: 0, contentHash: "h".repeat(64), qualityVerdict: "acceptable" as const, qualityFailures: [],
  acceptedOverObjection: false, ocrAttempted: true, ocrMeanConfidence: 95, ocrText: null, barcodes: null,
};

d("the scanning surface is gated server-side", () => {
  it("lets a driver read paperwork guidance, because the ticket is in their hand", async () => {
    const driver = await withRole("driver");
    const r = await caller(driver).scanning.guidance({ kind: "disposal_ticket", observations: [] });
    expect(r.guidance.kind).toBe("disposal_ticket");
    expect(r.guidance.verification).toBe("unverified");
  });

  it("refuses a role that holds no paperwork permission", async () => {
    const payroll = await withRole("payroll_admin");
    await expect(caller(payroll).scanning.guidance({ kind: "disposal_ticket", observations: [] })).rejects.toThrow();
  });

  it("refuses an anonymous caller outright", async () => {
    const anon = appRouter.createCaller({ req: {} as never, res: {} as never, user: null as never });
    await expect(anon.scanning.guidance({ kind: "disposal_ticket", observations: [] })).rejects.toThrow();
  });

  it("refuses a caller acting for two organizations rather than picking one", async () => {
    const office = await withRole("office");
    await membership(office, await organization(`A ${rnd()}`));
    await membership(office, await organization(`B ${rnd()}`));
    // reviewScan reads rows, so it resolves the acting scope — and that resolution refuses.
    await expect(caller(office).scanning.reviewScan({
      kind: "disposal_ticket", pages: [PAGE], observations: [],
    })).rejects.toThrow();
  });

  it("still answers the pure guidance question for that caller, because it reads nobody's rows", async () => {
    const office = await withRole("office");
    await membership(office, await organization(`A ${rnd()}`));
    await membership(office, await organization(`B ${rnd()}`));
    const r = await caller(office).scanning.guidance({ kind: "invoice", observations: [] });
    expect(r.guidance.kind).toBe("invoice");
  });
});

d("the matcher follows the office's configuration, not the request", () => {
  it("proposes a link using the configured format", async () => {
    const office = await withRole("office");
    const prefix = `D${rnd().slice(0, 3)}`;
    await sequenceRow("DSP", prefix);
    const minted = formatTrackingNumber({ ...DEFAULT_FORMAT, prefix }, new Date("2026-09-21T00:00:00Z"), 123);

    const r = await caller(office).scanning.reviewScan({
      kind: "disposal_ticket",
      pages: [{ ...PAGE, ocrText: `Facility ticket ${minted}` }],
      observations: [],
    });
    expect(r.links.disposition).toBe("propose_single");
    expect(r.links.best?.trackingNumber).toBe(minted);
  });

  it("stops matching when the office widens the sequence, instead of using a stale pattern", async () => {
    const office = await withRole("office");
    const prefix = `W${rnd().slice(0, 3)}`;
    // Configured at seven digits; a six-digit number must NOT match it.
    await sequenceRow("DSP", prefix, { sequenceDigits: 7 });
    const sixDigit = formatTrackingNumber({ ...DEFAULT_FORMAT, prefix }, new Date("2026-09-21T00:00:00Z"), 123);

    const r = await caller(office).scanning.reviewScan({
      kind: "disposal_ticket", pages: [{ ...PAGE, ocrText: `ticket ${sixDigit}` }], observations: [],
    });
    expect(r.links.best).toBeNull();
  });

  it("takes no tracking pattern from the caller at all", async () => {
    const office = await withRole("office");
    const injected = `INJ${rnd().slice(0, 3)}`;
    const wouldMatch = formatTrackingNumber({ ...DEFAULT_FORMAT, prefix: injected }, new Date("2026-09-21T00:00:00Z"), 7);

    // A caller supplying their own binding gets it STRIPPED by the input schema rather than
    // honoured — zod drops unknown keys — so the number only they could match is not matched.
    // Asserted by behaviour rather than by hoping nobody adds the field later.
    const r = await caller(office).scanning.reviewScan({
      kind: "disposal_ticket",
      pages: [{ ...PAGE, ocrText: `ticket ${wouldMatch}` }],
      observations: [],
      trackingBindings: [{ target: "disposal", format: { ...DEFAULT_FORMAT, prefix: injected } }],
    } as never);
    expect(r.links.candidates.map(c => c.trackingNumber)).not.toContain(wouldMatch);
    expect(r.links.best?.trackingNumber ?? null).not.toBe(wouldMatch);
  });
});

d("the surface decides nothing it is not allowed to decide", () => {
  it("returns an unverified verdict and the caveat rather than asserting statutory compliance", async () => {
    const office = await withRole("office");
    const r = await caller(office).scanning.retention({ kind: "disposal_ticket" });
    expect(r.guidanceVerification).toBe("unverified");
    expect(r.policy.statutorySourceStatus).toBe("unverified");
    expect(r.effective.statutoryBackingVerified).toBe(false);
    expect(r.effective.caveat).toContain("statutory compliance not asserted");
    expect(r.legalHoldConsulted).toBe(false);
  });

  it("refuses to print a regulatory document whose required values are only proposed", async () => {
    const driver = await withRole("driver");
    const r = await caller(driver).scanning.guidance({
      kind: "tdg_shipping_document",
      observations: [{ key: "un_number", status: "proposed" }, { key: "shipping_name", status: "proposed" }],
    });
    expect(r.printability.verdict).toBe("refused");
  });

  it("sends an ambiguous page to review instead of naming one record", async () => {
    const office = await withRole("office");
    const dsp = `A${rnd().slice(0, 3)}`, job = `B${rnd().slice(0, 3)}`;
    await sequenceRow("DSP", dsp);
    await sequenceRow("FT", job);
    const at = new Date("2026-09-21T00:00:00Z");
    const one = formatTrackingNumber({ ...DEFAULT_FORMAT, prefix: dsp }, at, 1);
    const two = formatTrackingNumber({ ...DEFAULT_FORMAT, prefix: job }, at, 2);

    const r = await caller(office).scanning.reviewScan({
      kind: "disposal_ticket", pages: [{ ...PAGE, ocrText: `${one} and ${two}` }], observations: [],
    });
    expect(r.links.disposition).toBe("requires_review");
    expect(r.links.best).toBeNull();
  });
});
