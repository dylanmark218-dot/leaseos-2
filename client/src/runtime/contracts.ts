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

export type SyncState = "saved_locally" | "queued" | "syncing" | "synchronized" | "failed" | "conflict";

export type CaptureKind =
  | "pretrip" | "posttrip" | "hos_event" | "job_accept" | "load_ticket" | "disposal_ticket" | "fuel_receipt"
  | "expense_receipt" | "photo" | "signature" | "incident" | "defect_report" | "tailgate" | "tdg_document" | "voice_note";

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
  /** The device key never leaves the keystore; only its fingerprint does. */
  fingerprint(): Promise<string>;
  createdAt(): Promise<string>;
  attestation(): Promise<"hardware" | "software" | "unknown" | "failed">;
  /** Generates a new device key; the old one remains available for the rotation grace window. */
  rotate(): Promise<{ oldFingerprint: string; newFingerprint: string }>;
  wrapDataKey(raw: Uint8Array): Promise<Uint8Array>;
  unwrapDataKey(wrapped: Uint8Array): Promise<Uint8Array>;
}

export interface Transport {
  enroll(input: { platform: "android" | "ios" | "windows" | "linux" | "web" | "other"; keyFingerprint: string; keystoreAttestation: "hardware" | "software" | "unknown" | "failed"; displayName?: string }): Promise<{ deviceRef: string; status: string }>;
  activate(input: { deviceRef: string }): Promise<{ status: string }>;
  rotateKey(input: { deviceRef: string; newKeyFingerprint: string; reason?: string }): Promise<{ status: string }>;
  uploadEvidence(input: { title: string; category: string; fileName: string; mimeType: string; dataBase64: string; latitude?: number; longitude?: number; notes?: string; clientCaptureRef: string; capturedAt: Date }): Promise<{ id: number; alreadyUploaded?: boolean }>;
  sealEvidence(input: { evidenceId: number; contentHash: string; recordType: string; relationships: { entityType: string; entityId: number; relation: string }[]; deviceId: string; devicePlatform?: string }): Promise<{ ok: true; alreadySealed: boolean; manifestHash: string | null }>;
  receivePackage(input: { deviceRef: string; packageRef: string; queuedAt: Date; signedWithFingerprint: string; items: { evidenceRecordId: number; declaredContentHash: string; declaredManifestHash: string; computedContentHash: string; computedManifestHash: string }[]; recordUpdates: { recordType: string; recordRef: string; baseVersion: number; baseValues: Record<string, unknown>; deviceValues: Record<string, unknown> }[] }): Promise<{ packageRef: string; state: string; reason?: string; verified: number; rejected: number; conflicts: number; itemVerdicts?: { evidenceRecordId: number; outcome: "verified" | "rejected"; reason?: string }[] }>;
}

export interface Connectivity { online(): Promise<boolean>; }
export interface Clock { now(): Date; }

export class NotOnDeviceError extends Error {
  constructor(what: string) { super(`${what} is only available on a device with the native shell`); this.name = "NotOnDeviceError"; }
}
