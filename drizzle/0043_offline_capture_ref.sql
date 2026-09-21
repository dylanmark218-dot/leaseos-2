-- v21.6 — Offline-first evidence capture.
--
-- A capture made in a dead zone reaches the server hours later, possibly
-- more than once if the connection drops mid-sync. The device's own
-- reference makes the upload idempotent: the same capture uploaded twice is
-- the same record. And the device knows WHEN it captured; the server knows
-- when it received. Both are kept.

ALTER TABLE `evidenceRecords`
  ADD COLUMN `clientCaptureRef` varchar(80) NULL AFTER `trackingNumber`,
  ADD UNIQUE INDEX `evidenceRecords_clientCaptureRef_unique` (`clientCaptureRef`);
