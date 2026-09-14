/**
 * Commercial projects — the engines.
 *
 * A quote's acceptance is refused if it is not issued, has expired, was
 * superseded, or the hash the customer saw is not the hash on file. A
 * change order is authorized within a signatory's extra-work limit, recorded
 * as exceeding it, or unknown when no authority is on file — never assumed.
 * A forecast is arithmetic over what was quoted, authorized, billed and
 * collected; forecast-at-completion exists only when a person has stated
 * how complete the work is.
 */

export type Authority = { extraWorkLimitCents: number | null; mayAcceptQuotes: boolean; mayAnswerRfis: boolean; status: "active" | "revoked"; validTo: Date | null } | null;

export function quoteAcceptanceDecision(args: { status: string; validUntil: Date | null; snapshotHashOnFile: string | null; snapshotHashSeen: string; authority: Authority; at: Date }): { permitted: boolean; refusals: string[]; withinAuthority: "yes" | "no" | "unknown" } {
  const r: string[] = [];
  if (args.status !== "issued") r.push(`Quote is ${args.status} — only an issued quote is accepted`);
  if (args.validUntil && args.at > args.validUntil) r.push(`Quote expired ${args.validUntil.toISOString().slice(0, 10)}`);
  if (!args.snapshotHashOnFile || args.snapshotHashOnFile !== args.snapshotHashSeen) r.push("The quote changed since it was presented — present it again");
  const active = args.authority && args.authority.status === "active" && (!args.authority.validTo || args.at <= args.authority.validTo);
  const within: "yes" | "no" | "unknown" = !args.authority ? "unknown" : active && args.authority.mayAcceptQuotes ? "yes" : "no";
  if (within === "no") r.push("This signatory does not hold the authority to accept quotes for the account");
  return { permitted: r.length === 0, refusals: r, withinAuthority: within };
}

export function changeOrderAuthority(args: { estimatedCents: number; authority: Authority; at: Date }): { withinAuthority: "yes" | "no" | "unknown"; detail: string } {
  const a = args.authority;
  if (!a) return { withinAuthority: "unknown", detail: "No signatory authority on file — recorded as exercised, for the office to review" };
  if (a.status !== "active" || (a.validTo && args.at > a.validTo)) return { withinAuthority: "no", detail: "Signatory authority is revoked or expired" };
  if (a.extraWorkLimitCents == null) return { withinAuthority: "no", detail: "Signatory holds no extra-work authority" };
  if (args.estimatedCents > a.extraWorkLimitCents) return { withinAuthority: "no", detail: `${fmt(args.estimatedCents)} exceeds the signatory's ${fmt(a.extraWorkLimitCents)} limit — authorized above authority; the office confirms with the customer` };
  return { withinAuthority: "yes", detail: `Within the signatory's ${fmt(a.extraWorkLimitCents)} extra-work limit` };
}

export type Forecast = {
  budgetCents: number;
  quotedCents: number | null;
  authorizedChangesCents: number;
  committedCents: number | null;
  billedCents: number;
  collectedCents: number;
  varianceToBudgetCents: number | null;
  percentComplete: number | null;
  forecastAtCompletionCents: number | null;
  determination: "computed" | "partial" | "unknown";
  reasons: string[];
};

export function projectForecast(args: { budgetCents: number; quotedCents: number | null; authorizedChangesCents: number; billedCents: number; collectedCents: number; percentComplete: number | null }): Forecast {
  const reasons: string[] = [];
  const committed = args.quotedCents == null ? null : args.quotedCents + args.authorizedChangesCents;
  if (committed == null) reasons.push("No accepted quote — the committed value is unknown; change orders alone do not make a commitment");
  const variance = committed == null ? null : committed - args.budgetCents;
  let fac: number | null = null;
  if (args.percentComplete == null) reasons.push("Percent complete not stated — forecast at completion is unknown");
  else if (args.percentComplete <= 0) reasons.push("Percent complete is zero — forecast at completion is unknown");
  else fac = Math.round(args.billedCents / (args.percentComplete / 100));
  if (args.collectedCents > args.billedCents) reasons.push(`Collected ${fmt(args.collectedCents)} exceeds billed ${fmt(args.billedCents)} — REVIEW`);
  return { budgetCents: args.budgetCents, quotedCents: args.quotedCents, authorizedChangesCents: args.authorizedChangesCents, committedCents: committed, billedCents: args.billedCents, collectedCents: args.collectedCents, varianceToBudgetCents: variance, percentComplete: args.percentComplete, forecastAtCompletionCents: fac, determination: reasons.length === 0 ? "computed" : committed != null || fac != null ? "partial" : "unknown", reasons };
}

const fmt = (c: number) => `$${(c / 100).toFixed(2)}`;
