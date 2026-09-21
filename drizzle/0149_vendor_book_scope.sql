-- v22.52 — 0149 (P4.1, the last monolith records): a vendor record belongs to the business (book) that
-- keeps it. vendors.orgRef already means the vendor's OWN organization (P7.2 link), so the owner is a
-- separate column, bookOrgRef, under the record rule of 0132: NULL = the historical single tenant's;
-- a member sees the vendors their organization keeps. (P7's layered bookWhere — defaults plus own —
-- is a configuration semantic and does not apply to records.)
ALTER TABLE `vendors` ADD COLUMN `bookOrgRef` varchar(64) NULL;
--> statement-breakpoint
CREATE INDEX `vendors_book` ON `vendors` (`bookOrgRef`);
