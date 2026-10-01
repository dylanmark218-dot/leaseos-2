/**
 * P0-C — serving the built client, with no edge to the build tool.
 *
 * This used to live beside `setupVite` in `./vite.ts`, which imports `vite` and `vite.config.ts`
 * (and through it every Vite plugin). The production entrypoint imported that module for this
 * one function, so `dist/index.js` carried static imports of five devDependencies and refused to
 * boot anywhere only `dependencies` were installed — `ERR_MODULE_NOT_FOUND: Cannot find package
 * 'vite'`. Serving already-built files needs Express and the filesystem, nothing else, so it has
 * its own module and the Vite module is reached only from the development entrypoint.
 * `productionDependencyBoundary.test.ts` and `scripts/prod-runtime-smoke.sh` keep it that way.
 */
import express, { type Express } from "express";
import fs from "fs";
import path from "path";

export function serveStatic(app: Express) {
  const distPath =
    process.env.NODE_ENV === "development"
      ? path.resolve(import.meta.dirname, "../..", "dist", "public")
      : path.resolve(import.meta.dirname, "public");
  if (!fs.existsSync(distPath)) {
    console.error(
      `Could not find the build directory: ${distPath}, make sure to build the client first`
    );
  }

  app.use(express.static(distPath));

  // fall through to index.html if the file doesn't exist
  app.use("*", (_req, res) => {
    res.sendFile(path.resolve(distPath, "index.html"));
  });
}
