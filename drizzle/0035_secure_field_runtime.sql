-- v20.20 — P4 Secure Field Runtime, server side.
--
-- The tablet at a cardlock with no signal keeps working; when it reconnects,
-- it has to prove three things: it is a device the company issued, its keys
-- are the ones on record, and nothing it captured was altered on the way
-- back. The sync spine already carries declared and computed hashes and
-- sealed evidence hashes. This adds the device that is doing the proving.
--
-- No secret is stored here. A device's private key never leaves its keystore;
-- the server holds the fingerprint of the public half, and that is all it
-- needs to refuse a package signed by something else.

CREATE TABLE `fieldDevices` (
  `id` int AUTO_INCREMENT NOT NULL,
  `deviceRef` varchar(64) NOT NULL,
  `userId` int NOT NULL,
  `platform` enum('android','ios','windows','linux','web','other') NOT NULL,
  `platformDeviceIdHash` varchar(64),
  `displayName` varchar(120),
  -- Fingerprint of the keystore-backed public key. Not the key. Never a secret.
  `keyFingerprint` varchar(64) NOT NULL,
  `keystoreAttestation` enum('hardware','software','unknown','failed') NOT NULL DEFAULT 'unknown',
  `encryptedStorageAttested` boolean NOT NULL DEFAULT false,
  `appVersion` varchar(40),
  `status` enum('enrolled','active','suspended','revoked') NOT NULL DEFAULT 'enrolled',
  `enrolledAt` timestamp NOT NULL,
  `enrolledByUserId` int NOT NULL,
  `activatedAt` timestamp,
  `lastSeenAt` timestamp,
  `suspendedAt` timestamp,
  `revokedAt` timestamp,
  `revokedByUserId` int,
  `revocationReason` varchar(300),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `fieldDevices_id` PRIMARY KEY(`id`),
  CONSTRAINT `fieldDevices_deviceRef_unique` UNIQUE(`deviceRef`)
);
--> statement-breakpoint
CREATE INDEX `fieldDevices_user_idx` ON `fieldDevices` (`userId`, `status`);
--> statement-breakpoint
CREATE INDEX `fieldDevices_fingerprint_idx` ON `fieldDevices` (`keyFingerprint`);
--> statement-breakpoint

-- Every key the device has ever presented, with when it stopped being valid.
-- A package signed with a retired key inside the grace window is accepted;
-- outside it, refused.
CREATE TABLE `deviceKeyEvents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `fieldDeviceId` int NOT NULL,
  `keyFingerprint` varchar(64) NOT NULL,
  `eventType` enum('enrolled','rotated','retired','compromised') NOT NULL,
  `validFrom` timestamp NOT NULL,
  `validUntil` timestamp,
  `reason` varchar(300),
  `recordedByUserId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `deviceKeyEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `deviceKeyEvents_device_idx` ON `deviceKeyEvents` (`fieldDeviceId`, `validFrom`);
--> statement-breakpoint

-- A record the device changed that the server also changed. Both versions
-- kept, a person decides, nothing merged in the dark.
CREATE TABLE `syncConflicts` (
  `id` int AUTO_INCREMENT NOT NULL,
  `conflictRef` varchar(64) NOT NULL,
  `fieldDeviceId` int NOT NULL,
  `syncPackageId` int,
  `recordType` varchar(60) NOT NULL,
  `recordRef` varchar(120) NOT NULL,
  `deviceBaseVersion` int NOT NULL,
  `serverVersion` int NOT NULL,
  `conflictingFieldsJson` text NOT NULL,
  `deviceValuesJson` text NOT NULL,
  `serverValuesJson` text NOT NULL,
  `material` boolean NOT NULL DEFAULT true,
  `status` enum('unresolved','resolved_device','resolved_server','resolved_merged','withdrawn') NOT NULL DEFAULT 'unresolved',
  `resolvedByUserId` int,
  `resolvedAt` timestamp,
  `resolutionNote` varchar(400),
  `detectedAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `syncConflicts_id` PRIMARY KEY(`id`),
  CONSTRAINT `syncConflicts_conflictRef_unique` UNIQUE(`conflictRef`)
);
--> statement-breakpoint
CREATE INDEX `syncConflicts_status_idx` ON `syncConflicts` (`status`, `detectedAt`);
--> statement-breakpoint

-- Packages come from enrolled devices, not from a string.
ALTER TABLE `syncPackages`
  ADD COLUMN `fieldDeviceId` int NULL AFTER `deviceId`,
  ADD COLUMN `signedWithFingerprint` varchar(64) NULL AFTER `fieldDeviceId`,
  ADD COLUMN `refusalReason` varchar(300) NULL AFTER `failureReason`;
