/**
 * Egress guard — how the server fetches a URL that somebody else chose.
 *
 * A URL a person types into a form, or a model proposes, and that the server then
 * requests, is a server-side request forgery surface: the server stands inside the
 * network, so it can reach what the person cannot — localhost services, private
 * ranges, the cloud metadata endpoint at 169.254.169.254. The regulator-layer
 * importers (`facilityDirectory.arcgis.*`) did exactly that with a bare `fetch`, and
 * the AIL-3R research-gateway design (RC-9, RI-8) wants the same rules for its
 * fetcher. They are here, once:
 *
 *   - https only, and no credentials in the URL;
 *   - a name is resolved and every address it answers is checked; loopback, private,
 *     link-local, unique-local, "this network", metadata and every other
 *     non-public range is refused, and the connection goes to the addresses that
 *     were checked, never to a second lookup;
 *   - redirects are followed by hand, and each hop is checked again from the start;
 *   - one deadline for the whole exchange, a byte ceiling, an allowed content type;
 *   - no cookies and no credentials: the request's headers are fixed here, and the
 *     caller passes a URL as data, never a fetch configuration.
 *
 * Everything in this file is pure or takes its I/O as an argument: the resolver
 * and the transport are injected, so every rule above is tested against fakes.
 * The Node resolver and https transport are in `egressHttp.ts`.
 */

export type ResolvedAddress = { address: string; family: 4 | 6 };

/** Every address a host name answers. A failure or an empty answer is "does not resolve". */
export type Resolver = (hostname: string) => Promise<ResolvedAddress[]>;

export type TransportResponse = {
  status: number;
  /** Lower-case names. */
  headers: Record<string, string | undefined>;
  body: AsyncIterable<Uint8Array>;
  /** Release the connection, whether or not the body was read. */
  close(): void;
};

/**
 * One GET. A transport connects to one of `addresses` (every one of them checked) and
 * nowhere else, sends exactly `headers`, follows no redirect, keeps no cookies, and gives
 * up when `signal` aborts.
 */
export interface EgressTransport {
  get(input: { url: URL; addresses: ResolvedAddress[]; headers: Record<string, string>; signal: AbortSignal }): Promise<TransportResponse>;
}

export type EgressEdges = { resolve: Resolver; transport: EgressTransport };

export type EgressLimits = {
  /** Milliseconds for the whole exchange: every lookup, every hop and the body. */
  timeoutMs: number;
  /** Bytes of body read from the final answer. More is refused, not truncated. */
  maxBytes: number;
  /** Redirects followed, each one checked again. One more is refused. */
  maxRedirects: number;
  /** Sent as Accept. */
  accept: string;
  /** Media types a 2xx answer may carry. Anything else, or none, is refused. */
  contentTypes: readonly string[];
};

export type EgressResponse = {
  ok: boolean;
  status: number;
  /** Where the answer came from, after redirects. */
  url: string;
  /** Every URL requested, in order; the first is the caller's. */
  hops: string[];
  contentType: string | null;
  /** The body of a 2xx answer. A non-2xx body is not read. */
  bytes: Uint8Array;
  text(): string;
  json(): unknown;
};

export type EgressRefusalCode =
  | "invalid_url" | "scheme" | "credentials_in_url" | "blocked_host" | "blocked_address" | "unresolvable"
  | "too_many_redirects" | "content_type" | "content_encoding" | "too_large" | "timeout" | "transport";

/** The destination itself is refused, as against one that answered badly or not at all. */
const DESTINATION_CODES: EgressRefusalCode[] = ["invalid_url", "scheme", "credentials_in_url", "blocked_host", "blocked_address", "unresolvable"];

/** Messages name the host or the URL the caller gave, and never an address a lookup returned. */
export class EgressRefused extends Error {
  readonly destination: boolean;
  constructor(readonly code: EgressRefusalCode, message: string) {
    super(message);
    this.name = "EgressRefused";
    this.destination = DESTINATION_CODES.indexOf(code) >= 0;
  }
}

/* ---- addresses ---- */

function parseIpv4(text: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (!m) return null;
  const parts = [m[1]!, m[2]!, m[3]!, m[4]!];
  // A leading zero means octal to some parsers and decimal to others; an address that reads two ways is refused.
  if (parts.some(p => p.length > 1 && p[0] === "0")) return null;
  const bytes = parts.map(Number);
  return bytes.every(b => b <= 255) ? bytes : null;
}

