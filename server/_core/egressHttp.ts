/**
 * The Node edge of the egress guard: the system resolver, and one https GET that
 * connects to the address the guard checked.
 *
 * The pinning is the point. The guard resolves a name and checks every answer; if
 * the socket then asked DNS again, a name with a short TTL could answer public for
 * the check and 169.254.169.254 for the connection. So the socket's `lookup` does
 * not look anything up: it hands back the checked addresses — all of them, so Node
 * can still fall back from one address family to the other as it would for a plain
 * fetch. TLS still verifies the certificate against the URL's host name, so pinning
 * cannot talk to the wrong server quietly either.
 *
 * Nothing else is added: no shared agent (so no socket pooled from an earlier
 * request), no cookie jar, no redirect following. The rules themselves are in
 * `egressGuard.ts`.
 */
import { lookup } from "node:dns/promises";
import { request } from "node:https";
import type { LookupFunction } from "node:net";
import {
  guardedGet, guardedPost,
  type EgressLimits, type EgressPostResult, type EgressPostTransport, type EgressResponse, type EgressTransport, type Resolver,
} from "./egressGuard";

export const systemResolver: Resolver = async hostname =>
  (await lookup(hostname, { all: true })).map(a => ({ address: a.address, family: a.family === 6 ? 6 : 4 }));

export const httpsTransport: EgressTransport = {
  get: ({ url, addresses, headers, signal }) => new Promise((resolve, reject) => {
    const pinned: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, addresses.map(a => ({ address: a.address, family: a.family })));
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    };
    const req = request(url, { method: "GET", headers, agent: false, lookup: pinned, signal }, res => {
      // The guard reads the body or closes it; an abort after that must not surface as an uncaught stream error.
      res.on("error", () => undefined);
      const flat: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(res.headers)) flat[name] = Array.isArray(value) ? value.join(", ") : value;
      resolve({ status: res.statusCode ?? 0, headers: flat, body: res, close: () => { res.destroy(); } });
    });
    req.on("error", reject);
    req.end();
  }),
};

/** A guarded GET over the real network. */
export const egressGet = (target: string | URL, limits: EgressLimits): Promise<EgressResponse> =>
  guardedGet(target, { resolve: systemResolver, transport: httpsTransport }, limits);

/*
 * The same pinning for a delivery. `httpsTransport` above and this one differ only in the
 * method and the body: the `lookup` still hands back the addresses the guard checked, the
 * agent is still off so no socket is reused from an earlier request, and nothing follows a
 * redirect. Written as its own object rather than a method on the first so that a caller
 * holding a GET transport cannot POST with it by accident.
 */
export const httpsPostTransport: EgressPostTransport = {
  post: ({ url, addresses, headers, body, signal }) => new Promise((resolve, reject) => {
    const pinned: LookupFunction = (_hostname, options, callback) => {
      if (options.all) callback(null, addresses.map(a => ({ address: a.address, family: a.family })));
      else callback(null, addresses[0]!.address, addresses[0]!.family);
    };
    const req = request(url, { method: "POST", headers, agent: false, lookup: pinned, signal }, res => {
      // The guard closes this without reading it; an abort must not surface as an uncaught stream error.
      res.on("error", () => undefined);
      const flat: Record<string, string | undefined> = {};
      for (const [name, value] of Object.entries(res.headers)) flat[name] = Array.isArray(value) ? value.join(", ") : value;
      resolve({ status: res.statusCode ?? 0, headers: flat, body: res, close: () => { res.destroy(); } });
    });
    req.on("error", reject);
    req.end(body);
  }),
};

/** A guarded POST over the real network. */
export const egressPost = (target: string | URL, options: { body: string; headers?: Record<string, string>; timeoutMs: number }): Promise<EgressPostResult> =>
  guardedPost(target, { resolve: systemResolver, transport: httpsPostTransport }, options);
