-- B20.5 — Finance and payroll roles.
--
-- Payroll and tax work does not belong to HR by accident of being sensitive,
-- and it does not belong to management by seniority. It belongs to people whose
-- job it is. Five roles are added so that access follows function rather than
-- being borrowed from whoever already had a broad grant.
--
-- `external_accountant` matters most: an accountant needs the books and must
-- not thereby be able to dispatch trucks, read safety investigations or change
-- payroll banking details.

ALTER TABLE `userRoleAssignments`
  MODIFY COLUMN `role` enum(
    'driver','dispatcher','mechanic','shop_lead','safety','office',
    'management','hr','legal','auditor',
    'bookkeeper','payroll_admin','tax_preparer','controller','external_accountant'
  ) NOT NULL;
