/**
 * v23.28 — the page scanner, from the hardware boundary to the guidance a person reads.
 *
 * The cases worth having are the ones where a scanner is tempted to be convenient: a frame nobody
 * measured passing as a good one, an OCR read arriving as a fact, a tracking number invented out
 * of six corrections, a document with no requirements because nobody looked them up, a second scan
 * of the same paper quietly becoming a second document.
 *
 * Thresholds are tested immediately below, exactly at, and immediately above. A constant nobody
 * tests at its own boundary is a constant that can move by one without anything noticing.
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
import { NotOnDeviceError, type DeviceOcrResult, type ScannedPage } from "../client/src/runtime/contracts";
import {
  ALL_QUALITY_SIGNALS, QUALITY_FLOORS, assessPageQuality, sessionQualityVerdict,
  type CaptureQualitySignals,
} from "@shared/captureQuality";
import {
  DuplicateScan, ScanCancelled, ScanSession, ScannerUnavailable, captureKindForScan,
  type ScanDocumentKind,
} from "../client/src/runtime/scanSession";
import { Outbox } from "../client/src/runtime/outbox";
import { captureSyncPriority, prioritizeQueuedCaptures } from "../client/src/runtime/syncEngine";
import { sha256Hex } from "../client/src/runtime/crypto";

import {
  ALL_PAPERWORK_KINDS, GUIDANCE_SOURCE, ITC_TIER_CENTS, OPERATOR_SELECTED_KINDS, PAPERWORK_GUIDANCE,
  fieldStateFor, guidanceFor, itcTierFor, kindsClaimingVerified, toPrintFields,
  type ObservedFieldStatus, type PaperworkKind,
} from "@shared/paperworkGuidance";
import { assessPrintability } from "@shared/printability";
import type { DocumentType } from "./_core/documentExtraction";
import type { FieldStatus } from "./_core/aiProposal";
import { DEFAULT_FORMAT, formatTrackingNumber, type SequenceFormat } from "./_core/trackingNumbers";
import {
  MAX_OCR_SUBSTITUTIONS, formatProblem, patternMatchesOwnOutput, proposeLinks, trackingNumberPattern,
  type TrackingBinding,
} from "./_core/scanAutoLink";
import { reviewScan, type ScannedPageSummary } from "./_core/scanReview";
import { retentionPolicyFor } from "./_core/paperworkRetention";
import { computeEffectiveRetention } from "./_core/retentionPolicy";

/* ------------------------------------------------------------------ */
/* One vocabulary, mechanically                                        */
/* ------------------------------------------------------------------ */

describe("the scanner adds no second vocabulary", () => {
  it("accepts every DocumentType as a PaperworkKind", () => {
    // A compile-time assertion with a runtime witness. `shared/` cannot import from `server/_core/`,
    // so PaperworkKind restates DocumentType — and if the two ever drift, this line stops compiling
    // and the gate's test-file typecheck ratchet fails at zero.
    const widen = (d: DocumentType): PaperworkKind => d;
    expect(widen("disposal_ticket")).toBe("disposal_ticket");
    expect(widen("unknown")).toBe("unknown");
  });

  it("uses aiProposal's own four field statuses", () => {
    const widen = (f: FieldStatus): ObservedFieldStatus => f;
    expect(widen("proposed")).toBe("proposed");
    expect(widen("corrected")).toBe("corrected");
  });

  it("files every scannable document kind under a kind guidance knows", () => {
    const widen = (k: ScanDocumentKind): PaperworkKind => k;
    expect(widen("bill_of_lading")).toBe("bill_of_lading");
    expect(OPERATOR_SELECTED_KINDS).toContain("tdg_shipping_document");
  });

  it("has guidance for every kind it lists, and lists every kind it has", () => {
    for (const k of ALL_PAPERWORK_KINDS) expect(PAPERWORK_GUIDANCE[k], k).toBeDefined();
    expect(Object.keys(PAPERWORK_GUIDANCE).sort()).toEqual([...ALL_PAPERWORK_KINDS].sort());
  });
});

/* ------------------------------------------------------------------ */
/* The hardware boundary                                               */
/* ------------------------------------------------------------------ */

describe("the hardware boundary is declared, not faked", () => {
  it("refuses each native binding off a device rather than returning something plausible", async () => {
    await expect(capacitorDocumentScanner().open()).rejects.toThrow(NotOnDeviceError);
    await expect(capacitorOcrEngine().open()).rejects.toThrow(NotOnDeviceError);
    await expect(capacitorBarcodeScanner().open()).rejects.toThrow(NotOnDeviceError);
  });

  it("reports the plugins as absent in a server or browser process", async () => {
    expect(await capacitorDocumentScanner().available()).toBe(false);
    expect(await capacitorOcrEngine().available()).toBe(false);
    expect(await capacitorBarcodeScanner().available()).toBe(false);
  });

  it("names the three scanner capabilities as native-only", () => {
    expect(NATIVE_ONLY_CAPABILITIES).toContain("document_scanner");
    expect(NATIVE_ONLY_CAPABILITIES).toContain("on_device_ocr");
    expect(NATIVE_ONLY_CAPABILITIES).toContain("barcode_scanner");
  });

  it("makes the fallback explicit and observable rather than silent", async () => {
    // available() is false AND the call throws. A fallback that returned an empty result would be
    // indistinguishable from a page with nothing on it.
    expect(await new UnavailableDocumentScanner().available()).toBe(false);
    expect(await new UnavailableOcrEngine().available()).toBe(false);
    expect(await new UnavailableBarcodeScanner().available()).toBe(false);
    await expect(new UnavailableOcrEngine().recognize()).rejects.toThrow(NotOnDeviceError);
    await expect(new UnavailableDocumentScanner().scan()).rejects.toThrow(NotOnDeviceError);
    await expect(new UnavailableBarcodeScanner().scanImage()).rejects.toThrow(NotOnDeviceError);
  });

  it("says what is missing in words a worker can act on", async () => {
    const { session } = deviceWith(
      new ScriptedDocumentScanner([], false),
      new ScriptedOcrEngine(new Map(), false),
      new ScriptedBarcodeScanner(new Map(), false),
    );
    const hw = await session.hardware();
    expect(hw).toMatchObject({ scanner: false, ocr: false, barcodes: false });
    expect(hw.unavailable.join(" ")).toContain("document scanner");
    expect(hw.unavailable.join(" ")).toContain("text recognition");
    expect(hw.unavailable.join(" ")).toContain("barcode scanning");
  });
});

/* ------------------------------------------------------------------ */
/* The quality gate, at every boundary                                 */
/* ------------------------------------------------------------------ */

const GOOD: CaptureQualitySignals = {
  widthPx: 1700, heightPx: 2200, focusScore: 88, glarePercent: 2, edgeConfidence: 95, pageCoveragePercent: 80,
};
const UNREPORTED: CaptureQualitySignals = {
  widthPx: null, heightPx: null, focusScore: null, glarePercent: null, edgeConfidence: null, pageCoveragePercent: null,
};

