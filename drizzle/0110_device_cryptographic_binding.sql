-- v22.21 — cryptographically bind field sync to tenant-owned P-256 device keys.
-- Existing devices intentionally remain without a public key/org binding and therefore
-- fail the new signature gate until re-enrolled; no fingerprint-only grandfather path.
ALTER TABLE `fieldDevices`
  ADD COLUMN `orgRef` varchar(40) NULL AFTER `userId`,
  ADD COLUMN `publicKeySpkiBase64` text NULL AFTER `keyFingerprint`;
ALTER TABLE `deviceKeyEvents`
  ADD COLUMN `publicKeySpkiBase64` text NULL AFTER `keyFingerprint`;
CREATE TABLE `deviceSyncNonces` (
  `id` int NOT NULL AUTO_INCREMENT,
  `fieldDeviceId` int NOT NULL,
  `orgRef` varchar(40) NOT NULL,
  `nonce` varchar(120) NOT NULL,
  `signedAt` timestamp NOT NULL,
  `packageRef` varchar(64) NOT NULL,
  `receivedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `deviceSyncNonces_device_nonce_uq` (`fieldDeviceId`,`nonce`),
  KEY `deviceSyncNonces_org_received_idx` (`orgRef`,`receivedAt`)
);
