/**
 * A `DocumentScanner` over the browser's file picker — the demo adapter the routed showcase uses.
 *
 * HS1 keeps hardware behind the runtime's interfaces: no page opens a file input, the camera or the
 * GPS itself (the guard is `server/hs1Capabilities.test.ts`). The showcase is routed in production,
 * so it gets no exemption; it acquires files through the same `DocumentScanner` interface the field
 * runtime's scanner uses, and this adapter is the only file input in the client.
 *
 * It is honest about what it is: a picker, not a scanner. It does no edge detection or deskewing and
 * measured nothing, so every quality signal is null (UNRECORDED, never good). Without a document — a
 * test, a server render — it is unavailable and says so with `NotOnDeviceError`, the one name the
 * runtime uses for a capability that is not there.
 */

import { NotOnDeviceError, type CaptureQualitySignals, type DocumentScanner, type ScannedPage } from "../contracts";

const UNRECORDED: CaptureQualitySignals = { widthPx: null, heightPx: null, focusScore: null, glarePercent: null, edgeConfidence: null, pageCoveragePercent: null };

export class BrowserFilePickerScanner implements DocumentScanner {
  /** `accept` is the picker's file filter, e.g. `image/*` or `image/*,application/pdf`. */
  constructor(private options: { accept: string }) {}

  async available(): Promise<boolean> {
    return typeof document !== "undefined" && typeof document.createElement === "function";
  }

  /** Resolves with the chosen files as pages, or null if the person closed the picker. */
  async scan(options: { maxPages: number; allowGallery: boolean }): Promise<ScannedPage[] | null> {
    if (!(await this.available())) throw new NotOnDeviceError("File picker");
    const input = document.createElement("input");
    input.type = "file";
    input.accept = this.options.accept;
    input.multiple = options.maxPages > 1;
    const files = await new Promise<File[] | null>(resolve => {
      input.addEventListener("change", () => resolve(input.files && input.files.length ? Array.from(input.files) : null), { once: true });
      input.addEventListener("cancel", () => resolve(null), { once: true });
      input.click();
    });
    if (!files) return null;
    const pages: ScannedPage[] = [];
    for (const file of files.slice(0, Math.max(1, options.maxPages))) {
      pages.push({ bytes: new Uint8Array(await file.arrayBuffer()), mimeType: file.type || "application/octet-stream", quality: UNRECORDED });
    }
    return pages;
  }
}
