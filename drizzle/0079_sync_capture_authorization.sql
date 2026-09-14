-- UNRELEASED candidate — recording is not authorization.
--
-- A field device may capture a fact while disconnected or while its authorization
-- context cannot be established. That historical fact must survive. A later
-- successful synchronization must not rewrite the capture as "authorized".
--
-- These columns store the DEVICE'S CLAIM AT CAPTURE TIME, not a server decision.
-- `unknown` is deliberately the default for all legacy clients and for any client
-- that cannot prove what authorization context existed when the worker captured it.

ALTER TABLE `syncPackageItems`
  ADD COLUMN `captureAuthorizationClaim` enum('authorized','unauthorized','unknown') NOT NULL DEFAULT 'unknown' AFTER `declaredManifestHash`,
  ADD COLUMN `captureAuthorizationReason` varchar(300) NULL AFTER `captureAuthorizationClaim`;
