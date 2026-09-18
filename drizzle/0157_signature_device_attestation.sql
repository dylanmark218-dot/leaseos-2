-- v22.76 — 0157 (P1.4): a `device_auth` signature carries proof that the device made it.
--
-- `signatureMethod` already offers `device_auth`, and nothing behind it proved anything: a caller
-- could write `device_auth` on a row typed in from a laptop and the record would read exactly like
-- one a biometric unlocked on an enrolled phone. The method was a label.
--
-- These columns make it a claim that can be checked. The device signs the same payload hash the
-- signature already stores, with the P-256 key enrolled in `fieldDevices`, and the server verifies
-- against the enrolled public key before the row is written.
--
-- What is deliberately NOT here, and must never be: any biometric material. The platform biometric
-- **unlocks the key on the device**; it never travels and it is never stored. A fingerprint or face
-- template in this table would be a permanent, unrevocable credential sitting next to a signature —
-- the one thing a device-key design exists to avoid, since a key can be rotated and a fingerprint
-- cannot. `server/_core/deviceSignature.ts` carries a guard against a column or field that looks
-- like one being added later.
ALTER TABLE `fieldTicketSignatures`
  ADD COLUMN `deviceRef` varchar(64) NULL,
  ADD COLUMN `deviceKeyFingerprint` varchar(80) NULL,
  ADD COLUMN `deviceSignatureBase64` text NULL,
  ADD COLUMN `deviceSignedAt` timestamp NULL;
--> statement-breakpoint
CREATE INDEX `sig_device` ON `fieldTicketSignatures` (`deviceRef`, `deviceKeyFingerprint`);
