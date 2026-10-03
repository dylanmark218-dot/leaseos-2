/**
 * Integration Hub — measurable state.
 *
 * Counts and ages only. No payload, no secret, no destination URL. The Hub's
 * one-line health is derived from the same numbers a dashboard would show,
 * so the line and the numbers cannot disagree.
 */
export type HubMetrics = {
  at: Date;
  outbox: { queueDepth: number; oldestQueuedAgeSeconds: number | null; deadLettered: number };
  deliveries: { queued: number; retryBacklog: number; attempted24h: number; succeeded24h: number; failed24h: number; dead: number; oldestQueuedAgeSeconds: number | null };
  deadLetters: { open: number; oldestOpenAgeSeconds: number | null };
  connectors: Record<string, number>;
  sync: { pending: number; running: number; failed24h: number; staleConnectors: number };
  inbound: { accepted24h: number; rejected24h: number; quarantined24h: number; authFailures24h: number; schemaFailures24h: number };
  rateLimitEvents24h: number;
  workerHeartbeatAgeSeconds: number | null;
  perTenantFailures24h: Record<string, number>;
};

export type HubHealthState = "healthy" | "lagging" | "degraded";
export function assessHubHealth(m: HubMetrics, args: { lagThresholdSeconds?: number; heartbeatThresholdSeconds?: number } = {}): { state: HubHealthState; line: string } {
  const lag = args.lagThresholdSeconds ?? 300, hb = args.heartbeatThresholdSeconds ?? 120;
  const failing = Object.entries(m.connectors).filter(([k]) => k === "failing" || k === "authentication_required").reduce((a, [, n]) => a + n, 0);
  if (m.deadLetters.open > 0) return { state: "degraded", line: `${m.deadLetters.open} open dead letter(s) need a person` };
  if (failing > 0) return { state: "degraded", line: `${failing} connector(s) failing or needing credentials` };
  if (m.workerHeartbeatAgeSeconds != null && m.workerHeartbeatAgeSeconds > hb) return { state: "degraded", line: `worker heartbeat is ${m.workerHeartbeatAgeSeconds}s old` };
  if ((m.deliveries.oldestQueuedAgeSeconds ?? 0) > lag) return { state: "lagging", line: `oldest queued delivery is ${m.deliveries.oldestQueuedAgeSeconds}s old` };
  if ((m.outbox.oldestQueuedAgeSeconds ?? 0) > lag) return { state: "lagging", line: `oldest unprocessed outbox event is ${m.outbox.oldestQueuedAgeSeconds}s old` };
  if (m.sync.staleConnectors > 0) return { state: "lagging", line: `${m.sync.staleConnectors} sync connector(s) past their freshness window` };
  return { state: "healthy", line: "integration hub is current" };
}
