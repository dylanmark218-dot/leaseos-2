-- v22.68 — 0154 (P8.2): the existing deployment keeps working when the fail-closed rule lands.
--
-- P8.2 says an unresolved entitlement fails closed, and that is right. But applied to a database
-- with no entitlement rows at all, it makes every capability unevaluated, and every dispatch
-- carries five "required capability not evaluated" blockers. Measured before writing this: a bare
-- composition went from its ordinary verdict to five capability blockers. A safety rule that
-- blocks work which was running fine the day before is not a safety rule, it is an outage.
--
-- So two backfills, and they are deliberately different in kind:
--
--   ENTITLEMENT — recorded as `entitled` for the historical single tenant (orgRef NULL) only.
--   These capabilities are in use in the existing deployment; that is an observation about what is
--   running, not a commercial claim. It is NOT extended to other tenants: whether a business bought
--   a capability is a commercial fact that belongs to onboarding, and inferring it here would put a
--   guess in the record where a subscription should be.
--
--   POLICY — explicit MANUAL rows, per the owner decision ("migrate/backfill to MANUAL unless an
--   explicit policy already establishes something else"). The resolver already defaults to MANUAL,
--   so this changes no behaviour; what it adds is a visible row. It is sourced as `migration_0154`
--   with no actor, so nobody later reads it as a person's decision — an explicit row that claimed
--   to be someone's choice would be worse than no row.
--
-- Nothing here enables automation. Every written policy is MANUAL, and a capability already
-- carrying a policy is left exactly as it is.
INSERT INTO `capabilityEntitlements` (`orgRef`, `capability`, `state`, `reference`, `effectiveFrom`)
SELECT NULL, c.capability, 'entitled',
       'migration_0154: in use in the existing deployment before the entitlement rule existed',
       CURRENT_TIMESTAMP
  FROM (
    SELECT 'hos' AS capability UNION ALL
    SELECT 'operator qualification' UNION ALL
    SELECT 'unit inspection' UNION ALL
    SELECT 'operating documents' UNION ALL
    SELECT 'mechanic release' UNION ALL
    SELECT 'route restrictions' UNION ALL
    SELECT 'destination acceptance' UNION ALL
    SELECT 'enforcement orders'
  ) AS c
 WHERE NOT EXISTS (
    SELECT 1 FROM `capabilityEntitlements` e
     WHERE e.`capability` = c.capability AND e.`orgRef` IS NULL AND e.`supersededAt` IS NULL
 );
--> statement-breakpoint
INSERT INTO `automationPolicies`
  (`policyVersionId`, `orgRef`, `capability`, `scope`, `scopeId`, `requestedMode`, `source`, `reason`, `actorUserId`, `effectiveFrom`)
SELECT CONCAT('PV-0154-', UPPER(REPLACE(c.capability, ' ', '-'))), NULL, c.capability, 'tenant', NULL, 'MANUAL',
       'migration_0154',
       'Backfilled by the P8.2 migration, not chosen by a person. MANUAL is what the resolver already defaults to; this makes it a visible row. Replace it with a decision when one is made.',
       NULL, CURRENT_TIMESTAMP
  FROM (
    SELECT 'hos' AS capability UNION ALL
    SELECT 'operator qualification' UNION ALL
    SELECT 'unit inspection' UNION ALL
    SELECT 'operating documents' UNION ALL
    SELECT 'mechanic release' UNION ALL
    SELECT 'route restrictions' UNION ALL
    SELECT 'destination acceptance' UNION ALL
    SELECT 'enforcement orders'
  ) AS c
 WHERE NOT EXISTS (
    SELECT 1 FROM `automationPolicies` p
     WHERE p.`capability` = c.capability AND p.`orgRef` IS NULL AND p.`scope` = 'tenant' AND p.`supersededAt` IS NULL
 );
