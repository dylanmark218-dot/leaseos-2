/**
 * A minimal stand-in for the Forge object store, so the REAL upload path can run
 * against a live server.
 *
 * `server/storage.ts` has no local mode: it presigns against
 * `v1/storage/presign/put`, PUTs the bytes to the URL it is handed, and presigns
 * `v1/storage/presign/get` to read them back. This serves exactly those three
 * shapes and keeps the bytes in memory, which is what the unit suites achieve by
 * mocking the module — a mock cannot help a server in another process.
 *
 * It is a test double for storage only. It makes no authorization decision: the
 * bearer token is accepted without inspection, precisely so that nothing here can
 * accidentally stand in for the tenant boundary being measured.
 */
import { createServer } from "node:http";

const objects = new Map();
const PORT = Number(process.argv[2]);

createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  if (url.pathname.endsWith("/v1/storage/presign/put") || url.pathname.endsWith("/v1/storage/presign/get")) {
    const key = url.searchParams.get("key") ?? url.searchParams.get("path") ?? "";
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ url: `http://127.0.0.1:${PORT}/object?key=${encodeURIComponent(key)}` }));
    return;
  }

  if (url.pathname === "/object") {
    const key = url.searchParams.get("key") ?? "";
    if (req.method === "PUT") {
      const chunks = [];
      req.on("data", c => chunks.push(c));
      req.on("end", () => { objects.set(key, Buffer.concat(chunks)); res.writeHead(200).end("ok"); });
      return;
    }
    const body = objects.get(key);
    if (!body) { res.writeHead(404).end("no such object"); return; }
    res.writeHead(200, { "content-type": "application/octet-stream" }).end(body);
    return;
  }

  res.writeHead(404, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: `fake-forge: unhandled ${req.method} ${url.pathname}` }));
}).listen(PORT, "127.0.0.1", () => console.log(`fake-forge listening on ${PORT}`));
