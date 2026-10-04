-- 0244 — Document Control, Checkpoint G (manual): who verified a disposal record, and when.
--
-- Slot: the first number above every slot in use on main (head 0241) and on every remote branch at the
-- scan (0242–0243: claude/fleet-*), as docs/architecture/MIGRATION_COLLISION_REGISTER.md requires.
--
-- A disposal record enters `needs_review` from either writer (the facility portal and the assistant's typed
-- commit); billing counts verified records only; and nothing in the repository recorded who verified one, or
-- when. The authorization trail names the actor and time of a sensitive act but not the record it acted on.
-- These columns are the disposal domain's own, not Document Control's: the register only hears about the act
-- through its links (`document.domain_verified`). Nullable, no backfill: a record nobody verified says so.
-- The design built on the adopted branch carried the same three columns as its 0183; that file was never
-- merged or applied anywhere, so this is a new file under its own number.
ALTER TABLE `disposalTickets` ADD COLUMN `verifiedByUserId` int NULL;
--> statement-breakpoint
ALTER TABLE `disposalTickets` ADD COLUMN `verifiedAt` timestamp NULL;
--> statement-breakpoint
ALTER TABLE `disposalTickets` ADD COLUMN `verificationNote` varchar(400) NULL;
