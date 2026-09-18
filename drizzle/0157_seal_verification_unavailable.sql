-- v22.75 — 0157 (P1.2): a seal that could not be checked needs its own word.
--
-- `evidenceSeals.verificationResult` had 'verified' | 'pending' | 'hash_mismatch' |
-- 'manifest_mismatch'. There was no value for the outcome that actually matters most to act on:
-- the server tried to check the stored object and could not read it.
--
-- Recording that as 'pending' would say the check has not happened yet. Recording it as
-- 'hash_mismatch' would assert a mismatch nobody observed. Both are false, and the first is the
-- dangerous one — an unreadable object would look like a queue item rather than a missing exhibit,
-- and would sit in that queue indefinitely looking fine.
--
-- Unknown stays unknown, and gets a name of its own.
ALTER TABLE `evidenceSeals`
  MODIFY COLUMN `verificationResult`
  enum('pending','verified','hash_mismatch','manifest_mismatch','content_unavailable')
  NOT NULL DEFAULT 'pending';
