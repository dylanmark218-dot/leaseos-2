/**
 * 0175 — A tRPC client for the one-time tracking page. The token comes from the URL path (`/t/<token>`),
 * lives in memory for the page's life and travels as `x-tracking-token`. It is never written to
 * storage, never put in a query string, and never sent to any other origin.
 */
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "../../../server/routers";

let token: string | null = null;
export function setTrackingToken(t: string | null) { token = t; }
export function hasTrackingToken() { return token != null; }

export const trackingClient = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: "/api/trpc", transformer: superjson, headers: () => (token ? { "x-tracking-token": token } : {}) })],
});
