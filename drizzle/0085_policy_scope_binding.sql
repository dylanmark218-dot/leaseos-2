-- v22.20 — 0085: whose policy governs this release.
--
-- `policyInForce` selected the highest-version approved policy effective at the
-- release time and knew nothing about scope. With a company policy, a Branch A
-- policy and a Branch B policy all approved, Branch B's higher version governed
-- a Branch A truck. That is the wrong branch's rules deciding whether a
-- prohibited vehicle may move.
--
-- The organizational scope is snapshotted onto the event and the order when the
-- stop is confirmed, not read from the unit at release time. A truck can be
-- transferred between branches while an order is open, and the policy governing
-- its release must not change because somebody reassigned the asset afterwards.

ALTER TABLE `enforcementEvents`
  ADD COLUMN `tenantId` varchar(40) NULL AFTER `jurisdiction`,
  ADD COLUMN `branchId` varchar(40) NULL AFTER `tenantId`,
  ADD COLUMN `terminalId` varchar(40) NULL AFTER `branchId`;
--> statement-breakpoint

ALTER TABLE `outOfServiceOrders`
  ADD COLUMN `tenantId` varchar(40) NULL AFTER `subjectRef`,
  ADD COLUMN `branchId` varchar(40) NULL AFTER `tenantId`,
  ADD COLUMN `terminalId` varchar(40) NULL AFTER `branchId`;
--> statement-breakpoint

-- A policy belongs to a tenant. Without this the scope columns describe a
-- hierarchy with no root.
ALTER TABLE `oosReleasePolicies`
  ADD COLUMN `tenantId` varchar(40) NULL AFTER `policyRef`;
--> statement-breakpoint
CREATE INDEX `oosReleasePolicies_scope` ON `oosReleasePolicies` (`tenantId`, `scopeType`, `scopeRef`, `status`);
