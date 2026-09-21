-- v22.35 — 0142: how a field package was verified, and the tablet's clock skew.
-- The work-order release blockers (item 27): the signature was verified over a re-canonicalized,
-- zod-parsed payload rather than the exact bytes the device signed, and freshness was judged
-- against the server's clock alone. A package may now carry the exact signed bytes
-- (`exact_wire`); one that does not is still accepted the old way but marked `reconstructed`,
-- so the office can see which devices have not been updated. The device's own clock at send
-- time gives the skew, which is recorded and, when large, becomes an exception.

ALTER TABLE `syncPackages`
  ADD COLUMN `verificationMode` enum('exact_wire','reconstructed','unverified') NOT NULL DEFAULT 'unverified',
  ADD COLUMN `deviceClockAt` timestamp NULL,
  ADD COLUMN `clockSkewMs` int NULL;
