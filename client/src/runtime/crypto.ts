/**
 * Envelope encryption on WebCrypto, which exists in browsers and in Node.
 *
 * Each file gets its own AES-256-GCM data key. The data key is wrapped by
 * the device key, which lives in the keystore and never leaves it. Rotating
 * the device key rewraps data keys; it never re-encrypts files. Hashes are
 * SHA-256 hex, the same as the server's seals.
 */

const subtle = globalThis.crypto.subtle;

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256HexOfString(s: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(s));
}

/** Canonical JSON: sorted keys, so the same manifest hashes the same on device and server. */
export function canonicalJson(value: unknown): string {
  const sort = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sort)
    : v && typeof v === "object" ? Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map(k => [k, sort((v as Record<string, unknown>)[k])]))
    : v;
  return JSON.stringify(sort(value));
}

export type Envelope = { iv: Uint8Array; ciphertext: Uint8Array; wrappedKey: Uint8Array };

export async function generateRawKey(): Promise<Uint8Array> {
  return globalThis.crypto.getRandomValues(new Uint8Array(32));
}

export async function encryptWithRawKey(raw: Uint8Array, plaintext: Uint8Array): Promise<{ iv: Uint8Array; ciphertext: Uint8Array }> {
  const key = await subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, plaintext as BufferSource);
  return { iv, ciphertext: new Uint8Array(ct) };
}

export async function decryptWithRawKey(raw: Uint8Array, iv: Uint8Array, ciphertext: Uint8Array): Promise<Uint8Array> {
  const key = await subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, ["decrypt"]);
  const pt = await subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, key, ciphertext as BufferSource);
  return new Uint8Array(pt);
}

export function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]!);
  return btoa(s);
}
