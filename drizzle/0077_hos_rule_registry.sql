-- v22.20 — Hours of service as versioned rules, not code.
--
-- There is no "Canadian HOS" to hard-code. The applicable schedule turns on the
-- carrier's operating authority, the jurisdiction, the vehicle's weight class,
-- the kind of operation and the sixtieth parallel — and Alberta alone needs two
-- profiles that are not variants of each other. So the rules are rows.
--
-- `hosRuleProfiles` is the applicability and the provenance. `hosRuleLimits` is
-- one row per figure, each verified on its own, so a regulation changing one
-- number does not require rewriting an engine or re-verifying a whole regime.
--
-- Everything seeds unverified. An unverified limit determines nothing: the
-- clocks still show, because the hours a driver worked are a fact even when the
-- rule they are judged against is not.

CREATE TABLE `hosRuleProfiles` (
  `id` int AUTO_INCREMENT NOT NULL,
  `profileKey` varchar(60) NOT NULL,
  `label` varchar(220) NOT NULL,
  `authorityLevel` enum('federal','provincial','territorial') NOT NULL,
  `jurisdiction` varchar(8),
  `latitudeRule` enum('north_of_60','south_of_60'),
  `minimumWeightKg` int,
  `operationClass` varchar(40),
  `sourceAuthority` varchar(220) NOT NULL,
  `sourceCitation` varchar(400) NOT NULL,
  `sourceUrl` varchar(600),
  `sourceSection` varchar(120),
  `effectiveFrom` timestamp NULL,
  `effectiveTo` timestamp NULL,
  `retrievedAt` timestamp NULL,
  `verificationStatus` enum('unverified','verified','superseded') NOT NULL DEFAULT 'unverified',
  `verifiedByUserId` int,
  `verifiedAt` timestamp NULL,
  `supersedesProfileKey` varchar(60),
  `recordedByUserId` int,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `hosRuleProfiles_id` PRIMARY KEY(`id`),
  CONSTRAINT `hosRuleProfiles_key_unique` UNIQUE(`profileKey`)
);
--> statement-breakpoint
CREATE INDEX `hosRuleProfiles_applicability` ON `hosRuleProfiles` (`authorityLevel`, `jurisdiction`, `verificationStatus`);
--> statement-breakpoint

CREATE TABLE `hosRuleLimits` (
  `id` int AUTO_INCREMENT NOT NULL,
  `profileKey` varchar(60) NOT NULL,
  `limitKey` varchar(60) NOT NULL,
  `value` double NOT NULL,
  `sourceSection` varchar(120),
  `verificationStatus` enum('unverified','verified','superseded') NOT NULL DEFAULT 'unverified',
  `verifiedByUserId` int,
  `verifiedAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `hosRuleLimits_id` PRIMARY KEY(`id`),
  CONSTRAINT `hosRuleLimits_profile_limit_unique` UNIQUE(`profileKey`, `limitKey`)
);
--> statement-breakpoint
CREATE INDEX `hosRuleLimits_profile` ON `hosRuleLimits` (`profileKey`, `verificationStatus`);
