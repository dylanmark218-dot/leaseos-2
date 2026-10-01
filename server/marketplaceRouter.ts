/**
 * Marketplace — the client / contractor job exchange, checkpoint 1.
 *
 * Postings, bids and awards between organizations. Every procedure is role-gated
 * and acts for the caller's organization as `resolveActingScope` establishes it;
 * nothing here reads an organization from input. The rules are in
 * `_core/marketplace.ts`, the transactions in `_core/marketplaceService.ts`.
 * This file is the door and the input contract, and nothing else.
 */
import { TRPCError } from "@trpc/server";
import { z } from "zod";
import { getDb } from "./db";
import { resolveActingScope } from "./_core/actingScope";
import { POSTING_STATES, PRICING_TYPES, PRICING_UNITS } from "./_core/marketplace";
import * as svc from "./_core/marketplaceService";
import { roleProcedure, router } from "./_core/trpc";

async function actorFor(userId: number): Promise<{ db: NonNullable<Awaited<ReturnType<typeof getDb>>>; actor: svc.MarketplaceActor }> {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const scope = await resolveActingScope(db, userId);
  return { db, actor: { userId, orgRef: scope.tenantId } };
}

const ref = z.string().min(1).max(64);
const code = z.string().min(1).max(60);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "a SHA-256 hex digest");
const attachment = z.object({ name: z.string().min(1).max(200), sha256: sha256Hex, sizeBytes: z.number().int().nonnegative() });

const requirements = z.object({
  certifications: z.array(code).max(40).default([]),
  permits: z.array(code).max(40).default([]),
  dangerousGoods: z.array(code).max(40).default([]),
  insuranceLiabilityMinimumCents: z.number().int().nonnegative().nullable().default(null),
  equipmentTypes: z.array(code).max(40).default([]),
});

const postingDraft = z.object({
  title: z.string().min(3).max(220),
  workType: code,
  description: z.string().max(8000).nullable().optional(),
  pickupLocation: z.string().max(220).nullable().optional(),
  pickupLsd: z.string().max(40).nullable().optional(),
  destination: z.string().max(220).nullable().optional(),
  destinationLsd: z.string().max(40).nullable().optional(),
  pickupLat: z.number().min(-90).max(90).nullable().optional(),
  pickupLng: z.number().min(-180).max(180).nullable().optional(),
  estimatedQuantityMillis: z.number().int().nonnegative().nullable().optional(),
  quantityUnit: z.string().max(20).nullable().optional(),
  equipmentType: z.string().max(120).nullable().optional(),
  unitsRequired: z.number().int().positive().nullable().optional(),
  estimatedDurationMinutes: z.number().int().positive().nullable().optional(),
  estimatedDistanceKm: z.number().nonnegative().nullable().optional(),
  requestedStart: z.coerce.date().nullable().optional(),
  deadline: z.coerce.date().nullable().optional(),
  biddingClosesAt: z.coerce.date().nullable().optional(),
  pricingBasis: z.enum(["fixed_price", "unit_rate", "hourly", "combination", "any"]).optional(),
  visibility: z.enum(["open", "sealed"]).optional(),
  distribution: z.enum(["public", "invite_only"]).optional(),
  operatingArea: z.string().max(120).nullable().optional(),
  currency: z.string().length(3).toUpperCase().optional(),
  requirements: requirements.partial().optional(),
  documents: z.array(attachment).max(50).optional(),
});

