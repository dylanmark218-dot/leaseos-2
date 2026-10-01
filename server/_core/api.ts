/**
 * P0-B — the HTTP API, registered in one place.
 *
 * `index.ts` used to mount the tRPC router inline with a literal path. The refresh cookie's Path
 * named a different literal, nothing related the two, and the browser never delivered the
 * credential to the request that needed it. The mount now reads `TRPC_MOUNT_PATH`, the same
 * constant the cookie path and the client derive from, and this function is what both the server
 * and the HTTP regression (`sessionCookieTransport.http.db.test.ts`) call — so the test exercises
 * the production mounting rather than a copy of it.
 */
import express, { type Express } from "express";
import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { TRPC_MOUNT_PATH } from "@shared/const";
import { appRouter } from "../routers";
import { createContext } from "./context";
import { registerOAuthRoutes } from "./oauth";
import { allowedOriginsFromEnv, crossSiteGuard, rateLimit } from "./httpHardening";

export function registerApi(app: Express): void {
  // #19: a cross-site write to the API is refused before any parser or procedure runs.
  app.use("/api", crossSiteGuard({ allowedOrigins: allowedOriginsFromEnv(process.env) }));
  // Body limits by route. Only tRPC carries files, and the largest is an
  // evidence upload: 15 MB of bytes is 20 MB of base64, and the procedure
  // refuses anything longer. Everything else is kilobytes. The limit used to
  // be 50 MB everywhere.
  app.use(TRPC_MOUNT_PATH, express.json({ limit: "25mb" }));
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ limit: "100kb", extended: true }));
  // A floor against one client hammering sign-in, per process. See rateLimit.
  app.use("/api/oauth", rateLimit({ windowMs: 60_000, max: 60 }));
  registerOAuthRoutes(app);
  // tRPC API
  app.use(TRPC_MOUNT_PATH, createExpressMiddleware({ router: appRouter, createContext }));
}
