import "dotenv/config";
import express from "express";
import { createServer } from "http";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic } from "./static";
import { startProductionWorker } from "./productionWorker";
import { ENV, assertProductionSecrets } from "./env";
import { listenOnPort, resolveListenPort } from "./listen";
import { createReadinessState, registerHealthRoutes } from "./health";
import {
  allowedOriginsFromEnv,
  crossSiteGuard,
  rateLimit,
  securityHeaders,
  trustProxySetting,
} from "./httpHardening";

async function startServer() {
  // One decision, read twice. Which bundle gets served and which configuration
  // must be present to serve it are the same question, and asking it twice is
  // how they drift: `ENV.isProduction` is `NODE_ENV === "production"`, while the
  // choice below serves the production bundle for anything that is not
  // "development". A deployment with NODE_ENV unset, or set to "staging", lands
  // in the gap — production assets, no secret check.
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
  app.disable("x-powered-by");
  const trustProxy = trustProxySetting(process.env);
  if (trustProxy !== null) app.set("trust proxy", trustProxy);
  app.use(
    securityHeaders({
      hsts: !isDevelopment,
      frameAncestors: process.env.LEASEOS_FRAME_ANCESTORS?.trim() || null,
    })
  );
  app.use("/api", crossSiteGuard({ allowedOrigins: allowedOriginsFromEnv(process.env) }));
  // Body limits by route. Only tRPC carries files, and the largest is an
  // evidence upload: 15 MB of bytes is 20 MB of base64, and the procedure
  // refuses anything longer. Everything else is kilobytes. The limit used to
  // be 50 MB everywhere.
  app.use("/api/trpc", express.json({ limit: "25mb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ limit: "100kb", extended: true }));
  // A floor against one client hammering sign-in, per process. See rateLimit.
  app.use("/api/oauth", rateLimit({ windowMs: 60_000, max: 60 }));
  registerOAuthRoutes(app);
  // tRPC API
  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    })
  );
  // development mode uses Vite, production mode uses static files
  if (isDevelopment) {
    // Dynamic, so the production bundle never loads Vite — see vite.ts.
    const { setupVite } = await import("./vite");
    await setupVite(app, server);
  } else {
    serveStatic(app);
  }

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
  // `startServer().catch` below and the process lingered with no server and exit code 0.
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

startServer().catch(error => {
  // A refusal to start is not a background error to log and carry on from: the
  // process has no server, and exiting non-zero is what makes a supervisor or a
  // deploy pipeline report the failure rather than declare success.
  console.error(error);
  process.exitCode = 1;
});