function parseIpv6(text: string): number[] | null {
  const halves = text.split("%")[0]!.split("::");
  if (halves.length > 2) return null;
  const words = (part: string, last: boolean): number[] | null => {
    if (part === "") return [];
    const out: number[] = [];
    const pieces = part.split(":");
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i]!;
      if (last && i === pieces.length - 1 && p.indexOf(".") >= 0) {
        const v4 = parseIpv4(p);
        if (!v4) return null;
        out.push((v4[0]! << 8) | v4[1]!, (v4[2]! << 8) | v4[3]!);
      } else if (/^[0-9a-f]{1,4}$/i.test(p)) out.push(parseInt(p, 16));
      else return null;
    }
    return out;
  };
  const compressed = halves.length === 2;
  const head = words(halves[0]!, !compressed);
  const tail = compressed ? words(halves[1]!, true) : [];
  if (!head || !tail) return null;
  const missing = 8 - head.length - tail.length;
  if (compressed ? missing < 1 : missing !== 0) return null;
  const all = head.concat(new Array<number>(compressed ? missing : 0).fill(0), tail);
  const bytes: number[] = [];
  for (const w of all) bytes.push(w >> 8, w & 0xff);
  return bytes;
}

/** An IP address as bytes (four or sixteen), or null when the text is not one. */
export function ipBytes(text: string): number[] | null {
  return parseIpv4(text) ?? parseIpv6(text);
}

type Range = { bytes: number[]; bits: number; why: string };
function range(cidr: string, why: string): Range {
  const [address, bits] = cidr.split("/");
  const bytes = ipBytes(address!);
  if (!bytes) throw new Error(`egressGuard: bad range ${cidr}`);
  return { bytes, bits: Number(bits), why };
}
function inRange(ip: number[], r: Range): boolean {
  if (ip.length !== r.bytes.length) return false;
  for (let i = 0, bits = r.bits; bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((ip[i]! & mask) !== (r.bytes[i]! & mask)) return false;
  }
  return true;
}

/** Most specific first, so the reason names the metadata endpoint rather than its range. */
const REFUSED_V4: Range[] = [
  range("169.254.169.254/32", "cloud metadata endpoint"),
  range("100.100.100.200/32", "cloud metadata endpoint"),
  range("0.0.0.0/8", "\"this network\" (0/8)"),
  range("10.0.0.0/8", "private network (10/8)"),
  range("100.64.0.0/10", "shared address space (100.64/10)"),
  range("127.0.0.0/8", "loopback (127/8)"),
  range("169.254.0.0/16", "link-local (169.254/16)"),
  range("172.16.0.0/12", "private network (172.16/12)"),
  range("192.0.0.0/24", "IETF protocol assignments (192.0.0/24)"),
  range("192.0.2.0/24", "documentation (192.0.2/24)"),
  range("192.88.99.0/24", "6to4 relay anycast (192.88.99/24)"),
  range("192.168.0.0/16", "private network (192.168/16)"),
  range("198.18.0.0/15", "benchmarking (198.18/15)"),
  range("198.51.100.0/24", "documentation (198.51.100/24)"),
  range("203.0.113.0/24", "documentation (203.0.113/24)"),
  range("224.0.0.0/4", "multicast (224/4)"),
  range("240.0.0.0/4", "reserved (240/4), including broadcast"),
];

/** IPv6 forms that carry an IPv4 address and reach it: judged by the address they carry. */
const CARRIES_V4: Range[] = [range("::ffff:0:0/96", "IPv4-mapped"), range("64:ff9b::/96", "NAT64")];

const REFUSED_V6: Range[] = [
  range("fd00:ec2::254/128", "cloud metadata endpoint"),
  range("::/128", "unspecified (::)"),
  range("::1/128", "loopback (::1)"),
  range("fe80::/10", "link-local (fe80::/10)"),
  range("fc00::/7", "unique-local (fc00::/7)"),
  range("fec0::/10", "site-local (fec0::/10)"),
  range("ff00::/8", "multicast (ff00::/8)"),
  range("2001::/23", "IETF protocol assignments (2001::/23), including Teredo"),
  range("2001:db8::/32", "documentation (2001:db8::/32)"),
  range("2002::/16", "6to4 (2002::/16)"),
  range("3fff::/20", "documentation (3fff::/20)"),
];

