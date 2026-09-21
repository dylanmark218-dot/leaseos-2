-- v20.16 — Server-resolved load and facility on a proposal.
--
-- A disposal ticket attaches to a load at a facility. Both are resolved when
-- the proposal is opened — the driver's current load, the facility they are
-- at — the same way tripId and unitId already are. Neither is ever taken from
-- the ticket's text: a facility name read by OCR is a hint for the person
-- confirming, not an identifier the record is keyed on.
ALTER TABLE `assistantProposals`
  ADD COLUMN `loadId` int NULL AFTER `unitId`,
  ADD COLUMN `facilityId` int NULL AFTER `loadId`;
