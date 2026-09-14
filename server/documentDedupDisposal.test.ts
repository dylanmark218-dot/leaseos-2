import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import {
  assessDuplicate,
  buildFingerprint,
  commitPermittedUnder,
  contentHash,
  type PriorCapture,
} from "./_core/documentFingerprint";
import { planAssistantCommit, type AssistantCommitContext } from "./_core/assistantCommitAdapters";
import type { CommittedField } from "./_core/aiProposal";
import { classifyDocument, extractToProposal } from "./_core/documentExtraction";
import {
  noteMerchantConfirmed,
  noteMerchantRejected,
  noteMerchantSeen,
  recallMerchant,
} from "./merchantMemoryService";

/* ------------------------------------------------------------------ */
/* Fingerprints                                                         */
/* ------------------------------------------------------------------ */

const prior = (over: Partial<PriorCapture> = {}): PriorCapture => ({
  fingerprintRef: "FP-1",
  contentSha256: null,
  structuredKeyHash: "x",
  targetType: null,
  targetRecordId: null,
  capturedAt: new Date("2026-09-09T10:00:00Z"),
  ...over,
});

describe("the same document photographed twice", () => {
  it("builds the same structured key from a different photo of the same receipt", () => {
    const a = buildFingerprint({ documentType: "expense_receipt", vendorName: "Petro-Canada #4471", transactionDate: "2026-09-09", total: 184.2 });
    const b = buildFingerprint({ documentType: "expense_receipt", vendorName: "PETRO CANADA 4471", transactionDate: "2026-09-09", total: 184.2 });
    // Punctuation and case in the vendor name must not fork the key.
    expect(a.structuredKeyHash).toBe(b.structuredKeyHash);
    expect(a.complete).toBe(true);
  });

  it("keys a disposal ticket on facility, ticket number AND load", () => {
    // The same facility ticket number legitimately recurs across years and
    // across facilities. It does not recur across loads.
    const sameLoad = buildFingerprint({ documentType: "disposal_ticket", facilityRef: "fac-12", facilityTicketNumber: "A 88431", loadRef: "LD-500" });
    const otherLoad = buildFingerprint({ documentType: "disposal_ticket", facilityRef: "fac-12", facilityTicketNumber: "A88431", loadRef: "LD-501" });
    expect(sameLoad.structuredKeyHash).not.toBe(otherLoad.structuredKeyHash);
    expect(sameLoad.structuredKey).toContain("A88431");
  });

  it("refuses to build a usable key from a receipt with no total", () => {
    // A total-less key would collide with every receipt from that vendor that day.
    const fp = buildFingerprint({ documentType: "expense_receipt", vendorName: "Shell", transactionDate: "2026-09-09", total: null });
    expect(fp.complete).toBe(false);
    expect(fp.missing).toEqual(["total"]);
  });

  it("calls identical bytes an exact duplicate with no judgement to make", () => {
    const bytes = Buffer.from("same-photo");
    const h = contentHash(bytes);
    const fp = buildFingerprint({ documentType: "expense_receipt", vendorName: "Shell", transactionDate: "2026-09-09", total: 50 });
    const v = assessDuplicate({ fingerprint: fp, contentSha256: h, priors: [prior({ contentSha256: h })] });
    expect(v.outcome).toBe("exact_duplicate");
    expect(commitPermittedUnder(v, true).permitted).toBe(false);
  });

  it("calls a matching key a possible duplicate, and a person decides", () => {
    const fp = buildFingerprint({ documentType: "expense_receipt", vendorName: "Shell", transactionDate: "2026-09-09", total: 50 });
    const v = assessDuplicate({
      fingerprint: fp,
      contentSha256: "different-bytes",
      priors: [prior({ structuredKeyHash: fp.structuredKeyHash, targetType: "expense_record", targetRecordId: 77 })],
    });
    expect(v.outcome).toBe("possible_duplicate");
    if (v.outcome === "possible_duplicate") expect(v.reason).toContain("expense_record #77");
    expect(commitPermittedUnder(v, false).permitted).toBe(false);
    expect(commitPermittedUnder(v, true).permitted).toBe(true);
    expect(commitPermittedUnder(v, true).reason).toContain("overridden by a person");
  });

  it("reports cannot-assess rather than unique when the key is incomplete", () => {
    const fp = buildFingerprint({ documentType: "expense_receipt", vendorName: "Shell", transactionDate: null, total: 50 });
    const v = assessDuplicate({ fingerprint: fp, priors: [] });
    expect(v.outcome).toBe("cannot_assess");
    // Not "unique". Not permitted either.
    expect(commitPermittedUnder(v, true).permitted).toBe(false);
  });

  it("lets a genuinely new document through", () => {
    const fp = buildFingerprint({ documentType: "expense_receipt", vendorName: "Shell", transactionDate: "2026-09-09", total: 50 });
    const v = assessDuplicate({ fingerprint: fp, contentSha256: "new", priors: [prior({ contentSha256: "old", structuredKeyHash: "other" })] });
    expect(v.outcome).toBe("unique");
    expect(commitPermittedUnder(v, false).permitted).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/* Disposal ticket adapter                                              */
/* ------------------------------------------------------------------ */

const ctx = (over: Partial<AssistantCommitContext> = {}): AssistantCommitContext => ({
  proposalId: "P-1",
  formKey: "disposal_ticket",
  targetRef: "LD-500",
  loadId: 500,
  facilityId: 12,
  utcOffsetMinutes: -360,
  actorUserId: 9,
  capturedAt: new Date(),
  ...over,
});

const cf = (key: string, value: string | number, confidence: "low" | "medium" | "high" = "high"): CommittedField => ({
  key, label: key, value, precision: "exact", source: "human_corrected", confidence, status: "confirmed", committedAt: new Date(),
});

const goodTicket = () => [
  cf("facilityName", "Northgate Disposal"),
  cf("facilityTicketNumber", "A-88431"),
  cf("loadRef", "LD-500"),
  cf("ticketDate", "2026-09-09"),
  cf("scaleInTime", "14:25"),
  cf("grossWeightKg", 41200),
  cf("tareWeightKg", 18400),
  cf("netWeightKg", 22800),
];

describe("a scanned disposal ticket lands as needs_review", () => {
  it("plans a needs_review ticket and never a verified one", () => {
    const plan = planAssistantCommit(ctx(), goodTicket());
    expect(plan.ok).toBe(true);
    if (!plan.ok || plan.intent.kind !== "disposal_ticket_create") throw new Error("wrong plan");
    expect(plan.intent.values.verificationStatus).toBe("needs_review");
    expect(plan.intent.values.source).toBe("photo_ocr");
    expect(plan.intent.requiredPermission).toBe("load.write");
    expect(plan.intent.values.netKg).toBe(22800);
    expect(plan.intent.values.quantityUnit).toBe("kg");
  });

  it("converts the scale-in time using the date and offset, like the unload stop", () => {
    const plan = planAssistantCommit(ctx(), goodTicket());
    if (!plan.ok || plan.intent.kind !== "disposal_ticket_create") throw new Error("wrong plan");
    // 14:25 at UTC-6 is 20:25Z.
    expect(plan.intent.values.scaleInAt?.toISOString()).toBe("2026-09-09T20:25:00.000Z");
  });

  it("refuses when load or facility were not resolved by the server", () => {
    expect(planAssistantCommit(ctx({ loadId: null }), goodTicket()).ok).toBe(false);
    const p = planAssistantCommit(ctx({ facilityId: 0 }), goodTicket());
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.refusals.join(" ")).toContain("facilityId resolved by the server");
  });

  it("refuses gross, tare and net that disagree beyond the scale's resolution", () => {
    const fields = goodTicket().map(f => (f.key === "netWeightKg" ? cf("netWeightKg", 21000) : f));
    const p = planAssistantCommit(ctx(), fields);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.refusals.join(" ")).toContain("does not equal net");
  });

  it("tolerates a 20 kg scale rounding difference", () => {
    const fields = goodTicket().map(f => (f.key === "netWeightKg" ? cf("netWeightKg", 22790) : f));
    expect(planAssistantCommit(ctx(), fields).ok).toBe(true);
  });

  it("refuses gross below tare — a misread, not a light load", () => {
    const fields = goodTicket().map(f => (f.key === "grossWeightKg" ? cf("grossWeightKg", 18000) : f));
    const p = planAssistantCommit(ctx(), fields);
    expect(p.ok).toBe(false);
    if (!p.ok) expect(p.refusals.join(" ")).toContain("less than tare");
  });

  it("derives net from gross and tare when net is absent", () => {
    const fields = goodTicket().filter(f => f.key !== "netWeightKg");
    const p = planAssistantCommit(ctx(), fields);
    if (!p.ok || p.intent.kind !== "disposal_ticket_create") throw new Error("wrong plan");
    expect(p.intent.values.netKg).toBe(22800);
  });

  it("accepts a volume-only ticket and refuses a ticket with no quantity at all", () => {
    const vol = [cf("facilityName", "F"), cf("facilityTicketNumber", "V1"), cf("loadRef", "LD-500"), cf("ticketDate", "2026-09-09"), cf("volumeM3", 8.4)];
    const p = planAssistantCommit(ctx(), vol);
    if (!p.ok || p.intent.kind !== "disposal_ticket_create") throw new Error("wrong plan");
    expect(p.intent.values.quantityUnit).toBe("m3");

    const none = vol.filter(f => f.key !== "volumeM3");
    const q = planAssistantCommit(ctx(), none);
    expect(q.ok).toBe(false);
    if (!q.ok) expect(q.refusals.join(" ")).toContain("needs a net weight, a volume, or gross and tare");
  });

  it("rates the record by its weakest weight, not its most confident field", () => {
    // A confident facility name does not make an uncertain net figure certain.
    const fields = goodTicket().map(f => (f.key === "netWeightKg" ? cf("netWeightKg", 22800, "low") : f));
    const p = planAssistantCommit(ctx(), fields);
    if (!p.ok || p.intent.kind !== "disposal_ticket_create") throw new Error("wrong plan");
    expect(p.intent.values.confidence).toBe("low");
  });

  it("refuses a ticket number no facility would print", () => {
    const fields = goodTicket().map(f => (f.key === "facilityTicketNumber" ? cf("facilityTicketNumber", "<script>") : f));
    expect(planAssistantCommit(ctx(), fields).ok).toBe(false);
  });
});

describe("both ticket types reach the one form", () => {
  it("maps a scale ticket and a disposal ticket to disposal_ticket", () => {
    for (const rawText of [
      "NORTHGATE DISPOSAL  MANIFEST 0091  FACILITY TICKET A-88431  8.4 m3",
      "GROSS 41200 KG  TARE 18400 KG  NET 22800 KG  SCALE 2",
    ]) {
      const c = classifyDocument({ ocr: { engine: "t", rawText, fields: [] } });
      const out = extractToProposal({ ocr: { engine: "t", rawText, fields: [] }, classification: c });
      expect(out.refusal, rawText).toBeUndefined();
      expect(out.formKey, rawText).toBe("disposal_ticket");
    }
  });

  it("asks a question for every weight even at high confidence", () => {
    const ocr = {
      engine: "t",
      rawText: "GROSS 41200 KG TARE 18400 KG NET 22800 KG SCALE",
      documentTypeHint: "scale_ticket" as const,
      documentTypeConfidence: 99,
      fields: [
        { key: "grossWeightKg", confidence: 99, value: 41200 },
        { key: "tareWeightKg", confidence: 99, value: 18400 },
        { key: "netWeightKg", confidence: 99, value: 22800 },
        { key: "facilityName", confidence: 99, value: "Northgate" },
      ],
    };
    const out = extractToProposal({ ocr, classification: classifyDocument({ ocr }) });
    const asked = out.questions.map(q => q.fieldKey);
    for (const k of ["grossWeightKg", "tareWeightKg", "netWeightKg"]) expect(asked, k).toContain(k);
    expect(asked).not.toContain("facilityName");
    expect(out.counts.humanOnly).toBeGreaterThanOrEqual(3);
  });
});

/* ------------------------------------------------------------------ */
/* Merchant memory, persisted                                           */
/* ------------------------------------------------------------------ */

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;

beforeAll(async () => {
  if (!URL) return;
  pool = mysql.createPool({ uri: URL, connectionLimit: 4 });
  await pool.execute("DELETE FROM merchantMemory");
});

d("merchant memory earns trust from confirmations", () => {
  it("recalls nothing for a vendor only ever seen", async () => {
    for (let i = 0; i < 40; i++) await noteMerchantSeen("Husky Cardlock 22", "fuel_receipt");
    expect(await recallMerchant("HUSKY CARDLOCK #22")).toBeNull();
  });

  it("recalls a vendor after confirmations, with a category", async () => {
    for (let i = 0; i < 6; i++) await noteMerchantConfirmed("Petro-Canada 4471", "fuel_receipt", "fuel");
    const r = await recallMerchant("petro canada 4471");
    expect(r).not.toBeNull();
    expect(r!.documentType).toBe("fuel_receipt");
    expect(r!.categoryKey).toBe("fuel");
    expect(r!.confidence).toBeGreaterThan(0);
  });

  it("stops trusting a vendor whose classification keeps being corrected", async () => {
    for (let i = 0; i < 3; i++) await noteMerchantConfirmed("Ambiguous Supply", "expense_receipt");
    const before = await recallMerchant("Ambiguous Supply");
    for (let i = 0; i < 3; i++) await noteMerchantRejected("Ambiguous Supply", "expense_receipt");
    const after = await recallMerchant("Ambiguous Supply");
    expect(before).not.toBeNull();
    expect(after).toBeNull();
  });

  it("keeps one row per vendor per document type", async () => {
    await noteMerchantConfirmed("Dual Vendor", "expense_receipt");
    await noteMerchantConfirmed("Dual Vendor", "fuel_receipt");
    await noteMerchantConfirmed("dual vendor", "fuel_receipt");
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT documentType, confirmedCount FROM merchantMemory WHERE vendorNormalized = 'dual vendor' ORDER BY documentType"
    );
    expect(rows.map(r => [r.documentType, r.confirmedCount])).toEqual([["expense_receipt", 1], ["fuel_receipt", 2]]);
  });
});
