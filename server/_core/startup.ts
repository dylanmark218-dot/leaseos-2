/**
 * Startup, shared by the production entrypoint (`./index.ts`) and the development one (`./dev.ts`).
 *
 * P0-C — the only thing the two entrypoints decide differently is how the client is served:
 * production serves `dist/public` (`./staticAssets.ts`), development runs Vite in middleware
 * mode (`./vite.ts`). That choice is made by WHICH ENTRYPOINT RUNS, not by an environment
 * variable read at runtime: the production bundle must not contain an edge to Vite at all, so
 * `dist/index.js` cannot reach it however the process is configured. Everything else here —
 * probes, the secret check, the embedded worker, the API, port semantics, graceful shutdown —
 * is one implementation, so the two entrypoints cannot drift apart.
 */
import express, { type Express } from "express";
import { createServer, type Server } from "http";
import { registerApi } from "./api";
import { startProductionWorker } from "./productionWorker";
import { ENV, assertProductionSecrets } from "./env";
import { listenOnPort, resolveListenPort } from "./listen";
import { createReadinessState, registerHealthRoutes } from "./health";

/** How the client is served: the built bundle, or Vite over this server (development). */
export type Frontend = (app: Express, server: Server) => void | Promise<void>;

export async function startServer(frontend: Frontend): Promise<void> {
  // One decision, read twice. Which configuration must be present and whether the port may
  // move are the same question, and asking it twice is how they drift: `ENV.isProduction` is
  // `NODE_ENV === "production"`, while the checks below enforce production rules for anything
  // that is not "development". A deployment with NODE_ENV unset, or set to "staging", lands
  // on the strict side rather than in a gap.
  const isDevelopment = process.env.NODE_ENV === "development";

  const app = express();
  const server = createServer(app);

  // The operational probes go on before anything else, and deliberately before the secret
  // check: while startup is still running — or failing — `/readyz` must be able to say so.
  // Registered here they are also never subject to application authorization, which
  // matters because a readiness endpoint that needs a session cannot report that sessions
  // are unavailable.
  const readiness = createReadinessState();
  registerHealthRoutes(app, readiness);

  // Before anything binds a port or starts a worker: a server that cannot
  // authenticate anyone should not reach the point of accepting requests.
  assertProductionSecrets(ENV, !isDevelopment);

  const worker = await startProductionWorker();
  // Body parsers, the OAuth callback and the tRPC mount — one registration, shared with the HTTP
  // regression so the test drives the production mounting (P0-B).
  registerApi(app);
  // The client, as the entrypoint chose to serve it (P0-C).
  await frontend(app, server);

  const preferredPort = parseInt(process.env.PORT || "3000");

  // Production binds the configured port or refuses to start; only development searches.
  // The old search ran everywhere, so a busy 3000 silently became 3001 — under an
  // orchestrator, a container bound to a port nothing routes to, restarted forever by a
  // probe that could never succeed.
  const port = await resolveListenPort(preferredPort, isDevelopment);

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  // `await`, because `server.listen()` reports a bind failure by emitting `error` rather
  // than throwing. Awaiting the old call caught nothing, so EADDRINUSE never reached the
  // entrypoint's `.catch` and the process lingered with no server and exit code 0.
  await listenOnPort(server, port);

  console.log(`Server running on http://localhost:${port}/`);
  if (worker) console.log(`[worker] started ${worker.lifecycle.workerId}`);

  // Everything required to serve — the secret check, the worker, the asset handler — has
  // completed above, and the port is bound. Nothing asynchronous that startup depends on
  // happens after this point, so this is the moment the process can honestly accept work.
  readiness.markReady();

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    // First, before draining anything: stop being a candidate for new work. A load
    // balancer polling `/readyz` sees 503 and takes this process out of rotation while the
    // existing shutdown below finishes what is already in flight.
    readiness.markNotReady();
    if (worker) await worker.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

/**
 * A refusal to start is not a background error to log and carry on from: the process has no
 * server, and exiting non-zero is what makes a supervisor or a deploy pipeline report the
 * failure rather than declare success.
 */
export function reportStartupFailure(error: unknown): void {
  console.error(error);
  process.exitCode = 1;
}
