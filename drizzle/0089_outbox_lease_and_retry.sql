-- v22.20 — 0089: a claim that expires, a retry that waits, a dead letter that says so.
--
-- Three defects in the drain worker, all of them about what happens when things
-- go wrong rather than when they go right.
--
-- **A crashed worker owned its event forever.** The claim query accepted only
-- `claimedAt IS NULL`, so a process that died between claiming and finishing
-- left the row claimed by a worker that no longer exists, and nothing would ever
-- pick it up again. `claimedAt` becomes a lease: old enough, and it is fair game.
--
-- **A retry did not wait.** `classifyFailure` computes a backoff and the write
-- threw it away, clearing the claim and making the row immediately eligible.
-- A failing event would spin at poll speed rather than backing off.
--
-- **A dead letter was a stuck claim.** Terminal failure was represented by
-- leaving `claimedAt` set so the row stopped circulating — indistinguishable
-- from a crashed worker, and about to become reclaimable once the lease exists.
-- It gets its own column and its own reason.

ALTER TABLE `domainEventOutbox`
  ADD COLUMN `retryAvailableAt` timestamp NULL AFTER `claimedBy`,
  ADD COLUMN `deadLetteredAt` timestamp NULL AFTER `retryAvailableAt`,
  ADD COLUMN `deadLetterReason` varchar(1000) NULL AFTER `deadLetteredAt`;
--> statement-breakpoint
CREATE INDEX `domainEventOutbox_drain` ON `domainEventOutbox`
  (`processedAt`, `deadLetteredAt`, `retryAvailableAt`, `claimedAt`, `id`);
