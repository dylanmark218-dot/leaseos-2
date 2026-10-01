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
import { organizationSelectionMiddleware } from "./organizationSelection";

export function registerApi(app: Express): void {
  // Configure body parser with larger size limit for file uploads
  app.use(express.json({ limit: "50mb" }));
  app.use(express.urlencoded({ limit: "50mb", extended: true }));
  registerOAuthRoutes(app);
  // v23.26 (#64) — the request's claimed organization, in scope for the whole handler. It carries a
  // claim and never an authority: `resolveActingScope` checks it against the membership table on
  // every request, so a forged cookie names an organization the caller has been proved to belong to
  // or it names nothing. Registered on the mount ahead of tRPC (it runs `next` inside the scope)
  // rather than in `createContext`, because a context factory returns before any procedure runs.
  app.use(TRPC_MOUNT_PATH, organizationSelectionMiddleware);
  // tRPC API
  app.use(TRPC_MOUNT_PATH, createExpressMiddleware({ router: appRouter, createContext }));
}
