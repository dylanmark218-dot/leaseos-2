/**
 * The page scanner, from the hardware boundary to the guidance a person reads.
 *
 * The cases worth having here are the ones where a scanner is tempted to be
 * convenient: a frame nobody measured passing as a good one, an OCR read
 * arriving as a fact, a tracking number invented out of six corrections, a
 * document with no requirements because nobody looked them up.
 */
import { describe, expect, it } from "vitest";

import {
  MemoryKeystore, MemoryStore, MemoryVault, ScriptedBarcodeScanner, ScriptedDocumentScanner,
  ScriptedOcrEngine, SettableClock, UnavailableBarcodeScanner, UnavailableDocumentScanner,
  UnavailableOcrEngine,
} from "../client/src/runtime/adapters/memory";
import {
  NATIVE_ONLY_CAPABILITIES, capacitorBarcodeScanner, capacitorDocumentScanner, capacitorOcrEngine,
} from "../client/src/runtime/adapters/capacitor";
import { NotOnDeviceError, type CaptureQualitySignals, type DeviceOcrResult, type ScannedPage } from "../client/src/runtime/contracts";
import { QUALITY_FLOORS, assessPageQuality, sessionQualityVerdict } from "../client/src/runtime/captureQuality";
import { ScanCancelled, ScanSession, ScannerUnavailable, captureKindForScan, type ScanDocumentKind } from "../client/src/runtime/scanSession";
import { Outbox } from "../client/src/runtime/outbox";
import { captureSyncPriority } from "../client/src/runtime/syncEngine";
import { sha256Hex } from "../client/src/runtime/crypto";

import {
  ITC_TIER_CENTS, OPERATOR_SELECTED_KINDS, PAPERWORK_GUIDANCE, guidanceFor, itcTierFor,
  longestRetentionYears, paperworkChecklist, type PaperworkKind,
} from "./_core/documentGuidance";
import { DEFAULT_FORMAT, formatTrackingNumber, type SequenceFormat } from "./_core/trackingNumbers";
import { patternMatchesOwnOutput, proposeLinks, trackingNumberPattern, type TrackingBinding } from "./_core/scanAutoLink";
import { reviewScan, type ScannedPageSummary } from "./_core/scanReview";

/* ------------------------------------------------------------------ */
/* Fixtures                                                            */
/* ------------------------------------------------------------------ */

const GOOD: CaptureQualitySignals = {
  widthPx: 1700, heightPx: 2200, focusScore: 88, glarePercent: 2, edgeConfidence: 95, pageCoveragePercent: 80,
};
const UNREPORTED: CaptureQualitySignals = {
  widthPx: null, heightPx: null, focusScore: null, glarePercent: null, edgeConfidence: null, pageCoveragePercent: null,
};

const pageBytes = (seed: string) => new TextEncoder().encode(`page:${seed}`);

const page = (seed: string, quality: CaptureQualitySignals = GOOD, mimeType = "image/jpeg"): ScannedPage =>
  ({ bytes: pageBytes(seed), mimeType, quality });

const ocr = (text: string, mean: number | null = 92): DeviceOcrResult => ({
  engine: "mlkit-text-recognition", engineVersion: "v2", rawText: text,
  blocks: [{ text, confidence: mean }], meanConfidence: mean,
});

async function scriptOcr(entries: [ScannedPage, DeviceOcrResult][]) {
  const m = new Map<string, DeviceOcrResult>();
  for (const [p, r] of entries) m.set(await sha256Hex(p.bytes), r);
  return new ScriptedOcrEngine(m);
}

async function scriptBarcodes(entries: [ScannedPage, { format: string; value: string }[]][]) {
  const m = new Map<string, { format: string; value: string }[]>();
  for (const [p, r] of entries) m.set(await sha256Hex(p.bytes), r);
  return new ScriptedBarcodeScanner(m);
}

function deviceWith(scanner: ScriptedDocumentScanner, ocrEngine = new ScriptedOcrEngine(new Map()), barcodes = new ScriptedBarcodeScanner(new Map())) {
  const clock = new SettableClock(new Date("2026-09-21T15:00:00Z"));
  const keystore = new MemoryKeystore(clock);
  const vault = new MemoryVault(keystore);
  const store = new MemoryStore();
  const outbox = new Outbox(store, vault, clock);
  return { session: new ScanSession({ scanner, ocr: ocrEngine, barcodes, outbox, clock }), outbox, store, vault, clock };
}

