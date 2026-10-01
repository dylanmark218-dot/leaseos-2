/**
 * The organization-selection cookie (#64, v23.26), issued and cleared with the same attributes.
 *
 * A browser deletes a cookie only when its name, domain and path all match the issuing ones, so the
 * write and the clear take their attributes from one place — the session cookie's, which this cookie
 * is set alongside (see ORG_SELECTION_COOKIE). Kept apart from organizationSelection.ts, which the
 * worker reaches through actingScope and which therefore must not pull in the HTTP cookie layer.
 */
import type { Request, Response } from "express";
import { ONE_YEAR_MS } from "@shared/const";
import { getSessionCookieOptions } from "./cookies";
import { ORG_SELECTION_COOKIE } from "./organizationSelection";

export function issueOrganizationSelectionCookie(req: Request, res: Response, orgRef: string): void {
  res.cookie(ORG_SELECTION_COOKIE, orgRef, { ...getSessionCookieOptions(req), maxAge: ONE_YEAR_MS });
}

export function clearOrganizationSelectionCookie(req: Request, res: Response): void {
  res.clearCookie(ORG_SELECTION_COOKIE, { ...getSessionCookieOptions(req), maxAge: -1 });
}
