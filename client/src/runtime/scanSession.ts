/**
 * v23.28 — a scan, from the platform's scanner to the durable outbox.
 *
 * What happens here, in order: the worker opens the platform's own scanning UI and accepts some
 * pages; every page is hashed and judged; text and barcodes are read ON the device; and the whole
 * thing becomes one capture in the outbox that syncs like every other piece of evidence. Nothing
 * new is invented downstream of this file — a scan is evidence, and the evidence path already
 * exists. There is deliberately no second queue and no second sync protocol.
 *
 * ## The original is the evidence, and it is never rewritten
 *
 * The bytes the scanner hands back are the bytes that go in the vault and the bytes the hash is
 * taken over. This file does not re-encode, recompress, rotate or "improve" them. A derived copy
 * is for showing on a screen; the evidence artifact is the original, because an evidence chain
 * whose first link is a transformation nobody recorded is not a chain.
 *
 * ## Everything read off the page is a proposal
 *
 * OCR output lands in the capture as proposed values with their engine, their confidence and the
 * text they came from. It is never written as a fact, and this file has no path that promotes it
 * to one. `shared/paperworkGuidance.fieldStateFor` turns a proposal into `provisional`, and
 * `printability` refuses to print a provisional value on a regulatory document. A model that
 * "thought the ticket said 14.2 m3" and a ticket that says 14.2 m3 look identical in a database
 * column and entirely different to an auditor.
 *
 * ## Missing hardware is said out loud, at the moment it is reached for
 *
 * A device with no text recognizer still scans: the pages are captured, hashed and queued, and the
 * capture records that nothing read them. That is a worse outcome than a device with OCR and a
 * much better one than a scan that silently carries no text and looks like a document with nothing
 * on it.
 *
 * ## A re-scan of the same paper is not a second document
 *
 * Finalizing computes a fingerprint over the ordered page hashes and refuses a draft whose
 * fingerprint is already in the outbox. A driver who taps Save twice on a bad connection, or a UI
 * that retries, files one scan and not three. Overriding is possible and explicit, because two
 * genuinely separate photographs of the same ticket are a real thing — but it has to be asked for.
 */

import type {
  BarcodeScanner, CaptureAuthorizationClaim, CaptureKind, Clock, DecodedBarcode, DeviceOcrResult,
  DocumentScanner, GpsFix, LocalCapture, OcrEngine, ScannedPage,
} from "./contracts";
import {
  assessPageQuality, sessionQualityVerdict,
  type PageQualityAssessment, type PageQualityVerdict,
} from "@shared/captureQuality";
import { canonicalJson, sha256Hex, sha256HexOfString } from "./crypto";
import type { Outbox } from "./outbox";

/* ------------------------------------------------------------------ */
/* What a scan is, before it becomes a capture                         */
/* ------------------------------------------------------------------ */

/**
 * The document kinds a scan can be filed as.
 *
 * Exactly `shared/paperworkGuidance.PaperworkKind` minus `unknown`, which is not something a
 * worker chooses — an unclassified scan is the absence of a choice, and `documentKind` is
 * optional on `finalize` for that reason. A compile-time assertion in the test suite fails the
 * build if the two lists drift.
 */
export type ScanDocumentKind =
  | "expense_receipt" | "fuel_receipt" | "disposal_ticket" | "load_ticket"
  | "scale_ticket" | "invoice" | "safety_document"
  | "tdg_shipping_document" | "hazardous_waste_manifest" | "bill_of_lading" | "inspection_report";

/**
 * Which outbox tier a scanned document rides in.
 *
 * A scanned TDG shipping document is legal-state evidence and outranks photographs; a scanned
 * receipt is not and does not. This maps onto the EXISTING `CaptureKind` tiers rather than adding
 * a scanner-specific priority table, so there is one answer to "what outruns what".
 */
