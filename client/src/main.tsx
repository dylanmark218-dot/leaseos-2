import { trpc } from "@/lib/trpc";
import { COOKIE_NAME, TRPC_MOUNT_PATH, UNAUTHED_ERR_MSG } from "@shared/const";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink, TRPCClientError } from "@trpc/client";
import { showcaseGuardLink } from "./lib/showcaseGuard";
import {
  createRefreshGate,
  refreshViaHttp,
  sessionRefreshLink,
} from "./lib/sessionRefresh";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import { startLogin } from "./const";
import "./index.css";
import { installAnalytics } from "./lib/analytics";

const queryClient = new QueryClient();

const redirectToLoginIfUnauthorized = (error: unknown) => {
  if (!(error instanceof TRPCClientError)) return;
  if (typeof window === "undefined") return;

  const isUnauthorized = error.message === UNAUTHED_ERR_MSG;

  if (!isUnauthorized) return;

  startLogin();
};

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Query Error]", error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    redirectToLoginIfUnauthorized(error);
    console.error("[API Mutation Error]", error);
  }
});

/**
 * S1-I — one rotation at a time, shared by every caller in the tab.
 *
 * Built once at module scope, not per request: the single-flight guarantee only holds if every
 * expired request consults the same gate.
 */
const refreshGate = createRefreshGate(() => refreshViaHttp());

/**
 * What a refresh failure clears, and what it deliberately leaves alone.
 *
 * The sessionStorage Bearer mirror is dropped, because it now holds a token the server has stopped
 * honouring and it is the *fallback* credential — leaving it would keep presenting a dead token on
 * surfaces where cookies are blocked.
 *
 * It does NOT call `startLogin()`. The link surfaces the original `UNAUTHED_ERR_MSG` error, which
 * the query/mutation cache subscribers below already act on. Redirecting here as well would call
 * `startLogin()` twice, and each call mints a fresh nonce over the `__Host-` state cookie — the
 * second would desync the first and the callback would reject with "invalid oauth state".
 */
const clearStaleBrowserAuth = () => {
  try {
    sessionStorage.removeItem("manus-cookie");
  } catch {
    // sessionStorage unavailable — nothing mirrored, nothing to clear.
  }
};

const trpcClient = trpc.createClient({
  links: [
    showcaseGuardLink(),
    // Above httpBatchLink so it sees a finished request and can run it again, and below the
    // showcase guard so a refused showcase write is never retried against the server.
    sessionRefreshLink({
      refresh: () => refreshGate.refresh(),
      onSignedOut: clearStaleBrowserAuth,
    }),
    httpBatchLink({
      url: TRPC_MOUNT_PATH,
      transformer: superjson,
      headers() {
        // Preview auto-login fallback: when the browser blocks iframe cookies
        // (Safari ITP / private browsing / WebView), the runtime mirrors the
        // session into sessionStorage so we can forward it as a Bearer token.
        // The regular OAuth cookie flow keeps working and takes priority server-side.
        try {
          const raw = sessionStorage.getItem("manus-cookie");
          if (raw) {
            const prefix = `${COOKIE_NAME}=`;
            const pair = raw.split(";").find(s => s.trim().startsWith(prefix));
            const token = pair?.trim().slice(prefix.length);
            if (token) {
              return { Authorization: `Bearer ${token}` };
            }
          }
        } catch {
          // sessionStorage unavailable
        }
        return {};
      },
      fetch(input, init) {
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
        });
      },
    }),
  ],
});

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </trpc.Provider>
);


// Optional, and off unless both variables are set — see lib/analytics.ts.
installAnalytics(document, import.meta.env as unknown as Record<string, string | undefined>);
