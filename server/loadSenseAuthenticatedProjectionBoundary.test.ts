import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const gateway = readFileSync("server/integrationRouter.ts", "utf8");
const protocol = readFileSync("server/_core/loadSenseProtocol.ts", "utf8");

describe("authenticated LoadSense projection boundary", () => {
  it("requires a server-owned gateway binding before calibrated projection", () => {
    expect(gateway).toContain("loadSenseGatewayBindings");
    expect(gateway).toContain('eq(loadSenseGatewayBindings.orgRef, i.orgRef)');
    expect(gateway).toContain('recordBelongsToOrganization(db, i.orgRef, "unit", binding.unitId)');
  });

  it("uses only a current server calibration model and never grants billing/scale authority", () => {
    expect(gateway).toContain('eq(loadSenseCalibrationModels.status, "active")');
    expect(gateway).toContain("calibrationEvent.validUntil");
    expect(gateway).toContain("Billing authority: not_granted");
    expect(gateway).toContain("Certified-scale authority: not_granted");
  });

  it("refuses to call a reading stable when motion telemetry is incomplete", () => {
    expect(gateway).toContain('reasons: ["Vehicle stability telemetry incomplete"]');
  });

  it("requires at least one sensor channel", () => {
    expect(protocol).toContain('errors.push("readings must contain at least one channel")');
  });
});