const bidContent = z.object({
  pricingType: z.enum(PRICING_TYPES),
  currency: z.string().length(3).toUpperCase(),
  fixedTotalCents: z.number().int().nonnegative().nullable().default(null),
  components: z.array(z.object({
    code: z.string().min(2).max(40),
    label: z.string().min(1).max(120),
    unit: z.enum(PRICING_UNITS),
    rateCents: z.number().int().nonnegative(),
    estimatedQuantityMillis: z.number().int().nonnegative().nullable().default(null),
  })).max(40).default([]),
  exclusions: z.array(z.string().min(1).max(500)).max(40).default([]),
  qualifications: z.object({
    certifications: z.array(code).max(40).default([]),
    permits: z.array(code).max(40).default([]),
    dangerousGoods: z.array(code).max(40).default([]),
    insuranceLiabilityCents: z.number().int().nonnegative().nullable().default(null),
    equipmentTypes: z.array(code).max(40).default([]),
  }).default({ certifications: [], permits: [], dangerousGoods: [], insuranceLiabilityCents: null, equipmentTypes: [] }),
  unitsOffered: z.number().int().positive(),
  availableFrom: z.coerce.date().nullable().default(null),
  notes: z.string().max(4000).nullable().default(null),
  attachments: z.array(attachment).max(50).default([]),
});

const withVersion = { expectedVersion: z.number().int().positive().optional() };

