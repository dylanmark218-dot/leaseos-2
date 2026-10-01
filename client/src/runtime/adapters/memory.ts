/**
 * In-memory adapters: for tests, and the browser fallback.
 *
 * The browser fallback is honest about what it is: files are encrypted in
 * memory with a key that also lives in memory. Nothing here is at-rest
 * protection; that is what the native shell exists for. A worker on a plain
 * browser gets the offline queue and the sync protocol, not the vault.
 */

import {
  NotOnDeviceError,
  type BarcodeScanner, type Clock, type Connectivity, type DecodedBarcode, type DeviceOcrResult,
  type DocumentScanner, type FileVault, type Keystore, type LocalCapture, type LocalPackage,
  type LocalStore, type OcrEngine, type ScannedPage, type SyncState,
} from "../contracts";
import { decryptWithRawKey, encryptWithRawKey, generateRawKey, sha256Hex, toBase64 } from "../crypto";

export class MemoryStore implements LocalStore {
  private captures = new Map<string, LocalCapture>();
  private packages = new Map<string, LocalPackage>();
  private meta = new Map<string, string>();
  async putCapture(c: LocalCapture) { this.captures.set(c.localId, structuredClone(c)); }
  async getCapture(id: string) { const c = this.captures.get(id); return c ? structuredClone(c) : null; }
  async listCaptures(filter?: { syncState?: SyncState | SyncState[] }) {
    const want = filter?.syncState == null ? null : new Set(Array.isArray(filter.syncState) ? filter.syncState : [filter.syncState]);
    return Array.from(this.captures.values()).filter(c => !want || want.has(c.syncState)).map(c => structuredClone(c));
  }
  async putPackage(p: LocalPackage) { this.packages.set(p.packageRef, structuredClone(p)); }
  async listPackages() { return Array.from(this.packages.values()).map(p => structuredClone(p)); }
  async getMeta(k: string) { return this.meta.get(k) ?? null; }
  async setMeta(k: string, v: string) { this.meta.set(k, v); }
}

export class MemoryKeystore implements Keystore {
  private keys: { raw: Uint8Array; privateKey: CryptoKey; publicKey: CryptoKey; spki: string; fingerprint: string; createdAt: string }[] = [];
  constructor(private clock: Clock, private attest: "hardware" | "software" | "unknown" | "failed" = "software") {}
  private async makeKey() {
    const pair = await globalThis.crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]) as CryptoKeyPair;
    const spkiBytes = new Uint8Array(await globalThis.crypto.subtle.exportKey("spki", pair.publicKey));
    const spki = toBase64(spkiBytes);
    const raw = await generateRawKey(); // separate AES wrapping key for browser fallback vault
    return { raw, privateKey: pair.privateKey, publicKey: pair.publicKey, spki, fingerprint: await sha256Hex(spkiBytes), createdAt: this.clock.now().toISOString() };
  }
  private async current() { if (!this.keys.length) this.keys.push(await this.makeKey()); return this.keys[this.keys.length - 1]!; }
  async fingerprint() { return (await this.current()).fingerprint; }
  async publicKeySpkiBase64() { return (await this.current()).spki; }
  async signP1363(payload: Uint8Array) { return toBase64(new Uint8Array(await globalThis.crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, (await this.current()).privateKey, payload as BufferSource))); }
  async createdAt() { return (await this.current()).createdAt; }
  async attestation() { return this.attest; }
  async rotate() { const old = await this.current(); const next = await this.makeKey(); this.keys.push(next); return { oldFingerprint: old.fingerprint, newFingerprint: next.fingerprint, newPublicKeySpkiBase64: next.spki }; }
  async wrapDataKey(raw: Uint8Array) { const k = await this.current(); const e = await encryptWithRawKey(k.raw, raw); const out = new Uint8Array(e.iv.length + e.ciphertext.length); out.set(e.iv, 0); out.set(e.ciphertext, e.iv.length); return out; }
  async unwrapDataKey(wrapped: Uint8Array) {
    for (const k of [...this.keys].reverse()) { try { return await decryptWithRawKey(k.raw, wrapped.slice(0, 12), wrapped.slice(12)); } catch { /* next */ } }
    throw new Error("No key unwraps this data key");
  }
}

