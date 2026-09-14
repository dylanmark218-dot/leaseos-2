-- v20.16 — A fourth typed commit target: a disposal ticket read from a photo.
ALTER TABLE `assistantCommitReceipts`
  MODIFY COLUMN `targetType` enum('trip_stop','maintenance_defect','expense_record','disposal_ticket') NOT NULL;
