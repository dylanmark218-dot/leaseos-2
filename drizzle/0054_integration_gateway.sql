-- v21.18 — Integration gateway.
--
-- A machine is an identity: a client with a hashed key, a kind, a scope of
-- feeds it may send, and a lockout like a person's. Everything it sends is
-- an inbound event, idempotent by its own key, stored with its hash, and it
-- becomes a LeaseOS record only as a PROPOSAL into a ledger that already
-- holds proposals — never a confirmed fact. What LeaseOS sends out is a
-- webhook delivery of an outbox event: signed with the subscription's
-- secret, retried on a schedule, dead after its attempts, every attempt
-- kept. Secrets are stored encrypted under the server key, never in the
-- clear, and are shown once.

CREATE TABLE `integrationClients` (
  `id` int AUTO_INCREMENT NOT NULL,
  `clientRef` varchar(64) NOT NULL,
  `name` varchar(160) NOT NULL,
  `kind` enum('telematics','eld','fuel_card','accounting','customer_system','facility_system','other') NOT NULL,
  `keyHash` varchar(64) NOT NULL,
  `scopesJson` text NOT NULL,
  `status` enum('active','suspended','revoked') NOT NULL DEFAULT 'active',
  `failedAttempts` int NOT NULL DEFAULT 0,
  `lockedUntil` timestamp,
  `lastSeenAt` timestamp,
  `createdByUserId` int NOT NULL,
  `revokedAt` timestamp,
  `revokedReason` varchar(300),
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `integrationClients_id` PRIMARY KEY(`id`),
  CONSTRAINT `integrationClients_clientRef_unique` UNIQUE(`clientRef`),
  CONSTRAINT `integrationClients_keyHash_unique` UNIQUE(`keyHash`)
);
--> statement-breakpoint

CREATE TABLE `inboundEvents` (
  `id` int AUTO_INCREMENT NOT NULL,
  `inboundRef` varchar(64) NOT NULL,
  `clientId` int NOT NULL,
  `feed` enum('gps_position','fuel_transaction','eld_duty_status','generic') NOT NULL,
  `idempotencyKey` varchar(120) NOT NULL,
  `payloadJson` text NOT NULL,
  `payloadHash` varchar(64) NOT NULL,
  `status` enum('accepted','rejected','duplicate') NOT NULL,
  `resultKind` varchar(40),
  `resultRef` varchar(80),
  `rejectionReason` varchar(400),
  `receivedAt` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `inboundEvents_id` PRIMARY KEY(`id`),
  CONSTRAINT `inboundEvents_inboundRef_unique` UNIQUE(`inboundRef`),
  CONSTRAINT `inboundEvents_client_key_unique` UNIQUE(`clientId`,`idempotencyKey`)
);
--> statement-breakpoint

CREATE TABLE `webhookSubscriptions` (
  `id` int AUTO_INCREMENT NOT NULL,
  `subscriptionRef` varchar(64) NOT NULL,
  `name` varchar(160) NOT NULL,
  `url` varchar(500) NOT NULL,
  `secretEnc` varchar(400) NOT NULL,
  `eventTypesJson` text NOT NULL,
  `status` enum('active','paused','revoked') NOT NULL DEFAULT 'active',
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `webhookSubscriptions_id` PRIMARY KEY(`id`),
  CONSTRAINT `webhookSubscriptions_subscriptionRef_unique` UNIQUE(`subscriptionRef`)
);
--> statement-breakpoint

CREATE TABLE `webhookDeliveries` (
  `id` int AUTO_INCREMENT NOT NULL,
  `deliveryRef` varchar(64) NOT NULL,
  `subscriptionId` int NOT NULL,
  `eventId` varchar(40) NOT NULL,
  `eventType` varchar(80) NOT NULL,
  `attempt` int NOT NULL,
  `status` enum('queued','delivered','failed','dead') NOT NULL,
  `requestHash` varchar(64) NOT NULL,
  `signature` varchar(64) NOT NULL,
  `responseStatus` int,
  `error` varchar(400),
  `nextAttemptAt` timestamp,
  `at` timestamp NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `webhookDeliveries_id` PRIMARY KEY(`id`),
  CONSTRAINT `webhookDeliveries_deliveryRef_unique` UNIQUE(`deliveryRef`),
  CONSTRAINT `webhookDeliveries_sub_event_attempt_unique` UNIQUE(`subscriptionId`,`eventId`,`attempt`)
);
