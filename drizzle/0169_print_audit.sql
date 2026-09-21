-- v23.27 (0169): printing becomes a delivery that knows what it put on paper.
--
-- commercialDocumentDeliveries already accepted channel 'print'. What a print row could not say:
-- which printer produced it, whether that paper was the first of its version or a reprint, and
-- what the paper check (shared/printability.ts) found when it was printed. Staleness needs no
-- column: a print is stale exactly when its document is superseded or withdrawn, and
-- commercialDocuments already records that. Rows written before this migration read NULL in all
-- five columns, which is the truth about them: not recorded.
ALTER TABLE `commercialDocumentDeliveries`
  ADD COLUMN `printerId` int NULL,
  ADD COLUMN `copyKind` enum('original','reprint') NULL,
  ADD COLUMN `printabilityVerdict` enum('printable','printable_with_markings','refused') NULL,
  ADD COLUMN `printabilityDetail` text NULL,
  ADD COLUMN `printedOffline` boolean NULL;
--> statement-breakpoint
CREATE INDEX `cdd_printer` ON `commercialDocumentDeliveries` (`printerId`);
--> statement-breakpoint
-- A printer is a peripheral, not a LeaseOS client: it holds no keys and syncs nothing, so it is
-- not a fieldDevice; it measures nothing, so it is not a measurementDevice.
CREATE TABLE `fieldPrinters` (
  `id` int NOT NULL AUTO_INCREMENT,
  `printerRef` varchar(40) NOT NULL,
  `orgRef` varchar(64) NULL,
  `manufacturer` varchar(80) NOT NULL,
  `model` varchar(80) NOT NULL,
  `serialNumber` varchar(80) NULL,
  `connectionType` enum('bluetooth_classic','bluetooth_le','wifi','wifi_direct','usb','network') NOT NULL,
  `paperFormat` enum('letter','receipt_4in','receipt_3in','receipt_2in','label') NOT NULL,
  `printTechnology` enum('direct_thermal','thermal_transfer','inkjet','laser') NOT NULL,
  -- NULL is "not established": Bluetooth Classic on iOS needs Apple MFi, and nobody should assume it.
  `iosMfiCertified` boolean NULL,
  `status` enum('active','out_of_service','retired') NOT NULL DEFAULT 'active',
  `createdByUserId` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `fp_ref` (`printerRef`)
);
--> statement-breakpoint
CREATE INDEX `fp_org` ON `fieldPrinters` (`orgRef`);
--> statement-breakpoint
-- Superseded, never edited, so "which printer was in unit 14 on the day of the spill" stays
-- answerable. Same shape as measurementDeviceAssignments.
CREATE TABLE `fieldPrinterAssignments` (
  `id` int NOT NULL AUTO_INCREMENT,
  `printerId` int NOT NULL,
  `assignedToType` enum('unit','yard','office') NOT NULL,
  `assignedToId` int NULL,
  `assignedFrom` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `assignedUntil` timestamp NULL DEFAULT NULL,
  `assignedByUserId` int NOT NULL,
  `endedByUserId` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
);
--> statement-breakpoint
CREATE INDEX `fpa_printer` ON `fieldPrinterAssignments` (`printerId`, `assignedUntil`);
--> statement-breakpoint
CREATE INDEX `fpa_target` ON `fieldPrinterAssignments` (`assignedToType`, `assignedToId`);
