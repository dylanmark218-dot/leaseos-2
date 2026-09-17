-- v22.39 — 0145 (P7.8): a vendor audit package, and the newer chains feeding every package.
-- The audit-package engine (kinds vehicle/driver/job/customer/incident/tax/cor/insurance, hashed
-- canonical manifests, redaction policies, completeness gaps, second-person release) already
-- existed. What was missing: a package for a vendor — its bills with the approval ledger's
-- signatures, contractor payables, facility statements when the vendor runs a facility, and the
-- registry documents linked to it — and registry documents in the job/customer packages.
ALTER TABLE `auditPackages` MODIFY COLUMN `kind` enum('vehicle','driver','job','customer','incident','tax','cor','insurance','vendor') NOT NULL;
