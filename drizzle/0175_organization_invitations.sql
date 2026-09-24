-- B23.2 — organization invitations.
--
-- The hole this fills: nothing in LeaseOS has ever created an
-- `organizationMemberships` row. B23.0 resolved an identity into a company and
-- B23.1 scoped every role grant to the company that issued it, both on top of a
-- table only test fixtures ever wrote to. This is how a real person gets in.
--
-- SLOT. 0175 is the first four-digit slot free in EVERY lineage of this
-- repository, checked rather than assumed (see LEASEOS_MIGRATION_POLICY.md).
-- The head on this branch is 0170; `origin/main` is already at 0174, and
-- 0168, 0169 and 0170 each carry two or three different migrations across
-- lineages. head+1 would have collided three times over.
--
-- IDENTITY. An invitation is NOT claimed by matching an email address. The
-- OAuth provider (`GetUserInfoResponse`) returns `email` with no verification
-- flag at all, so LeaseOS cannot tell a proved address from a typed one.
-- `emailHint` exists so an administrator can see who they meant and send the
-- link somewhere; it is never consulted when deciding whether acceptance is
-- allowed. The claim is the invitation token plus an authenticated openId.
--
-- SECRETS. Only `tokenDigest` (SHA-256 hex) is stored. The raw token is
-- returned exactly once, to the administrator who created it, and is written to
-- no row and no log.

CREATE TABLE `organizationInvitations` (
  `id` int AUTO_INCREMENT NOT NULL,
  `invitationRef` varchar(64) NOT NULL,
  -- The company doing the inviting. Written from the actor's verified acting
  -- scope, never from a request parameter, and re-read inside the acceptance
  -- transaction.
  `orgRef` varchar(40) NOT NULL,
  -- A hint, not an authority. See IDENTITY above.
  `emailHint` varchar(320),
  `displayNameHint` varchar(180),
  -- SHA-256 of the one-time token, hex. Unique so a digest cannot be reused.
  `tokenDigest` varchar(64) NOT NULL,
  -- `expired` is deliberately NOT a stored status: a stored one is only true
  -- while some sweeper keeps it true, and wrong in the window before it runs.
  -- Expiry is decided from `expiresAt` by `invitationCheck()`, the same pure
  -- function the external portal already uses.
  `status` enum('pending','accepted','cancelled') NOT NULL DEFAULT 'pending',
  `expiresAt` timestamp NOT NULL,
  `invitedByUserId` int NOT NULL,
  `invitedAt` timestamp NOT NULL,
  `acceptedAt` timestamp NULL,
  `acceptedByUserId` int,
  `cancelledAt` timestamp NULL,
  `cancelledByUserId` int,
  `cancelReason` varchar(300),
  -- The workspace the invited person lands in, if the administrator chose one.
  -- Validated against what their invited roles actually compose, and validated
  -- again on acceptance — `workspaceAccess` ignores a default outside the
  -- member's open set, so a stale one grants nothing either way.
  `defaultWorkspace` varchar(60),
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `organizationInvitations_id` PRIMARY KEY(`id`),
  CONSTRAINT `organizationInvitations_invitationRef_unique` UNIQUE(`invitationRef`),
  CONSTRAINT `organizationInvitations_tokenDigest_unique` UNIQUE(`tokenDigest`)
);
--> statement-breakpoint

-- One LIVE invitation per (organization, email hint).
--
-- MariaDB has no partial index, so the uniqueness is carried by a generated
-- column that is NULL unless the row is pending — NULLs do not collide in a
-- unique index, so accepted and cancelled rows drop out of the constraint and
-- stay as history. This is the same construction 0021 and 0170 use for
-- `activeGrantKey`, rather than a second invention.
--
-- A row with no email hint is exempt: there is nothing to be a duplicate of,
-- and two such invitations are two genuinely separate acts.
ALTER TABLE `organizationInvitations`
  ADD COLUMN `pendingKey` varchar(380)
    AS (CASE WHEN `status` = 'pending' AND `emailHint` IS NOT NULL
             THEN CONCAT(`orgRef`, ':', LOWER(`emailHint`))
             ELSE NULL END) PERSISTENT;
--> statement-breakpoint

CREATE UNIQUE INDEX `organizationInvitations_pendingKey_unique`
  ON `organizationInvitations` (`pendingKey`);
--> statement-breakpoint

-- The administrator's own list, and the acceptance path's lookup.
CREATE INDEX `organizationInvitations_org_status_idx`
  ON `organizationInvitations` (`orgRef`, `status`);
--> statement-breakpoint

-- The roles the invitation confers on acceptance.
--
-- A child table rather than a JSON column: these become real grants, the set is
-- small and closed, and a role that has to be parsed out of a blob before it can
-- be checked is a role nothing can index, constrain or audit.
CREATE TABLE `organizationInvitationRoles` (
  `id` int AUTO_INCREMENT NOT NULL,
  `invitationId` int NOT NULL,
  `role` varchar(40) NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `organizationInvitationRoles_id` PRIMARY KEY(`id`),
  CONSTRAINT `organizationInvitationRoles_unique` UNIQUE(`invitationId`,`role`)
);
--> statement-breakpoint

CREATE INDEX `organizationInvitationRoles_invitation_idx`
  ON `organizationInvitationRoles` (`invitationId`);
