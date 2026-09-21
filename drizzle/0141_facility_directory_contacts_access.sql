-- v22.34 — 0141: what the operator briefs of 2026-09-17 showed the directory still lacked —
-- who a facility takes loads from (a government facility layer lists producer-owned sites that
-- take nobody's load but their owner's), the phones a driver actually needs (site, dispatch,
-- after-hours, sales), preapproval / manifest / TDG requirements, NORM and sour acceptance
-- flags, the parent company, the physical address, and a lifecycle separate from the gate
-- status (SECURE says its Virden site is no longer in operation; the Town says another firm runs
-- it — that is `conflicting`, and the engine fails closed on it).

ALTER TABLE `facilities`
  ADD COLUMN `parentCompany` varchar(220) NULL,
  ADD COLUMN `physicalAddress` varchar(300) NULL,
  ADD COLUMN `dispatchPhone` varchar(60) NULL,
  ADD COLUMN `afterHoursPhone` varchar(60) NULL,
  ADD COLUMN `salesContact` varchar(220) NULL,
  ADD COLUMN `email` varchar(200) NULL,
  ADD COLUMN `commercialAccess` enum('commercial_public','commercial_preapproval_required','operator_private','transfer_only','unknown') NOT NULL DEFAULT 'unknown',
  ADD COLUMN `lifecycle` enum('operating','suspended','closed','conflicting','unknown') NOT NULL DEFAULT 'unknown',
  ADD COLUMN `preapprovalRequired` boolean NULL,
  ADD COLUMN `manifestRequired` boolean NULL,
  ADD COLUMN `tdgRequired` boolean NULL,
  ADD COLUMN `twentyFourHourCallout` boolean NULL,
  ADD COLUMN `normAccepted` boolean NULL,
  ADD COLUMN `sourAccepted` boolean NULL,
  ADD COLUMN `wasteApprovalFormUrl` varchar(1024) NULL,
  ADD COLUMN `facilityTypes` json NULL,
  ADD COLUMN `statusVerifiedAt` timestamp NULL,
  ADD COLUMN `sourceAuthority` varchar(400) NULL;
--> statement-breakpoint
INSERT INTO `wasteStreamVocabulary` (`internalCode`,`label`,`aerWasteCode`,`sourceUrl`,`sourceVersion`,`verificationStatus`) VALUES
  ('sour_produced_water','Sour produced water (H2S)',NULL,'https://www.aer.ca/documents/directives/Directive058.pdf','Directive 058 (effective 2026-06-04)','candidate'),
  ('norm_impacted','NORM-impacted waste',NULL,'https://www.aer.ca/documents/directives/Directive058.pdf','Directive 058 (effective 2026-06-04); Canadian NORM guidelines','candidate'),
  ('cement_returns','Cement returns',NULL,'https://www.aer.ca/documents/directives/Directive058.pdf','Directive 058 (effective 2026-06-04)','candidate'),
  ('oily_sludge','Oily sludge / tank bottoms',NULL,'https://www.aer.ca/documents/directives/Directive058.pdf','Directive 058 (effective 2026-06-04)','candidate'),
  ('pcb_waste','PCB waste',NULL,'https://www.canada.ca/','Cross-border Movement of Hazardous Waste Regulations (XBR)','candidate'),
  ('dangerous_goods_solids','Dangerous goods solids (TDG classes 4.1 / 8 / 9)',NULL,NULL,NULL,'candidate');
