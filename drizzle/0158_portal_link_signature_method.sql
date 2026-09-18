-- v22.77 — 0158 (P1.4): a signature method that describes what actually happened.
--
-- The customer portal recorded every signature as `device_auth`. A customer tapping a secure link
-- on their own phone has no device enrolled with this company and never could have — enrolment is
-- for our field devices — so the method claimed an authentication that had not occurred. It was
-- the same label problem `0157` fixed one layer down, sitting in production-facing code.
--
-- Calling it `drawn` instead would replace one inaccurate label with another: the customer did not
-- draw anything, they proved identity through a signed portal link and confirmed. So the method
-- gets a name: `portal_link`, paired with the `externalIdentityId` the row already carries.
--
-- `device_auth` now means what it says, and since 0157 it must carry an attestation to be written.
ALTER TABLE `fieldTicketSignatures`
  -- NULL-able, as it was. A MODIFY restates the whole definition, so omitting the original
  -- nullability would silently tighten the column and reject rows that were legal the day before —
  -- caught by the column-parity check, which compares schema.ts against the applied migrations.
  MODIFY COLUMN `signatureMethod` enum('drawn','device_auth','pin','paper_scan','portal_link') NULL;
--> statement-breakpoint
-- Existing rows were written by the portal path and are portal-link signatures mislabelled. They
-- are corrected rather than left reading as device authentication that never happened; no row is
-- given an attestation, because none exists to give.
UPDATE `fieldTicketSignatures`
   SET `signatureMethod` = 'portal_link'
 WHERE `signatureMethod` = 'device_auth' AND `deviceSignatureBase64` IS NULL;