/** Outside this, an IPv6 address is not a public host. */
const GLOBAL_UNICAST = range("2000::/3", "global unicast");

/** Why an address is not fetched from, or null when it is public. Text that is not an address is refused. */
export function addressRefusal(address: string): string | null {
  const ip = ipBytes(address);
  if (!ip) return "not an IP address";
  if (ip.length === 4) return REFUSED_V4.find(r => inRange(ip, r))?.why ?? null;
  const carrier = CARRIES_V4.find(r => inRange(ip, r));
  if (carrier) {
    const inner = addressRefusal(ip.slice(12).join("."));
    return inner ? `${inner}, ${carrier.why}` : null;
  }
  const hit = REFUSED_V6.find(r => inRange(ip, r));
  if (hit) return hit.why;
  return inRange(ip, GLOBAL_UNICAST) ? null : "not a global unicast address";
}

/* ---- names and URLs ---- */

/** Special-use names that only ever lead inside. The DNS check catches the rest; these never reach it. */
const INSIDE_NAMES: [string, string][] = [
  ["localhost", "localhost"],
  ["local", "multicast DNS (.local)"],
  ["internal", "private-use domain (.internal)"],
  ["home.arpa", "home network (.home.arpa)"],
];

/** Why a host name is not fetched from without looking it up, or null. */
export function hostNameRefusal(hostname: string): string | null {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  const inside = INSIDE_NAMES.find(([suffix]) => h === suffix || h.endsWith(`.${suffix}`));
  if (inside) return inside[1];
  return h.indexOf(".") < 0 ? "a single-label name" : null;
}

/** The URL's host without IPv6 brackets or a trailing dot. */
const bareHost = (url: URL) => url.hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "");

/**
 * The checks that need no lookup: a valid https URL, no credentials, and a host that is
 * a public address or a name not reserved for the inside. Returns a copy of the URL.
 *
 * The URL parser has already normalised the host: `https://2130706433/` and
 * `https://0x7f.1/` both arrive here as 127.0.0.1.
 */
export function checkEgressUrl(target: string | URL): URL {
  let url: URL;
  try { url = new URL(String(target)); } catch { throw new EgressRefused("invalid_url", "not a valid URL"); }
  if (url.protocol !== "https:") throw new EgressRefused("scheme", `${url.protocol.replace(/:$/, "")} is not fetched; https only`);
  if (url.username || url.password) throw new EgressRefused("credentials_in_url", "a URL carrying credentials is not fetched");
  const host = bareHost(url);
  if (ipBytes(host)) {
    const why = addressRefusal(host);
    if (why) throw new EgressRefused("blocked_address", `${host} is not a public address (${why})`);
  } else {
    const why = hostNameRefusal(host);
    if (why) throw new EgressRefused("blocked_host", `${host} is not a public host name (${why})`);
  }
  return url;
}

/* ---- the exchange ---- */

const REDIRECT_STATUSES = [301, 302, 303, 307, 308];
const USER_AGENT = "LeaseOS";

/** The whole request, by construction: nothing a caller passes becomes a header, and there is no cookie or credential to attach. */
const requestHeaders = (limits: EgressLimits): Record<string, string> =>
  ({ accept: limits.accept, "accept-encoding": "identity", "user-agent": USER_AGENT });

/** `work`, or a timeout refusal once `signal` aborts — whether or not the work itself honours the signal. */
function untilDeadline<T>(work: Promise<T>, signal: AbortSignal, timeoutMs: number): Promise<T> {
  const late = () => new EgressRefused("timeout", `no complete answer within ${timeoutMs} ms`);
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) { work.catch(() => undefined); reject(late()); return; }
    const onAbort = () => reject(late());
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      v => { signal.removeEventListener("abort", onAbort); resolve(v); },
      e => { signal.removeEventListener("abort", onAbort); reject(e); },
    );
  });
}
type Within = <T>(work: Promise<T>) => Promise<T>;

/**
 * Where to connect: a literal (checked already), or every answer for a name once all of
 * them have passed. A name that answers both public and private is trusted with neither.
 * "Does not resolve" and "resolves inside" read the same, so a refusal does not map the
 * internal DNS for whoever is asking.
 */
