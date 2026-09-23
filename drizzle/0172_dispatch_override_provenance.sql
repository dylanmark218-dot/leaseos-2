-- 0172 — C1a: an override says who GRANTED it, under what, for how long; a check says whose it is.
--
-- Slot: main ends at 0169 after PR #4. 0170 is claimed twice on open branches
-- (0170_dispatch_role_types on PR #9, 0170_organization_scoped_role_grants on the auth-workspace
-- branch) and 0171 by PR #9, so this takes the first number no open branch holds.
--
-- dispatchOverrides recorded only the REQUESTER. `overrideGrant` flipped `granted` on the request row,
-- and the award path then rebuilt the grant with `grantedByUserId = requestedByUserId` — so every
-- override on record named the person who asked for it as the person who approved it, the one thing
-- the separation-of-duties check existed to prevent. The grantor now has its own columns. Legacy rows
-- keep them NULL and are read as NOT granted: a grant that cannot name its grantor proves nothing.
--
-- `overrideClass`, `policyRef` and `policyVersion` record what released the finding; `scopeJson` the
-- exact check and code it covers; `expiresAt` when it stops counting. `orgRef` is the acting
-- organization of the request, from the server's scope resolution — never from input.
ALTER TABLE `dispatchOverrides`
  ADD COLUMN `grantedByUserId` int NULL,
  ADD COLUMN `grantedByRole` varchar(40) NULL,
  ADD COLUMN `grantedAt` timestamp NULL,
  ADD COLUMN `grantReason` text NULL,
  ADD COLUMN `overrideClass` varchar(32) NULL,
  ADD COLUMN `policyRef` varchar(120) NULL,
  ADD COLUMN `policyVersion` int NULL,
  ADD COLUMN `scopeJson` text NULL,
  ADD COLUMN `expiresAt` timestamp NULL,
  ADD COLUMN `orgRef` varchar(64) NULL;
--> statement-breakpoint
-- The C1a fingerprint is `EF2-` + a 64-character SHA-256, which does not fit varchar(32). Widening is
-- lossless; existing `EF-` values stay as they are and simply never match a new fingerprint, so each
-- pre-C1a check re-evaluates once rather than being trusted under a hash it was not taken with.
--
-- `ruleSetHash` is the hash of the rules the check's findings were decided under (point-in-time), and
-- `orgRef` the acting organization that took the check. NULL on legacy rows = the historical single
-- tenant, the same rule as 0132.
ALTER TABLE `dispatchEligibilityChecks`
  MODIFY COLUMN `fingerprint` varchar(80) NOT NULL,
  ADD COLUMN `ruleSetHash` varchar(64) NULL,
  ADD COLUMN `orgRef` varchar(64) NULL;
