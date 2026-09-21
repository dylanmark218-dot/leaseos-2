-- v22.20 — 0086: organizations and memberships.
--
-- Two turns ago `resolveActingScope` had nothing to resolve from: no
-- organization table, no membership table, no tenant on the request context.
-- The honest answer then was to say the system is single-tenant and refuse to
-- let a caller name a tenant. This is the root fix.
--
-- Deliberately two tables and not twenty-five. The proposed model lists roles,
-- role_permissions, membership_roles and resource_scopes — all of which already
-- exist here as `userRoleAssignments` plus the permission map, and duplicating
-- them would create exactly the second authorization system this codebase has
-- spent several checkpoints avoiding. What is missing is the organization a
-- membership belongs to, and nothing else.
--
-- `membershipType` distinguishes an employee from a contractor's own staff,
-- because an owner-operator's driver is a real member of a real organization
-- that is not this one.

CREATE TABLE `organizations` (
  `id` int AUTO_INCREMENT NOT NULL,
  `orgRef` varchar(40) NOT NULL,
  `name` varchar(220) NOT NULL,
  `status` enum('active','suspended','closed') NOT NULL DEFAULT 'active',
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `organizations_id` PRIMARY KEY(`id`),
  CONSTRAINT `organizations_ref_unique` UNIQUE(`orgRef`)
);
--> statement-breakpoint

CREATE TABLE `organizationMemberships` (
  `id` int AUTO_INCREMENT NOT NULL,
  `membershipRef` varchar(64) NOT NULL,
  `orgRef` varchar(40) NOT NULL,
  `userId` int NOT NULL,
  `membershipType` enum('employee','contractor','client','system') NOT NULL DEFAULT 'employee',
  `status` enum('active','suspended','ended') NOT NULL DEFAULT 'active',
  `defaultWorkspace` varchar(60),
  `branchId` varchar(40),
  `contractorOrgRef` varchar(40),
  `effectiveFrom` timestamp NOT NULL,
  `effectiveTo` timestamp NULL,
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `organizationMemberships_id` PRIMARY KEY(`id`),
  CONSTRAINT `organizationMemberships_ref_unique` UNIQUE(`membershipRef`)
);
--> statement-breakpoint
CREATE INDEX `organizationMemberships_user` ON `organizationMemberships` (`userId`, `status`);
--> statement-breakpoint
CREATE INDEX `organizationMemberships_org` ON `organizationMemberships` (`orgRef`, `status`);