describe("the capture quality gate", () => {
  it("accepts a well-photographed page", () => {
    const a = assessPageQuality(GOOD);
    expect(a.verdict).toBe("acceptable");
    expect(a.failures).toEqual([]);
    expect(a.unreported).toEqual([]);
  });

  it("pins the floors themselves, not just the comparisons against them", () => {
    /*
     * The boundary tests below are written against QUALITY_FLOORS, so they move WITH the constants
     * and would not notice a floor being quietly lowered. These are the numbers, spelled out. A
     * change here should be an argument somebody has, not a diff nobody sees.
     */
    expect(QUALITY_FLOORS).toEqual({
      minLongEdgePx: 1600,
      minShortEdgePx: 900,
      minFocusScore: 60,
      maxGlarePercent: 8,
      minEdgeConfidence: 70,
      minPageCoveragePercent: 45,
    });
  });

  describe("every threshold, below / at / above", () => {
    const verdictFor = (s: Partial<CaptureQualitySignals>) => assessPageQuality({ ...GOOD, ...s }).verdict;

    it("long edge: below fails, exactly at the floor passes, above passes", () => {
      expect(verdictFor({ widthPx: QUALITY_FLOORS.minLongEdgePx - 1, heightPx: 1200 })).toBe("reshoot");
      expect(verdictFor({ widthPx: QUALITY_FLOORS.minLongEdgePx, heightPx: 1200 })).toBe("acceptable");
      expect(verdictFor({ widthPx: QUALITY_FLOORS.minLongEdgePx + 1, heightPx: 1200 })).toBe("acceptable");
    });

    it("short edge: below fails, exactly at the floor passes, above passes", () => {
      expect(verdictFor({ widthPx: 2000, heightPx: QUALITY_FLOORS.minShortEdgePx - 1 })).toBe("reshoot");
      expect(verdictFor({ widthPx: 2000, heightPx: QUALITY_FLOORS.minShortEdgePx })).toBe("acceptable");
      expect(verdictFor({ widthPx: 2000, heightPx: QUALITY_FLOORS.minShortEdgePx + 1 })).toBe("acceptable");
    });

    it("focus: below fails, exactly at the floor passes, above passes", () => {
      expect(verdictFor({ focusScore: QUALITY_FLOORS.minFocusScore - 1 })).toBe("reshoot");
      expect(verdictFor({ focusScore: QUALITY_FLOORS.minFocusScore })).toBe("acceptable");
      expect(verdictFor({ focusScore: QUALITY_FLOORS.minFocusScore + 1 })).toBe("acceptable");
    });

    it("glare: exactly at the ceiling passes, above fails, below passes", () => {
      expect(verdictFor({ glarePercent: QUALITY_FLOORS.maxGlarePercent - 1 })).toBe("acceptable");
      expect(verdictFor({ glarePercent: QUALITY_FLOORS.maxGlarePercent })).toBe("acceptable");
      expect(verdictFor({ glarePercent: QUALITY_FLOORS.maxGlarePercent + 1 })).toBe("reshoot");
    });

    it("edge confidence: below fails, exactly at the floor passes, above passes", () => {
      expect(verdictFor({ edgeConfidence: QUALITY_FLOORS.minEdgeConfidence - 1 })).toBe("reshoot");
      expect(verdictFor({ edgeConfidence: QUALITY_FLOORS.minEdgeConfidence })).toBe("acceptable");
      expect(verdictFor({ edgeConfidence: QUALITY_FLOORS.minEdgeConfidence + 1 })).toBe("acceptable");
    });

    it("page coverage: below fails, exactly at the floor passes, above passes", () => {
      expect(verdictFor({ pageCoveragePercent: QUALITY_FLOORS.minPageCoveragePercent - 1 })).toBe("reshoot");
      expect(verdictFor({ pageCoveragePercent: QUALITY_FLOORS.minPageCoveragePercent })).toBe("acceptable");
      expect(verdictFor({ pageCoveragePercent: QUALITY_FLOORS.minPageCoveragePercent + 1 })).toBe("acceptable");
    });

    it("names the signal and the floor it missed, not just that something failed", () => {
      const a = assessPageQuality({ ...GOOD, focusScore: QUALITY_FLOORS.minFocusScore - 1 });
      expect(a.failures).toHaveLength(1);
      expect(a.failures[0]!).toMatchObject({
        signal: "focus", observed: QUALITY_FLOORS.minFocusScore - 1, floor: QUALITY_FLOORS.minFocusScore,
      });
      expect(a.advice).toContain(String(QUALITY_FLOORS.minFocusScore));
    });
  });

  it("does not call an unmeasured frame acceptable", () => {
    const a = assessPageQuality(UNREPORTED);
    expect(a.verdict).toBe("unjudged");
    expect(a.verdict).not.toBe("acceptable");
    expect(a.unreported).toHaveLength(ALL_QUALITY_SIGNALS.length);
    expect(a.advice).toContain("not checked");
  });

  it("treats junk numbers as unreported rather than as measurements", () => {
    // A platform returning NaN has not measured anything, and comparing NaN to a floor is false,
    // which would silently pass.
    const a = assessPageQuality({ ...UNREPORTED, focusScore: Number.NaN, glarePercent: Number.POSITIVE_INFINITY });
    expect(a.verdict).toBe("unjudged");
    expect(a.unreported).toContain("focus");
    expect(a.unreported).toContain("glare");
  });

  it("judges only the signals the platform reported", () => {
    const a = assessPageQuality({ ...UNREPORTED, focusScore: 90 });
    expect(a.verdict).toBe("acceptable");
    expect(a.unreported).toEqual(["resolution", "glare", "edges", "coverage"]);
    expect(a.advice).toContain("reports nothing about");
  });

  it("gives one instruction and counts the rest, because five faults get none of them fixed", () => {
    const a = assessPageQuality({ widthPx: 400, heightPx: 500, focusScore: 10, glarePercent: 60, edgeConfidence: 10, pageCoveragePercent: 5 });
    expect(a.verdict).toBe("reshoot");
    expect(a.failures.length).toBeGreaterThan(3);
    expect(a.advice).toContain("other issue");
    expect(a.advice.startsWith("focus")).toBe(true);
  });

  it("takes a session's verdict from its worst page, and calls no pages unjudged rather than acceptable", () => {
    expect(sessionQualityVerdict([])).toBe("unjudged");
    expect(sessionQualityVerdict([assessPageQuality(GOOD), assessPageQuality(GOOD)])).toBe("acceptable");
    expect(sessionQualityVerdict([assessPageQuality(GOOD), assessPageQuality(UNREPORTED)])).toBe("unjudged");
    expect(sessionQualityVerdict([assessPageQuality(UNREPORTED), assessPageQuality({ ...GOOD, focusScore: 2 })])).toBe("reshoot");
  });
});

/* ------------------------------------------------------------------ */
/* Guidance                                                            */
/* ------------------------------------------------------------------ */