export function captureKindForScan(kind: ScanDocumentKind | null): CaptureKind {
  switch (kind) {
    case "tdg_shipping_document": return "tdg_document";
    case "disposal_ticket": return "disposal_ticket";
    case "load_ticket": return "load_ticket";
    case "fuel_receipt": return "fuel_receipt";
    case "expense_receipt": return "expense_receipt";
    case "hazardous_waste_manifest":
    case "scale_ticket":
    case "invoice":
    case "bill_of_lading":
    case "inspection_report":
    case "safety_document":
    case null:
      return "scanned_document";
  }
}

export type ScannedPageRecord = {
  pageIndex: number;
  contentHash: string;
  bytes: number;
  mimeType: string;
  quality: PageQualityAssessment;
  /**
   * True when the gate said re-shoot and the worker kept the page anyway. Not a fault — it is
   * often the right call on a lease — but it is a fact a reviewer of a doubtful extraction needs.
   */
  acceptedOverObjection: boolean;
  /** null when no recognizer was available OR the recognizer failed on this page. */
  ocr: DeviceOcrResult | null;
  /** True when a recognizer ran and threw. Distinguishes a failed read from no recognizer at all. */
  ocrFailed: boolean;
  /** null when no barcode scanner was available; an empty array means it looked and found none. */
  barcodes: DecodedBarcode[] | null;
  barcodeScanFailed: boolean;
};

export type ScanHardwareReport = {
  scanner: boolean;
  ocr: boolean;
  barcodes: boolean;
  /** Plain words for the worker. Empty when everything is present. */
  unavailable: string[];
};

export type ScanDraft = {
  pages: ScannedPageRecord[];
  /** The raw bytes, held only until the draft is finalized into the vault. */
  pageBytes: Uint8Array[];
  qualityVerdict: PageQualityVerdict;
  hardware: ScanHardwareReport;
  /** Concatenated page text, in page order. null when no recognizer was available. */
  combinedText: string | null;
  /** Every barcode found across the pages. null when no scanner was available. */
  allBarcodes: DecodedBarcode[] | null;
  /**
   * SHA-256 over the ordered page hashes. The same paper photographed the same way twice produces
   * the same fingerprint, which is what makes a replayed finalize detectable.
   */
  sessionFingerprint: string;
  /** Pages where a recognizer ran and failed. A partial read is reported, never hidden. */
  partialFailures: number[];
};

/* ------------------------------------------------------------------ */
/* The session                                                         */
/* ------------------------------------------------------------------ */

export class ScanCancelled extends Error {
  constructor() { super("The worker closed the scanner without accepting any pages"); this.name = "ScanCancelled"; }
}

export class ScannerUnavailable extends Error {
  constructor() {
    super("This device has no document scanner. Photograph the document with the camera instead, or scan it from a device that has one.");
    this.name = "ScannerUnavailable";
  }
}

export class DuplicateScan extends Error {
  constructor(public readonly fingerprint: string, public readonly existingLocalId: string) {
    super(`These exact pages are already in the outbox as capture ${existingLocalId}. File it again only if this really is a second scan.`);
    this.name = "DuplicateScan";
  }
}

export class ScanSession {
  constructor(private deps: {
    scanner: DocumentScanner;
    ocr: OcrEngine;
    barcodes: BarcodeScanner;
    outbox: Outbox;
    clock: Clock;
  }) {}

  /**
   * What this device can actually do, asked before the worker commits to anything. A rugged
   * Android tablet without Google Play Services has no ML Kit document scanner, and the moment to
   * say so is now — not four hours later at the edge of coverage.
   */
  async hardware(): Promise<ScanHardwareReport> {
    const [scanner, ocr, barcodes] = await Promise.all([
      this.deps.scanner.available().catch(() => false),
      this.deps.ocr.available().catch(() => false),
      this.deps.barcodes.available().catch(() => false),
    ]);
    const unavailable: string[] = [];
    if (!scanner) unavailable.push("document scanner");
    if (!ocr) unavailable.push("text recognition — pages will be stored and queued, but nothing will read them on this device");
    if (!barcodes) unavailable.push("barcode scanning — tracking numbers will not be auto-detected");
    return { scanner, ocr, barcodes, unavailable };
  }

