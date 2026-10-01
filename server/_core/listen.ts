/**
 * Binding a port: what production does, what development does, and how a failure is heard.
 *
 * Two defects lived in `index.ts` and are fixed here.
 *
 * THE SILENT PORT MOVE. Startup searched for a free port and took the next one if the
 * configured port was busy. On a laptop that is a convenience; under an orchestrator it is
 * a crash loop that reports success — the container binds a port nothing routes to, the
 * readiness probe on the configured port never answers, the supervisor restarts it, and the
 * one log line explaining why is lost in a stream nobody reads during an incident. In
 * production the configured port is a contract with whatever routes to it, so it is bound
 * or the process refuses to start.
 *
 * THE UNHEARD FAILURE. `server.listen()` reports a bind failure by emitting `error` on the
 * server, not by throwing. The old code awaited a function that could not reject, so a
 * failure to bind never reached `startServer().catch` — the handler that exists precisely
 * to exit non-zero — and the process lingered with no server and a zero exit code.
 * `listenOnPort` converts that event into a rejection.
 *
 * Extracted from `index.ts` rather than fixed in place so the behaviour can be tested
 * without starting the application.
 */
import net from "node:net";
import type { Server } from "node:http";

/** Is this port free right now? Answers, never throws. */
function isPortAvailable(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const probe = net.createServer();
    probe.listen(port, () => {
      probe.close(() => resolve(true));
    });
    probe.on("error", () => resolve(false));
  });
}

/**
 * The development-only search, carried over unchanged.
 *
 * Inherently racy — it binds a probe, closes it, and returns the number, so the port can
 * be taken in between. That is acceptable for a developer's machine and is exactly why it
 * must not run in production: there, `listenOnPort` binding the real server is the only
 * check, and losing that race is a refusal to start rather than a wrong port.
 */
export async function findAvailablePort(startPort: number = 3000): Promise<number> {
  for (let port = startPort; port < startPort + 20; port++) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found starting from ${startPort}`);
}

/**
 * Which port this process will bind.
 *
 * Production returns the configured port untouched and never calls the finder — not even
 * to check it, because checking invites the fallback back in. Development keeps the search.
 */
export async function resolveListenPort(
  preferredPort: number,
  isDevelopment: boolean,
  finder: (startPort: number) => Promise<number> = findAvailablePort
): Promise<number> {
  if (!isDevelopment) return preferredPort;
  return finder(preferredPort);
}

/**
 * Bind, and resolve only once the server is actually listening.
 *
 * Both listeners are temporary and each removes the other. Leaving the `error` listener
 * attached after success would mean a later runtime error is handled by an already-settled
 * promise — silently dropped instead of reaching whatever the application installs for it.
 */
export function listenOnPort(server: Server, port: number, host?: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };

    server.once("error", onError);
    server.once("listening", onListening);

    if (host === undefined) server.listen(port);
    else server.listen(port, host);
  });
}