describe("paperwork guidance", () => {
  it("seeds every rule unverified, because LeaseOS read a report and not the regulation", () => {
    expect(kindsClaimingVerified()).toEqual([]);
    for (const k of ALL_PAPERWORK_KINDS) {
      const g = PAPERWORK_GUIDANCE[k]!;
      expect(g.verification, k).toBe("unverified");
      for (const f of g.fields) {
        expect(f.citation.readFrom, `${k}.${f.key}`).toBe(GUIDANCE_SOURCE);
        expect(f.citation.source.length).toBeGreaterThan(0);
      }
      expect(g.statutoryRetention.citation.readFrom).toBe(GUIDANCE_SOURCE);
      if (g.paper) expect(g.paper.citation.readFrom).toBe(GUIDANCE_SOURCE);
    }
  });

  it("preserves the citation through the context rules, not just in the base registry", () => {
    const g = guidanceFor("invoice", { totalCents: 900_00 });
    const added = g.fields.find(f => f.key === "tax_by_rate")!;
    expect(added.citation.source).toContain("SOR/91-45");
    expect(added.citation.locator).toBe("s. 3");
    expect(added.citation.readFrom).toBe(GUIDANCE_SOURCE);
  });

  it("puts the TDG paper requirement and its location in the driver's own terms", () => {
    const g = guidanceFor("tdg_shipping_document");
    expect(g.paper?.paperRequired).toBe(true);
    expect(g.paper?.where).toContain("driver's door");
    expect(g.paper?.citation.locator).toBe("s. 3.7");
    expect(g.cautions.join(" ")).toContain("not the paper requirement");
    expect(g.cautions.join(" ")).toContain("paperless cab");
  });

  it("marks the fields where an approximation is materially different from a measurement", () => {
    const g = guidanceFor("tdg_shipping_document");
    expect(g.fields.find(f => f.key === "un_number")?.precisionSensitive).toBe(true);
    expect(g.fields.find(f => f.key === "consignor")?.precisionSensitive).toBe(false);
  });

  it("names every party that must retain a copy separately, since they are separate duties", () => {
    const g = guidanceFor("hazardous_waste_manifest");
    expect(g.statutoryRetention.whoMustRetain).toHaveLength(3);
    expect(g.cautions.join(" ")).toContain("21 days");
  });

  it("does not let thermal paper be mistaken for the record", () => {
    for (const kind of ["disposal_ticket", "fuel_receipt", "invoice", "scale_ticket"] as const) {
      expect(guidanceFor(kind).cautions.join(" "), kind).toContain("thermal");
    }
  });

  it("gives an unclassified document the strictest class, not the loosest", () => {
    // Nobody has established who reads it, so it is treated as though an inspector might.
    expect(guidanceFor("unknown").documentClass).toBe("regulatory");
    expect(guidanceFor("unknown").fields).toEqual([]);
  });

  it("resolves a kind this build does not know to the strictest guidance rather than throwing", () => {
    const g = guidanceFor("some_kind_from_a_newer_client");
    expect(g.kind).toBe("unknown");
    expect(g.documentClass).toBe("regulatory");
  });

  describe("jurisdiction", () => {
    it("adds BC's own rule to the documents BC treats differently", () => {
      expect(guidanceFor("hazardous_waste_manifest", { jurisdiction: "BC" }).cautions.join(" ")).toContain("six-sheet");
      expect(guidanceFor("bill_of_lading", { jurisdiction: "BC" }).cautions.join(" ")).toContain("six-sheet");
    });

    it("adds Saskatchewan's reversion rule to oilfield waste", () => {
      expect(guidanceFor("disposal_ticket", { jurisdiction: "SK" }).cautions.join(" ")).toContain("Saskatchewan");
    });

    it("says plainly when the province is not established", () => {
      const c = guidanceFor("hazardous_waste_manifest", {}).cautions.join(" ");
      expect(c).toContain("not established");
      expect(c).toContain("Alberta, BC and Saskatchewan each want something different");
    });

    it("does not attach one province's rule to another's document", () => {
      expect(guidanceFor("hazardous_waste_manifest", { jurisdiction: "AB" }).cautions.join(" ")).not.toContain("six-sheet");
      expect(guidanceFor("disposal_ticket", { jurisdiction: "AB" }).cautions.join(" ")).not.toContain("Saskatchewan");
    });
  });

  describe("the CRA documentation tiers", () => {
    it("places a total in its tier at the raised thresholds, on both sides of each boundary", () => {
      expect(itcTierFor(ITC_TIER_CENTS.middle - 1)).toBe("under_100");
      expect(itcTierFor(ITC_TIER_CENTS.middle)).toBe("from_100_to_499");
      expect(itcTierFor(ITC_TIER_CENTS.upper - 1)).toBe("from_100_to_499");
      expect(itcTierFor(ITC_TIER_CENTS.upper)).toBe("500_and_over");
      expect(itcTierFor(0)).toBe("under_100");
    });

    it("reads an unestablished or nonsensical total as an unknown tier, never the cheapest", () => {
      for (const v of [null, undefined, Number.NaN, -1, Number.POSITIVE_INFINITY]) {
        expect(itcTierFor(v as number | null | undefined), String(v)).toBe("unknown");
      }
    });

    it("fails closed on an unknown total by requiring every tier's fields", () => {
      const g = guidanceFor("invoice", {});
      const keys = g.fields.map(f => f.key);
      expect(keys).toContain("supplier_gst_number");
      expect(keys).toContain("supply_description");
      expect(g.cautions.join(" ")).toContain("UNKNOWN");
      expect(g.cautions.join(" ")).toContain("required until somebody reads the total");
    });

    it("asks for only the base fields under $100", () => {
      const keys = guidanceFor("expense_receipt", { totalCents: 42_00 }).fields.map(f => f.key);
      expect(keys).not.toContain("supplier_gst_number");
      expect(keys).not.toContain("recipient_name");
    });

    it("adds the registration number in the middle tier and the rest above $500", () => {
      const mid = guidanceFor("invoice", { totalCents: 250_00 }).fields.map(f => f.key);
      expect(mid).toContain("supplier_gst_number");
      expect(mid).not.toContain("recipient_name");

      const upper = guidanceFor("invoice", { totalCents: 900_00 }).fields.map(f => f.key);
      expect(upper).toContain("recipient_name");
      expect(upper).toContain("tax_by_rate");
    });

    it("leaves documents the tiers do not govern alone", () => {
      const keys = guidanceFor("tdg_shipping_document", { totalCents: 900_00 }).fields.map(f => f.key);
      expect(keys).not.toContain("supplier_gst_number");
    });
  });

  it("never mutates the registry when it composes context", () => {
    const before = PAPERWORK_GUIDANCE["invoice"]!.fields.length;
    guidanceFor("invoice", { totalCents: 900_00 });
    guidanceFor("invoice", { totalCents: 900_00 });
    guidanceFor("invoice", { jurisdiction: "BC" });
    expect(PAPERWORK_GUIDANCE["invoice"]!.fields).toHaveLength(before);
    expect(PAPERWORK_GUIDANCE["invoice"]!.cautions.join(" ")).not.toContain("UNKNOWN");
  });
});

/* ------------------------------------------------------------------ */
/* Guidance feeds printability; it does not second-guess it            */
/* ------------------------------------------------------------------ */

describe("what is known about a value decides what may go on paper", () => {
  const states = (kind: PaperworkKind, obs: { key: string; status: ObservedFieldStatus }[]) =>
    Object.fromEntries(toPrintFields(kind, obs).map(f => [f.key, f.state]));

  it("maps each provenance to the printability state it deserves", () => {
    expect(fieldStateFor("confirmed")).toBe("confirmed");
    expect(fieldStateFor("corrected")).toBe("confirmed");
    expect(fieldStateFor("proposed")).toBe("provisional");
    // A person looked and said the read was wrong: the question matters and is unanswered.
    expect(fieldStateFor("rejected")).toBe("unknown");
    expect(fieldStateFor(undefined)).toBe("absent");
    expect(fieldStateFor(null)).toBe("absent");
  });

  it("never lets an OCR read stand as confirmed", () => {
    const s = states("tdg_shipping_document", [{ key: "un_number", status: "proposed" }]);
    expect(s.un_number).toBe("provisional");
    expect(s.un_number).not.toBe("confirmed");
  });

  it("refuses to print a regulatory document whose required value is only proposed", () => {
    const g = guidanceFor("tdg_shipping_document");
    const fields = toPrintFields("tdg_shipping_document",
      g.fields.map(f => ({ key: f.key, status: "proposed" as ObservedFieldStatus })));
    const a = assessPrintability(g.documentClass, fields);
    expect(a.verdict).toBe("refused");
    expect(a.blockers.map(b => b.key)).toContain("un_number");
  });

  it("prints the same document once a person has confirmed every value", () => {
    const g = guidanceFor("tdg_shipping_document");
    const fields = toPrintFields("tdg_shipping_document",
      g.fields.map(f => ({ key: f.key, status: "confirmed" as ObservedFieldStatus })));
    expect(assessPrintability(g.documentClass, fields).verdict).toBe("printable");
  });

  it("refuses an unclassified document outright, because an empty manifest is not a clean one", () => {
    const g = guidanceFor("unknown");
    const a = assessPrintability(g.documentClass, toPrintFields("unknown", []));
    expect(a.verdict).toBe("refused");
    expect(a.blockers[0]!.reason).toContain("No field manifest was supplied");
    expect(a.blockers[0]!.reason).toContain("nothing on this document has been checked");
  });

  it("lets a commercial document carry a provisional value, marked", () => {
    const g = guidanceFor("load_ticket");
    const fields = toPrintFields("load_ticket", [
      { key: "lease", status: "proposed" },
      { key: "customer_signature", status: "confirmed" },
      { key: "service_date", status: "confirmed" },
    ]);
    const a = assessPrintability(g.documentClass, fields);
    expect(a.verdict).toBe("printable_with_markings");
    expect(a.markings.find(m => m.key === "lease")?.mark).toBe("PROVISIONAL");
  });

  it("ignores an observation for a field this document does not have", () => {
    const fields = toPrintFields("load_ticket", [{ key: "not_a_field_here", status: "confirmed" }]);
    expect(fields.map(f => f.key)).not.toContain("not_a_field_here");
  });

  it("takes the last word when a field is observed twice", () => {
    const s = states("load_ticket", [
      { key: "lease", status: "proposed" },
      { key: "lease", status: "confirmed" },
    ]);
    expect(s.lease).toBe("confirmed");
  });
});