  /**
   * Open the scanner, judge what comes back, and read it.
   *
   * Throws `ScanCancelled` when the worker backs out or accepts nothing, which is an ordinary
   * outcome and not an error state — the caller catches it and shows nothing. Calling `capture`
   * again is how a re-capture works: nothing is retained between calls, so a re-shoot is simply
   * the next scan.
   */
  async capture(options: {
    maxPages?: number;
    allowGallery?: boolean;
    /** Pages the gate objected to that the worker chose to keep, by page index. */
    keepDespiteObjection?: readonly number[];
  } = {}): Promise<ScanDraft> {
    const hardware = await this.hardware();
    if (!hardware.scanner) throw new ScannerUnavailable();

    const maxPages = options.maxPages ?? 20;
    const pages = await this.deps.scanner.scan({ maxPages, allowGallery: options.allowGallery ?? false });
    if (pages == null || pages.length === 0) throw new ScanCancelled();

    const keep = new Set(options.keepDespiteObjection ?? []);
    const records: ScannedPageRecord[] = [];
    const bytes: Uint8Array[] = [];
    const partialFailures: number[] = [];

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i]!;
      const quality = assessPageQuality(page.quality);
      const read = hardware.ocr ? await this.readText(page) : { result: null, failed: false };
      const codes = hardware.barcodes ? await this.readBarcodes(page) : { result: null, failed: false };
      if (read.failed) partialFailures.push(i);

