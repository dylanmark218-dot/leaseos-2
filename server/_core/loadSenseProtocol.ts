export type LoadSenseGatewayFrame = {
  protocol: "leaseos.loadsense.v1";
  gatewayDeviceId: string;
  sequence: number;
  measuredAt: string;
  buffered: boolean;
  readings: Record<string, number>;
  vehicle?: {
    speedKph?: number;
    pitchDeg?: number;
    rollDeg?: number;
    accelerationMps2?: number;
  };
  calibrationId?: string;
  pairingId?: string;
  loadId?: number;
};

export type GatewayFrameValidation = {
  ok: boolean;
  errors: string[];
  frame?: LoadSenseGatewayFrame;
};

export function validateGatewayFrame(value: unknown): GatewayFrameValidation {
  const errors: string[] = [];
  if (!value || typeof value !== "object") return { ok: false, errors: ["Frame must be an object"] };
  const v = value as Record<string, unknown>;
  if (v.protocol !== "leaseos.loadsense.v1") errors.push("Unsupported protocol");
  if (typeof v.gatewayDeviceId !== "string" || !v.gatewayDeviceId.trim()) errors.push("gatewayDeviceId is required");
  if (!Number.isInteger(v.sequence) || Number(v.sequence) < 0) errors.push("sequence must be a non-negative integer");
  if (typeof v.measuredAt !== "string" || Number.isNaN(Date.parse(v.measuredAt))) errors.push("measuredAt must be ISO date/time");
  if (typeof v.buffered !== "boolean") errors.push("buffered must be boolean");
  if (!v.readings || typeof v.readings !== "object" || Array.isArray(v.readings)) errors.push("readings must be an object");
  else {
    for (const [key, reading] of Object.entries(v.readings as Record<string, unknown>)) {
      if (!key.trim() || typeof reading !== "number" || !Number.isFinite(reading)) errors.push(`Invalid reading ${key || "<empty>"}`);
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, errors: [], frame: value as LoadSenseGatewayFrame };
}

export function frameKey(frame: Pick<LoadSenseGatewayFrame, "gatewayDeviceId" | "sequence">) {
  return `${frame.gatewayDeviceId}:${frame.sequence}`;
}

/**
 * Replays gateway-buffered data deterministically after BLE reconnect. Duplicate
 * sequence numbers are ignored so reconnect/retry cannot create double telemetry.
 */
export function mergeGatewayFrames(existing: LoadSenseGatewayFrame[], incoming: LoadSenseGatewayFrame[]) {
  const byKey = new Map<string, LoadSenseGatewayFrame>();
  for (const frame of [...existing, ...incoming]) {
    const checked = validateGatewayFrame(frame);
    if (!checked.ok || !checked.frame) continue;
    const key = frameKey(checked.frame);
    const prior = byKey.get(key);
    // Prefer the non-buffered/live copy when the gateway sent the same frame twice.
    if (!prior || (prior.buffered && !checked.frame.buffered)) byKey.set(key, checked.frame);
  }
  return [...byKey.values()].sort((a, b) => {
    const time = Date.parse(a.measuredAt) - Date.parse(b.measuredAt);
    return time || a.sequence - b.sequence;
  });
}

export function detectSequenceGaps(frames: LoadSenseGatewayFrame[]) {
  const byGateway = new Map<string, number[]>();
  for (const frame of frames) {
    const list = byGateway.get(frame.gatewayDeviceId) ?? [];
    list.push(frame.sequence); byGateway.set(frame.gatewayDeviceId, list);
  }
  const gaps: Array<{ gatewayDeviceId: string; from: number; to: number }> = [];
  for (const [gatewayDeviceId, seqs] of byGateway) {
    const sorted = [...new Set(seqs)].sort((a, b) => a - b);
    for (let i = 1; i < sorted.length; i++) if (sorted[i] > sorted[i - 1] + 1) gaps.push({ gatewayDeviceId, from: sorted[i - 1] + 1, to: sorted[i] - 1 });
  }
  return gaps;
}