/* ------------------------------------------------------------------ */
/* Retention is asked of the engine that owns it                       */
/* ------------------------------------------------------------------ */

describe("retention", () => {
  const sealedAt = new Date("2026-09-21T00:00:00Z");

  it("hands the unverified statutory figure over rather than applying it", () => {
    const policy = retentionPolicyFor({ kind: "disposal_ticket" });
    expect(policy.statutoryMinimumMonths).toBe(24);
    expect(policy.statutorySourceStatus).toBe("unverified");

    const eff = computeEffectiveRetention({ policy, sealedAt, underLegalHold: false });
    // Company policy wins and says so; the two-year figure is NOT asserted as law.
    expect(eff.basis).toBe("company");
    expect(eff.statutoryBackingVerified).toBe(false);
    expect(eff.caveat).toContain("statutory compliance not asserted");
  });

  it("says so when no statutory figure has even been recorded", () => {
    const policy = retentionPolicyFor({ kind: "inspection_report" });
    expect(policy.statutoryMinimumMonths).toBeNull();
    const eff = computeEffectiveRetention({ policy, sealedAt, underLegalHold: false });
    expect(eff.caveat).toContain("No verified statutory minimum loaded");
  });

  it("never under-retains while nobody has read the regulation", () => {
    // The whole fail-closed argument in one assertion: company policy is longer than every
    // candidate statutory figure, so an unverified rule cannot shorten anything.
    for (const k of ALL_PAPERWORK_KINDS) {
      const policy = retentionPolicyFor({ kind: k });
      const eff = computeEffectiveRetention({ policy, sealedAt, underLegalHold: false });
      expect(eff.months, k).toBeGreaterThanOrEqual(policy.statutoryMinimumMonths ?? 0);
    }
  });

  it("lets a legal hold outrank every period", () => {
    const policy = retentionPolicyFor({ kind: "disposal_ticket" });
    const held = computeEffectiveRetention({ policy, sealedAt, underLegalHold: true });
    expect(held.basis).toBe("legal_hold_indefinite");
    expect(held.officeRetainUntil).toBeNull();
  });

  it("carries the jurisdiction onto the policy so an auditor can see which one was asked about", () => {
    expect(retentionPolicyFor({ kind: "disposal_ticket", context: { jurisdiction: "AB" } }).jurisdiction).toBe("AB");
    expect(retentionPolicyFor({ kind: "disposal_ticket" }).jurisdiction).toBeNull();
  });
});

/* ------------------------------------------------------------------ */
/* Auto-linking                                                        */
/* ------------------------------------------------------------------ */

const DISPOSAL_FORMAT: SequenceFormat = { ...DEFAULT_FORMAT, prefix: "DSP" };
const JOB_FORMAT: SequenceFormat = { ...DEFAULT_FORMAT, prefix: "JOB" };
const BINDINGS: TrackingBinding[] = [
  { target: "disposal", format: DISPOSAL_FORMAT },
  { target: "job", format: JOB_FORMAT },
];
const AT = new Date("2026-09-21T00:00:00Z");
const DSP = formatTrackingNumber(DISPOSAL_FORMAT, AT, 123);
const JOB = formatTrackingNumber(JOB_FORMAT, AT, 55);

describe("the tracking-number matcher is derived from the configured format", () => {
  it("matches a number the format itself mints, with and without a branch", () => {
    expect(patternMatchesOwnOutput(DISPOSAL_FORMAT, AT, 123)).toBe(true);
    expect(patternMatchesOwnOutput(DISPOSAL_FORMAT, AT, 123, "YEG")).toBe(true);
  });

  it("follows the format when the office changes it", () => {
    const wider: SequenceFormat = { ...DISPOSAL_FORMAT, sequenceDigits: 7 };
    expect(patternMatchesOwnOutput(wider, AT, 123)).toBe(true);
    // The six-digit pattern does not match a seven-digit number — the failure a hardcoded regex
    // would have produced silently.
    expect(formatTrackingNumber(wider, AT, 123).match(trackingNumberPattern(DISPOSAL_FORMAT))).toBeNull();

    expect(patternMatchesOwnOutput({ ...DISPOSAL_FORMAT, includeMonth: true, resetPeriod: "monthly" }, AT, 9)).toBe(true);
    expect(patternMatchesOwnOutput({ ...DISPOSAL_FORMAT, yearDigits: 0, separator: "/" }, AT, 9)).toBe(true);
    expect(patternMatchesOwnOutput({ ...DISPOSAL_FORMAT, yearDigits: 2 }, AT, 9)).toBe(true);
  });

  it("does not half-match a number embedded in a longer token", () => {
    expect(("X" + DSP + "X").match(trackingNumberPattern(DISPOSAL_FORMAT))).toBeNull();
  });

  describe("a malformed configuration matches nothing, loudly", () => {
    const bad = (o: Partial<SequenceFormat>) => formatProblem({ ...DISPOSAL_FORMAT, ...o });

    it("refuses a width of zero, which would match an empty run", () => {
      expect(bad({ sequenceDigits: 0 })).toContain("width of 0");
      expect(bad({ sequenceDigits: -1 })).toBeTruthy();
      expect(bad({ sequenceDigits: 13 })).toBeTruthy();
      expect(bad({ sequenceDigits: 2.5 })).toBeTruthy();
    });

    it("refuses an empty prefix, which would match a bare number anywhere", () => {
      expect(bad({ prefix: "" })).toContain("prefix is empty");
    });

    it("refuses an alphanumeric or empty separator, which breaks the boundary checks", () => {
      expect(bad({ separator: "" })).toContain("separator is empty");
      expect(bad({ separator: "A" })).toContain("letter or digit");
    });

    it("refuses a year width the minter cannot produce", () => {
      expect(bad({ yearDigits: 3 as unknown as 4 })).toContain("yearDigits");
    });

    it("accepts a sound configuration", () => {
      expect(formatProblem(DISPOSAL_FORMAT)).toBeNull();
    });

    it("refuses to build a matcher for a configuration already known to be unusable", () => {
      expect(() => trackingNumberPattern({ ...DISPOSAL_FORMAT, sequenceDigits: 0 })).toThrow(/unusable/);
    });

    it("reports the unusable binding by name instead of silently not searching it", () => {
      const p = proposeLinks({
        bindings: [{ target: "disposal", format: { ...DISPOSAL_FORMAT, sequenceDigits: 0 } }],
        ocrText: `ticket ${DSP}`,
      });
      expect(p.candidates).toEqual([]);
      expect(p.disposition).toBe("not_configured");
      expect(p.unusableBindings).toHaveLength(1);
      expect(p.unusableBindings[0]!.target).toBe("disposal");
      expect(p.reasons.join(" ")).toContain("was not searched");
    });

    it("still searches the sound bindings when one of several is malformed", () => {
      const p = proposeLinks({
        bindings: [{ target: "disposal", format: { ...DISPOSAL_FORMAT, prefix: "" } }, { target: "job", format: JOB_FORMAT }],
        ocrText: `job ${JOB}`,
      });
      expect(p.disposition).toBe("propose_single");
      expect(p.best!.target).toBe("job");
      expect(p.unusableBindings).toHaveLength(1);
    });
  });
});

