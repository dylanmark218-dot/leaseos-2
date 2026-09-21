# LeaseOS LoadSense authenticated projection checkpoint — 2026-09-14

## Added

- Organization-scoped gateway binding to an owned unit and an owned active LoadSense-capable measurement device.
- Human/role-gated server calibration fitting from a recorded successful calibration event.
- R² floor of 0.98 for multi-point server calibration models.
- Older active models are superseded when a new approved model is created.
- Gateway frames are always retained as evidence first.
- A calibrated weight snapshot is produced only when the gateway is bound, the load belongs to the organization, the server calibration is current at measurement time, and the frame has readings.
- Missing vehicle stability telemetry forces `stable=false`; absence is not interpreted as zero motion.
- Raw client `calibrationId` does not select server authority.
- Snapshot creation still grants neither billing authority nor certified-scale authority.

## Still open

- Hardware/device attestation below the integration API key boundary.
- Native BLE transport and encrypted offline queue.
- Per-channel independent calibration models if hardware requires them; this checkpoint uses one approved device calibration model over each configured raw channel.
- Certified scale reconciliation workflow remains the stronger evidence path and is not bypassed here.