async function connectableAddresses(url: URL, resolve: Resolver, within: Within): Promise<ResolvedAddress[]> {
  const host = bareHost(url);
  const familyOf = (address: string): 4 | 6 => (ipBytes(address)!.length === 4 ? 4 : 6);
  if (ipBytes(host)) return [{ address: host, family: familyOf(host) }];
  const notPublic = `${host} does not resolve to a public address`;
  let answers: ResolvedAddress[] = [];
  try { answers = await within(resolve(url.hostname)); } catch (e) { if (e instanceof EgressRefused) throw e; }
  if (!answers.length) throw new EgressRefused("unresolvable", notPublic);
  if (answers.some(a => addressRefusal(a.address) !== null)) throw new EgressRefused("blocked_address", notPublic);
  return answers.map(a => ({ address: a.address, family: familyOf(a.address) }));
}

function transportFailure(e: unknown, url: URL): EgressRefused {
  if (e instanceof EgressRefused) return e;
  const why = e instanceof Error && e.message ? e.message : "no reason given";
  return new EgressRefused("transport", `the request to ${url.host} failed: ${why.slice(0, 200)}`);
}

async function readBody(body: AsyncIterable<Uint8Array>, url: URL, limits: EgressLimits, within: Within): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const it = body[Symbol.asyncIterator]();
  for (;;) {
    const next = await within(it.next());
    if (next.done) break;
    total += next.value.byteLength;
    if (total > limits.maxBytes) throw new EgressRefused("too_large", `${url.host} sent more than ${limits.maxBytes} bytes`);
    chunks.push(next.value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.byteLength; }
  return out;
}

function answer(status: number, url: URL, hops: string[], contentType: string | null, bytes: Uint8Array): EgressResponse {
  const text = () => new TextDecoder("utf-8").decode(bytes);
  return { ok: status >= 200 && status <= 299, status, url: url.href, hops, contentType, bytes, text, json: () => JSON.parse(text()) as unknown };
}

/**
 * GET `target` under the rules above. Throws `EgressRefused` for a refused destination
 * (`destination` true) or an answer outside the limits; a non-2xx answer is returned
 * with `ok` false and its body unread.
 */
