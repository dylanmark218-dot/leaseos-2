-- 0185 — AIL-1A: an assistant proposal names the organization it belongs to.
--
-- Slot: main ends at 0174. Every number from 0170 to 0184 is claimed by main or by an open branch
-- (including feature/tenant-scope-foundation and claude/mobile-hardware-scanner-mzp1e1-v2327, which
-- share no history with main and are missed by a three-dot scan). This takes 0185, the first number
-- no branch holds. docs/architecture/MIGRATION_COLLISION_REGISTER.md records it.
--
-- Until now a proposal had no owner. Its organization was inferred from whichever of jobId, tripId or
-- unitId was set first — ids the draft copied from the request body unchecked — and a proposal with
-- none of them was the single tenant's by default. `tenantId` is now stamped at draft time from the
-- server's acting scope, never from input, and `tenantDerivedFrom` says how it was established.
--
-- Legacy rows are not assigned to anybody by guesswork:
--
--   * If `organizationMemberships` is empty, no user has ever resolved to anything but the single
--     tenant — resolveActingScope() returns another organization only through a membership row, and
--     no production path writes one. Every existing proposal was therefore created under 'default',
--     and is stamped so, with `backfill_single_tenant_deployment` recording that this was proved from
--     the deployment and not observed at draft time. (The same rule contextAdmission's
--     `legacy_single_tenant` proof applies: sound while only one organization can exist, not after.)
--   * Otherwise the row keeps `tenantId` NULL and `legacy_unresolved`. Every read compares tenantId
--     by equality, so an unresolved row is visible to nobody and committable by nobody until a person
--     resolves it. NULL here means "unresolved", never "global": the CHECK below makes the two
--     columns say the same thing, and there is no GLOBAL proposal.
--
-- The DEFAULT on `tenantDerivedFrom` is the fail-closed marker, not a tenant. A writer that forgets
-- both columns produces an unresolved row nobody can see; a writer that sets a tenant but forgets how
-- it was derived is refused by the CHECK.
ALTER TABLE `assistantProposals`
  ADD COLUMN `tenantId` varchar(40) NULL,
  ADD COLUMN `tenantDerivedFrom` enum('membership','single_tenant_fallback','backfill_single_tenant_deployment','legacy_unresolved') NOT NULL DEFAULT 'legacy_unresolved';
--> statement-breakpoint
UPDATE `assistantProposals`
  SET `tenantId` = 'default', `tenantDerivedFrom` = 'backfill_single_tenant_deployment'
  WHERE `tenantId` IS NULL
    AND NOT EXISTS (SELECT 1 FROM `organizationMemberships`);
--> statement-breakpoint
ALTER TABLE `assistantProposals`
  ADD CONSTRAINT `assistantProposals_tenant_shape`
  CHECK ((`tenantDerivedFrom` = 'legacy_unresolved') = (`tenantId` IS NULL));
--> statement-breakpoint
CREATE INDEX `assistantProposals_tenant_state_idx` ON `assistantProposals` (`tenantId`, `commitState`, `createdAt`);
