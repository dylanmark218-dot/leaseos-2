-- v22.85 — 0160 (P4.6): the record that a worker was told what is collected about them.
--
-- LeaseOS reads a driver's position continuously, holds their duty hours, their inspections, their
-- defect reports and increasingly their device state. Canadian privacy law and every reasonable
-- reading of the employment relationship require that the person knows. Nothing here recorded it:
-- `complianceConsents` covers hiring checks — abstracts, medicals, background — and says nothing
-- about ongoing monitoring.
--
-- Three distinctions the table exists to keep:
--
--   **Issued is not acknowledged.** "We sent the notice" and "they know" are different facts, and
--   the second is the one that matters in a dispute. Both are recorded; neither is inferred.
--
--   **A notice is about a PURPOSE.** Telling someone in 2024 that their truck reports its position
--   does not cover reading their in-cab camera in 2026. A new purpose needs its own notice.
--
--   **The content is hashed.** A notice nobody can reproduce proves nothing; a hash of the text
--   issued means the version a worker saw can be shown later rather than described.
--
-- Absence means NOT NOTIFIED. There is deliberately no "assumed" state: a worker with no row is a
-- worker nobody told, which is exactly the fact a register like this exists to surface.
CREATE TABLE `monitoringNotices` (
  `id` int NOT NULL AUTO_INCREMENT,
  `orgRef` varchar(64) NULL,                                  -- NULL = historical single tenant (0132)
  `subjectUserId` int NOT NULL,
  `purpose` enum('vehicle_location','driver_duty_hours','in_cab_camera','device_telemetry','app_usage','biometric_device_unlock') NOT NULL,
  `noticeVersion` varchar(40) NOT NULL,
  `noticeTextHash` varchar(128) NOT NULL,                     -- what they were actually shown
  `issuedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `issuedByUserId` int NOT NULL,
  -- Null until the person acknowledges. Issued-and-unacknowledged is a real, common state.
  `acknowledgedAt` timestamp NULL,
  `acknowledgementMethod` enum('in_app','signed_document','verbal_witnessed') NULL,
  `acknowledgementEvidenceRecordId` int NULL,
  `supersededAt` timestamp NULL,
  `supersededByNoticeId` int NULL,
  `withdrawnAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `notice_subject` (`orgRef`, `subjectUserId`, `purpose`, `supersededAt`)
);
