-- 0114 — bind authenticated LoadSense gateway identity to an owned unit/device.
CREATE TABLE `loadSenseGatewayBindings` (
  `id` int NOT NULL AUTO_INCREMENT,
  `orgRef` varchar(40) NOT NULL,
  `gatewayDeviceRef` varchar(96) NOT NULL,
  `measurementDeviceId` int NOT NULL,
  `unitId` int NOT NULL,
  `trailerId` int NULL,
  `tareKg` double NOT NULL,
  `channelConfigJson` text NULL,
  `status` enum('active','suspended','retired') NOT NULL DEFAULT 'active',
  `boundByUserId` int NOT NULL,
  `boundAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `loadSenseGatewayBindings_org_gateway_unique` (`orgRef`,`gatewayDeviceRef`)
);
