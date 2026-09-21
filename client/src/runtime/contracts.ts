/**
 * Secure Field Runtime — the contracts.
 *
 * The rule: no internet stops synchronization, not the worker. Everything a
 * worker captures is saved locally first, encrypted, queued, and synced when
 * it can be. The UI must always be able to say which of these a record is:
 *
 *   saved_locally  on this device, not yet queued (a draft the worker is editing)
 *   queued         complete, waiting for a connection
 *   syncing        being sent now
 *   synchronized   the server has it, verified against the seal
 *   failed         the server refused it or the hash did not match — retained, never deleted
 *   conflict       the server had a different version — both retained, a person decides
 *
 * The platform pieces this container cannot run — an encrypted SQLite
 * database, an encrypted file store, a hardware keystore, camera, GPS,
 * biometrics — are behind these interfaces. `adapters/memory.ts` implements
 * them for tests and as the browser fallback; `adapters/capacitor.ts` is the
 * native binding and is exercised only on a device.
 */

import type { CaptureQualitySignals } from "@shared/captureQuality";

export type { CaptureQualitySignals };

export type SyncState = "saved_locally" | "queued" | "syncing" | "synchronized" | "failed" | "conflict";

/** What the device knew at the moment of capture. This is historical evidence, not server authorization. */
export type CaptureAuthorizationClaim = "authorized" | "unauthorized" | "unknown";

export type CaptureKind =
  | "pretrip" | "posttrip" | "hos_event" | "job_accept" | "load_ticket" | "disposal_ticket" | "fuel_receipt"
  | "expense_receipt" | "photo" | "signature" | "incident" | "defect_report" | "tailgate" | "tdg_document" | "voice_note"
  // v22.20 — a roadside enforcement document and the order it carries.
  | "roadside_enforcement" | "oos_order"
  // v23.28 — a document put through the page scanner whose type nobody has established.
  // A scan the classifier DID place is saved under that kind instead, so a scanned
  // disposal ticket syncs at ticket priority rather than at this one.
  | "scanned_document";

export type GpsFix = { latitude: number; longitude: number; accuracyM: number | null; fixedAt: string; source: "device_gps" | "network" | "manual" };

export type LocalCapture = {
  /** Device-scoped id; the server sees `${deviceRef}:${localId}` as the capture reference. */
  localId: string;
  kind: CaptureKind;
  /** The server form this becomes on sync, where one exists (the AI Secretary forms), or null for pure evidence. */
  formKey: string | null;
  title: string;
  category: string;
  fields: Record<string, unknown>;
  /** Encrypted files in the vault: photos, signatures, audio. */
  files: { vaultRef: string; fileName: string; mimeType: string; bytes: number; contentHash: string }[];
  /** When the worker captured it — the device's clock, kept even if it is wrong; the server records its own receipt time. */
  capturedAt: string;
  gps: GpsFix | null;
  jobId: number | null;
  unitId: number | null;
  /**
   * The device's historical claim about whether an authorization context was
   * available at capture time. UNKNOWN is the default. A later successful sync
   * never upgrades this field: recording and authorization are separate facts.
   */
  captureAuthorizationClaim: CaptureAuthorizationClaim;
  captureAuthorizationReason: string | null;
  syncState: SyncState;
  attempts: number;
  lastError: string | null;
  /** Assigned by the server when the upload is acknowledged; the idempotent retry returns the same id. */
  serverEvidenceId: number | null;
  sealed: boolean;
  /** The server's manifest hash from the seal — what the device declares in the package. */
  sealManifestHash: string | null;
  packagedIn: string | null;
  createdAt: string;
  updatedAt: string;
};

export type LocalPackage = { packageRef: string; captureIds: string[]; queuedAt: string; state: "queued" | "sent" | "accepted" | "rejected" | "partial"; receipt: unknown; attempts: number };

export interface LocalStore {
  putCapture(c: LocalCapture): Promise<void>;
  getCapture(localId: string): Promise<LocalCapture | null>;
  listCaptures(filter?: { syncState?: SyncState | SyncState[] }): Promise<LocalCapture[]>;
  putPackage(p: LocalPackage): Promise<void>;
  listPackages(): Promise<LocalPackage[]>;
  getMeta(key: string): Promise<string | null>;
  setMeta(key: string, value: string): Promise<void>;
}

export interface FileVault {
  /** Encrypts and stores; returns the vault reference and the SHA-256 of the plaintext. */
  put(bytes: Uint8Array, mimeType: string): Promise<{ vaultRef: string; contentHash: string; bytes: number }>;
  get(vaultRef: string): Promise<Uint8Array>;
  delete(vaultRef: string): Promise<void>;
  usageBytes(): Promise<number>;
}

export interface Keystore {
  /** The private device key never leaves the keystore. The public SPKI is enrolled server-side. */
  fingerprint(): Promise<string>;
  publicKeySpkiBase64(): Promise<string>;
  signP1363(payload: Uint8Array): Promise<string>;
  createdAt(): Promise<string>;
  attestation(): Promise<"hardware" | "software" | "unknown" | "failed">;
  /** Generates a new device key; the old one remains available for the rotation grace window. */
  rotate(): Promise<{ oldFingerprint: string; newFingerprint: string; newPublicKeySpkiBase64: string }>;
  wrapDataKey(raw: Uint8Array): Promise<Uint8Array>;
  unwrapDataKey(wrapped: Uint8Array): Promise<Uint8Array>;
}