      records.push({
        pageIndex: i,
        contentHash: await sha256Hex(page.bytes),
        bytes: page.bytes.length,
        mimeType: page.mimeType,
        quality,
        acceptedOverObjection: quality.verdict === "reshoot" && keep.has(i),
        ocr: read.result,
        ocrFailed: read.failed,
        barcodes: codes.result,
        barcodeScanFailed: codes.failed,
      });
      bytes.push(page.bytes);
    }

    const texts = records.map(r => r.ocr?.rawText ?? "").filter(t => t.length > 0);
    const barcodeLists = records.map(r => r.barcodes).filter((b): b is DecodedBarcode[] => b != null);

    return {
      pages: records,
      pageBytes: bytes,
      qualityVerdict: sessionQualityVerdict(records.map(r => r.quality)),
      hardware,
      combinedText: hardware.ocr ? texts.join("\n\n") : null,
      allBarcodes: hardware.barcodes ? barcodeLists.flat() : null,
      sessionFingerprint: await sha256HexOfString(canonicalJson(records.map(r => r.contentHash))),
      partialFailures,
    };
  }

  /**
   * A recognizer that throws did not read the page — which is what `null` means here, with
   * `failed` distinguishing it from a device that has no recognizer at all. It is never allowed to
   * fail the whole scan: the pages are the evidence and they are already captured.
   */
  private async readText(page: ScannedPage): Promise<{ result: DeviceOcrResult | null; failed: boolean }> {
    try { return { result: await this.deps.ocr.recognize(page.bytes, page.mimeType), failed: false }; }
    catch { return { result: null, failed: true }; }
  }

  private async readBarcodes(page: ScannedPage): Promise<{ result: DecodedBarcode[] | null; failed: boolean }> {
    try { return { result: await this.deps.barcodes.scanImage(page.bytes, page.mimeType), failed: false }; }
    catch { return { result: null, failed: true }; }
  }

  /**
   * Put the scan in the outbox.
   *
   * The draft is saved, never queued, by this method. Queuing is the worker saying they are
   * finished with it, and `Outbox.queue` refuses a capture that names no job and no unit — better
   * heard while the paper is still in their hand than by the sync engine at midnight.
   *
   * `documentKind` is nullable on purpose: a scan nobody has classified is filed as one, under the
   * strictest guidance, rather than being guessed at.
   */
  async finalize(args: {
    draft: ScanDraft;
    documentKind: ScanDocumentKind | null;
    title: string;
    /** Values a PERSON entered or confirmed. OCR proposals never come in through here. */
    confirmedFields?: Record<string, unknown>;
    jobId?: number | null;
    unitId?: number | null;
    gps?: GpsFix | null;
    capturedAt?: Date;
    captureAuthorizationClaim?: CaptureAuthorizationClaim;
    captureAuthorizationReason?: string | null;
    /** Explicitly file a second scan of the same pages. Refused by default. */
    allowDuplicate?: boolean;
  }): Promise<LocalCapture> {
    const { draft } = args;
    if (draft.pages.length === 0) throw new Error("A scan with no pages cannot be filed");
    if (draft.pages.length !== draft.pageBytes.length) {
      throw new Error(`Scan draft is inconsistent: ${draft.pages.length} page records against ${draft.pageBytes.length} page images`);
    }

    if (!args.allowDuplicate) {
      const existing = await this.findByFingerprint(draft.sessionFingerprint);
      if (existing) throw new DuplicateScan(draft.sessionFingerprint, existing);
    }

    const ext = (mime: string) => (mime.indexOf("pdf") >= 0 ? "pdf" : mime.indexOf("png") >= 0 ? "png" : "jpg");
    const kindLabel = args.documentKind ?? "unclassified";

    return this.deps.outbox.saveDraft({
      kind: captureKindForScan(args.documentKind),
      // The server form, where the document has one, is decided by the server's extraction path
      // from the document type. The device does not choose it.
      formKey: null,
      title: args.title,
      category: "scanned_document",
      fields: {
        documentKind: args.documentKind,
        sessionFingerprint: draft.sessionFingerprint,
        /** Confirmed by a person. Separate from anything read off the page. */
        confirmed: args.confirmedFields ?? {},
        /**
         * Everything the device read. Nested under `proposed` so no consumer can mistake it for
         * confirmed data by reading a top-level key, and so a reviewer sees the boundary in the
         * record itself.
         */
        proposed: {
          pages: draft.pages.map(p => ({
            pageIndex: p.pageIndex,
            contentHash: p.contentHash,
            mimeType: p.mimeType,
            bytes: p.bytes,
            qualityVerdict: p.quality.verdict,
            qualityFailures: p.quality.failures.map(f => f.message),
            qualityUnreported: p.quality.unreported,
            acceptedOverObjection: p.acceptedOverObjection,
            ocrEngine: p.ocr?.engine ?? null,
            ocrEngineVersion: p.ocr?.engineVersion ?? null,
            ocrMeanConfidence: p.ocr?.meanConfidence ?? null,
            ocrText: p.ocr?.rawText ?? null,
            ocrAttempted: p.ocr !== null || p.ocrFailed,
            ocrFailed: p.ocrFailed,
            barcodes: p.barcodes,
            barcodesAttempted: p.barcodes !== null || p.barcodeScanFailed,
            barcodeScanFailed: p.barcodeScanFailed,
          })),
          combinedText: draft.combinedText,
        },
        capture: {
          qualityVerdict: draft.qualityVerdict,
          pageCount: draft.pages.length,
          hardwareUnavailable: draft.hardware.unavailable,
          textRecognitionRan: draft.hardware.ocr,
          barcodeScanningRan: draft.hardware.barcodes,
          partialFailurePages: draft.partialFailures,
        },
      },
      files: draft.pages.map((p, i) => ({
        bytes: draft.pageBytes[i]!,
        fileName: `${kindLabel}-p${String(p.pageIndex + 1).padStart(2, "0")}.${ext(p.mimeType)}`,
        mimeType: p.mimeType,
      })),
      gps: args.gps ?? null,
      jobId: args.jobId ?? null,
      unitId: args.unitId ?? null,
      capturedAt: args.capturedAt ?? this.deps.clock.now(),
      captureAuthorizationClaim: args.captureAuthorizationClaim ?? "unknown",
      captureAuthorizationReason: args.captureAuthorizationReason ?? null,
    });
  }

  /** The localId of a capture already carrying this fingerprint, or null. */
  private async findByFingerprint(fingerprint: string): Promise<string | null> {
    const all = await this.deps.outbox.listAll();
    for (const c of all) {
      const fields = c.fields as { sessionFingerprint?: unknown };
      if (typeof fields?.sessionFingerprint === "string" && fields.sessionFingerprint === fingerprint) return c.localId;
    }
    return null;
  }
}
