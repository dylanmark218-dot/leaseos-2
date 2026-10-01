-- 0185 — SEC-004: webhook delivery attempts are claimed before they are sent.
--
-- Two dispatchers could each POST attempt n of the same (subscriptionId, eventId) and only
-- then collide on UNIQUE(subscriptionId, eventId, attempt) — after the consumer had received
-- it twice. The attempt row is now written first, as status 'queued' (already in the enum,
-- never written for webhooks until now) with the claim below, and the unique key decides
-- which worker sends. A claim older than the lease (server/webhookDispatchService.ts,
-- WEBHOOK_CLAIM_LEASE_MS) may be taken over; the finish is guarded by claimedBy.
--
-- Additive and backwards compatible: two NULL-able columns, no data rewritten, no
-- constraint added or changed. Existing rows keep NULL, which only matters for a 'queued'
-- row — and no code has ever written one (scripts/preflight/sec004-webhook-delivery-duplicates.sql
-- section 6 reports any). A claimedAt of NULL on a 'queued' row reads as an expired claim.
--
-- claimedAt: when the current (or last) owner claimed the attempt, on the lease clock.
-- claimedBy: an opaque worker/claim id ("host:pid#random"), for audit only — never a secret.

ALTER TABLE `webhookDeliveries`
  ADD COLUMN `claimedAt` timestamp NULL AFTER `nextAttemptAt`,
  ADD COLUMN `claimedBy` varchar(64) NULL AFTER `claimedAt`;
