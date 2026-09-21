-- v22.23 — authenticated LoadSense gateway evidence through tenant-bound integration clients.
ALTER TABLE `inboundEvents` MODIFY COLUMN `feed` enum('gps_position','fuel_transaction','eld_duty_status','vehicle_telemetry','fault_code','safety_event','video_clip','loadsense_weight','generic') NOT NULL;
ALTER TABLE `loadSenseGatewayFrames`
  ADD COLUMN `orgRef` varchar(40) NOT NULL DEFAULT 'default' AFTER `id`,
  ADD COLUMN `sourceClientId` int NOT NULL DEFAULT 0 AFTER `orgRef`;
CREATE INDEX `loadSenseGatewayFrames_org_gateway_sequence_idx` ON `loadSenseGatewayFrames` (`orgRef`,`gatewayDeviceRef`,`sequence`);
CREATE INDEX `loadSenseGatewayFrames_client_received_idx` ON `loadSenseGatewayFrames` (`sourceClientId`,`receivedAt`);
