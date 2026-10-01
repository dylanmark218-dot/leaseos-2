-- SEC-004 preflight: webhook delivery integrity. READ-ONLY — every statement is a SELECT.
--
-- Run against a copy of production (or production, read-only) BEFORE any SEC-004 migration:
--   mysql -h HOST -u READONLY_USER -p DBNAME < scripts/preflight/sec004-webhook-delivery-duplicates.sql
--
-- The logical delivery is (subscriptionId, eventId). Each ATTEMPT is its own row, numbered by
-- `attempt`; migration 0054 already enforces UNIQUE(subscriptionId, eventId, attempt). So a
-- legitimate retry is a new row with attempt+1, and what this looks for is anything that
-- contradicts "one logical delivery, attempts 1..n, at most one terminal outcome, nothing after it".
--
-- What a clean result does NOT prove: the race SEC-004 closes leaves no row behind. Two workers
-- both POST attempt n; the second INSERT hits the unique key and throws, so the double send is
-- visible only in logs — search worker logs for "webhook dispatch failed" with "Duplicate entry".
-- Section 0 is the one check here that the race DOES leave traces for.

-- 0. Is the unique key actually present? (Drift would make every section below meaningful.)
SELECT index_name, GROUP_CONCAT(column_name ORDER BY seq_in_index) AS columns, MIN(non_unique) AS non_unique
FROM information_schema.statistics
WHERE table_schema = DATABASE() AND table_name = 'webhookDeliveries'
GROUP BY index_name;

-- 1. Duplicate ATTEMPT rows: same (subscription, event, attempt) more than once.
--    Impossible while the unique key exists; non-empty means the key is missing.
SELECT d.subscriptionId, d.eventId, d.attempt, COUNT(*) AS rows_n,
       GROUP_CONCAT(DISTINCT d.orgRef) AS orgRefs, GROUP_CONCAT(d.status ORDER BY d.id) AS statuses,
       MIN(d.at) AS first_at, MAX(d.at) AS last_at
FROM webhookDeliveries d
GROUP BY d.subscriptionId, d.eventId, d.attempt
HAVING COUNT(*) > 1;

-- 2. A logical delivery DELIVERED more than once (the consumer received it twice, on record).
SELECT d.orgRef, s.subscriptionRef, d.subscriptionId, d.eventId, COUNT(*) AS delivered_rows,
       GROUP_CONCAT(d.attempt ORDER BY d.attempt) AS attempts, MIN(d.at) AS first_at, MAX(d.at) AS last_at
FROM webhookDeliveries d LEFT JOIN webhookSubscriptions s ON s.id = d.subscriptionId
WHERE d.status = 'delivered'
GROUP BY d.orgRef, s.subscriptionRef, d.subscriptionId, d.eventId
HAVING COUNT(*) > 1;

-- 3. Attempts written AFTER a terminal one (delivered or dead) for the same logical delivery.
SELECT t.orgRef, t.subscriptionId, t.eventId, t.attempt AS terminal_attempt, t.status AS terminal_status,
       later.attempt AS later_attempt, later.status AS later_status, t.at AS terminal_at, later.at AS later_at
FROM webhookDeliveries t
JOIN webhookDeliveries later
  ON later.subscriptionId = t.subscriptionId AND later.eventId = t.eventId AND later.attempt > t.attempt
WHERE t.status IN ('delivered', 'dead')
ORDER BY t.subscriptionId, t.eventId, later.attempt;

-- 4. Gaps: attempts are not exactly 1..n (informational — a gap means a row was lost or skipped).
SELECT d.orgRef, d.subscriptionId, d.eventId, COUNT(*) AS rows_n, MIN(d.attempt) AS min_attempt,
       MAX(d.attempt) AS max_attempt, GROUP_CONCAT(d.attempt ORDER BY d.attempt) AS attempts,
       GROUP_CONCAT(d.status ORDER BY d.attempt) AS statuses
FROM webhookDeliveries d
GROUP BY d.orgRef, d.subscriptionId, d.eventId
HAVING MIN(d.attempt) <> 1 OR MAX(d.attempt) <> COUNT(*);

-- 5. Tenant boundary: a delivery whose orgRef differs from its subscription's, or whose
--    subscription no longer exists.
SELECT d.id, d.deliveryRef, d.orgRef AS delivery_org, s.orgRef AS subscription_org, d.subscriptionId,
       d.eventId, d.attempt, d.status, d.at
FROM webhookDeliveries d LEFT JOIN webhookSubscriptions s ON s.id = d.subscriptionId
WHERE s.id IS NULL OR NOT (d.orgRef <=> s.orgRef);

-- 6. Rows in 'queued'. Current code never writes this status, so any row here predates it or was
--    written by hand; a claim-before-send design would treat it as a claim, so it must be known first.
SELECT d.orgRef, d.subscriptionId, d.eventId, d.attempt, d.status, d.at, d.createdAt
FROM webhookDeliveries d
WHERE d.status = 'queued';

-- 7. Summary for the report.
SELECT COUNT(*) AS delivery_rows,
       COUNT(DISTINCT CONCAT(d.subscriptionId, ':', d.eventId)) AS logical_deliveries,
       COUNT(DISTINCT d.orgRef) AS organizations,
       COUNT(DISTINCT d.subscriptionId) AS subscriptions,
       SUM(d.status = 'queued') AS queued, SUM(d.status = 'delivered') AS delivered,
       SUM(d.status = 'failed') AS failed, SUM(d.status = 'dead') AS dead,
       MIN(d.at) AS earliest, MAX(d.at) AS latest
FROM webhookDeliveries d;
