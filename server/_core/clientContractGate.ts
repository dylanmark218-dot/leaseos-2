/**
 * HS5 — the contract gate in front of /api/trpc.
 *
 * Reads the contract an installed client declares (`shared/clientContract.ts`)
 * and refuses, with 426 Upgrade Required, a request that client may not make:
 * a retired or future major, a garbled header, a platform/shell pair that no
 * build ships, or — for a drain-only install — anything but handing over the
 * work it already holds.
 *
 * This is a compatibility control, not an authorization control. The website
 * sends no header (it is served by this server and cannot be out of date with
 * it), so a request without one passes through to the ordinary authentication
 * and permission checks, which decide everything they always decided.
 */

import type { NextFunction, Request, Response } from "express";
import {
  CLIENT_HEADER,
  CONTRACT_HEADER,
  SERVER_SUPPORTED_CONTRACTS,
  SUPPORTED_CONTRACT_HEADER,
  formatSupportedContracts,
  negotiateContract,
  parseClientIdentity,
  procedureAllowed,
  type ContractNegotiation,
  type SupportedContracts,
} from "@shared/clientContract";

export type ContractGateDecision =
  | { allow: true; negotiation: ContractNegotiation }
  | { allow: false; status: 426; outcome: string; message: string };

/** tRPC puts the procedure path(s) in the URL: `/a.b` or, batched, `/a.b,c.d`. */
export function trpcPathsFromUrlPath(urlPath: string): string[] {
  const trimmed = urlPath.replace(/^\/+/, "").split("?")[0];
  return trimmed ? trimmed.split(",").map(p => decodeURIComponent(p)).filter(Boolean) : [];
}

export function contractGateDecision(
  headers: { contract: string | undefined; client: string | undefined },
  procedurePaths: string[],
  supported: SupportedContracts = SERVER_SUPPORTED_CONTRACTS,
): ContractGateDecision {
  const negotiation = negotiateContract(headers.contract, supported, { unversionedAllowed: true });
  if (negotiation.access === "none") {
    return { allow: false, status: 426, outcome: negotiation.outcome, message: refusalMessage(negotiation) };
  }
  // An installed shell that declares a contract must also say what it is.
  if (negotiation.outcome !== "unversioned" && !parseClientIdentity(headers.client)) {
    return { allow: false, status: 426, outcome: "malformed_client", message: `${CLIENT_HEADER} must be "<platform>/<shell>/<appVersion>" for a platform and shell LeaseOS ships` };
  }
  if (negotiation.access === "drain_only") {
    const blocked = procedurePaths.filter(p => !procedureAllowed("drain_only", p));
    if (blocked.length > 0 || procedurePaths.length === 0) {
      return { allow: false, status: 426, outcome: "drain_only", message: `This version of the app can only send work it already holds. Update to continue (refused: ${blocked.join(", ") || "no procedure"}).` };
    }
  }
  return { allow: true, negotiation };
}

function refusalMessage(n: ContractNegotiation): string {
  switch (n.outcome) {
    case "client_upgrade_required": return "This version of the app is no longer supported. Update to continue.";
    case "server_upgrade_required": return "This app is newer than the LeaseOS server it is connected to.";
    case "malformed": return `${CONTRACT_HEADER} must be "<major>.<minor>"`;
    default: return "Client contract refused";
  }
}

function headerValue(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

/** Mount before the tRPC middleware on the same prefix. */
export function clientContractGate(supported: SupportedContracts = SERVER_SUPPORTED_CONTRACTS) {
  const advertised = formatSupportedContracts(supported);
  return (req: Request, res: Response, next: NextFunction) => {
    res.setHeader(SUPPORTED_CONTRACT_HEADER, advertised);
    const decision = contractGateDecision(
      { contract: headerValue(req.headers[CONTRACT_HEADER]), client: headerValue(req.headers[CLIENT_HEADER]) },
      trpcPathsFromUrlPath(req.path),
      supported,
    );
    if (decision.allow) return next();
    res.status(decision.status).json({ error: { code: "CONTRACT_REFUSED", outcome: decision.outcome, message: decision.message, supported: advertised } });
  };
}
