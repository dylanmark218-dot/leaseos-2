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
 *
 * What must be true on the device, and cannot be proven here:
 *   - the SQLite file is encrypted at rest with a key from the keystore;
 *   - the device key is hardware-backed where the platform offers it, and the
 *     enrolment reports `keystoreAttestation: "hardware"` only when it is;
 *   - biometrics or the device PIN authorize signing and never leave the
 *     platform authenticator; LeaseOS stores no biometric template.
 */

import { NotOnDeviceError, type FileVault, type Keystore, type LocalStore } from "../contracts";

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

export const NATIVE_ONLY_CAPABILITIES = ["encrypted_sqlite", "encrypted_file_vault", "hardware_keystore", "camera", "gps", "biometric_signing", "local_notifications"] as const;
