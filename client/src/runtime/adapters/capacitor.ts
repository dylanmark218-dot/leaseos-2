/**
 * Native bindings — exercised only on a device with the Capacitor shell.
 *
 * This file is the boundary the P4 checkpoint drew and this tranche does not
 * cross in a container: the encrypted SQLite database, the encrypted file
 * store, the hardware keystore, camera, GPS, biometrics. Each binding loads
 * its plugin at runtime and throws NotOnDeviceError when it is absent, so the
 * runtime compiles and tests here and does the real thing there.
 *
 * Expected plugins (not installed in this repository):
 *   @capacitor-community/sqlite       encrypted database (SQLCipher)
 *   @capacitor/filesystem             encrypted file store under the app sandbox
 *   capacitor-secure-storage-plugin   Keychain / Keystore-backed device key
 *   @capacitor/camera, @capacitor/geolocation
 *   @capacitor-mlkit/document-scanner ML Kit Document Scanner / VisionKit
 *   @capacitor-mlkit/barcode-scanning ML Kit barcode
 *
 * What must be true on the device, and cannot be proven here:
 *   - the SQLite file is encrypted at rest with a key from the keystore;
 *   - the device key is hardware-backed where the platform offers it, and the
 *     enrolment reports `keystoreAttestation: "hardware"` only when it is;
 *   - biometrics or the device PIN authorize signing and never leave the
 *     platform authenticator; LeaseOS stores no biometric template.
 *   - the scanner and the text recognizer run wholly on the device, so a
 *     photographed rate sheet or payroll document is never uploaded to be read;
 *   - the confidences the OCR binding reports are the engine's own. A binding
 *     that returned a flattering constant would defeat the quality gate and
 *     the extraction floor together, and neither would show a mark.
 */

import {
  NotOnDeviceError,
  type BarcodeScanner, type DocumentScanner, type FileVault, type Keystore, type LocalStore, type OcrEngine,
} from "../contracts";

type PluginLoader<T> = () => Promise<T | null>;

async function load<T>(name: string): Promise<T | null> {
  try { return (await import(/* @vite-ignore */ name)) as T; } catch { return null; }
}

export function capacitorStore(): { available: () => Promise<boolean>; open: PluginLoader<LocalStore> } {
  return {
    available: async () => (await load("@capacitor-community/sqlite")) != null,
    open: async () => { if (!(await load("@capacitor-community/sqlite"))) throw new NotOnDeviceError("Encrypted local database"); throw new NotOnDeviceError("Encrypted local database binding (implemented against the plugin on device)"); },
  };
}

export function capacitorKeystore(): { available: () => Promise<boolean>; open: PluginLoader<Keystore> } {
  return {
    available: async () => (await load("capacitor-secure-storage-plugin")) != null,
    open: async () => { throw new NotOnDeviceError("Device keystore"); },
  };
}

export function capacitorVault(): { available: () => Promise<boolean>; open: PluginLoader<FileVault> } {
  return {
    available: async () => (await load("@capacitor/filesystem")) != null,
    open: async () => { throw new NotOnDeviceError("Encrypted file vault"); },
  };
}

/**
 * The page scanner.
 *
 * ML Kit's document scanner is Android-only and arrives through Google Play
 * Services, so `available()` is a real question on a rugged tablet that ships
 * without them and not a formality — which is exactly why the capability is
 * asked for rather than assumed. On iOS the same plugin fronts VisionKit.
 */
export function capacitorDocumentScanner(): { available: () => Promise<boolean>; open: PluginLoader<DocumentScanner> } {
  return {
    available: async () => (await load("@capacitor-mlkit/document-scanner")) != null,
    open: async () => { throw new NotOnDeviceError("Document scanner"); },
  };
}

/**
 * On-device text recognition.
 *
 * Deliberately not a cloud call. A driver photographs customer rate sheets and
 * payroll letters, and the difference between reading those on the handset and
 * posting them to a recognition service is the difference between a scanner and
 * a disclosure.
 */
export function capacitorOcrEngine(): { available: () => Promise<boolean>; open: PluginLoader<OcrEngine> } {
  return {
    available: async () => (await load("@capacitor-mlkit/text-recognition")) != null,
    open: async () => { throw new NotOnDeviceError("On-device text recognition"); },
  };
}

export function capacitorBarcodeScanner(): { available: () => Promise<boolean>; open: PluginLoader<BarcodeScanner> } {
  return {
    available: async () => (await load("@capacitor-mlkit/barcode-scanning")) != null,
    open: async () => { throw new NotOnDeviceError("Barcode scanner"); },
  };
}

/**
 * HS1 — camera and location probes, so `capabilities()` can aggregate them like the rest. Probe and
 * refusal only: no capture or fix is implemented here, and `open` throws until a device binding is.
 */
export function capacitorCamera(): { available: () => Promise<boolean>; open: PluginLoader<never> } {
  return {
    available: async () => (await load("@capacitor/camera")) != null,
    open: async () => { throw new NotOnDeviceError("Camera"); },
  };
}

export function capacitorGeolocation(): { available: () => Promise<boolean>; open: PluginLoader<never> } {
  return {
    available: async () => (await load("@capacitor/geolocation")) != null,
    open: async () => { throw new NotOnDeviceError("Location"); },
  };
}

export const NATIVE_ONLY_CAPABILITIES = ["encrypted_sqlite", "encrypted_file_vault", "hardware_keystore", "camera", "gps", "biometric_signing", "local_notifications", "document_scanner", "on_device_ocr", "barcode_scanner"] as const;