describe("proposing which record a scan belongs to", () => {
  it("trusts a barcode decode more than a read off the print", () => {
    const fromBarcode = proposeLinks({ bindings: BINDINGS, barcodes: [{ format: "CODE_128", value: DSP }] });
    const fromText = proposeLinks({ bindings: BINDINGS, ocrText: `Facility ticket ${DSP}` });
    expect(fromBarcode.best!.confidence).toBeGreaterThan(fromText.best!.confidence);
    expect(fromBarcode.best!.target).toBe("disposal");
    expect(fromBarcode.best!.barcodeFormat).toBe("CODE_128");
  });

  it("proposes and never links", () => {
    const p = proposeLinks({ bindings: BINDINGS, barcodes: [{ format: "QR_CODE", value: DSP }] });
    expect(p.disposition).toBe("propose_single");
    expect(p.reasons.join(" ")).toContain("confirm it before anything is attached");
    // There is no vocabulary here for having done it.
    expect(["propose_single", "requires_review", "no_candidates", "not_configured"]).toContain(p.disposition);
  });

  it("collapses one number read twice into the better piece of evidence", () => {
    const p = proposeLinks({ bindings: BINDINGS, barcodes: [{ format: "CODE_128", value: DSP }], ocrText: `ticket ${DSP}` });
    expect(p.candidates).toHaveLength(1);
    expect(p.candidates[0]!.source).toBe("barcode");
    expect(p.ambiguous).toBe(false);
  });

  it("collapses the same number repeated across pages", () => {
    const p = proposeLinks({ bindings: BINDINGS, ocrText: `${DSP}\n\n${DSP}\n\n${DSP}` });
    expect(p.candidates).toHaveLength(1);
    expect(p.disposition).toBe("propose_single");
  });

  it("requires review rather than choosing when the page names two records", () => {
    const p = proposeLinks({ bindings: BINDINGS, ocrText: `${DSP} for ${JOB}` });
    expect(p.ambiguous).toBe(true);
    expect(p.disposition).toBe("requires_review");
    expect(p.best).toBeNull();
    expect(p.candidates).toHaveLength(2);
    expect(p.reasons.join(" ")).toContain("not something the scan can settle");
  });

  it("requires review even when one of two candidates is far more confident", () => {
    // A barcode plus a different number in print is still two records, and confidence does not
    // settle which document this is.
    const p = proposeLinks({ bindings: BINDINGS, barcodes: [{ format: "CODE_128", value: DSP }], ocrText: `see job ${JOB}` });
    expect(p.disposition).toBe("requires_review");
    expect(p.best).toBeNull();
  });

  it("requires review for a document that is already linked, whatever it finds", () => {
    const p = proposeLinks({
      bindings: BINDINGS, barcodes: [{ format: "CODE_128", value: DSP }],
      existingLink: { target: "disposal", trackingNumber: DSP },
    });
    expect(p.disposition).toBe("requires_review");
    expect(p.best).toBeNull();
    expect(p.alreadyLinked).toEqual({ target: "disposal", trackingNumber: DSP });
    expect(p.reasons.join(" ")).toContain("already linked");
    expect(p.reasons.join(" ")).toContain("not a re-scan's");
  });

  it("corrects the characters OCR confuses, and says which ones it corrected", () => {
    const p = proposeLinks({ bindings: BINDINGS, ocrText: "Ticket DSP-2026-OOO123 accepted" });
    expect(p.best).not.toBeNull();
    expect(p.best!.trackingNumber).toBe(DSP);
    expect(p.best!.asRead).toContain("OOO");
    expect(p.best!.substitutions).toHaveLength(3);
    expect(p.best!.confidence).toBeLessThan(72);
    expect(p.best!.reason).toContain("Check these characters against the page");
  });

  it("never corrects a barcode decode, which is the number rather than a reading of it", () => {
    const p = proposeLinks({ bindings: BINDINGS, barcodes: [{ format: "CODE_128", value: "DSP-2026-OOO123" }] });
    expect(p.candidates).toEqual([]);
  });

  it("stops proposing once it is correcting half the number", () => {
    expect(MAX_OCR_SUBSTITUTIONS).toBeGreaterThan(0);
    const p = proposeLinks({ bindings: BINDINGS, ocrText: "DSP-ZO26-OOOIZ3" });
    expect(p.best).toBeNull();
    expect(p.candidates).toEqual([]);
    expect(p.disposition).toBe("no_candidates");
  });

  it("does not mangle the prefix while correcting the digits", () => {
    // "DSP" is three characters the substitution table would happily rewrite to "050" if it ran
    // over the whole string, which is how every corrected read stopped matching once.
    const p = proposeLinks({ bindings: BINDINGS, ocrText: "DSP-2026-O00123" });
    expect(p.best!.trackingNumber.startsWith("DSP-")).toBe(true);
  });

  it("says plainly when it found nothing", () => {
    const p = proposeLinks({ bindings: BINDINGS, ocrText: "Nothing resembling a ticket number here" });
    expect(p.candidates).toEqual([]);
    expect(p.best).toBeNull();
    expect(p.disposition).toBe("no_candidates");
  });

  it("distinguishes nothing-found from nothing-configured", () => {
    expect(proposeLinks({ bindings: [], ocrText: DSP }).disposition).toBe("not_configured");
    expect(proposeLinks({ bindings: BINDINGS, ocrText: "nothing here" }).disposition).toBe("no_candidates");
  });

  it("mines a QR pointer for a number without treating the payload as content", () => {
    const p = proposeLinks({ bindings: BINDINGS, barcodes: [{ format: "QR_CODE", value: `https://leaseos.example/r/${DSP}` }] });
    expect(p.best!.trackingNumber).toBe(DSP);
    expect(p.best!.target).toBe("disposal");
  });

  it("survives empty and absent inputs without proposing anything", () => {
    expect(proposeLinks({ bindings: BINDINGS }).disposition).toBe("no_candidates");
    expect(proposeLinks({ bindings: BINDINGS, ocrText: "" }).disposition).toBe("no_candidates");
    expect(proposeLinks({ bindings: BINDINGS, ocrText: null }).disposition).toBe("no_candidates");
    expect(proposeLinks({ bindings: BINDINGS, barcodes: [{ format: "QR_CODE", value: "" }] }).disposition).toBe("no_candidates");
  });
});

/* ------------------------------------------------------------------ */
/* The session                                                         */
/* ------------------------------------------------------------------ */

const pageBytes = (seed: string) => new TextEncoder().encode(`page:${seed}`);
const page = (seed: string, quality: CaptureQualitySignals = GOOD, mimeType = "image/jpeg"): ScannedPage =>
  ({ bytes: pageBytes(seed), mimeType, quality });

const ocrOf = (text: string, mean: number | null = 92): DeviceOcrResult => ({
  engine: "mlkit-text-recognition", engineVersion: "v2", rawText: text,
  blocks: [{ text, confidence: mean }], meanConfidence: mean,
});

