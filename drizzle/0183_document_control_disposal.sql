-- 0183 — Document Control, Checkpoint G: the disposal vertical slice.
--
-- Slot: 0178–0182 are Checkpoints A–D and F on this branch; 0183 is the next number free on main
-- and on every open branch at the same scan (docs/architecture/MIGRATION_COLLISION_REGISTER.md).
--
-- A disposal ticket read from a photograph enters `needs_review` (v20.16) and the billing gate
-- counts verified tickets only — but nothing in the repository recorded who verified one, or when.
-- The verifier's act now leaves its name: the columns below are the disposal domain's own, not
-- Document Control's; the register only hears about the act through its links.
ALTER TABLE `disposalTickets` ADD COLUMN `verifiedByUserId` int NULL;
--> statement-breakpoint
ALTER TABLE `disposalTickets` ADD COLUMN `verifiedAt` timestamp NULL;
--> statement-breakpoint
ALTER TABLE `disposalTickets` ADD COLUMN `verificationNote` varchar(400) NULL;
