-- 0236 — who entered a compliance document.
--
-- complianceDocuments recorded who verified a document (verifiedByUserId) but
-- not who entered it, so "the person who recorded a credential may not verify
-- it" could only be checked for uploads the Driver Portfolio had logged in its
-- own audit rows. recordedByUserId is the person whose action created the row:
-- the driver who submitted it, the office user who filed it, the trainer who
-- recorded the training it came from. It is the same column name trainingRecords,
-- vendorBills and hosRuleLimits use for the same fact.
--
-- NULL means not known. Historical rows stay NULL: nothing here infers or
-- invents who entered them. The verification service treats NULL as "no
-- recorder on file", never as "no restriction" — the credential's own subject
-- is still refused, and the portfolio's audit row is still consulted.

ALTER TABLE `complianceDocuments`
  ADD COLUMN `recordedByUserId` int NULL AFTER `confidence`;
