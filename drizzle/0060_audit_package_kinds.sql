-- v22.2 — COR and insurance package kinds.
ALTER TABLE `auditPackages` MODIFY COLUMN `kind` enum('vehicle','driver','job','customer','incident','tax','cor','insurance') NOT NULL;
