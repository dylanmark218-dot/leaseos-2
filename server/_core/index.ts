import "dotenv/config";
import express from "express";
import { createServer } from "http";
import net from "net";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { registerOAuthRoutes } from "./oauth";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { serveStatic } from "./static";
import { startProductionWorker } from "./productionWorker";
import { ENV, assertProductionSecrets } from "./env";
import { sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  allowedOriginsFromEnv,
  crossSiteGuard,
  rateLimit,
  registerHealthRoutes,
  securityHeaders,
  trustProxySetting,
} from "./httpHardening";

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const server = net.createServer();
    server.listen(port, () => {
      server.close(() => resolve(true));
    });
    server.on("error", () => resolve(false));
  });
}

async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

async function startServer() {
  // One decision, read twice. Which bundle gets served and which configuration
  // must be present to serve it are the same question, and asking it twice is
  // how they drift: `ENV.isProduction` is `NODE_ENV === "production"`, while the
  // choice below serves the production bundle for anything that is not
  // "development". A deployment with NODE_ENV unset, or set to "staging", lands
  // in the gap — production assets, no secret check.
  const isDevelopment = process.env.NODE_ENV === "development";

  // Before anything binds a port or starts a worker: a server that cannot
  // authenticate anyone should not reach the point of accepting requests.
  assertProductionSecrets(ENV, !isDevelopment);

  const app = express();
  const server = createServer(app);
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
  registerHealthRoutes(app, {
    database: async () => {
      const db = await getDb();
      if (!db) throw new Error("DATABASE_URL is not configured");
      await db.execute(sql`SELECT 1`);
    },
  });
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
  // Hunting for a free port is a development convenience. In production the
  // load balancer is pointed at PORT, and a server that quietly binds another
  // one is a healthy process nobody can reach — so refuse to start instead.
  if (!isDevelopment && !(await isPortAvailable(preferredPort))) {
    throw new Error(`Port ${preferredPort} is in use; refusing to start on a different one outside development`);
  }
  const port = isDevelopment ? await findAvailablePort(preferredPort) : preferredPort;

  if (port !== preferredPort) {
    console.log(`Port ${preferredPort} is busy, using port ${port} instead`);
  }

  server.listen(port, () => {
    console.log(`Server running on http://localhost:${port}/`);
    if (worker) console.log(`[worker] started ${worker.lifecycle.workerId}`);
  });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
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
