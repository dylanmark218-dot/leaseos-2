/**
 * The one door out of the server for a URL that a person typed.
 *
 * Two procedures took a URL from a user and handed it straight to `fetch()`:
 * `facilityDirectory.arcgis.{inspect,importFromLayer}` and webhook delivery
 * (`integration.webhookSubscribe` stores it, the dispatcher POSTs to it). Both
 * let anyone holding the permission point the server at whatever it can reach
 * that the internet cannot — loopback admin ports, the database host, a cloud
 * metadata endpoint at 169.254.169.254. The permission gate is who may ask; it
 * says nothing about where the request goes.
 *
 * What this module refuses, and why each is here:
 *
 * - **Anything but https on 443.** No plain http, no other ports, no userinfo
 *   in the URL. Every legitimate destination we have is a public TLS endpoint.
 * - **Private, loopback, link-local, CGNAT, multicast, reserved and
 *   documentation ranges**, IPv4 and IPv6, including IPv4-mapped and NAT64
 *   IPv6 forms, which otherwise smuggle 127.0.0.1 past a v4-only check.
 * - **DNS rebinding.** Checking a name and then letting `fetch` resolve it
 *   again is a race the attacker's DNS server wins. So the check happens
 *   *inside* the socket's own `lookup`: the address that is checked is the
 *   address that is connected to. If any address a name resolves to is
 *   forbidden, the name is refused, so round-robin does not help either.
 * - **Redirects.** Never followed. A 3xx is returned as a status, which every
 *   caller already treats as a failure. A redirect to an internal host is the
 *   classic way around a check that only looked at the first URL.
 * - **Unbounded responses and hung peers.** A byte cap and a wall-clock
 *   timeout, both per request.
 *
 * `LEASEOS_OUTBOUND_ALLOWED_HOSTS` (comma-separated) optionally narrows this
 * further to named hosts and their subdomains. It never widens it: an
 * allowlisted name that resolves to a private address is still refused.
 *
 * This is the application-layer control. It is not a substitute for an egress
 * policy at the network layer, and a deployment should have both.
 */
import { lookup as dnsLookup } from "node:dns";
import https from "node:https";
import net from "node:net";
import type { LookupAddress } from "node:dns";

export class OutboundRefused extends Error {
  constructor(public readonly reason: string) {
    super(`Outbound request refused: ${reason}`);
    this.name = "OutboundRefused";
  }
}

const blocked = new net.BlockList();
for (const [addr, prefix] of [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // RFC1918
  ["100.64.0.0", 10], // CGNAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local, including cloud metadata
  ["172.16.0.0", 12], // RFC1918
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // TEST-NET-1
  ["192.88.99.0", 24], // 6to4 relay anycast
  ["192.168.0.0", 16], // RFC1918
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // TEST-NET-2
  ["203.0.113.0", 24], // TEST-NET-3
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, including broadcast
] as const) blocked.addSubnet(addr, prefix, "ipv4");
for (const [addr, prefix] of [
  // No ::ffff:0:0/96 rule. BlockList already checks an IPv4-mapped address
  // against the IPv4 rules above (the tests pin ::ffff:127.0.0.1), and it also
  // matches every plain IPv4 address against a mapped subnet, so adding that
  // rule would refuse the whole IPv4 internet.
  ["::", 128], // unspecified
  ["::1", 128], // loopback
  ["64:ff9b::", 96], // NAT64 well-known prefix
  ["64:ff9b:1::", 48], // NAT64 local-use
  ["100::", 64], // discard-only
  ["2001::", 32], // Teredo
  ["2001:db8::", 32], // documentation
  ["2002::", 16], // 6to4 — embeds an arbitrary IPv4 address
  ["fc00::", 7], // unique local
  ["fe80::", 10], // link-local
  ["fec0::", 10], // deprecated site-local
  ["ff00::", 8], // multicast
] as const) blocked.addSubnet(addr, prefix, "ipv6");

/** Why an address may not be contacted, or null when it may. */
export function forbiddenAddressReason(address: string): string | null {
  const family = net.isIP(address);
  if (family === 0) return `"${address}" is not an IP address`;
  if (blocked.check(address, family === 4 ? "ipv4" : "ipv6")) return `${address} is in a private, loopback, link-local or reserved range`;
  return null;
}

export function allowedHostsFromEnv(env: Record<string, string | undefined> = process.env): string[] | null {
  const raw = env.LEASEOS_OUTBOUND_ALLOWED_HOSTS?.trim();
  if (!raw) return null;
  return raw.split(",").map(h => h.trim().toLowerCase().replace(/^\*\./, "")).filter(Boolean);
}

/**
 * Static checks on a URL, before any network activity. Safe to call at the
 * moment a person saves a destination, so they hear about a bad one then rather
 * than on the first failed delivery.
 */
