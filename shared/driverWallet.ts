/**
 * The Driver Wallet's offline freshness rule, shared by the server and the
 * mobile client so both run the same code.
 *
 * The wallet is cached on the phone and read without coverage. The server says
 * how long its answer holds (`validUntil`: the earlier of the offline allowance
 * and the first expiry of a required credential that was satisfied). Past that
 * moment a cached BASELINE MET or ACTION REQUIRED is not an answer any more, and
 * it reads STALE until the phone reconnects. NOT READY stays NOT READY: time
 * passing never makes a driver more ready.
 *
 * BASELINE MET is about the company's own baseline only. It is never a
 * dispatch authorization: a particular job can need more (a client's, a site's
 * or the equipment's requirements, medical fitness, hours of service, the
 * vehicle), and dispatch's readiness decides that job. The wallet says so in
 * its contract (`grantsDispatch: false`).
 */

export type WalletHeadline = "BASELINE MET" | "ACTION REQUIRED" | "NOT READY";

/** What the wallet's headline does not evaluate; dispatch readiness does, for each job. */
export const WALLET_NOT_COVERED = [
  "job, client, site and equipment requirements",
  "medical fitness",
  "hours of service",
  "vehicle and trailer readiness",
] as const;
export const WALLET_STALE = "STALE" as const;
export type WalletStatus = WalletHeadline | typeof WALLET_STALE;

const toMs = (d: Date | string) => (typeof d === "string" ? Date.parse(d) : d.getTime());

export function walletStatusAt(wallet: { headline: WalletHeadline; validUntil: Date | string }, at: Date): WalletStatus {
  if (wallet.headline === "NOT READY") return wallet.headline;
  const until = toMs(wallet.validUntil);
  // An unreadable validUntil is not a licence to keep saying READY.
  if (!Number.isFinite(until) || at.getTime() >= until) return WALLET_STALE;
  return wallet.headline;
}