export interface Transport {
  enroll(input: { platform: "android" | "ios" | "windows" | "linux" | "web" | "other"; publicKeySpkiBase64: string; keystoreAttestation: "hardware" | "software" | "unknown" | "failed"; displayName?: string }): Promise<{ deviceRef: string; status: string }>;
  activate(input: { deviceRef: string }): Promise<{ status: string }>;
  rotateKey(input: { deviceRef: string; newPublicKeySpkiBase64: string; reason?: string }): Promise<{ status: string }>;
  uploadEvidence(input: { title: string; category: string; fileName: string; mimeType: string; dataBase64: string; latitude?: number; longitude?: number; notes?: string; clientCaptureRef: string; capturedAt: Date }): Promise<{ id: number; alreadyUploaded?: boolean }>;
  sealEvidence(input: { evidenceId: number; contentHash: string; recordType: string; relationships: { entityType: string; entityId: number; relation: string }[]; deviceId: string; devicePlatform?: string }): Promise<{ ok: true; alreadySealed: boolean; manifestHash: string | null }>;
  receivePackage(input: { deviceRef: string; packageRef: string; queuedAt: Date; signedWithFingerprint: string; signedAt: Date; nonce: string; signatureP1363Base64: string; items: { evidenceRecordId: number; declaredContentHash: string; declaredManifestHash: string; computedContentHash: string; computedManifestHash: string; captureAuthorizationClaim: CaptureAuthorizationClaim; captureAuthorizationReason?: string | null }[]; recordUpdates: { recordType: string; recordRef: string; baseVersion: number; baseValues: Record<string, unknown>; deviceValues: Record<string, unknown> }[] }): Promise<{ packageRef: string; state: string; reason?: string; verified: number; rejected: number; conflicts: number; itemVerdicts?: { evidenceRecordId: number; outcome: "verified" | "rejected"; reason?: string }[] }>;
}

export interface Connectivity { online(): Promise<boolean>; }
export interface Clock { now(): Date; }

export class NotOnDeviceError extends Error {
  constructor(what: string) { super(`${what} is only available on a device with the native shell`); this.name = "NotOnDeviceError"; }
}

/* ------------------------------------------------------------------ */
/* The page scanner                                                     */
/* ------------------------------------------------------------------ */

/**
 * v23.28 — scanning is three separate pieces of hardware-backed machinery, and they are three
 * interfaces because a device can have one without the others: a rugged Android tablet shipped
 * without Google Play Services has no ML Kit document scanner and may still decode a barcode
 * through the plain camera.
 *
 * Each is `available()`-first for the reason the vault is: a capability the device does not have
 * must be declared unavailable in plain words at the moment the worker reaches for it, not
 * discovered at the edge of coverage four hours later. `NotOnDeviceError` is thrown, never
 * returned as a null result that reads like "the page was blank".
 *
 * Expected plugins (not installed in this repository):
 *   @capacitor-mlkit/document-scanner   ML Kit Document Scanner (Android) / VisionKit (iOS)
 *   @capacitor-mlkit/barcode-scanning   ML Kit barcode, Android + iOS + Web
 *   @capacitor-mlkit/text-recognition   ML Kit Text Recognition v2 / Apple Vision, on-device
 *
 * What must be true on the device and cannot be proven here:
 *   - recognition runs ON the device, so a photographed payroll document or a customer's rate
 *     sheet never leaves it to be read;
 *   - the bytes handed back are the scanner's own perspective-corrected output and nothing
 *     re-encodes them between the sensor and the vault;
 *   - the confidences the OCR binding reports are the engine's own. A binding that returned a
 *     flattering constant would defeat the quality gate and the extraction floor together, and
 *     neither would show a mark.
 */

/** One page as the scanner handed it back: already edge-detected, deskewed, shadow-removed. */
export type ScannedPage = {
  bytes: Uint8Array;
  mimeType: string;
  quality: CaptureQualitySignals;
};

export interface DocumentScanner {
  available(): Promise<boolean>;
  /**
   * Opens the platform's own scanning UI and resolves with the pages the worker accepted, or null
   * if they backed out. Cancelling is an ordinary outcome and not an error: a driver who opens the
   * scanner by mistake has not failed at anything.
   */
  scan(options: { maxPages: number; allowGallery: boolean }): Promise<ScannedPage[] | null>;
}

export type OcrBlock = {
  text: string;
  /** 0-100. null where the platform does not expose a per-block score. */
  confidence: number | null;
};

export type DeviceOcrResult = {
  engine: string;
  engineVersion: string | null;
  rawText: string;
  blocks: OcrBlock[];
  /** Mean of the block confidences, or null when the platform scored none of them. */
  meanConfidence: number | null;
};

export interface OcrEngine {
  available(): Promise<boolean>;
  /** On-device text recognition over one page. Nothing is uploaded to read it. */
  recognize(bytes: Uint8Array, mimeType: string): Promise<DeviceOcrResult>;
}

export type DecodedBarcode = {
  /** The symbology as the platform names it: QR_CODE, CODE_128, PDF417, ... */
  format: string;
  value: string;
};

export interface BarcodeScanner {
  available(): Promise<boolean>;
  scanImage(bytes: Uint8Array, mimeType: string): Promise<DecodedBarcode[]>;
}