async function scriptOcr(entries: Array<[ScannedPage, DeviceOcrResult]>) {
  const m = new Map<string, DeviceOcrResult>();
  for (const [p, r] of entries) m.set(await sha256Hex(p.bytes), r);
  return new ScriptedOcrEngine(m);
}

function deviceWith(
  scanner: ScriptedDocumentScanner,
  ocrEngine: ScriptedOcrEngine = new ScriptedOcrEngine(new Map()),
  barcodes: ScriptedBarcodeScanner = new ScriptedBarcodeScanner(new Map()),
) {
  const clock = new SettableClock(new Date("2026-09-21T15:00:00Z"));
  const keystore = new MemoryKeystore(clock);
  const vault = new MemoryVault(keystore);
  const store = new MemoryStore();
  const outbox = new Outbox(store, vault, clock);
  return { session: new ScanSession({ scanner, ocr: ocrEngine, barcodes, outbox, clock }), outbox, store, vault, clock };
}

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
    expect(await vault.get(capture.files[0]!.vaultRef)).toEqual(p.bytes);
  });

  it("treats an empty scan the same as backing out", async () => {
    const { session } = deviceWith(new ScriptedDocumentScanner([null]));
    await expect(session.capture()).rejects.toThrow(ScanCancelled);

    const { session: s2 } = deviceWith(new ScriptedDocumentScanner([[]]));
    await expect(s2.capture()).rejects.toThrow(ScanCancelled);
  });

  it("says plainly that the device has no scanner rather than failing later", async () => {
    const { session } = deviceWith(new ScriptedDocumentScanner([[page("x")]], false));
    await expect(session.capture()).rejects.toThrow(ScannerUnavailable);
    await expect(session.capture()).rejects.toThrow(/no document scanner/i);
  });

  it("captures and queues when nothing on the device can read the page", async () => {
    const p = page("unreadable");
    const { session } = deviceWith(
      new ScriptedDocumentScanner([[p]]),
      new ScriptedOcrEngine(new Map(), false),
      new ScriptedBarcodeScanner(new Map(), false),
    );
    const draft = await session.capture();
    expect(draft.pages[0]!.ocr).toBeNull();
    expect(draft.pages[0]!.ocrFailed).toBe(false);
    expect(draft.combinedText).toBeNull();

    const capture = await session.finalize({ draft, documentKind: "disposal_ticket", title: "Ticket", jobId: 7 });
    const fields = capture.fields as Record<string, Record<string, unknown>>;
    const proposed = fields.proposed as { pages: Array<{ ocrAttempted: boolean }> };
    expect(proposed.pages[0]!.ocrAttempted).toBe(false);
    expect((fields.capture as { textRecognitionRan: boolean }).textRecognitionRan).toBe(false);
  });

  it("distinguishes a page nobody read, one that read as blank, and one where reading failed", async () => {
    const blank = page("blank");
    const { session } = deviceWith(new ScriptedDocumentScanner([[blank]]), new ScriptedOcrEngine(new Map()));
    const d1 = await session.capture();
    expect(d1.pages[0]!.ocr).not.toBeNull();
    expect(d1.pages[0]!.ocr!.rawText).toBe("");
    expect(d1.pages[0]!.ocrFailed).toBe(false);

    const throwing = new ScriptedOcrEngine(new Map());
    throwing.recognize = async () => { throw new Error("ML Kit model not downloaded"); };
    const { session: s2 } = deviceWith(new ScriptedDocumentScanner([[blank]]), throwing);
    const d2 = await s2.capture();
    expect(d2.pages[0]!.ocr).toBeNull();
    expect(d2.pages[0]!.ocrFailed).toBe(true);
    expect(d2.partialFailures).toEqual([0]);
  });

  it("reports a partial failure across a multi-page scan without losing the pages", async () => {
    const a = page("a"), b = page("b"), c = page("c");
    const engine = await scriptOcr([[a, ocrOf("page a")], [c, ocrOf("page c")]]);
    const bHash = await sha256Hex(b.bytes);
    const inner = engine.recognize.bind(engine);
    engine.recognize = async (bytes: Uint8Array, mime: string) => {
      if ((await sha256Hex(bytes)) === bHash) throw new Error("recognizer died on page 2");
      return inner(bytes, mime);
    };

    const { session } = deviceWith(new ScriptedDocumentScanner([[a, b, c]]), engine);
    const draft = await session.capture();
    expect(draft.pages).toHaveLength(3);
    expect(draft.partialFailures).toEqual([1]);
    expect(draft.pages[0]!.ocr!.rawText).toBe("page a");
    expect(draft.pages[1]!.ocrFailed).toBe(true);
    expect(draft.pages[2]!.ocr!.rawText).toBe("page c");
    // The evidence survives a failed read: all three pages are still filed.
    const capture = await session.finalize({ draft, documentKind: "disposal_ticket", title: "T", jobId: 1 });
    expect(capture.files).toHaveLength(3);
  });

  it("keeps everything read off the page under `proposed`, never beside the confirmed values", async () => {
    const p = page("disp");
    const { session } = deviceWith(
      new ScriptedDocumentScanner([[p]]),
      await scriptOcr([[p, ocrOf("DISPOSAL TICKET\nVolume 14.2 m3")]]),
    );
    const draft = await session.capture();
    const capture = await session.finalize({
      draft, documentKind: "disposal_ticket", title: "Ticket", jobId: 7, confirmedFields: { volume: 14.2 },
    });

    const fields = capture.fields as Record<string, Record<string, unknown>>;
    expect(fields.confirmed).toEqual({ volume: 14.2 });
    expect(Object.keys(fields)).not.toContain("volume");
    expect(JSON.stringify(fields.proposed)).toContain("14.2 m3");
    expect(fields.confirmed).not.toHaveProperty("ocrText");
  });

  it("records that a worker kept a page the gate objected to, and never discards it", async () => {
    const bad = page("gloved", { ...GOOD, focusScore: 20 });
    const { session } = deviceWith(new ScriptedDocumentScanner([[bad], [bad]]));

    const kept = await session.capture({ keepDespiteObjection: [0] });
    expect(kept.pages[0]!.quality.verdict).toBe("reshoot");
    expect(kept.pages[0]!.acceptedOverObjection).toBe(true);
    expect(kept.qualityVerdict).toBe("reshoot");

    const notKept = await session.capture();
    expect(notKept.pages[0]!.acceptedOverObjection).toBe(false);
    const capture = await session.finalize({ draft: notKept, documentKind: "disposal_ticket", title: "T", jobId: 1 });
    expect(capture.files).toHaveLength(1);
  });

  it("lets a worker re-capture after a bad shot, and files the good one", async () => {
    const bad = page("attempt-1", { ...GOOD, glarePercent: 70 });
    const good = page("attempt-2");
    const { session, outbox } = deviceWith(new ScriptedDocumentScanner([[bad], [good]]));

    const first = await session.capture();
    expect(first.qualityVerdict).toBe("reshoot");
    // Nothing was filed, so the re-capture is simply the next scan.
    const second = await session.capture();
    expect(second.qualityVerdict).toBe("acceptable");
    await session.finalize({ draft: second, documentKind: "disposal_ticket", title: "T", jobId: 1 });
    expect(await outbox.listAll()).toHaveLength(1);
  });

  it("keeps multi-page order and names the pages in it", async () => {
    const pages = [page("a"), page("b"), page("c")];
    const { session } = deviceWith(new ScriptedDocumentScanner([pages]));
    const draft = await session.capture();
    expect(draft.pages.map(p => p.pageIndex)).toEqual([0, 1, 2]);

    const capture = await session.finalize({ draft, documentKind: "hazardous_waste_manifest", title: "Manifest", jobId: 3 });
    expect(capture.files.map(f => f.fileName)).toEqual([
      "hazardous_waste_manifest-p01.jpg", "hazardous_waste_manifest-p02.jpg", "hazardous_waste_manifest-p03.jpg",
    ]);
    for (let i = 0; i < pages.length; i++) {
      expect(capture.files[i]!.contentHash).toBe(await sha256Hex(pages[i]!.bytes));
    }
  });

  it("files a single page and a multi-page scan as one capture each", async () => {
    const { session, outbox } = deviceWith(new ScriptedDocumentScanner([[page("one")], [page("m1"), page("m2")]]));
    await session.finalize({ draft: await session.capture(), documentKind: "invoice", title: "One", jobId: 1 });
    await session.finalize({ draft: await session.capture(), documentKind: "invoice", title: "Two", jobId: 1 });
    const all = await outbox.listAll();
    expect(all).toHaveLength(2);
    expect(all.map(c => c.files.length).sort()).toEqual([1, 2]);
  });

  it("refuses a scan with no pages", async () => {
    const { session } = deviceWith(new ScriptedDocumentScanner([[page("x")]]));
    const draft = await session.capture();
    await expect(session.finalize({
      draft: { ...draft, pages: [], pageBytes: [] }, documentKind: "disposal_ticket", title: "T", jobId: 1,
    })).rejects.toThrow(/no pages/);
  });

  it("files an unclassified scan rather than guessing what it is", async () => {
    const { session } = deviceWith(new ScriptedDocumentScanner([[page("mystery")]]));
    const capture = await session.finalize({
      draft: await session.capture(), documentKind: null, title: "Unknown document", jobId: 1,
    });
    expect(capture.kind).toBe("scanned_document");
    expect((capture.fields as { documentKind: unknown }).documentKind).toBeNull();
    expect(capture.files[0]!.fileName).toContain("unclassified");
  });

  describe("offline capture and the claim it carries", () => {
    it("carries the device's capture-time authorization claim without upgrading it", async () => {
      const { session } = deviceWith(new ScriptedDocumentScanner([[page("auth")]]));
      const capture = await session.finalize({
        draft: await session.capture(), documentKind: "disposal_ticket", title: "T", jobId: 1,
        captureAuthorizationClaim: "unauthorized", captureAuthorizationReason: "no session on the device",
      });
      expect(capture.captureAuthorizationClaim).toBe("unauthorized");
      expect(capture.captureAuthorizationReason).toBe("no session on the device");
    });

    it("defaults the claim to unknown rather than to authorized", async () => {
      const { session } = deviceWith(new ScriptedDocumentScanner([[page("noclaim")]]));
      const capture = await session.finalize({ draft: await session.capture(), documentKind: "disposal_ticket", title: "T", jobId: 1 });
      expect(capture.captureAuthorizationClaim).toBe("unknown");
    });

    it("keeps the device's own capture time", async () => {
      const { session } = deviceWith(new ScriptedDocumentScanner([[page("timed")]]));
      const at = new Date("2026-09-20T03:15:00Z");
      const capture = await session.finalize({
        draft: await session.capture(), documentKind: "disposal_ticket", title: "T", jobId: 1, capturedAt: at,
      });
      expect(capture.capturedAt).toBe(at.toISOString());
    });
  });

  describe("a re-scan of the same paper is not a second document", () => {
    it("gives identical pages an identical fingerprint and different pages a different one", async () => {
      const { session } = deviceWith(new ScriptedDocumentScanner([[page("same")], [page("same")], [page("other")]]));
      const a = await session.capture();
      const b = await session.capture();
      const c = await session.capture();
      expect(b.sessionFingerprint).toBe(a.sessionFingerprint);
      expect(c.sessionFingerprint).not.toBe(a.sessionFingerprint);
    });

    it("refuses to file the same pages twice", async () => {
      const { session, outbox } = deviceWith(new ScriptedDocumentScanner([[page("dup")], [page("dup")]]));
      await session.finalize({ draft: await session.capture(), documentKind: "disposal_ticket", title: "T", jobId: 1 });
      await expect(session.finalize({
        draft: await session.capture(), documentKind: "disposal_ticket", title: "T", jobId: 1,
      })).rejects.toThrow(DuplicateScan);
      expect(await outbox.listAll()).toHaveLength(1);
    });

    it("files a genuine second scan when somebody asks for it explicitly", async () => {
      const { session, outbox } = deviceWith(new ScriptedDocumentScanner([[page("dup")], [page("dup")]]));
      await session.finalize({ draft: await session.capture(), documentKind: "disposal_ticket", title: "T", jobId: 1 });
      await session.finalize({
        draft: await session.capture(), documentKind: "disposal_ticket", title: "T", jobId: 1, allowDuplicate: true,
      });
      expect(await outbox.listAll()).toHaveLength(2);
    });

    it("orders the fingerprint by page, so the same pages scanned in a different order are a different scan", async () => {
      const p1 = page("p1"), p2 = page("p2");
      const { session } = deviceWith(new ScriptedDocumentScanner([[p1, p2], [p2, p1]]));
      const a = await session.capture();
      const b = await session.capture();
      expect(a.sessionFingerprint).not.toBe(b.sessionFingerprint);
    });
  });
});

