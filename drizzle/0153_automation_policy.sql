-- v22.67 — 0153 (P8.2): entitlement, automation policy, and the history of both.
--
-- Two tables because they answer two questions the owner decision deliberately kept apart:
-- whether a capability is available to this tenant at all, and — only if it is — how a record
-- reaches confirmed. A missing policy row means MANUAL; a missing entitlement row means the
-- capability reports NOT_EVALUATED and has no mode. Merging them would let one forgotten row
-- either start a machine or falsely claim a customer never had the feature.
--
-- Policy is append-only with supersession, not updated in place: "what mode were we in when this
-- record was made" has to be answerable from evidence, and an UPDATE erases the answer.
CREATE TABLE `capabilityEntitlements` (
  `id` int NOT NULL AUTO_INCREMENT,
  `orgRef` varchar(64) NULL,                      -- NULL = the historical single tenant (0132 rule)
  `capability` varchar(64) NOT NULL,
  `state` enum('entitled','not_entitled') NOT NULL,
  -- Why, when not entitled. An absent row is NOT this: an absent row is unresolved, which fails
  -- closed differently, so a broken feed can be told apart from a customer who did not buy it.
  `reason` enum('unlicensed','disabled','not_in_product_set') NULL,
  `reference` varchar(128) NULL,                  -- the subscription, order or product-set row
  `effectiveFrom` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `supersededAt` timestamp NULL,
  `setByUserId` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `ent_lookup` (`orgRef`, `capability`, `supersededAt`)
);
--> statement-breakpoint
CREATE TABLE `automationPolicies` (
  `id` int NOT NULL AUTO_INCREMENT,
  `policyVersionId` varchar(64) NOT NULL,
  `orgRef` varchar(64) NULL,
  `capability` varchar(64) NOT NULL,
  `scope` enum('tenant','role','task','customer') NOT NULL,
  `scopeId` varchar(64) NULL,                     -- role name, task ref, customer ref; NULL at tenant
  `requestedMode` enum('AUTO','HYBRID','MANUAL') NOT NULL,
  -- The ceiling in force when this row was written, for the record. The live ceiling comes from
  -- P8.4's classification, which is an owner decision and is not stored here.
  `safetyCeilingApplied` enum('AUTO','HYBRID','MANUAL') NULL,
  `source` varchar(64) NOT NULL,                  -- onboarding preset, person, import
  `reason` varchar(500) NULL,
  `actorUserId` int NULL,
  `effectiveFrom` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `supersededAt` timestamp NULL,
  `supersededByVersionId` varchar(64) NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `pol_lookup` (`orgRef`, `capability`, `scope`, `supersededAt`),
  KEY `pol_version` (`policyVersionId`)
);
--> statement-breakpoint
-- The decision-time snapshot, continuing 0152: an audit reads the policy that governed the
-- decision, never today's resolver re-run against an old decision.
ALTER TABLE `dispatchEligibilityChecks`
  ADD COLUMN `automationPolicyJson` text NULL;
