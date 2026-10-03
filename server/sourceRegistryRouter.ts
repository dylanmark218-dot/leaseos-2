/**
 * The approved external source registry (0233) — the reviewer's and administrator's surface.
 *
 * Each procedure is its own permission (`source.*` in recordsAuthorization): reading, proposing a source,
 * editing an endpoint, binding a credential reference, and each decision — reject, approve, suspend,
 * revoke — so the person who proposes or edits a source is never, by permission alone, the person who
 * authorises it; and the service refuses an approver who requested the approval or made the revision.
 *
 * Every mutation names the version it read (`expectedRowVersion`) and a reason. Nothing here returns a
 * credential: an endpoint reports whether one is bound, and the credential store alone resolves it.
 * No procedure here contacts a source; the runtime gateway is `registryGet` in the service.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { roleProcedure, router } from "./_core/trpc";
import {
  ENDPOINT_AUTH_SCHEMES, ENDPOINT_CONTENT_TYPES, ENDPOINT_METHODS, ENDPOINT_PATH_MATCHES, ENDPOINT_SERVICE_TYPES, REGISTRY_PURPOSES,
  RISK_CLASSES, SENSITIVITY_CLASSES, SOURCE_CLASSES,
} from "./_core/sourceRegistry";
import { externalDataSources } from "../drizzle/schema";
import * as reg from "./sourceRegistryService";

const toTrpc = (e: unknown): unknown => {
  if (!(e instanceof reg.SourceRegistryError)) return e;
  const code = e.code === "not_found" ? "NOT_FOUND"
    : e.code === "conflict" ? "CONFLICT"
    : e.code === "separation_of_duties" ? "FORBIDDEN"
    : e.code === "invalid" ? "BAD_REQUEST"
    : "PRECONDITION_FAILED";
  return new TRPCError({ code, message: `Source registry: ${e.message}` });
};
async function run<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (e) { throw toTrpc(e); }
}

const SOURCE_KEY = z.string().regex(/^[a-z][a-z0-9_]{1,59}$/, "lower_snake, 2–60 characters");
const ENDPOINT_KEY = z.string().regex(/^[a-z][a-z0-9_]{1,79}$/, "lower_snake, 2–80 characters");
const VERSION = z.number().int().min(1);
/** Why — every change carries one, and it lands in the source's event history. */
const REASON = z.string().trim().min(10).max(1000);
const URL_TEXT = z.string().url().max(600).nullable().optional();
const PERMITTED = z.enum(["yes", "no", "unknown"]);
const CATEGORY = z.enum(externalDataSources.category.enumValues);

const sourceFields = {
  displayName: z.string().trim().min(3).max(220),
  authority: z.string().trim().min(3).max(220),
  category: CATEGORY,
  jurisdiction: z.string().max(80).nullable().optional(),
  sourceUrl: URL_TEXT,
  termsUrl: URL_TEXT,
  sourceClass: z.enum(SOURCE_CLASSES).nullable().optional(),
  riskClass: z.enum(RISK_CLASSES).nullable().optional(),
  sensitivity: z.enum(SENSITIVITY_CLASSES).nullable().optional(),
  licenceName: z.string().max(180).nullable().optional(),
  licenceUrl: URL_TEXT,
  attributionText: z.string().max(600).nullable().optional(),
  commercialUsePermitted: PERMITTED.optional(),
  redistributionPermitted: PERMITTED.optional(),
  notes: z.string().max(4000).nullable().optional(),
};

const endpointFields = {
  displayName: z.string().trim().min(3).max(200),
  serviceType: z.enum(ENDPOINT_SERVICE_TYPES),
  httpMethod: z.enum(ENDPOINT_METHODS),
  baseUrl: z.string().max(1024),
  pathMatch: z.enum(ENDPOINT_PATH_MATCHES),
  authScheme: z.enum(ENDPOINT_AUTH_SCHEMES),
  contentTypes: z.array(z.enum(ENDPOINT_CONTENT_TYPES)).min(1).max(ENDPOINT_CONTENT_TYPES.length),
  timeoutMs: z.number().int().nullable(),
  maxBytes: z.number().int().nullable(),
  enabled: z.boolean(),
};

