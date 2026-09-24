-- 0186 — four more kinds of government source the licence review has to be able to name.
--
-- Slot: main ends at 0174. Open branches at survey time (2026-09-24) claim up to 0185 (auth-workspace,
-- client-portal, driver-portfolio and training-academy 0175; driver-portfolio 0176–0177; document-control
-- 0178–0183; eld-compliance and migration-0169-reconciliation 0179; communications-marketplace,
-- customer-contract-rates, integration-hub and safety-program-builder 0182–0184; relaxed-carson and
-- sec-004 0185). This takes 0186, the first number no branch holds.
-- docs/architecture/MIGRATION_COLLISION_REGISTER.md.
--
-- The federal and provincial candidates added to the registry on 2026-09-24 include a vehicle recall
-- database, a recalls-and-safety-alerts feed, two statistics services and two open-data catalogues. None
-- is a road network or a weather layer, and filing them as `other` would hide what a licence review is
-- actually reviewing — the same reason 0074 added `spectrum` and `coverage`. Additive: every existing
-- value keeps its meaning and no row changes.
--
-- Rollback: MODIFY the column back to the 0074 list once no row carries one of the four new values.

ALTER TABLE `externalDataSources`
  MODIFY COLUMN `category` enum('base_map','road_network','land_grid','oilfield_assets','road_conditions','weather','wildfire','routing_engine','geocoder','tiles','spectrum','coverage','vehicle_recalls','safety_alerts','statistics','dataset_catalog','other') NOT NULL;
