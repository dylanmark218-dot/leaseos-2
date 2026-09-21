-- 0168 — retire the storage capability URLs.
--
-- `/manus-storage/{key}` was a route that minted a signed read from any key a
-- caller could name: no session, no role, no tenant, no ownership lookup and no
-- access event. The route is deleted and `storagePut` no longer returns a URL,
-- so nothing new can be written. These are the rows already carrying one.
--
-- `storageKey` stays the source of truth; only the capability path is cleared.
-- The predicate is deliberately narrow: a value that does not start with
-- `/manus-storage/` was supplied by a caller (an SDS link, a vendor's document)
-- and is not a minted capability, so it is left exactly as it is.
UPDATE evidenceRecords    SET storageUrl = NULL WHERE storageUrl LIKE '/manus-storage/%';
UPDATE complianceDocuments SET storageUrl = NULL WHERE storageUrl LIKE '/manus-storage/%';
UPDATE maintenanceDefects  SET storageUrl = NULL WHERE storageUrl LIKE '/manus-storage/%';
