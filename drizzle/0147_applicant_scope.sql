-- v22.45 — 0147 (P4.1 router 8): an applicant belongs to the organization that is hiring.
-- Applicants are not members yet, so membership cannot scope them; the row carries the acting
-- organization at creation, as jobs do (0132). NULL = the historical single tenant's.
ALTER TABLE `applicants` ADD COLUMN `orgRef` varchar(64) NULL;
--> statement-breakpoint
CREATE INDEX `applicants_org` ON `applicants` (`orgRef`);