/* ------------------------------------------------------------------ */
/* The outbox and sync: one queue, the existing tiers                  */
/* ------------------------------------------------------------------ */

describe("a scan rides the existing outbox", () => {
  it("files each document kind at the tier its content deserves", () => {
    expect(captureKindForScan("tdg_shipping_document")).toBe("tdg_document");
    expect(captureKindForScan("disposal_ticket")).toBe("disposal_ticket");
    expect(captureKindForScan("fuel_receipt")).toBe("fuel_receipt");
    expect(captureKindForScan("expense_receipt")).toBe("expense_receipt");
    expect(captureKindForScan("load_ticket")).toBe("load_ticket");
    expect(captureKindForScan("invoice")).toBe("scanned_document");
    expect(captureKindForScan(null)).toBe("scanned_document");
  });

  it("puts a scanned shipping document ahead of an unclassified scan, and both ahead of photographs", () => {
    expect(captureSyncPriority("tdg_document")).toBeLessThan(captureSyncPriority("scanned_document"));
    expect(captureSyncPriority("scanned_document")).toBeLessThan(captureSyncPriority("photo"));
    // And nothing outranks a prohibition.
    expect(captureSyncPriority("oos_order")).toBeLessThan(captureSyncPriority("tdg_document"));
  });

  it("puts an unclassified scan in the ticket tier rather than inventing one", () => {
    expect(captureSyncPriority("scanned_document")).toBe(captureSyncPriority("disposal_ticket"));
    expect(captureSyncPriority("scanned_document")).toBe(captureSyncPriority("fuel_receipt"));
  });

  it("sorts a real queue so evidence outruns bulk media", async () => {
    const { session, outbox } = deviceWith(new ScriptedDocumentScanner([[page("tdg")], [page("misc")]]));
    await session.finalize({ draft: await session.capture(), documentKind: "tdg_shipping_document", title: "TDG", jobId: 1 });
    await session.finalize({ draft: await session.capture(), documentKind: "invoice", title: "Inv", jobId: 1 });
    const ordered = prioritizeQueuedCaptures(await outbox.listAll());
    expect(ordered[0]!.kind).toBe("tdg_document");
    expect(ordered[1]!.kind).toBe("scanned_document");
  });

  it("refuses to queue a scan that belongs to no job and no unit", async () => {
    const { session, outbox } = deviceWith(new ScriptedDocumentScanner([[page("orphan")]]));
    const capture = await session.finalize({ draft: await session.capture(), documentKind: "disposal_ticket", title: "Orphan" });
    await expect(outbox.queue(capture.localId)).rejects.toThrow(/no job or unit/);
  });

  it("queues through the existing state machine and survives a retry idempotently", async () => {
    const { session, outbox } = deviceWith(new ScriptedDocumentScanner([[page("sync")]]));
    const capture = await session.finalize({ draft: await session.capture(), documentKind: "disposal_ticket", title: "T", jobId: 4 });
    expect(capture.syncState).toBe("saved_locally");

    const queued = await outbox.queue(capture.localId);
    expect(queued.syncState).toBe("queued");

    await outbox.markSyncing(capture.localId, "PKG-1");
    await outbox.markFailed(capture.localId, "connection dropped");
    // A retry re-queues the SAME capture rather than making a second one.
    const requeued = await outbox.queue(capture.localId);
    expect(requeued.syncState).toBe("queued");
    expect(requeued.localId).toBe(capture.localId);
    expect(await outbox.listAll()).toHaveLength(1);

    await outbox.markSyncing(capture.localId, "PKG-2");
    await outbox.markSynchronized(capture.localId);
    const finished = (await outbox.listAll())[0]!;
    expect(finished.syncState).toBe("synchronized");
    expect(finished.attempts).toBe(2);
  });

  it("adds no second queue: the scan is an ordinary capture in the same outbox", async () => {
    const { session, outbox } = deviceWith(new ScriptedDocumentScanner([[page("q")]]));
    await session.finalize({ draft: await session.capture(), documentKind: "disposal_ticket", title: "T", jobId: 1 });
    const status = await outbox.status();
    expect(status.counts.saved_locally).toBe(1);
    expect(Object.keys(status.counts).sort()).toEqual(
      ["conflict", "failed", "queued", "saved_locally", "syncing", "synchronized"].sort(),
    );
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

  const allConfirmed = (kind: PaperworkKind) =>
    guidanceFor(kind).fields.map(f => ({ key: f.key, status: "confirmed" as ObservedFieldStatus }));

  it("takes its verdict from printability rather than forming a second opinion", () => {
    const r = reviewScan({ kind: "disposal_ticket", pages: [summary()], observations: allConfirmed("disposal_ticket") });
    expect(r.printability.verdict).toBe("printable");
    expect(r.readyToFile).toBe(true);

    const provisional = reviewScan({
      kind: "disposal_ticket", pages: [summary()],
      observations: guidanceFor("disposal_ticket").fields.map(f => ({ key: f.key, status: "proposed" as ObservedFieldStatus })),
    });
    expect(provisional.printability.verdict).toBe("refused");
    expect(provisional.readyToFile).toBe(false);
  });

  it("puts what vanishes when the truck moves above what the office can chase", () => {
    const r = reviewScan({
      kind: "hazardous_waste_manifest",
      pages: [summary({ qualityVerdict: "reshoot", qualityFailures: ["focus 20 of 100"] })],
      observations: [],
    });
    const order: Array<ScannedPageSummary extends never ? never : string> = ["before_you_leave", "while_you_have_the_paper", "before_filing"];
    const seen = r.actions.map(a => a.urgency);
    expect(seen[0]).toBe("before_you_leave");
    expect(seen).toEqual([...seen].sort((a, b) => order.indexOf(a) - order.indexOf(b)));
    expect(r.actions[0]!.text).toMatch(/signature|PIN/i);
  });

  it("names a faded read for what it is rather than passing the numbers on", () => {
    const r = reviewScan({
      kind: "disposal_ticket", pages: [summary({ ocrMeanConfidence: 54 })],
      observations: allConfirmed("disposal_ticket"),
    });
    const rec = r.actions.find(a => a.from === "recognition")!;
    expect(rec.text).toContain("Faded thermal paper");
    expect(rec.urgency).toBe("while_you_have_the_paper");
  });

  it("says when no recognizer ran at all", () => {
    const r = reviewScan({
      kind: "disposal_ticket", pages: [summary({ ocrAttempted: false, ocrMeanConfidence: null })],
      observations: [], textRecognitionRan: false,
    });
    expect(r.actions.find(a => a.from === "recognition")!.text).toContain("No text recognizer");
  });

  it("names the pages where reading failed", () => {
    const r = reviewScan({
      kind: "disposal_ticket",
      pages: [summary({ pageIndex: 0 }), summary({ pageIndex: 1, ocrFailed: true, ocrMeanConfidence: null })],
      observations: allConfirmed("disposal_ticket"),
    });
    expect(r.actions.find(a => a.from === "recognition")!.text).toContain("page 2");
  });

  it("flags pages this device never checked", () => {
    const r = reviewScan({ kind: "load_ticket", pages: [summary({ qualityVerdict: "unjudged" })], observations: [] });
    expect(r.actions.find(a => a.from === "quality")!.text).toContain("does not score capture quality");
  });

  it("is not ready to file while a page wants re-shooting, even with every field confirmed", () => {
    const r = reviewScan({
      kind: "disposal_ticket",
      pages: [summary({ qualityVerdict: "reshoot", qualityFailures: ["glare"] })],
      observations: allConfirmed("disposal_ticket"),
    });
    expect(r.printability.verdict).toBe("printable");
    expect(r.readyToFile).toBe(false);
  });

  it("is never ready to file an unclassified document", () => {
    const r = reviewScan({ kind: "unknown", pages: [summary()], observations: [] });
    expect(r.readyToFile).toBe(false);
    expect(r.printability.verdict).toBe("refused");
  });

  it("proposes the link from what the pages actually carried", () => {
    const r = reviewScan({
      kind: "disposal_ticket",
      pages: [summary({ barcodes: [{ format: "CODE_128", value: DSP }] })],
      observations: [], trackingBindings: BINDINGS,
    });
    expect(r.links.disposition).toBe("propose_single");
    expect(r.links.best!.trackingNumber).toBe(DSP);
    expect(r.actions.find(a => a.from === "linking")!.text).toContain("Confirm it");
  });

  it("sends an ambiguous page to review instead of naming one record", () => {
    const r = reviewScan({
      kind: "disposal_ticket",
      pages: [summary({ ocrText: `${DSP} and ${JOB}` })],
      observations: [], trackingBindings: BINDINGS,
    });
    expect(r.links.disposition).toBe("requires_review");
    expect(r.links.best).toBeNull();
    expect(r.actions.find(a => a.from === "linking")!.text).toContain("not something the scan can settle");
  });

  it("sends an already-linked document to review", () => {
    const r = reviewScan({
      kind: "disposal_ticket",
      pages: [summary({ barcodes: [{ format: "CODE_128", value: DSP }] })],
      observations: [], trackingBindings: BINDINGS,
      existingLink: { target: "disposal", trackingNumber: DSP },
    });
    expect(r.links.disposition).toBe("requires_review");
    expect(r.links.best).toBeNull();
    expect(r.actions.find(a => a.from === "linking")!.text).toContain("already linked");
  });

  it("tells a person to pick the record by hand when nothing was found", () => {
    const r = reviewScan({ kind: "disposal_ticket", pages: [summary()], observations: [], trackingBindings: BINDINGS });
    expect(r.actions.find(a => a.from === "linking")!.text).toContain("by hand");
  });

  it("carries the unverified guidance onto the review so a reader can see what it rests on", () => {
    const r = reviewScan({ kind: "tdg_shipping_document", pages: [summary()], observations: [] });
    expect(r.guidance.verification).toBe("unverified");
    expect(r.guidance.fields[0]!.citation.readFrom).toBe(GUIDANCE_SOURCE);
  });

  it("derives its paperwork actions from printability's own blockers, so the two cannot disagree", () => {
    const r = reviewScan({
      kind: "tdg_shipping_document", pages: [summary()],
      observations: [{ key: "un_number", status: "proposed" }],
    });
    const texts = r.actions.filter(a => a.from === "paperwork").map(a => a.text).join(" ");
    for (const b of r.printability.blockers) expect(texts).toContain(b.label);
  });
});
