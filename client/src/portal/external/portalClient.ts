/**
 * A tRPC client for the external portal. The bearer token lives in memory
 * for the session and travels as `x-portal-token`; it is never written to
 * storage by this client — a deployment binds it to a cookie or a keystore.
 */
import { createTRPCClient, httpBatchLink } from "@trpc/client";
import superjson from "superjson";
import type { AppRouter } from "../../../../server/routers";

let token: string | null = null;
let mfa: string | null = null;
export function setPortalToken(t: string | null) { token = t; }
export function setPortalMfa(code: string | null) { mfa = code; }
export function hasPortalToken() { return token != null; }

export const portalClient = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: "/api/trpc", transformer: superjson, headers: () => ({ ...(token ? { "x-portal-token": token } : {}), ...(mfa ? { "x-portal-mfa": mfa } : {}) }) })],
});
