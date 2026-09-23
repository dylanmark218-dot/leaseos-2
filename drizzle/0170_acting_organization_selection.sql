-- 0170 — which organization a multi-member user is acting as.
--
-- resolveActingScope derives the organization from active memberships and
-- REFUSES a user who has more than one, because picking silently decides which
-- company a request writes into. That refusal is correct and stays. Its cost is
-- that a genuinely multi-organization user — a contractor administrator, a
-- consultant across client companies, an auditor with delegated access, an
-- owner of two fleets — cannot use the system at all.
--
-- What was missing was not a way to guess. It was a server-owned record of a
-- choice the person already made. This is that record, and nothing else:
--
--   * one row per user, so there is exactly one answer to "acting as what";
--   * it names the MEMBERSHIP, not just the organization, so a selection cannot
--     outlive the membership that justified it;
--   * selectedByUserId is kept separately from userId, because an administrator
--     setting somebody else's acting organization is a different act from a
--     person setting their own, and the audit trail should be able to tell.
--
-- The selection is never trusted on its own. resolveActingScope re-checks it
-- against the caller's currently active memberships on every request; a stale
-- or revoked one resolves to the same refusal as before. A row here is a
-- preference, not a grant, and it can confer nothing the membership does not.
--
-- Forward-only and empty on arrival. There is no backfill: a user with one
-- membership never needed a selection, and a user with several has not yet made
-- one. Nothing is attributed to an organization on their behalf.

CREATE TABLE `actingOrganizationSelections` (
  `id` int AUTO_INCREMENT NOT NULL,
  `userId` int NOT NULL,
  `orgRef` varchar(40) NOT NULL,
  `membershipRef` varchar(64) NOT NULL,
  `selectedAt` timestamp NOT NULL DEFAULT (now()),
  `selectedByUserId` int NOT NULL,
  CONSTRAINT `actingOrganizationSelections_id` PRIMARY KEY(`id`),
  -- One acting organization per user. A second selection replaces the first
  -- rather than accumulating, so there is never a set to choose from.
  CONSTRAINT `actingOrganizationSelections_user_unique` UNIQUE(`userId`)
);
