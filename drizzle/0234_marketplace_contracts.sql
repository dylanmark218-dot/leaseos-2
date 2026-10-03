-- 0234 — Marketplace checkpoint 2: the award → dispatch bridge.
--
-- One contract per award. The client issues it (posting awarded → contracted), which creates the
-- job — owned by the CONTRACTOR organization, with the client as its customer — and the commercial
-- chain, numbered by the same allocator contractor-office chains use. The contractor then
-- dispatches it through the canonical dispatch posting door (dispatchRoleService.createPosting),
-- and that posting's id is recorded here, so nothing is re-entered and the whole chain reads back:
-- posting → bid → award → contract → job → dispatch posting → roles.
CREATE TABLE `marketplaceContracts` (
  `id` int NOT NULL AUTO_INCREMENT,
  `contractRef` varchar(64) NOT NULL,
  `awardId` int NOT NULL,
  `postingId` int NOT NULL,
  `clientOrgRef` varchar(40) NOT NULL,
  `contractorOrgRef` varchar(40) NOT NULL,
  `contentHash` varchar(64) NOT NULL,
  `jobId` int NOT NULL,
  `jobCode` varchar(32) NOT NULL,
  `chainRef` varchar(80) NOT NULL,
  `chainNumber` varchar(120) NOT NULL,
  `dispatchPostingId` int NULL,
  `dispatchPostingNumber` varchar(64) NULL,
  `state` enum('issued','dispatched','cancelled') NOT NULL DEFAULT 'issued',
  `issuedByUserId` int NOT NULL,
  `issuedAt` timestamp NOT NULL,
  `dispatchedByUserId` int NULL,
  `dispatchedAt` timestamp NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `marketplaceContracts_contractRef_unique` (`contractRef`),
  UNIQUE KEY `marketplaceContracts_awardId_unique` (`awardId`),
  UNIQUE KEY `marketplaceContracts_postingId_unique` (`postingId`),
  UNIQUE KEY `marketplaceContracts_jobId_unique` (`jobId`),
  UNIQUE KEY `marketplaceContracts_dispatchPostingId_unique` (`dispatchPostingId`),
  KEY `marketplaceContracts_contractor_idx` (`contractorOrgRef`,`state`),
  KEY `marketplaceContracts_client_idx` (`clientOrgRef`,`state`)
);