export const marketplaceRouter = router({
  /* ---- postings: the client's side ---- */
  postingCreate: roleProcedure("marketplace.postingCreate").input(postingDraft).mutation(async ({ ctx, input }) => {
    const { db, actor } = await actorFor(ctx.user.id);
    return svc.createPosting(db, actor, input);
  }),
  postingUpdate: roleProcedure("marketplace.postingUpdate").input(z.object({ postingRef: ref, ...withVersion, draft: postingDraft })).mutation(async ({ ctx, input }) => {
    const { db, actor } = await actorFor(ctx.user.id);
    return svc.updatePosting(db, actor, input);
  }),
  postingPublish: roleProcedure("marketplace.postingPublish").input(z.object({ postingRef: ref, ...withVersion })).mutation(async ({ ctx, input }) => {
    const { db, actor } = await actorFor(ctx.user.id);
    return svc.publishPosting(db, actor, input);
  }),
  postingOpenBidding: roleProcedure("marketplace.postingOpenBidding").input(z.object({ postingRef: ref, ...withVersion })).mutation(async ({ ctx, input }) => {
    const { db, actor } = await actorFor(ctx.user.id);
    return svc.openBidding(db, actor, input);
  }),
  postingCloseBidding: roleProcedure("marketplace.postingCloseBidding").input(z.object({ postingRef: ref, ...withVersion })).mutation(async ({ ctx, input }) => {
    const { db, actor } = await actorFor(ctx.user.id);
    return svc.closeBidding(db, actor, input);
  }),
  postingCancel: roleProcedure("marketplace.postingCancel").input(z.object({ postingRef: ref, ...withVersion, reason: z.string().min(3).max(500) })).mutation(async ({ ctx, input }) => {
    const { db, actor } = await actorFor(ctx.user.id);
    return svc.cancelPosting(db, actor, input);
  }),
  postingInvite: roleProcedure("marketplace.postingInvite").input(z.object({ postingRef: ref, invitedOrgRef: z.string().min(1).max(40) })).mutation(async ({ ctx, input }) => {
    const { db, actor } = await actorFor(ctx.user.id);
    return svc.invite(db, actor, input);
  }),
  bidShortlist: roleProcedure("marketplace.bidShortlist").input(z.object({ bidRef: ref })).mutation(async ({ ctx, input }) => {
    const { db, actor } = await actorFor(ctx.user.id);
    return svc.shortlistBid(db, actor, input);
  }),
  /** The award. A person's decision with a reason — never "lowest wins". Sensitive: fail-closed. */
  award: roleProcedure("marketplace.award").input(z.object({ postingRef: ref, bidRef: ref, rationale: z.string().min(10).max(4000), ...withVersion })).mutation(async ({ ctx, input }) => {
    const { db, actor } = await actorFor(ctx.user.id);
    return svc.awardPosting(db, actor, input);
  }),

  /* ---- the award → dispatch bridge (0190) ---- */
  /** The client issues the contract: the job (owned by the contractor) and the commercial chain are created from the award, nothing re-entered. */
  contractIssue: roleProcedure("marketplace.contractIssue").input(z.object({ postingRef: ref, ...withVersion })).mutation(async ({ ctx, input }) => {
    const { db, actor } = await actorFor(ctx.user.id);
    return svc.issueContract(db, actor, input);
  }),
  /** The contractor dispatches: the canonical dispatch posting and its unit slots, through the same door its dispatcher's screen uses. Gated by dispatch.assign. */
  contractDispatch: roleProcedure("marketplace.contractDispatch").input(z.object({ contractRef: ref })).mutation(async ({ ctx, input }) => {
    const { db, actor } = await actorFor(ctx.user.id);
    return svc.dispatchContract(db, actor, input);
  }),
  contractGet: roleProcedure("marketplace.contractGet").input(z.object({ contractRef: ref })).query(async ({ ctx, input }) => {
    const { db, actor } = await actorFor(ctx.user.id);
    return svc.getContract(db, actor, input);
  }),
  contractsMine: roleProcedure("marketplace.contractsMine").query(async ({ ctx }) => {
    const { db, actor } = await actorFor(ctx.user.id);
    return svc.contractsMine(db, actor);
  }),

  /* ---- reading ---- */
  postingGet: roleProcedure("marketplace.postingGet").input(z.object({ postingRef: ref })).query(async ({ ctx, input }) => {
    const { db, actor } = await actorFor(ctx.user.id);
    return svc.getPosting(db, actor, input);
  }),
  postingsList: roleProcedure("marketplace.postingsList").input(z.object({ mineOnly: z.boolean().optional(), states: z.array(z.enum(POSTING_STATES)).optional() }).optional()).query(async ({ ctx, input }) => {
    const { db, actor } = await actorFor(ctx.user.id);
    return svc.listPostings(db, actor, input ?? {});
  }),
  postingEvents: roleProcedure("marketplace.postingEvents").input(z.object({ postingRef: ref })).query(async ({ ctx, input }) => {
    const { db, actor } = await actorFor(ctx.user.id);
    return svc.postingEvents(db, actor, input);
  }),
  bidsForPosting: roleProcedure("marketplace.bidsForPosting").input(z.object({ postingRef: ref })).query(async ({ ctx, input }) => {
    const { db, actor } = await actorFor(ctx.user.id);
    return svc.bidsForPosting(db, actor, input);
  }),
  bidsMine: roleProcedure("marketplace.bidsMine").input(z.object({ postingRef: ref.optional() }).optional()).query(async ({ ctx, input }) => {
    const { db, actor } = await actorFor(ctx.user.id);
    return svc.myBids(db, actor, input ?? {});
  }),

  /* ---- bids: the contractor's side ---- */
  bidReadiness: roleProcedure("marketplace.bidReadiness").input(z.object({ postingRef: ref, content: bidContent })).query(async ({ ctx, input }) => {
    const { db, actor } = await actorFor(ctx.user.id);
    return svc.previewReadiness(db, actor, input);
  }),
  bidDraftSave: roleProcedure("marketplace.bidDraftSave").input(z.object({ postingRef: ref, content: bidContent })).mutation(async ({ ctx, input }) => {
    const { db, actor } = await actorFor(ctx.user.id);
    return svc.saveBidDraft(db, actor, input);
  }),
  bidSubmit: roleProcedure("marketplace.bidSubmit").input(z.object({ bidRef: ref, ...withVersion })).mutation(async ({ ctx, input }) => {
    const { db, actor } = await actorFor(ctx.user.id);
    return svc.submitBid(db, actor, input);
  }),
  bidWithdraw: roleProcedure("marketplace.bidWithdraw").input(z.object({ bidRef: ref, ...withVersion, reason: z.string().max(500).nullable().optional() })).mutation(async ({ ctx, input }) => {
    const { db, actor } = await actorFor(ctx.user.id);
    return svc.withdrawBid(db, actor, input);
  }),
});
