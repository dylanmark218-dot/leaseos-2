-- v22.21 — 0120 (recovered from chat 4 checkpoint 0091): every figure LeaseOS has ever relied on.
--
-- `hosRuleLimits` carries UNIQUE(profileKey, limitKey), so it holds current
-- belief and nothing else. Updating a limit destroys what LeaseOS previously
-- thought, and an audit asking "what did you believe in March" had nowhere to
-- look. 0090 recorded where a figure came from; this records that it was ever
-- held at all.
--
-- The constraint is left alone and history is built around it. Two jobs, kept
-- separate:
--
--   hosRuleLimits         the current verified figure
--   hosRuleLimitHistory   every promoted figure, once, immutably
--
-- **Every promoted state once**, not every mutation. A change writes one row —
-- the incoming figure — rather than one for the departing value and one for the
-- arrival. Past belief is reconstructed by reading the ledger in order, and
-- nothing is recorded twice.
--
-- `currentPromotionId` on the live row points at the promotion that produced
-- it, so an audit can prove which verification event the running figure came
-- from. A test asserts the live row and its promotion still agree; if they ever
-- diverge, something wrote to `hosRuleLimits` outside the promotion path.
--
-- Four dates, none interchangeable:
--   verifiedAt    when a person checked it
--   effectiveFrom when the rule legally began
--   effectiveUntil when it stopped
--   recordedAt    when LeaseOS stored the verification
-- An amendment can be known in February, effective in March, and must not be
-- used for compliance until it is.

CREATE TABLE `hosRuleLimitHistory` (
  `id` int AUTO_INCREMENT NOT NULL,
  -- Immutable. Never reused, never rewritten.
  `promotionRef` varchar(64) NOT NULL,

  `profileKey` varchar(60) NOT NULL,
  `limitKey` varchar(60) NOT NULL,
  `value` double NOT NULL,
  `unit` varchar(32) NOT NULL,

  -- Evidence sufficient to relocate and defend the figure. Deliberately no
  -- column for the text itself: LeaseOS does not warehouse the source.
  `jurisdiction` varchar(64) NOT NULL,
  `authorityType` enum('law','official_guidance','recognized_standard','manufacturer') NOT NULL,
  `instrumentTitle` varchar(400) NOT NULL,
  `issuingAuthority` varchar(200) NOT NULL,
  `sourceSection` varchar(200) NOT NULL,
  `citationUrl` varchar(1000) NOT NULL,
  `instrumentVersion` varchar(120),
  `consolidationDate` date,
  `verificationMethod` enum(
    'OFFICIAL_WEB','OFFICIAL_PDF','OFFICIAL_PRINT','LEGAL_COUNSEL','REGULATOR_CONFIRMATION'
  ) NOT NULL,
  -- Only when an ingested document established it. Not a foreign key: the
  -- ordinary case is a person reading the instrument directly.
  `establishedByVersionRef` varchar(64),

  `verifiedByUserId` int NOT NULL,
  `verifiedAt` timestamp NOT NULL,
  `effectiveFrom` timestamp,
  `effectiveUntil` timestamp,
  `recordedAt` timestamp NOT NULL DEFAULT (now()),

  `status` enum('FUTURE','CURRENT','EXPIRED','REVOKED','SUPERSEDED') NOT NULL DEFAULT 'CURRENT',
  `changeReason` enum(
    'INITIAL_VERIFICATION','VERIFIED_REVISION','CORRECTED_VERIFICATION',
    'REVOCATION','REVERIFICATION'
  ) NOT NULL,

  -- A correction does not edit the row it corrects; it points at it. Keeping
  -- the error visible is stronger evidence than a silent rewrite.
  `correctsPromotionRef` varchar(64),
  `previousPromotionRef` varchar(64),

  CONSTRAINT `hosRuleLimitHistory_id` PRIMARY KEY(`id`),
  CONSTRAINT `hosRuleLimitHistory_promotionRef_unique` UNIQUE(`promotionRef`)
);

CREATE INDEX `hosRuleLimitHistory_profile_limit_idx` ON `hosRuleLimitHistory` (`profileKey`, `limitKey`);
CREATE INDEX `hosRuleLimitHistory_verified_at_idx` ON `hosRuleLimitHistory` (`verifiedAt`);
CREATE INDEX `hosRuleLimitHistory_effective_idx` ON `hosRuleLimitHistory` (`profileKey`, `limitKey`, `effectiveFrom`);

-- Which promotion produced the figure that is live right now.
ALTER TABLE `hosRuleLimits` ADD COLUMN `currentPromotionRef` varchar(64);