export function validateOutboundUrl(raw: string, opts: { allowedHosts?: string[] | null } = {}): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new OutboundRefused("not a valid URL");
  }
  if (url.protocol !== "https:") throw new OutboundRefused("only https destinations are allowed");
  if (url.username || url.password) throw new OutboundRefused("credentials in the URL are not allowed");
  if (url.port && url.port !== "443") throw new OutboundRefused("only port 443 is allowed");
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!host) throw new OutboundRefused("the URL has no host");
  if (net.isIP(host)) {
    const why = forbiddenAddressReason(host);
    if (why) throw new OutboundRefused(why);
  } else if (host === "localhost" || host.endsWith(".localhost")) {
    throw new OutboundRefused("localhost is not an allowed destination");
  }
  const allowed = opts.allowedHosts === undefined ? allowedHostsFromEnv() : opts.allowedHosts;
  if (allowed && !allowed.some(a => host === a || host.endsWith(`.${a}`))) {
    throw new OutboundRefused(`${host} is not on LEASEOS_OUTBOUND_ALLOWED_HOSTS`);
  }
  return url;
}

type Resolver = (hostname: string, cb: (err: NodeJS.ErrnoException | null, addresses: LookupAddress[]) => void) => void;
const systemResolver: Resolver = (hostname, cb) => dnsLookup(hostname, { all: true, verbatim: true }, cb);

/**
 * A `lookup` for `https.request` that refuses forbidden addresses. It is the
 * socket's own resolution, so there is no gap between the check and the
 * connect for a rebinding DNS server to use.
 */
export function guardedLookup(resolver: Resolver = systemResolver): net.LookupFunction {
  return ((hostname: string, options: { all?: boolean } | number | undefined, callback: (...args: unknown[]) => void) => {
    const cb = typeof options === "function" ? (options as typeof callback) : callback;
    const wantAll = typeof options === "object" && options !== null && options.all === true;
    resolver(hostname, (err, addresses) => {
      if (err) return cb(err);
      if (!addresses.length) return cb(new OutboundRefused(`${hostname} did not resolve`));
      for (const a of addresses) {
        const why = forbiddenAddressReason(a.address);
        if (why) return cb(new OutboundRefused(`${hostname} resolves to ${why}`));
      }
      if (wantAll) return cb(null, addresses);
      return cb(null, addresses[0]!.address, addresses[0]!.family);
    });
  }) as unknown as net.LookupFunction;
}

export type OutboundResponse = { status: number; headers: Record<string, string>; body: string };

export type OutboundRequest = {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: string;
  /** Wall-clock limit for the whole exchange. */
  timeoutMs?: number;
  /** Response bytes beyond this abort the request. */
  maxResponseBytes?: number;
  allowedHosts?: string[] | null;
  /** Tests only: resolve names without the network. */
  resolver?: Resolver;
};

/**
 * Make one request to a user-supplied destination under the policy above.
 * Throws `OutboundRefused` for a policy refusal, and ordinary errors for
 * network failures, timeouts and oversize responses.
 */
export async function outboundRequest(req: OutboundRequest): Promise<OutboundResponse> {
  const url = validateOutboundUrl(req.url, { allowedHosts: req.allowedHosts });
  const timeoutMs = req.timeoutMs ?? 15_000;
  const maxBytes = req.maxResponseBytes ?? 5 * 1024 * 1024;
  return new Promise<OutboundResponse>((resolve, reject) => {
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const r = https.request(
      url,
      {
        method: req.method ?? "GET",
        headers: { ...(req.headers ?? {}), ...(req.body !== undefined ? { "content-length": String(Buffer.byteLength(req.body)) } : {}) },
        lookup: guardedLookup(req.resolver),
        // No connection reuse: a pooled socket was checked for some other request.
        agent: false,
      },
      res => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          size += c.length;
          if (size > maxBytes) {
            r.destroy();
            finish(() => reject(new Error(`Response exceeded ${maxBytes} bytes`)));
            return;
          }
          chunks.push(c);
        });
        res.on("end", () => {
          const headers: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) headers[k] = Array.isArray(v) ? v.join(", ") : v;
          finish(() => resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString("utf8") }));
        });
        res.on("error", e => finish(() => reject(e)));
      }
    );
    const timer = setTimeout(() => {
      r.destroy();
      finish(() => reject(new Error(`No complete response within ${timeoutMs} ms`)));
    }, timeoutMs);
    r.on("error", e => finish(() => reject(e)));
    if (req.body !== undefined) r.write(req.body);
    r.end();
  });
}

/** GET a JSON document from a user-supplied destination. A non-2xx status is returned, not thrown, so callers keep their own error wording. */
export async function outboundJson<T>(url: string, opts: Omit<OutboundRequest, "url" | "method" | "body"> = {}): Promise<{ ok: boolean; status: number; json: () => T }> {
  const res = await outboundRequest({ ...opts, url, method: "GET", headers: { accept: "application/json", ...(opts.headers ?? {}) } });
  return { ok: res.status >= 200 && res.status < 300, status: res.status, json: () => JSON.parse(res.body) as T };
}
