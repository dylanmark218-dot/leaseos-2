/**
 * The routing source. There is none loaded (P0). This module is the honest
 * answer to every route request until one is: not a stub that pretends,
 * and not a provider silently chosen. When a provider is configured by
 * environment but its adapter is not implemented here, the status says
 * that too, so a key in an environment variable never reads as routing.
 *
 * Google Maps Platform may not be combined with HERE or Mapbox for places
 * (the "No Use With Non-Google Maps" clause); the guard test pins that no
 * Google Maps endpoint appears in server code.
 */

export type RoutingSourceStatus = { status: "not_loaded" | "configured_not_implemented" | "loaded"; provider: string | null; reason: string };

export function routingSourceStatus(env: Record<string, string | undefined> = process.env): RoutingSourceStatus {
  const provider = env.LEASEOS_ROUTING_PROVIDER?.trim() || null;
  if (!provider) return { status: "not_loaded", provider: null, reason: "No routing source is loaded (P0). Route requests against the road network are UNKNOWN. Segment evaluation over verified restrictions still runs." };
  return { status: "configured_not_implemented", provider, reason: `Routing provider "${provider}" is named in the environment, but no adapter for it is implemented in this build; a named provider is not a loaded source.` };
}

export type RouteAnswer = { determination: "unknown"; sourceStatus: RoutingSourceStatus["status"]; reason: string };

export function routeAgainstNetwork(args: { originRef: string; destinationRef: string }, status: RoutingSourceStatus = routingSourceStatus()): RouteAnswer {
  return { determination: "unknown", sourceStatus: status.status, reason: `${status.reason} Requested ${args.originRef} → ${args.destinationRef}; nothing was computed.` };
}
