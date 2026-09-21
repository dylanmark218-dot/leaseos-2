-- v22.22 — tenant-bind machine clients, inbound evidence, subscriptions and deliveries.
-- Nullable during migration so historical rows remain auditable; tenant-aware code refuses
-- unbound rows for scoped actions rather than guessing ownership.
ALTER TABLE `integrationClients` ADD COLUMN `orgRef` varchar(40) NULL AFTER `id`;
ALTER TABLE `inboundEvents` ADD COLUMN `orgRef` varchar(40) NULL AFTER `id`;
ALTER TABLE `webhookSubscriptions` ADD COLUMN `orgRef` varchar(40) NULL AFTER `id`;
ALTER TABLE `webhookDeliveries` ADD COLUMN `orgRef` varchar(40) NULL AFTER `id`;
CREATE INDEX `integrationClients_org_status_idx` ON `integrationClients` (`orgRef`,`status`);
CREATE INDEX `inboundEvents_org_received_idx` ON `inboundEvents` (`orgRef`,`receivedAt`);
CREATE INDEX `webhookSubscriptions_org_status_idx` ON `webhookSubscriptions` (`orgRef`,`status`);
CREATE INDEX `webhookDeliveries_org_event_idx` ON `webhookDeliveries` (`orgRef`,`eventId`);