export const sourceRegistryRouter = router({
  list: roleProcedure("sourceRegistry.list").query(() => run(() => reg.listSources())),
  get: roleProcedure("sourceRegistry.get").input(z.object({ sourceKey: SOURCE_KEY })).query(({ input }) => run(() => reg.getSource(input.sourceKey))),
  health: roleProcedure("sourceRegistry.health").input(z.object({ sourceKey: SOURCE_KEY.optional() }).optional())
    .query(({ input }) => run(() => reg.health(input?.sourceKey))),

  /** Insert the repository's seeds that the database lacks. Changes no existing row; approves nothing. */
  seed: roleProcedure("sourceRegistry.seed").mutation(() => run(() => reg.seedRegistry())),

  create: roleProcedure("sourceRegistry.create")
    .input(z.object({ sourceKey: SOURCE_KEY, ...sourceFields, reason: REASON }))
    .mutation(({ ctx, input }) => run(() => { const { reason, ...source } = input; return reg.createSource({ userId: ctx.user.id }, source, reason); })),
  update: roleProcedure("sourceRegistry.update")
    .input(z.object({ sourceKey: SOURCE_KEY, expectedRowVersion: VERSION, patch: z.object(sourceFields).partial(), reason: REASON }))
    .mutation(({ ctx, input }) => run(() => reg.updateSource({ userId: ctx.user.id }, input.sourceKey, input.expectedRowVersion, input.patch, input.reason))),

  endpointAdd: roleProcedure("sourceRegistry.endpointAdd")
    .input(z.object({ sourceKey: SOURCE_KEY, expectedRowVersion: VERSION, endpointKey: ENDPOINT_KEY, ...endpointFields, reason: REASON }))
    .mutation(({ ctx, input }) => run(() => {
      const { sourceKey, expectedRowVersion, reason, ...edit } = input;
      return reg.addEndpoint({ userId: ctx.user.id }, sourceKey, expectedRowVersion, edit, reason);
    })),
  endpointUpdate: roleProcedure("sourceRegistry.endpointUpdate")
    .input(z.object({ sourceKey: SOURCE_KEY, expectedRowVersion: VERSION, endpointKey: ENDPOINT_KEY, ...endpointFields, reason: REASON }))
    .mutation(({ ctx, input }) => run(() => {
      const { sourceKey, expectedRowVersion, endpointKey, reason, ...edit } = input;
      return reg.updateEndpoint({ userId: ctx.user.id }, sourceKey, endpointKey, expectedRowVersion, edit, reason);
    })),
  /** Names a providerCredentials row by reference. A credential value is never accepted here. */
  credentialBind: roleProcedure("sourceRegistry.credentialBind")
    .input(z.object({
      sourceKey: SOURCE_KEY, expectedRowVersion: VERSION, endpointKey: ENDPOINT_KEY, authScheme: z.enum(ENDPOINT_AUTH_SCHEMES),
      credentialRef: z.string().regex(/^cred_[A-Za-z0-9_-]{4,59}$/, "a providerCredentials credentialRef").nullable(), reason: REASON,
    }).strict())
    .mutation(({ ctx, input }) => run(() => reg.bindCredential({ userId: ctx.user.id }, input.sourceKey, input.endpointKey, input.expectedRowVersion,
      { authScheme: input.authScheme, credentialRef: input.credentialRef }, input.reason))),

  requestReview: roleProcedure("sourceRegistry.requestReview")
    .input(z.object({ sourceKey: SOURCE_KEY, expectedRowVersion: VERSION, scope: z.array(z.enum(REGISTRY_PURPOSES)).min(1), reason: REASON }))
    .mutation(({ ctx, input }) => run(() => reg.requestReview({ userId: ctx.user.id }, input.sourceKey, input.expectedRowVersion, input.scope, input.reason))),
  reject: roleProcedure("sourceRegistry.reject")
    .input(z.object({ sourceKey: SOURCE_KEY, expectedRowVersion: VERSION, note: REASON }))
    .mutation(({ ctx, input }) => run(() => reg.reject({ userId: ctx.user.id }, input.sourceKey, input.expectedRowVersion, input.note))),
  approve: roleProcedure("sourceRegistry.approve")
    .input(z.object({ sourceKey: SOURCE_KEY, expectedRowVersion: VERSION, reviewBy: z.coerce.date(), note: REASON }))
    .mutation(({ ctx, input }) => run(() => reg.approve({ userId: ctx.user.id }, input.sourceKey, input.expectedRowVersion, { expiresAt: input.reviewBy, note: input.note }))),
  suspend: roleProcedure("sourceRegistry.suspend")
    .input(z.object({ sourceKey: SOURCE_KEY, expectedRowVersion: VERSION, reason: REASON }))
    .mutation(({ ctx, input }) => run(() => reg.suspend({ userId: ctx.user.id }, input.sourceKey, input.expectedRowVersion, input.reason))),
  resume: roleProcedure("sourceRegistry.resume")
    .input(z.object({ sourceKey: SOURCE_KEY, expectedRowVersion: VERSION, note: REASON }))
    .mutation(({ ctx, input }) => run(() => reg.resume({ userId: ctx.user.id }, input.sourceKey, input.expectedRowVersion, input.note))),
  revoke: roleProcedure("sourceRegistry.revoke")
    .input(z.object({ sourceKey: SOURCE_KEY, expectedRowVersion: VERSION, reason: REASON }))
    .mutation(({ ctx, input }) => run(() => reg.revoke({ userId: ctx.user.id }, input.sourceKey, input.expectedRowVersion, input.reason))),
  retire: roleProcedure("sourceRegistry.retire")
    .input(z.object({ sourceKey: SOURCE_KEY, expectedRowVersion: VERSION, reason: REASON }))
    .mutation(({ ctx, input }) => run(() => reg.retire({ userId: ctx.user.id }, input.sourceKey, input.expectedRowVersion, input.reason))),
});
