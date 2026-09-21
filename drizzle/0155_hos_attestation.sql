-- v22.69 — 0155 (P8.3): the paper-log fallback, recorded as an attestation and never as a number.
--
-- A company running paper logs has no live hours figure. Today dispatch answers `hos_unknown` for
-- them, which is honest but permanent: there is no way for anyone to say "I checked his book and
-- he has hours", so the check can never be satisfied and the blocker is overridden instead —
-- which records nothing about what was checked.
--
-- An attestation is that missing statement, and its shape is the whole point:
--
--   it names the PERSON who attested and when, because a claim with no author is not evidence;
--   it is scoped to ONE duty date, because hours are a daily fact and yesterday's word says
--     nothing about today;
--   `hoursAvailableMinutesStated` is OPTIONAL and, when given, is the person's statement — it is
--     never copied into `hoursAvailableMinutes`, which means "the system computed this". A stated
--     number that flowed into a computed field would be indistinguishable from an ELD reading the
--     moment it left this table, and the difference is exactly what an audit turns on.
--
-- Superseded, not updated: a corrected attestation is a second statement, and both are on record.
CREATE TABLE `hosAttestations` (
  `id` int NOT NULL AUTO_INCREMENT,
  `orgRef` varchar(64) NULL,                                   -- NULL = historical single tenant (0132)
  `operatorId` int NOT NULL,
  `dutyDate` date NOT NULL,
  `method` enum('paper_log_reviewed','driver_declaration') NOT NULL,
  -- What the person actually said. Required: an attestation with no statement is a checkbox.
  `statement` varchar(500) NOT NULL,
  -- Their figure, if they gave one. Stated, never computed. Nullable on purpose.
  `hoursAvailableMinutesStated` int NULL,
  `attestedByUserId` int NOT NULL,
  `attestedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `supersededAt` timestamp NULL,
  `supersededByAttestationId` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `hos_att_lookup` (`operatorId`, `dutyDate`, `supersededAt`)
);