export async function guardedGet(target: string | URL, edges: EgressEdges, limits: EgressLimits): Promise<EgressResponse> {
  let url = checkEgressUrl(target);
  const hops: string[] = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), limits.timeoutMs);
  const within: Within = work => untilDeadline(work, controller.signal, limits.timeoutMs);
  try {
    for (;;) {
      hops.push(url.href);
      const addresses = await connectableAddresses(url, edges.resolve, within);
      const from = url;
      const res = await within(edges.transport.get({ url, addresses, headers: requestHeaders(limits), signal: controller.signal }).catch((e: unknown) => { throw transportFailure(e, from); }));
      try {
        const location = REDIRECT_STATUSES.indexOf(res.status) >= 0 ? res.headers["location"] : undefined;
        if (location !== undefined) {
          if (hops.length > limits.maxRedirects) throw new EgressRefused("too_many_redirects", `more than ${limits.maxRedirects} redirects from ${hops[0]}`);
          let next: URL;
          try { next = new URL(location, url); } catch { throw new EgressRefused("invalid_url", `a redirect from ${url.host} names no valid URL`); }
          url = checkEgressUrl(next);
          continue;
        }
        const contentType = res.headers["content-type"] ?? null;
        if (res.status < 200 || res.status > 299) return answer(res.status, url, hops, contentType, new Uint8Array(0));
        const media = (contentType ?? "").split(";")[0]!.trim().toLowerCase();
        if (limits.contentTypes.indexOf(media) < 0) throw new EgressRefused("content_type", `${url.host} answered ${media || "with no content type"}; expected ${limits.contentTypes.join(" or ")}`);
        const encoding = (res.headers["content-encoding"] ?? "identity").trim().toLowerCase();
        if (encoding !== "identity") throw new EgressRefused("content_encoding", `${url.host} answered ${encoding}-encoded when asked for identity`);
        if (Number(res.headers["content-length"]) > limits.maxBytes) throw new EgressRefused("too_large", `${url.host} declared more than ${limits.maxBytes} bytes`);
        return answer(res.status, url, hops, contentType, await readBody(res.body, url, limits, within));
      } finally {
        res.close();
      }
    }
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

/* ---- POST ---- */

/**
 * Delivering to a URL somebody else chose — the webhook case.
 *
 * `integration.webhookSubscribe` takes a destination from a tenant administrator and the
 * dispatcher POSTs to it, retrying six times over about fifteen hours. Until this existed it
 * did that with a bare `fetch`, so the permission decided who could ask and nothing decided
 * where the request went: a subscription pointed at 169.254.169.254 or a loopback admin port
 * was delivered to, repeatedly. The URL check at subscribe time was `https://` and nothing
 * more, and a check there could not have been enough anyway — a name resolves again at send
 * time, hours later.
 *
 * This is deliberately a SMALLER operation than `guardedGet`, not a bigger one. Same host and
 * address rules, same resolve-then-pin, same single deadline; and then three things it does
 * not do:
 *
 *   - **No redirects.** Following one would re-send a body signed for the first destination
 *     to a second host, and re-checking the hop would not undo that. A 3xx comes back as its
 *     status, which every caller already treats as a failed delivery.
 *   - **The answer's body is never read**, only closed. The caller needs the status; reading
 *     would put an internal service's response bytes inside this process for no purpose.
 *   - **No content-type, encoding or size rules**, because nothing is read to apply them to.
 *
 * Headers are the one thing a caller supplies, because a delivery has to carry its signature.
 * They are names and values only — never a fetch configuration — and the names that would let
 * a caller redirect the request, reuse a connection or attach a credential are refused rather
 * than quietly overwritten.
 */
export interface EgressPostTransport {
  post(input: { url: URL; addresses: ResolvedAddress[]; headers: Record<string, string>; body: string; signal: AbortSignal }): Promise<TransportResponse>;
}

export type EgressPostEdges = { resolve: Resolver; transport: EgressPostTransport };

/** What a delivery answered. There is no body here on purpose. */
export type EgressPostResult = { ok: boolean; status: number; url: string };

/*
 * Names the guard sets itself, or that would change where the request goes or what it carries
 * as proof of identity. A caller passing one is a mistake worth a refusal: silently dropping it
 * would ship a delivery that looks signed and is not, or one the caller believes is scoped and
 * is not.
 */
const RESERVED_POST_HEADERS = [
  "host", "connection", "content-length", "transfer-encoding", "accept-encoding", "upgrade", "te", "trailer",
  "cookie", "set-cookie", "authorization", "proxy-authorization", "proxy-connection",
];

function postHeaders(caller: Record<string, string>, contentLength: number): Record<string, string> {
  const out: Record<string, string> = { "user-agent": USER_AGENT, "accept-encoding": "identity", "content-length": String(contentLength) };
  for (const [rawName, value] of Object.entries(caller)) {
    const name = rawName.toLowerCase();
    // A name or value carrying CR or LF splits one request into two at the socket.
    if (!/^[a-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) throw new EgressRefused("transport", `header name ${JSON.stringify(rawName)} is not a header name`);
    if (RESERVED_POST_HEADERS.indexOf(name) >= 0) throw new EgressRefused("transport", `header ${name} is set by the egress guard and may not be supplied`);
    if (/[\r\n]/.test(value)) throw new EgressRefused("transport", `header ${name} carries a line break`);
    out[name] = value;
  }
  return out;
}

/**
 * POST `body` to `target` under the rules above. Throws `EgressRefused` for a refused
 * destination (`destination` true) or a request that did not complete; any answer that
 * arrives is returned with its status, `ok` only for 2xx.
 */
export async function guardedPost(
  target: string | URL,
  edges: EgressPostEdges,
  options: { body: string; headers?: Record<string, string>; timeoutMs: number },
): Promise<EgressPostResult> {
  const url = checkEgressUrl(target);
  const bytes = new TextEncoder().encode(options.body).byteLength;
  const headers = postHeaders(options.headers ?? {}, bytes);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  const within: Within = work => untilDeadline(work, controller.signal, options.timeoutMs);
  try {
    const addresses = await connectableAddresses(url, edges.resolve, within);
    const res = await within(
      edges.transport.post({ url, addresses, headers, body: options.body, signal: controller.signal })
        .catch((e: unknown) => { throw transportFailure(e, url); }),
    );
    // Closed without reading. The status is the whole answer.
    res.close();
    return { ok: res.status >= 200 && res.status <= 299, status: res.status, url: url.href };
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}
