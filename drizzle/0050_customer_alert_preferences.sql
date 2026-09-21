-- v21.14 — Customer alert preferences.
--
-- Alerts travel on the existing workflow notification queue; the recipient
-- is an external identity, named as `external:<identityRef>` in the
-- recipient role. This table holds only what the customer chose to receive.
-- The events a customer may subscribe to are the customer-safe ones; nothing
-- private has an event kind here to subscribe to.

CREATE TABLE `externalAlertPreferences` (
  `id` int AUTO_INCREMENT NOT NULL,
  `externalIdentityId` int NOT NULL,
  `eventKind` enum('arrival','work_start','delay','breakdown','incident_notice','load_complete','disposal_complete','signoff_ready','r1_available','r2_available','document_ready','dispute_update','billing_update','job_complete') NOT NULL,
  `enabled` boolean NOT NULL DEFAULT true,
  `updatedAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `externalAlertPreferences_id` PRIMARY KEY(`id`),
  CONSTRAINT `externalAlertPreferences_identity_kind_unique` UNIQUE(`externalIdentityId`,`eventKind`)
);