const DISPOSAL_FORMAT: SequenceFormat = { ...DEFAULT_FORMAT, prefix: "DISP" };
const JOB_FORMAT: SequenceFormat = { ...DEFAULT_FORMAT, prefix: "JOB" };
const BINDINGS: TrackingBinding[] = [
  { target: "disposal", format: DISPOSAL_FORMAT },
  { target: "job", format: JOB_FORMAT },
];

/* ------------------------------------------------------------------ */
/* The hardware boundary                                               */
/* ------------------------------------------------------------------ */

describe("the hardware boundary is declared, not faked", () => {
  it("refuses each native binding off a device rather than returning something plausible", async () => {
    await expect(capacitorDocumentScanner().open()).rejects.toThrow(NotOnDeviceError);
    await expect(capacitorOcrEngine().open()).rejects.toThrow(NotOnDeviceError);
    await expect(capacitorBarcodeScanner().open()).rejects.toThrow(NotOnDeviceError);
  });

  it("reports the plugins as absent in this container", async () => {
    expect(await capacitorDocumentScanner().available()).toBe(false);
    expect(await capacitorOcrEngine().available()).toBe(false);
    expect(await capacitorBarcodeScanner().available()).toBe(false);
  });

  it("names the three scanner capabilities as native-only", () => {
    expect(NATIVE_ONLY_CAPABILITIES).toContain("document_scanner");
    expect(NATIVE_ONLY_CAPABILITIES).toContain("on_device_ocr");
    expect(NATIVE_ONLY_CAPABILITIES).toContain("barcode_scanner");
  });

  it("has no in-memory recognizer, because an invented read is indistinguishable from a real one downstream", async () => {
    await expect(new UnavailableOcrEngine().recognize()).rejects.toThrow(NotOnDeviceError);
    await expect(new UnavailableDocumentScanner().scan()).rejects.toThrow(NotOnDeviceError);
    await expect(new UnavailableBarcodeScanner().scanImage()).rejects.toThrow(NotOnDeviceError);
    expect(await new UnavailableOcrEngine().available()).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* The quality gate                                                    */
/* ------------------------------------------------------------------ */

describe("the capture quality gate", () => {
  it("accepts a well-photographed page", () => {
    const a = assessPageQuality(GOOD);
    expect(a.verdict).toBe("acceptable");
    expect(a.failures).toEqual([]);
    expect(a.unreported).toEqual([]);
  });

  it("does not call an unmeasured frame acceptable", () => {
    const a = assessPageQuality(UNREPORTED);
    expect(a.verdict).toBe("unjudged");
    expect(a.verdict).not.toBe("acceptable");
    expect(a.unreported).toHaveLength(5);
    expect(a.advice).toContain("not checked");
  });

  it("judges only the signals the platform reported", () => {
    const a = assessPageQuality({ ...UNREPORTED, focusScore: 90 });
    // One signal reported and passing is a pass on what was measured, and the
    // four nobody measured are still named.
    expect(a.verdict).toBe("acceptable");
    expect(a.unreported).toEqual(["resolution", "glare", "edges", "coverage"]);
    expect(a.advice).toContain("reports nothing about");
  });

  it("names the number and the floor rather than showing a red border", () => {
    const a = assessPageQuality({ ...GOOD, focusScore: 30 });
    expect(a.verdict).toBe("reshoot");
    expect(a.failures[0]!.signal).toBe("focus");
    expect(a.failures[0]!.observed).toBe(30);
    expect(a.failures[0]!.floor).toBe(QUALITY_FLOORS.minFocusScore);
    expect(a.advice).toContain("30");
    expect(a.advice).toContain(String(QUALITY_FLOORS.minFocusScore));
  });

  it("gives one instruction and counts the rest, because five faults get none of them fixed", () => {
    const a = assessPageQuality({ widthPx: 400, heightPx: 500, focusScore: 10, glarePercent: 60, edgeConfidence: 10, pageCoveragePercent: 5 });
    expect(a.verdict).toBe("reshoot");
    expect(a.failures.length).toBeGreaterThan(3);
    expect(a.advice).toContain("other issue");
    // Focus outranks the rest: it is the one that changes what the hands do.
    expect(a.advice.startsWith("focus")).toBe(true);
  });

  it("catches each floor independently", () => {
    expect(assessPageQuality({ ...GOOD, widthPx: 500, heightPx: 700 }).failures[0]!.signal).toBe("resolution");
    expect(assessPageQuality({ ...GOOD, glarePercent: 40 }).failures[0]!.signal).toBe("glare");
    expect(assessPageQuality({ ...GOOD, edgeConfidence: 10 }).failures[0]!.signal).toBe("edges");
    expect(assessPageQuality({ ...GOOD, pageCoveragePercent: 5 }).failures[0]!.signal).toBe("coverage");
  });

  it("takes a session's verdict from its worst page, and calls no pages unjudged rather than acceptable", () => {
    expect(sessionQualityVerdict([])).toBe("unjudged");
    expect(sessionQualityVerdict([assessPageQuality(GOOD), assessPageQuality(GOOD)])).toBe("acceptable");
    expect(sessionQualityVerdict([assessPageQuality(GOOD), assessPageQuality(UNREPORTED)])).toBe("unjudged");
    expect(sessionQualityVerdict([assessPageQuality(UNREPORTED), assessPageQuality({ ...GOOD, focusScore: 2 })])).toBe("reshoot");
  });
});

/* ------------------------------------------------------------------ */
/* The session                                                         */
/* ------------------------------------------------------------------ */

describe("a scan reaching the outbox", () => {
  it("hashes the bytes the scanner handed back, and stores those bytes unchanged", async () => {
    const p = page("ticket-1");
    const { session, vault } = deviceWith(new ScriptedDocumentScanner([[p]]));
    const draft = await session.capture();

    expect(draft.pages).toHaveLength(1);
    expect(draft.pages[0]!.contentHash).toBe(await sha256Hex(p.bytes));

    const capture = await session.finalize({ draft, documentKind: "disposal_ticket", title: "Facility ticket", jobId: 7 });
    expect(capture.files).toHaveLength(1);
    expect(capture.files[0]!.contentHash).toBe(await sha256Hex(p.bytes));
    // The vault holds the original, not a re-encoding of it.
    expect(await vault.get(capture.files[0]!.vaultRef)).toEqual(p.bytes);
  });

  it("treats backing out of the scanner as an ordinary outcome", async () => {
    const { session } = deviceWith(new ScriptedDocumentScanner([null]));
    await expect(session.capture()).rejects.toThrow(ScanCancelled);
  });

  it("says plainly that the device has no scanner rather than failing later", async () => {
    const { session } = deviceWith(new ScriptedDocumentScanner([[page("x")]], false));
    await expect(session.capture()).rejects.toThrow(ScannerUnavailable);
    await expect(session.capture()).rejects.toThrow(/no document scanner/i);
  });

  it("still captures and queues when nothing on the device can read the page", async () => {
    const p = page("unreadable");
    const { session } = deviceWith(
      new ScriptedDocumentScanner([[p]]),
      new ScriptedOcrEngine(new Map(), false),
      new ScriptedBarcodeScanner(new Map(), false),
    );
    const hardware = await session.hardware();
    expect(hardware.ocr).toBe(false);
    expect(hardware.unavailable.join(" ")).toContain("text recognition");

    const draft = await session.capture();
    expect(draft.pages[0]!.ocr).toBeNull();
    expect(draft.combinedText).toBeNull();

    const capture = await session.finalize({ draft, documentKind: "disposal_ticket", title: "Ticket", jobId: 7 });
    const proposed = (capture.fields as Record<string, { pages: { ocrAttempted: boolean }[] }>).proposed;
    // "nothing read it" and "it had no text" must not read the same.
    expect(proposed.pages[0]!.ocrAttempted).toBe(false);
    expect((capture.fields as Record<string, { textRecognitionRan: boolean }>).capture.textRecognitionRan).toBe(false);
  });

  it("distinguishes a page nobody read from a page that read as blank", async () => {
    const p = page("blank");
    const { session } = deviceWith(new ScriptedDocumentScanner([[p]]), new ScriptedOcrEngine(new Map()));
    const draft = await session.capture();
    expect(draft.pages[0]!.ocr).not.toBeNull();
    expect(draft.pages[0]!.ocr!.rawText).toBe("");
  });

  it("keeps everything read off the page under `proposed`, never beside the confirmed values", async () => {
    const p = page("disp");
    const { session } = deviceWith(
      new ScriptedDocumentScanner([[p]]),
      await scriptOcr([[p, ocr("DISPOSAL TICKET\nVolume 14.2 m3")]]),
    );
    const draft = await session.capture();
    const capture = await session.finalize({
      draft, documentKind: "disposal_ticket", title: "Ticket", jobId: 7,
      confirmedFields: { volume: 14.2 },
    });

    const fields = capture.fields as Record<string, Record<string, unknown>>;
    expect(fields.confirmed).toEqual({ volume: 14.2 });
    expect(Object.keys(fields)).not.toContain("volume");
    expect(JSON.stringify(fields.proposed)).toContain("14.2 m3");
    // Nothing the engine read is promoted into the confirmed object.
    expect(fields.confirmed).not.toHaveProperty("ocrText");
  });

  it("records that a worker kept a page the gate objected to", async () => {
    const bad = page("gloved", { ...GOOD, focusScore: 20 });
    const { session } = deviceWith(new ScriptedDocumentScanner([[bad], [bad]]));

    const kept = await session.capture({ keepDespiteObjection: [0] });
    expect(kept.pages[0]!.quality.verdict).toBe("reshoot");
    expect(kept.pages[0]!.acceptedOverObjection).toBe(true);

    const notKept = await session.capture();
    expect(notKept.pages[0]!.acceptedOverObjection).toBe(false);
  });

  it("never discards a page it objected to", async () => {
    const bad = page("bad", { ...GOOD, glarePercent: 70 });
    const { session } = deviceWith(new ScriptedDocumentScanner([[bad]]));
    const draft = await session.capture();
    expect(draft.qualityVerdict).toBe("reshoot");
    const capture = await session.finalize({ draft, documentKind: "disposal_ticket", title: "T", jobId: 1 });
    expect(capture.files).toHaveLength(1);
  });

  it("files a scan at the tier its document kind deserves", async () => {
    expect(captureKindForScan("tdg_shipping_document")).toBe("tdg_document");
    expect(captureKindForScan("disposal_ticket")).toBe("disposal_ticket");
    expect(captureKindForScan("invoice")).toBe("scanned_document");
    // A shipping document outruns photographs; an unclassified scan rides with tickets.
    expect(captureSyncPriority("tdg_document")).toBeLessThan(captureSyncPriority("scanned_document"));
    expect(captureSyncPriority("scanned_document")).toBeLessThan(captureSyncPriority("photo"));
  });

  it("refuses to queue a scan that belongs to no job and no unit", async () => {
    const { session, outbox } = deviceWith(new ScriptedDocumentScanner([[page("orphan")]]));
    const draft = await session.capture();
    const capture = await session.finalize({ draft, documentKind: "disposal_ticket", title: "Orphan" });
    await expect(outbox.queue(capture.localId)).rejects.toThrow(/no job or unit/);
  });

  it("carries the device's capture-time authorization claim without upgrading it", async () => {
    const { session } = deviceWith(new ScriptedDocumentScanner([[page("auth")]]));
    const draft = await session.capture();
    const capture = await session.finalize({
      draft, documentKind: "disposal_ticket", title: "T", jobId: 1,
      captureAuthorizationClaim: "unauthorized", captureAuthorizationReason: "no session on the device",
    });
    expect(capture.captureAuthorizationClaim).toBe("unauthorized");
    expect(capture.captureAuthorizationReason).toBe("no session on the device");
  });

  it("defaults the authorization claim to unknown rather than to authorized", async () => {
    const { session } = deviceWith(new ScriptedDocumentScanner([[page("noclaim")]]));
    const draft = await session.capture();
    const capture = await session.finalize({ draft, documentKind: "disposal_ticket", title: "T", jobId: 1 });
    expect(capture.captureAuthorizationClaim).toBe("unknown");
  });

  it("survives a recognizer that throws, because the pages are already the evidence", async () => {
    const p = page("throwing");
    const throwing = new ScriptedOcrEngine(new Map());
    throwing.recognize = async () => { throw new Error("ML Kit model not downloaded"); };
    const { session } = deviceWith(new ScriptedDocumentScanner([[p]]), throwing);
    const draft = await session.capture();
    expect(draft.pages[0]!.ocr).toBeNull();
    expect(draft.pages[0]!.contentHash).toBe(await sha256Hex(p.bytes));
  });

  it("keeps multi-page order and names the pages in it", async () => {
    const pages = [page("a"), page("b"), page("c")];
    const { session } = deviceWith(new ScriptedDocumentScanner([pages]));
    const draft = await session.capture();
    const capture = await session.finalize({ draft, documentKind: "hazardous_waste_manifest", title: "Manifest", jobId: 3 });
    expect(capture.files.map(f => f.fileName)).toEqual([
      "hazardous_waste_manifest-p01.jpg", "hazardous_waste_manifest-p02.jpg", "hazardous_waste_manifest-p03.jpg",
    ]);
    expect(capture.files[0]!.contentHash).toBe(await sha256Hex(pages[0]!.bytes));
    expect(capture.files[2]!.contentHash).toBe(await sha256Hex(pages[2]!.bytes));
  });

  it("refuses a scan with no pages", async () => {
    const { session } = deviceWith(new ScriptedDocumentScanner([[page("x")]]));
    const draft = await session.capture();
    await expect(session.finalize({
      draft: { ...draft, pages: [], pageBytes: [] }, documentKind: "disposal_ticket", title: "T", jobId: 1,
    })).rejects.toThrow(/no pages/);
  });
});

/* ------------------------------------------------------------------ */
/* Guidance                                                            */
/* ------------------------------------------------------------------ */

describe("paperwork guidance", () => {
  it("seeds every rule unverified, because LeaseOS read a report and not the regulation", () => {
    for (const g of Array.from(PAPERWORK_GUIDANCE.values())) {
      expect(g.verification).toBe("unverified");
      for (const f of g.requiredFields) {
        expect(f.citation.readFrom).toContain("Planning report");
        expect(f.citation.source.length).toBeGreaterThan(0);
      }
    }
  });

  it("covers every document kind the scanner can file", () => {
    const kinds: ScanDocumentKind[] = [
      "tdg_shipping_document", "hazardous_waste_manifest", "disposal_ticket", "load_ticket",
      "scale_ticket", "fuel_receipt", "expense_receipt", "invoice", "bill_of_lading",
      "inspection_report", "safety_document", "unknown",
    ];
    for (const k of kinds) expect(PAPERWORK_GUIDANCE.has(k)).toBe(true);
  });

  it("keeps one document vocabulary: every scanner kind is a guidance kind", () => {
    // A compile-time assertion with a runtime witness: if ScanDocumentKind ever
    // gains a member PaperworkKind lacks, this file stops compiling.
    const widen = (k: ScanDocumentKind): PaperworkKind => k;
    expect(widen("bill_of_lading")).toBe("bill_of_lading");
    expect(OPERATOR_SELECTED_KINDS).toContain("tdg_shipping_document");
  });

  it("puts the TDG paper requirement and its location in the driver's own terms", () => {
    const g = guidanceFor("tdg_shipping_document");
    expect(g.paper?.paperRequired).toBe(true);
    expect(g.paper?.where).toContain("driver's door");
    expect(g.paper?.citation.locator).toBe("s. 3.7");
    // The June 2026 amendments are the trap: they moved the content rules and
    // left the paper requirement standing.
    expect(g.cautions.join(" ")).toContain("not the paper requirement");
    expect(g.cautions.join(" ")).toContain("paperless cab");
    expect(g.retention[0]!.years).toBe(2);
    expect(g.retention[0]!.whoMustRetain).toEqual(["the consignor", "the carrier", "the importer"]);
  });

  it("marks the fields that must never be filled from a guess", () => {
    const g = guidanceFor("tdg_shipping_document");
    const un = g.requiredFields.find(f => f.key === "un_number");
    expect(un?.neverGuess).toBe(true);
    const consignor = g.requiredFields.find(f => f.key === "consignor");
    expect(consignor?.neverGuess).toBe(false);
  });

  it("names every party that must retain a copy separately, since they are separate duties", () => {
    const g = guidanceFor("hazardous_waste_manifest");
    expect(g.retention[0]!.whoMustRetain).toHaveLength(3);
    expect(g.retention[0]!.years).toBe(2);
    expect(g.cautions.join(" ")).toContain("21 days");
  });

  it("does not let thermal paper be mistaken for the record", () => {
    for (const kind of ["disposal_ticket", "fuel_receipt", "invoice"] as const) {
      expect(guidanceFor(kind).cautions.join(" ")).toContain("thermal");
    }
  });

  describe("the CRA documentation tiers", () => {
    it("places a total in its tier at the raised thresholds", () => {
      expect(itcTierFor(99_99)).toBe("under_100");
      expect(itcTierFor(ITC_TIER_CENTS.middle)).toBe("from_100_to_499");
      expect(itcTierFor(499_99)).toBe("from_100_to_499");
      expect(itcTierFor(ITC_TIER_CENTS.upper)).toBe("500_and_over");
    });

    it("reads an unestablished total as an unknown tier rather than the cheapest one", () => {
      expect(itcTierFor(null)).toBe("unknown");
      expect(itcTierFor(undefined)).toBe("unknown");

      const g = guidanceFor("invoice", {});
      expect(g.cautions.join(" ")).toContain("UNKNOWN");
      // Every tier's fields are named, so a reader can place it the moment
      // they read the total off the page.
      const keys = g.requiredFields.map(f => f.key);
      expect(keys).toContain("supplier_gst_number");
      expect(keys).toContain("supply_description");
    });

    it("asks for only the base fields under $100", () => {
      const keys = guidanceFor("expense_receipt", { totalCents: 42_00 }).requiredFields.map(f => f.key);
      expect(keys).not.toContain("supplier_gst_number");
      expect(keys).not.toContain("recipient_name");
    });

    it("adds the registration number in the middle tier and the rest above $500", () => {
      const mid = guidanceFor("invoice", { totalCents: 250_00 }).requiredFields.map(f => f.key);
      expect(mid).toContain("supplier_gst_number");
      expect(mid).not.toContain("recipient_name");

      const upper = guidanceFor("invoice", { totalCents: 900_00 }).requiredFields.map(f => f.key);
      expect(upper).toContain("recipient_name");
      expect(upper).toContain("tax_by_rate");
    });
  });

  it("adds the province's own rule, and says so when the province is not established", () => {
    expect(guidanceFor("hazardous_waste_manifest", { jurisdiction: "BC" }).cautions.join(" ")).toContain("six-sheet");
    expect(guidanceFor("disposal_ticket", { jurisdiction: "SK" }).cautions.join(" ")).toContain("Saskatchewan");
    expect(guidanceFor("hazardous_waste_manifest", {}).cautions.join(" ")).toContain("not established");
  });

  it("never mutates the registry when it composes context", () => {
    const before = PAPERWORK_GUIDANCE.get("invoice")!.requiredFields.length;
    guidanceFor("invoice", { totalCents: 900_00 });
    guidanceFor("invoice", { totalCents: 900_00 });
    expect(PAPERWORK_GUIDANCE.get("invoice")!.requiredFields).toHaveLength(before);
  });

  it("reports an unknown retention period as unknown rather than as the shorter rule", () => {
    expect(longestRetentionYears([])).toBeNull();
    expect(longestRetentionYears([{ years: 2, whoMustRetain: [], citation: { source: "x", locator: null, readFrom: "y" } }])).toBe(2);
    expect(longestRetentionYears([
      { years: 2, whoMustRetain: [], citation: { source: "x", locator: null, readFrom: "y" } },
      { years: 6, whoMustRetain: [], citation: { source: "x", locator: null, readFrom: "y" } },
    ])).toBe(6);
    // A rule nobody established makes the answer unknown; it is not skipped in
    // favour of the one that happens to carry a number.
    expect(longestRetentionYears([
      { years: 2, whoMustRetain: [], citation: { source: "x", locator: null, readFrom: "y" } },
      { years: null, whoMustRetain: [], citation: { source: "x", locator: null, readFrom: "y" } },
    ])).toBeNull();
  });
});

describe("the checklist", () => {
  it("names what is missing and what must not be guessed at", () => {
    const c = paperworkChecklist({ kind: "hazardous_waste_manifest", presentFieldKeys: ["generator_pin", "waste_description"] });
    expect(c.complete).toBe(false);
    expect(c.missing).toContain("receiving_signature");
    expect(c.missingMustNotGuess).toContain("receiver_pin");
    const sig = c.items.find(i => i.field.key === "receiving_signature")!;
    expect(sig.advice).toContain("do not accept a scanner's guess");
  });

  it("counts a supplied field as present whatever its value", () => {
    const c = paperworkChecklist({ kind: "scale_ticket", presentFieldKeys: ["gross", "tare", "net", "weighed_at"] });
    expect(c.complete).toBe(true);
    expect(c.missing).toEqual([]);
  });

  it("never calls an unclassified document complete", () => {
    const c = paperworkChecklist({ kind: "unknown", presentFieldKeys: [] });
    expect(c.items).toEqual([]);
    expect(c.missing).toEqual([]);
    // Nothing is missing because nobody looked up what it needs. That is not a
    // clean bill of health.
    expect(c.complete).toBe(false);
    expect(c.cautions.join(" ")).toContain("nobody has looked up");
  });

  it("carries the retention rule and the paper rule onto the checklist", () => {
    const c = paperworkChecklist({ kind: "tdg_shipping_document", presentFieldKeys: [] });
    expect(c.paper?.paperRequired).toBe(true);
    expect(c.retention[0]!.years).toBe(2);
    expect(c.verification).toBe("unverified");
  });
});

/* ------------------------------------------------------------------ */
/* Auto-linking                                                        */
/* ------------------------------------------------------------------ */

describe("the tracking-number matcher is derived from the configured format", () => {
  it("matches a number the format itself mints", () => {
    const at = new Date("2026-09-21T00:00:00Z");
    expect(patternMatchesOwnOutput(DISPOSAL_FORMAT, at, 123)).toBe(true);
    expect(patternMatchesOwnOutput(DISPOSAL_FORMAT, at, 123, "YEG")).toBe(true);
  });

  it("follows the format when the office changes it", () => {
    const wider: SequenceFormat = { ...DISPOSAL_FORMAT, sequenceDigits: 7 };
    const at = new Date("2026-09-21T00:00:00Z");
    expect(patternMatchesOwnOutput(wider, at, 123)).toBe(true);
    // The six-digit pattern does not match a seven-digit number, which is the
    // failure a hardcoded regex would have produced silently.
    expect(formatTrackingNumber(wider, at, 123).match(trackingNumberPattern(DISPOSAL_FORMAT))).toBeNull();

    const monthly: SequenceFormat = { ...DISPOSAL_FORMAT, includeMonth: true, resetPeriod: "monthly" };
    expect(patternMatchesOwnOutput(monthly, at, 9)).toBe(true);

    const bare: SequenceFormat = { ...DISPOSAL_FORMAT, yearDigits: 0, separator: "/" };
    expect(patternMatchesOwnOutput(bare, at, 9)).toBe(true);
  });

  it("does not half-match a number embedded in a longer token", () => {
    const m = "XDISP-2026-000123X".match(trackingNumberPattern(DISPOSAL_FORMAT));
    expect(m).toBeNull();
  });
});

describe("proposing which record a scan belongs to", () => {
  const at = new Date("2026-09-21T00:00:00Z");
  const disp = formatTrackingNumber(DISPOSAL_FORMAT, at, 123);

  it("trusts a barcode decode more than a read off the print", () => {
    const fromBarcode = proposeLinks({ bindings: BINDINGS, barcodes: [{ format: "CODE_128", value: disp }] });
    const fromText = proposeLinks({ bindings: BINDINGS, ocrText: `Facility ticket ${disp}` });
    expect(fromBarcode.best!.confidence).toBeGreaterThan(fromText.best!.confidence);
    expect(fromBarcode.best!.target).toBe("disposal");
    expect(fromBarcode.best!.barcodeFormat).toBe("CODE_128");
  });

  it("proposes and never confirms", () => {
    const p = proposeLinks({ bindings: BINDINGS, barcodes: [{ format: "QR_CODE", value: disp }] });
    expect(p.reasons.join(" ")).toContain("confirm it");
  });

  it("collapses one number read twice into the better piece of evidence", () => {
    const p = proposeLinks({ bindings: BINDINGS, barcodes: [{ format: "CODE_128", value: disp }], ocrText: `ticket ${disp}` });
    expect(p.candidates).toHaveLength(1);
    expect(p.candidates[0]!.source).toBe("barcode");
    expect(p.ambiguous).toBe(false);
  });

  it("refuses to choose when the page names two different records", () => {
    const job = formatTrackingNumber(JOB_FORMAT, at, 55);
    const p = proposeLinks({ bindings: BINDINGS, ocrText: `${disp} for ${job}` });
    expect(p.ambiguous).toBe(true);
    expect(p.best).toBeNull();
    expect(p.candidates).toHaveLength(2);
    expect(p.reasons[0]).toContain("not something the scan can settle");
  });

  it("corrects the characters OCR confuses, and says which ones it corrected", () => {
    // A faded ticket read with two O-for-zero confusions.
    const p = proposeLinks({ bindings: BINDINGS, ocrText: "Ticket DISP-2026-OOO123 accepted" });
    expect(p.best).not.toBeNull();
    expect(p.best!.trackingNumber).toBe(disp);
    expect(p.best!.asRead).toContain("OOO");
    expect(p.best!.substitutions).toHaveLength(3);
    expect(p.best!.confidence).toBeLessThan(72);
    expect(p.best!.reason).toContain("Check these characters against the page");
  });

  it("stops proposing once it is correcting half the number", () => {
    // Six corrections: this is no longer reading a number, it is inventing one.
    const p = proposeLinks({ bindings: BINDINGS, ocrText: "DISP-ZO26-OOOIZ3" });
    expect(p.best).toBeNull();
    expect(p.candidates).toEqual([]);
  });

  it("says plainly when it found nothing", () => {
    const p = proposeLinks({ bindings: BINDINGS, ocrText: "Nothing resembling a ticket number here" });
    expect(p.candidates).toEqual([]);
    expect(p.best).toBeNull();
    expect(p.reasons[0]).toContain("No tracking number");
  });

  it("mines a QR pointer for a number without treating the payload as content", () => {
    const p = proposeLinks({ bindings: BINDINGS, barcodes: [{ format: "QR_CODE", value: `https://leaseos.example/r/${disp}` }] });
    expect(p.best!.trackingNumber).toBe(disp);
    expect(p.best!.target).toBe("disposal");
  });

  it("finds nothing when no sequence is configured", () => {
    expect(proposeLinks({ bindings: [], ocrText: disp }).candidates).toEqual([]);
  });
});

/* ------------------------------------------------------------------ */
/* The review a person reads                                           */
/* ------------------------------------------------------------------ */

describe("the scan review", () => {
  const summary = (o: Partial<ScannedPageSummary> = {}): ScannedPageSummary => ({
    pageIndex: 0, contentHash: "h", qualityVerdict: "acceptable", qualityFailures: [],
    acceptedOverObjection: false, ocrAttempted: true, ocrMeanConfidence: 95, ocrText: null, barcodes: [], ...o,
  });

  it("puts what vanishes when the truck moves above what the office can chase", () => {
    const r = reviewScan({
      kind: "hazardous_waste_manifest",
      pages: [summary({ qualityVerdict: "reshoot", qualityFailures: ["focus 20 of 100"] })],
      confirmedFieldKeys: [],
    });
    const urgencies = r.actions.map(a => a.urgency);
    expect(urgencies[0]).toBe("before_you_leave");
    expect(urgencies).toEqual([...urgencies].sort(
      (a, b) => ["before_you_leave", "while_you_have_the_paper", "before_filing"].indexOf(a)
             - ["before_you_leave", "while_you_have_the_paper", "before_filing"].indexOf(b),
    ));
    expect(r.actions[0]!.text).toMatch(/signature|PIN/i);
  });

  it("names a faded read for what it is rather than passing the numbers on", () => {
    const r = reviewScan({
      kind: "disposal_ticket",
      pages: [summary({ ocrMeanConfidence: 54 })],
      confirmedFieldKeys: ["facility", "ticket_number", "waste_code", "volume", "accepted_at"],
    });
    const rec = r.actions.find(a => a.from === "recognition")!;
    expect(rec.text).toContain("Faded thermal paper");
    expect(rec.urgency).toBe("while_you_have_the_paper");
  });

  it("says when no recognizer ran at all", () => {
    const r = reviewScan({
      kind: "disposal_ticket", pages: [summary({ ocrAttempted: false, ocrMeanConfidence: null })],
      confirmedFieldKeys: [], textRecognitionRan: false,
    });
    expect(r.actions.find(a => a.from === "recognition")!.text).toContain("No text recognizer");
  });

  it("flags pages this device never checked", () => {
    const r = reviewScan({ kind: "load_ticket", pages: [summary({ qualityVerdict: "unjudged" })], confirmedFieldKeys: [] });
    expect(r.actions.find(a => a.from === "quality")!.text).toContain("does not score capture quality");
  });

  it("is not ready to file while a page wants re-shooting", () => {
    const complete = ["facility", "ticket_number", "waste_code", "volume", "accepted_at"];
    expect(reviewScan({ kind: "disposal_ticket", pages: [summary()], confirmedFieldKeys: complete }).readyToFile).toBe(true);
    expect(reviewScan({
      kind: "disposal_ticket", pages: [summary({ qualityVerdict: "reshoot", qualityFailures: ["glare"] })],
      confirmedFieldKeys: complete,
    }).readyToFile).toBe(false);
  });

  it("is never ready to file an unclassified document", () => {
    const r = reviewScan({ kind: "unknown", pages: [summary()], confirmedFieldKeys: [] });
    expect(r.readyToFile).toBe(false);
    expect(r.retentionYears).toBeNull();
  });

  it("carries the retention period a filer needs", () => {
    expect(reviewScan({ kind: "invoice", pages: [summary()], confirmedFieldKeys: [] }).retentionYears).toBe(6);
    expect(reviewScan({ kind: "tdg_shipping_document", pages: [summary()], confirmedFieldKeys: [] }).retentionYears).toBe(2);
  });

  it("proposes the link from what the pages actually carried", () => {
    const disp = formatTrackingNumber(DISPOSAL_FORMAT, new Date("2026-09-21T00:00:00Z"), 123);
    const r = reviewScan({
      kind: "disposal_ticket",
      pages: [summary({ barcodes: [{ format: "CODE_128", value: disp }] })],
      confirmedFieldKeys: [], trackingBindings: BINDINGS,
    });
    expect(r.links.best!.trackingNumber).toBe(disp);
    expect(r.actions.find(a => a.from === "linking")!.text).toContain("Confirm it");
  });

  it("tells a person to pick the record by hand when nothing was found", () => {
    const r = reviewScan({ kind: "disposal_ticket", pages: [summary()], confirmedFieldKeys: [], trackingBindings: BINDINGS });
    expect(r.actions.find(a => a.from === "linking")!.text).toContain("by hand");
  });
});