export class MemoryVault implements FileVault {
  private files = new Map<string, { iv: Uint8Array; ciphertext: Uint8Array; wrappedKey: Uint8Array; bytes: number; mimeType: string }>();
  constructor(private keystore: Keystore) {}
  async put(bytes: Uint8Array, mimeType: string) {
    const raw = await generateRawKey();
    const e = await encryptWithRawKey(raw, bytes);
    const vaultRef = `vault-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    this.files.set(vaultRef, { iv: e.iv, ciphertext: e.ciphertext, wrappedKey: await this.keystore.wrapDataKey(raw), bytes: bytes.length, mimeType });
    return { vaultRef, contentHash: await sha256Hex(bytes), bytes: bytes.length };
  }
  async get(vaultRef: string) { const f = this.files.get(vaultRef); if (!f) throw new Error(`No file ${vaultRef}`); return decryptWithRawKey(await this.keystore.unwrapDataKey(f.wrappedKey), f.iv, f.ciphertext); }
  async delete(vaultRef: string) { this.files.delete(vaultRef); }
  async usageBytes() { let n = 0; for (const f of Array.from(this.files.values())) n += f.bytes; return n; }
  /** Test hook: the stored bytes are not the plaintext. */
  rawStored(vaultRef: string) { return this.files.get(vaultRef)?.ciphertext ?? null; }
}

export class FlagConnectivity implements Connectivity { constructor(public isOnline = true) {} async online() { return this.isOnline; } }
export class SettableClock implements Clock { constructor(private t: Date) {} now() { return new Date(this.t); } set(t: Date) { this.t = t; } advanceDays(n: number) { this.t = new Date(this.t.getTime() + n * 86_400_000); } }

/* ------------------------------------------------------------------ */
/* The page scanner: a script for tests, a refusal for the browser      */
/* ------------------------------------------------------------------ */

/**
 * There is deliberately no in-memory OCR engine.
 *
 * The other adapters in this file degrade honestly — a memory vault is real
 * encryption with a key in the wrong place, and a worker on a plain browser
 * still gets the queue and the sync protocol. Recognition has no such
 * degraded form. Anything this file could compute would be a made-up read of
 * a real document, and a made-up read is indistinguishable, downstream, from
 * a real one: it acquires a confidence, passes the extraction floor, and
 * arrives in front of a person as a proposal about a ticket nobody read.
 *
 * So the browser fallback declares recognition unavailable and the scan path
 * stops there, while tests get a scanner they SCRIPT — named `Scripted` so
 * that a reader of a stack trace can never mistake one for an implementation.
 */

export class UnavailableDocumentScanner implements DocumentScanner {
  async available() { return false; }
  async scan(): Promise<ScannedPage[] | null> { throw new NotOnDeviceError("Document scanner"); }
}

export class UnavailableOcrEngine implements OcrEngine {
  async available() { return false; }
  async recognize(): Promise<DeviceOcrResult> { throw new NotOnDeviceError("On-device text recognition"); }
}

export class UnavailableBarcodeScanner implements BarcodeScanner {
  async available() { return false; }
  async scanImage(): Promise<DecodedBarcode[]> { throw new NotOnDeviceError("Barcode scanner"); }
}

/** Hands back the pages it was given, in order, one session at a time. */
export class ScriptedDocumentScanner implements DocumentScanner {
  /** Each entry is one session's worth of pages; null scripts a cancellation. */
  constructor(private sessions: (ScannedPage[] | null)[], public isAvailable = true) {}
  async available() { return this.isAvailable; }
  async scan(options: { maxPages: number; allowGallery: boolean }): Promise<ScannedPage[] | null> {
    if (!this.isAvailable) throw new NotOnDeviceError("Document scanner");
    const next = this.sessions.shift();
    if (next === undefined) throw new Error("ScriptedDocumentScanner: no session scripted for this call");
    // A real scanner cannot return more pages than the UI allowed it to take;
    // a script that does would be testing against a device that does not exist.
    if (next && next.length > options.maxPages) throw new Error(`ScriptedDocumentScanner: scripted ${next.length} pages, maxPages is ${options.maxPages}`);
    return next;
  }
}

/** Returns the result scripted for a page's content hash, so reads follow bytes rather than call order. */
export class ScriptedOcrEngine implements OcrEngine {
  constructor(private byContentHash: Map<string, DeviceOcrResult>, public isAvailable = true) {}
  async available() { return this.isAvailable; }
  async recognize(bytes: Uint8Array, _mimeType: string): Promise<DeviceOcrResult> {
    if (!this.isAvailable) throw new NotOnDeviceError("On-device text recognition");
    const hash = await sha256Hex(bytes);
    const scripted = this.byContentHash.get(hash);
    // An unscripted page reads as a page the engine found no text on, which is
    // a real outcome for a dark or blank frame — not an error.
    return scripted ?? { engine: "scripted", engineVersion: null, rawText: "", blocks: [], meanConfidence: null };
  }
}

export class ScriptedBarcodeScanner implements BarcodeScanner {
  constructor(private byContentHash: Map<string, DecodedBarcode[]>, public isAvailable = true) {}
  async available() { return this.isAvailable; }
  async scanImage(bytes: Uint8Array, _mimeType: string): Promise<DecodedBarcode[]> {
    if (!this.isAvailable) throw new NotOnDeviceError("Barcode scanner");
    return this.byContentHash.get(await sha256Hex(bytes)) ?? [];
  }
}
