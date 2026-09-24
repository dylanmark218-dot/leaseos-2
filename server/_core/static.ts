import express, { type Express } from "express";
import fs from "fs";
import path from "path";

/**
 * Serve the built client. Split out of `vite.ts` so the production server's
 * module graph never reaches Vite: `vite` and every plugin in `vite.config.ts`
 * are devDependencies, and a production install without them must still boot.
 */
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
