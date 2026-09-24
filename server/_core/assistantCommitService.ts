/**
 * Transactional execution of a typed Assistant commit.
 *
 * The outer `assistant.commit` roleProcedure proves the caller may perform an
 * Assistant commit. This service then independently proves the caller may
 * perform the TARGET domain write (trip.write, maintenance.write_defect, ...),
 * locks the proposal and target, writes exactly once, records provenance, and
 * only then marks the proposal committed.
 */

import { toCents } from "./money";
import type { Tx } from "./dbTypes";
import { createHash } from "node:crypto";
import { and, eq, inArray, isNull } from "drizzle-orm";
import {
  assistantCommitReceipts,
  assistantProposals,
  authorizationDecisions,
  maintenanceDefects,
  proposalFields,
  tripStops,
  units,
  userRoleAssignments,
  expenseRecords,
  financialEntities,
  loads,
  facilities,
  disposalTickets,
  documentFingerprints,
  documentExtractions,
  evidenceRelationships,
  fuelTransactions,
  fleetFuelCards,
} from "../../drizzle/schema";
import { classifyFuelEvent, fuelHosContext, type FuelConsumer, type FuelPayer } from "./fuelLedger";
import {
  assessDuplicate,
  buildFingerprint,
  commitPermittedUnder,
  type Fingerprint,
  type PriorCapture,
} from "./documentFingerprint";
import { getDb, proposalAnchorRefusal } from "../db";
import { AmbiguousOrganization, resolveActingScope } from "./actingScope";
import { rowInTenant } from "./learningScope";
import { FORMS, commitProposal, type CommittedField } from "./aiProposal";
import { rehydrateProposal } from "./assistantPersistence";
import {
  ASSISTANT_COMMIT_ADAPTER_VERSION,
  planAssistantCommit,
  type AssistantCommitIntent,
} from "./assistantCommitAdapters";
import {
  authorize,
  type Permission,
  type RoleGrant,
} from "./recordsAuthorization";

export type DuplicateOutcome = "unique" | "exact_duplicate" | "possible_duplicate" | "cannot_assess";

export type ExecuteAssistantCommitResult =
  | {
      committed: true;
      replayed: boolean;
      proposalId: string;
      targetType: "trip_stop" | "maintenance_defect" | "expense_record" | "disposal_ticket" | "fuel_transaction";
      targetRecordId: number;
      receiptId: number;
    }
  | { committed: false; refusals: string[]; duplicate?: DuplicateOutcome };

const normalize = (value: unknown): unknown => {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, normalize(v)])
    );
  }
  return value;
};

function fieldManifest(fields: readonly CommittedField[]) {
  const body = fields
    .map(f => ({
      key: f.key,
      value: normalize(f.value),
      precision: f.precision,
      source: f.source,
      confidence: f.confidence,
      status: f.status,
      sourceUtterance: f.sourceUtterance ?? null,
      correctedFrom: normalize(f.correctedFrom ?? null),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  const json = JSON.stringify(body);
  return {
    json,
    sha256: createHash("sha256").update(json, "utf8").digest("hex"),
  };
}

function resultFromReceipt(row: typeof assistantCommitReceipts.$inferSelect): ExecuteAssistantCommitResult {
  return {
    committed: true,
    replayed: true,
    proposalId: row.proposalId,
    targetType: row.targetType,
    targetRecordId: row.targetRecordId,
    receiptId: row.id,
  };
}

export async function executeAssistantCommit(args: {
  proposalId: string;
  actorUserId: number;
  now?: Date;
}): Promise<ExecuteAssistantCommitResult> {
  const db = await getDb();
  if (!db) return { committed: false, refusals: ["Database unavailable"] };
  const now = args.now ?? new Date();

  return db.transaction(async tx => {
    // Serialize retries/concurrent commits by proposal.
    const proposals = await tx
      .select()
      .from(assistantProposals)
      .where(eq(assistantProposals.proposalId, args.proposalId))
      .for("update");
    const row = proposals[0];
    if (!row) return { committed: false as const, refusals: ["Proposal not found"] };

    // AIL-1A — the service checks the owner itself, so no caller (router, worker or test) can commit
    // another organization's proposal by reaching past the procedure's guard. A legacy row whose owner
    // was never proved has no tenant and belongs to nobody. Answered as "not found" either way.
    let actingTenant: string;
    try {
      actingTenant = (await resolveActingScope(tx, args.actorUserId)).tenantId;
    } catch (e) {
      if (e instanceof AmbiguousOrganization) return { committed: false as const, refusals: ["Proposal not found"] };
      throw e;
    }
    if (!rowInTenant(row, { tenantId: actingTenant })) {
      return { committed: false as const, refusals: ["Proposal not found"] };
    }

    const existingReceipt = await tx
      .select()
      .from(assistantCommitReceipts)
      .where(eq(assistantCommitReceipts.proposalId, args.proposalId));
    if (existingReceipt[0]) return resultFromReceipt(existingReceipt[0]);

    // A committed proposal without a receipt is inconsistent. Never guess that
    // the target write happened and never perform it a second time.
    if (row.commitState === "committed") {
      return {
        committed: false as const,
        refusals: [
          "Proposal is marked committed but has no typed commit receipt; manual reconciliation is required",
        ],
      };
    }

    // AIL-1A — the records the proposal names are re-checked against its owner at the moment of
    // writing, with the same rule the draft used, on this transaction's own connection. A proposal
    // backfilled from before 0185 was never checked at draft; this is where it is.
    const anchorRefusal = await proposalAnchorRefusal(
      tx,
      { formKey: row.formKey, jobId: row.jobId, tripId: row.tripId, unitId: row.unitId, targetRecordId: row.targetRecordId },
      { tenantId: actingTenant },
    );
    if (anchorRefusal) return { committed: false as const, refusals: [anchorRefusal] };

    const storedFields = await tx
      .select()
      .from(proposalFields)
      .where(eq(proposalFields.proposalId, args.proposalId));
    const proposal = rehydrateProposal(row, storedFields);
    const form = FORMS[proposal.formKey];
    if (!form) {
      return {
        committed: false as const,
        refusals: [`Unknown form ${proposal.formKey}`],
      };
    }
    const committed = commitProposal(proposal, form, now);
    if (!committed.ok) {
      return { committed: false as const, refusals: committed.refusals };
    }

    const plan = planAssistantCommit(
      {
        proposalId: row.proposalId,
        formKey: row.formKey,
        targetRef: row.targetRef,
        targetRecordId: row.targetRecordId,
        tripId: row.tripId,
        unitId: row.unitId,
        loadId: row.loadId,
        facilityId: row.facilityId,
        fleetCardId: row.fleetCardId,
        eventDateLocal: row.eventDateLocal,
        utcOffsetMinutes: row.utcOffsetMinutes,
        actorUserId: args.actorUserId,
        capturedAt: row.createdAt,
      },
      committed.fields
    );
    if (!plan.ok) return { committed: false as const, refusals: plan.refusals };

    // Re-read current grants in the SAME transaction as the target write. The
    // outer assistant.commit authorization is not a substitute for permission
    // to mutate the destination domain.
    const roleRows = await tx
      .select()
      .from(userRoleAssignments)
      .where(
        and(
          eq(userRoleAssignments.userId, args.actorUserId),
          isNull(userRoleAssignments.revokedAt)
        )
      );
    const grants: RoleGrant[] = roleRows.map(r => ({
      role: r.role,
      scopeRef: r.scopeType === "global" ? null : r.scopeRef,
    }));
    const targetPermission = plan.intent.requiredPermission as Permission;
    const decision = authorize({
      userId: args.actorUserId,
      grants,
      permission: targetPermission,
    });

    const auditInserted = await tx.insert(authorizationDecisions).values({
      actorUserId: args.actorUserId,
      procedureName: `assistant.commit.target.${plan.intent.targetType}`,
      permission: targetPermission,
      rolesHeld: decision.effectiveRoles.join(","),
      outcome: decision.outcome,
      subjectType: plan.intent.targetType,
      subjectId:
        plan.intent.kind === "trip_stop_update"
          ? String(plan.intent.targetRecordId)
          : row.unitId != null
            ? String(row.unitId)
            : null,
      detail: decision.detail ?? "Assistant typed target-write authorization",
      occurredAt: now,
    });
    const authorizationDecisionId = Number(auditInserted[0]?.insertId ?? 0) || null;

    if (!decision.allowed) {
      return {
        committed: false as const,
        refusals: [
          `Target write refused: ${decision.detail ?? targetPermission}`,
        ],
      };
    }

    // Fingerprint gate. This is a step the service takes, not a check a caller
    // remembers to run. Only forms that describe a document have a fingerprint;
    // an unload stop or a defect report is an event, not a piece of paper.
    let fingerprint: Fingerprint | null = null;
    let contentSha256: string | null = null;
    if (isDocumentForm(row.formKey)) {
      fingerprint = fingerprintFor(row.formKey, committed.fields, row);
      const extraction = await tx
        .select({ contentSha256: documentExtractions.contentSha256, evidenceRecordId: documentExtractions.evidenceRecordId })
        .from(documentExtractions)
        .where(eq(documentExtractions.proposalId, row.proposalId))
        .limit(1);
      contentSha256 = extraction[0]?.contentSha256 ?? null;

      // AIL-1A.1 — a prior is matched only if it was captured by this organization: its proposal's
      // proved owner (0185) is the committing tenant. Another organization's document must not
      // refuse this one, reveal that it exists, or lend it its metadata. A fingerprint whose proposal
      // has no proved owner (legacy_unresolved) matches nobody — a missing owner is not global.
      const ownPriors = inArray(
        documentFingerprints.proposalId,
        tx.select({ proposalId: assistantProposals.proposalId }).from(assistantProposals).where(eq(assistantProposals.tenantId, actingTenant)),
      );
      const priorRows = await tx
        .select()
        .from(documentFingerprints)
        .where(and(eq(documentFingerprints.structuredKeyHash, fingerprint.structuredKeyHash), ownPriors))
        .for("update");
      const byContent = contentSha256
        ? await tx.select().from(documentFingerprints).where(and(eq(documentFingerprints.contentSha256, contentSha256), ownPriors))
        : [];
      const priors: PriorCapture[] = [...priorRows, ...byContent]
        .filter((r, i, all) => all.findIndex(x => x.id === r.id) === i)
        .map(r => ({
          fingerprintRef: r.fingerprintRef,
          contentSha256: r.contentSha256,
          structuredKeyHash: r.structuredKeyHash,
          targetType: r.targetType,
          targetRecordId: r.targetRecordId,
          capturedAt: r.capturedAt,
        }));

      const verdict = assessDuplicate({ fingerprint, contentSha256, priors });
      // The override is a recorded act on the proposal — who, and why — not a
      // parameter on this call. A client cannot pass "override: true".
      const permitted = commitPermittedUnder(verdict, row.duplicateOverride && row.duplicateOverrideByUserId != null);
      if (!permitted.permitted) {
        return {
          committed: false as const,
          refusals: [`Duplicate gate: ${permitted.reason}`],
          duplicate: verdict.outcome,
        };
      }
    }

    // This call used to launder the handle through an escape cast, which put back
    // exactly the hole the typing removed. applyIntent already declares `tx: Tx`,
    // so the cast bought nothing and cost the checking of everything it calls.
    const target = await applyIntent(tx, plan.intent, row, committed.fields);
    if (!target.ok) return { committed: false as const, refusals: target.refusals };

    // Auto-file. The bytes already live once in the vault under the extraction's
    // evidence record; this attaches that one record to everything it now
    // belongs to. No second copy, no second document database.
    if (fingerprint) {
      await tx.insert(documentFingerprints).values({
        fingerprintRef: `FP-${row.proposalId.slice(0, 58)}`,
        documentType: fingerprint.documentType,
        contentSha256,
        structuredKeyHash: fingerprint.structuredKeyHash,
        structuredKey: fingerprint.structuredKey.slice(0, 400),
        proposalId: row.proposalId,
        targetType: plan.intent.targetType,
        targetRecordId: target.targetRecordId,
        capturedByUserId: args.actorUserId,
        capturedAt: row.createdAt,
      });

      const extraction = await tx
        .select({ evidenceRecordId: documentExtractions.evidenceRecordId })
        .from(documentExtractions)
        .where(eq(documentExtractions.proposalId, row.proposalId))
        .limit(1);
      const evidenceId = extraction[0]?.evidenceRecordId ?? null;
      if (evidenceId) {
        const rels = autoFileRelationships(plan.intent, target.targetRecordId, row);
        if (rels.length > 0) {
          await tx.insert(evidenceRelationships).values(
            rels.map(r => ({ evidenceRecordId: evidenceId, ...r }))
          );
        }
      }
    }

    const manifest = fieldManifest(committed.fields);
    const receiptInserted = await tx.insert(assistantCommitReceipts).values({
      proposalId: row.proposalId,
      formKey: row.formKey,
      action: plan.intent.action,
      targetType: plan.intent.targetType,
      targetRecordId: target.targetRecordId,
      requiredPermission: targetPermission,
      authorizationDecisionId,
      adapterVersion: ASSISTANT_COMMIT_ADAPTER_VERSION,
      fieldManifest: manifest.json,
      fieldManifestHash: manifest.sha256,
      actorUserId: args.actorUserId,
      committedAt: now,
    });
    const receiptId = Number(receiptInserted[0]?.insertId ?? 0);

    await tx
      .update(assistantProposals)
      .set({ commitState: "committed", committedAt: now })
      .where(eq(assistantProposals.proposalId, row.proposalId));

    return {
      committed: true as const,
      replayed: false,
      proposalId: row.proposalId,
      targetType: plan.intent.targetType,
      targetRecordId: target.targetRecordId,
      receiptId,
    };
  });
}

async function applyIntent(
  tx: Tx,
  intent: AssistantCommitIntent,
  proposalRow: typeof assistantProposals.$inferSelect,
  committedFields: readonly { key: string; value: unknown }[]
): Promise<{ ok: true; targetRecordId: number } | { ok: false; refusals: string[] }> {
  if (intent.kind === "trip_stop_update") {
    const targetRows = await tx
      .select()
      .from(tripStops)
      .where(eq(tripStops.id, intent.targetRecordId))
      .for("update");
    const target = targetRows[0];
    if (!target) return { ok: false, refusals: ["Target trip stop not found"] };
    if (target.stopType !== "unload") {
      return { ok: false, refusals: ["Target trip stop is not an unload stop"] };
    }
    if (proposalRow.tripId == null || target.tripId !== proposalRow.tripId) {
      return {
        ok: false,
        refusals: ["Target trip stop does not belong to the proposal trip"],
      };
    }

    const notes = intent.delayReason
      ? [target.notes, `Assistant-confirmed delay reason: ${intent.delayReason}`]
          .filter(Boolean)
          .join("\n")
      : target.notes;

    await tx
      .update(tripStops)
      .set({ ...intent.values, notes })
      .where(eq(tripStops.id, intent.targetRecordId));
    return { ok: true, targetRecordId: intent.targetRecordId };
  }

  if (intent.kind === "expense_draft_create") {
    // The financial entity must exist and be the one the server resolved.
    // The draft is written with its treatment column left at the schema
    // default — `unknown_review_required` — because that column is not part
    // of the intent's values and this adapter has no way to set it. A
    // receipt is not a deduction, and OCR is not an accountant.
    const entityRows = await tx
      .select({ id: financialEntities.id })
      .from(financialEntities)
      .where(eq(financialEntities.id, intent.values.financialEntityId))
      .for("update");
    if (!entityRows[0]) return { ok: false, refusals: ["Target financial entity not found"] };

    const expenseRef = `EXP-AI-${proposalRow.proposalId.slice(0, 40)}`;
    const inserted = await tx.insert(expenseRecords).values({
      expenseRef,
      financialEntityId: intent.values.financialEntityId,
      vendorName: intent.values.vendorName,
      transactionDate: intent.values.transactionDate,
      currency: intent.values.currency,
      subtotal: intent.values.subtotal,
      salesTaxAmount: intent.values.salesTaxAmount,
      total: intent.values.total,
      categorySource: intent.values.categorySource,
      businessUsePercent: intent.values.businessUsePercent,
      paidByUserId: proposalRow.createdByUserId ?? null,
      evidenceRecordId: intent.values.evidenceRecordId,
      status: intent.values.status,
    });
    const targetRecordId = Number(inserted[0]?.insertId ?? 0);
    if (!targetRecordId) return { ok: false, refusals: ["Expense draft insert returned no id"] };
    return { ok: true, targetRecordId };
  }

  if (intent.kind === "fuel_transaction_create") {
    const entityRows = await tx
      .select({ id: financialEntities.id, taxpayerType: financialEntities.taxpayerType, ownerUserId: financialEntities.ownerUserId })
      .from(financialEntities)
      .where(eq(financialEntities.id, intent.values.financialEntityId))
      .for("update");
    const company = entityRows[0];
    if (!company) return { ok: false, refusals: ["Target financial entity not found"] };

    // --- Who paid. From the card token, or from nothing. ---
    let payer: FuelPayer = { kind: "unknown" };
    if (intent.values.fleetCardId) {
      const cardRows = await tx
        .select({ id: fleetFuelCards.id, financialEntityId: fleetFuelCards.financialEntityId, lastFour: fleetFuelCards.lastFour, status: fleetFuelCards.status })
        .from(fleetFuelCards)
        .where(eq(fleetFuelCards.id, intent.values.fleetCardId));
      const card = cardRows[0];
      if (!card) return { ok: false, refusals: ["Fleet card on the proposal does not exist"] };
      if (card.status !== "active") return { ok: false, refusals: [`Fleet card ${card.id} is ${card.status}`] };
      // The slip's last four is a hint. If it contradicts the token, stop.
      if (intent.values.cardLastFourHint && intent.values.cardLastFourHint !== card.lastFour) {
        return { ok: false, refusals: [`Receipt shows card •${intent.values.cardLastFourHint} but the proposal was opened against card •${card.lastFour}`] };
      }
      payer = { kind: "fleet_card", fleetCardId: card.id, cardOwnerEntityId: card.financialEntityId };
    }
    // Personal payment is a declared fact on the proposal's target, not
    // inferred from the absence of a card. Absence is unknown.

    // --- What consumed it. From the assignment, or from nothing. ---
    let consumer: FuelConsumer = { kind: "unknown" };
    if (intent.values.unitId) {
      const unitRows = await tx
        .select({ id: units.id, unitNumber: units.unitNumber })
        .from(units)
        .where(eq(units.id, intent.values.unitId));
      const unit = unitRows[0];
      if (!unit) return { ok: false, refusals: ["Unit on the proposal does not exist"] };
      // "Unit 142" on the slip against unit 218 on the assignment is a
      // question for a person, not a silent rebinding either way.
      if (intent.values.unitNumberHint && unit.unitNumber && intent.values.unitNumberHint.toUpperCase().replace(/^UNIT\s*/, "") !== unit.unitNumber.toUpperCase().replace(/^UNIT\s*/, "")) {
        return { ok: false, refusals: [`Receipt shows unit ${intent.values.unitNumberHint} but the assignment is unit ${unit.unitNumber} — review before committing`] };
      }
      consumer = { kind: "company_unit", unitId: unit.id };
    }

    const fuelerIsOwner = company.ownerUserId != null && company.ownerUserId === proposalRow.createdByUserId
      && company.taxpayerType !== "employee";
    const classification = classifyFuelEvent({
      companyEntityId: company.id,
      fueledByUserId: proposalRow.createdByUserId ?? null,
      payer,
      consumer,
      purposeEvidence: intent.values.tripId ? "on_company_assignment" : "unknown",
      fuelerIsOwnerShareholder: fuelerIsOwner,
      fuelerIsContractor: company.taxpayerType === "independent_contractor",
    });

    const hos = fuelHosContext({
      operatorId: proposalRow.operatorId ?? 0,
      unitId: intent.values.unitId ?? 0,
      occurredAt: intent.values.occurredAt,
      commercialVehicle: consumer.kind === "company_unit",
      currentDutyStatus: "unknown",
      sourceEventRef: `fuel:${proposalRow.proposalId}`,
      // P9: no authoritative HOS rule is loaded.
      hosRulesLoaded: false,
    });

    // The expense record is the financial record; the fuel transaction is the
    // domain record underneath it. A private-to-fueler event gets no company
    // expense at all.
    let expenseRecordId: number | null = null;
    if (!classification.privateToFueler && classification.financialOwnerEntityId != null) {
      const exp = await tx.insert(expenseRecords).values({
        expenseRef: `EXP-FUEL-${proposalRow.proposalId.slice(0, 38)}`,
        financialEntityId: classification.financialOwnerEntityId,
        vendorName: intent.values.vendorName,
        transactionDate: intent.values.occurredAt,
        currency: "CAD",
        subtotal: intent.values.subtotal,
        salesTaxAmount: intent.values.taxAmount,
        total: intent.values.total,
        categorySource: "ai_proposed",
        businessUsePercent: 100,
        paidByUserId: proposalRow.createdByUserId ?? null,
        evidenceRecordId: null,
        status: "draft",
      });
      expenseRecordId = Number(exp[0]?.insertId ?? 0) || null;
    }

    const inserted = await tx.insert(fuelTransactions).values({
      fuelRef: `FUEL-${proposalRow.proposalId.slice(0, 58)}`,
      financialEntityId: classification.financialOwnerEntityId ?? company.id,
      expenseRecordId,
      operatorId: proposalRow.operatorId ?? null,
      fueledByUserId: proposalRow.createdByUserId ?? null,
      unitId: intent.values.unitId,
      jobId: proposalRow.jobId ?? null,
      tripId: intent.values.tripId,
      fleetCardId: intent.values.fleetCardId,
      vendorName: intent.values.vendorName,
      // v21.3 — the receipt says where the litres were bought; IFTA reads it.
      jurisdiction: intent.values.jurisdiction,
      jurisdictionSource: intent.values.jurisdictionSource,
      occurredAt: intent.values.occurredAt,
      fuelType: intent.values.fuelType,
      quantity: intent.values.quantity,
      quantityUnit: intent.values.quantityUnit,
      /**
       * The column is `unitPriceMillis` — tenths of a cent, because fuel is
       * priced per litre to three decimals and cents would round every fill.
       * This wrote `unitPrice`, which is not a column on this table, so the AI
       * Secretary's fuel commit would have failed at the database. Invisible
       * until the transaction handle was typed.
       */
      unitPriceMillis: intent.values.unitPrice != null ? Math.round(Number(intent.values.unitPrice) * 1000) : null,
      subtotalCents: toCents(intent.values.subtotal),
      taxAmountCents: toCents(intent.values.taxAmount),
      totalCents: toCents(intent.values.total)!,
      odometerKm: intent.values.odometerKm,
      unitNumberHint: intent.values.unitNumberHint,
      cardLastFourHint: intent.values.cardLastFourHint,
      payerType: classification.payerType,
      purpose: classification.purpose,
      financialTreatment: classification.treatment,
      reimbursementStatus: classification.reimbursementCandidate ? "pending" : "not_applicable",
      privateToFueler: classification.privateToFueler,
      hosRuleConclusion: hos.ruleConclusion,
      classificationReasons: JSON.stringify(classification.reasons),
      status: "needs_review",
    });
    const targetRecordId = Number(inserted[0]?.insertId ?? 0);
    if (!targetRecordId) return { ok: false, refusals: ["Fuel transaction insert returned no id"] };
    return { ok: true, targetRecordId };
  }

  if (intent.kind === "disposal_ticket_create") {
    // Lock the load; the ticket hangs off it and nothing else may advance it
    // concurrently. The chain state is deliberately NOT changed here.
    const loadRows = await tx
      .select({ id: loads.id, loadNumber: loads.loadNumber, chainState: loads.chainState, jobId: loads.jobId, tripId: loads.tripId, operatorId: loads.operatorId, unitId: loads.unitId })
      .from(loads)
      .where(eq(loads.id, intent.values.loadId))
      .for("update");
    const load = loadRows[0];
    if (!load) return { ok: false, refusals: ["Target load not found"] };
    if (load.chainState === "billed") {
      return { ok: false, refusals: ["Load is already billed — a new disposal ticket cannot be attached after invoicing"] };
    }

    // The human-readable load in the proposal must agree with the server's.
    const proposedLoad = committedFields.find(f => f.key === "loadRef")?.value;
    if (String(proposedLoad ?? "").trim().toUpperCase() !== String(load.loadNumber ?? "").toUpperCase()) {
      return {
        ok: false,
        refusals: ["Proposed load reference does not match the server-resolved load; refusing cross-load ticket creation"],
      };
    }

    const facilityRows = await tx
      .select({ id: facilities.id, name: facilities.name })
      .from(facilities)
      .where(eq(facilities.id, intent.values.facilityId));
    if (!facilityRows[0]) return { ok: false, refusals: ["Target facility not found"] };

    // One facility ticket number per load. A second capture of the same
    // ticket is a duplicate, not a second disposal.
    const dup = await tx
      .select({ id: disposalTickets.id })
      .from(disposalTickets)
      .where(
        and(
          eq(disposalTickets.loadId, intent.values.loadId),
          eq(disposalTickets.facilityTicketNumber, intent.values.facilityTicketNumber)
        )
      )
      .limit(1);
    if (dup[0]) {
      return {
        ok: false,
        refusals: [`Facility ticket ${intent.values.facilityTicketNumber} already recorded for this load as disposal ticket #${dup[0].id}`],
      };
    }

    const ticketNumber = `DSP-AI-${proposalRow.proposalId.slice(0, 40)}`;
    const inserted = await tx.insert(disposalTickets).values({
      ticketNumber,
      loadId: intent.values.loadId,
      jobId: load.jobId,
      tripId: load.tripId,
      facilityId: intent.values.facilityId,
      operatorId: load.operatorId,
      unitId: load.unitId,
      facilityTicketNumber: intent.values.facilityTicketNumber,
      scaleInAt: intent.values.scaleInAt,
      grossKg: intent.values.grossKg,
      tareKg: intent.values.tareKg,
      netKg: intent.values.netKg,
      quantity: intent.values.quantity,
      quantityUnit: intent.values.quantityUnit,
      verificationStatus: intent.values.verificationStatus,
      source: intent.values.source,
      confidence: intent.values.confidence,
      evidenceRefs: JSON.stringify({ proposalId: proposalRow.proposalId, material: intent.material }),
    });
    const targetRecordId = Number(inserted[0]?.insertId ?? 0);
    if (!targetRecordId) return { ok: false, refusals: ["Disposal ticket insert returned no id"] };
    return { ok: true, targetRecordId };
  }

  // Resolve the unit relation again from the authoritative table and ensure the
  // human-readable unit in the proposal agrees with the structured unit id.
  const unitRows = await tx
    .select()
    .from(units)
    .where(eq(units.id, intent.values.unitId))
    .for("update");
  const unit = unitRows[0];
  if (!unit) return { ok: false, refusals: ["Target unit not found"] };
  const proposedUnit = committedFields.find(f => f.key === "unitNumber")?.value;
  if (String(proposedUnit ?? "").trim() !== unit.unitNumber) {
    return {
      ok: false,
      refusals: [
        "Proposed unit number does not match the server-resolved unit; refusing cross-unit defect creation",
      ],
    };
  }

  const inserted = await tx.insert(maintenanceDefects).values(intent.values);
  const targetRecordId = Number(inserted[0]?.insertId ?? 0);
  if (!targetRecordId) {
    return { ok: false, refusals: ["Maintenance defect insert returned no id"] };
  }
  return { ok: true, targetRecordId };
}


/* ------------------------------------------------------------------ */
/* v20.17 — fingerprint gate and auto-filer helpers                      */
/* ------------------------------------------------------------------ */

const DOCUMENT_FORMS: ReadonlySet<string> = new Set(["expense_receipt", "disposal_ticket", "fuel_receipt"]);

export function isDocumentForm(formKey: string): boolean {
  return DOCUMENT_FORMS.has(formKey);
}

function fieldValue(fields: readonly CommittedField[], key: string): string | number | null {
  const f = fields.find(x => x.key === key);
  if (!f || f.value === null || f.value === undefined) return null;
  return typeof f.value === "boolean" ? String(f.value) : f.value;
}

/**
 * The structured key is built from the confirmed fields — the precision
 * sensitive ones a person signed off on — which is why the verdict it produces
 * is worth acting on.
 */
export function fingerprintFor(
  formKey: string,
  fields: readonly CommittedField[],
  row: { loadId?: number | null; facilityId?: number | null }
): Fingerprint {
  if (formKey === "fuel_receipt") {
    const total = fieldValue(fields, "total");
    const quantity = fieldValue(fields, "quantity");
    return buildFingerprint({
      documentType: "fuel_receipt",
      vendorName: fieldValue(fields, "vendorName") as string | null,
      transactionDate: fieldValue(fields, "transactionDate") as string | null,
      total: total === null ? null : Number(total),
      quantity: quantity === null ? null : Number(quantity),
      cardLastFour: fieldValue(fields, "cardLastFour") as string | null,
      unitNumber: fieldValue(fields, "unitNumber") as string | null,
    });
  }
  if (formKey === "expense_receipt") {
    const total = fieldValue(fields, "total");
    return buildFingerprint({
      documentType: "expense_receipt",
      vendorName: fieldValue(fields, "vendorName") as string | null,
      transactionDate: fieldValue(fields, "transactionDate") as string | null,
      total: total === null ? null : Number(total),
      currency: (fieldValue(fields, "currency") as string | null) ?? "CAD",
    });
  }
  return buildFingerprint({
    documentType: "disposal_ticket",
    facilityRef: row.facilityId != null ? `facility#${row.facilityId}` : null,
    facilityTicketNumber: fieldValue(fields, "facilityTicketNumber") as string | null,
    loadRef: row.loadId != null ? `load#${row.loadId}` : null,
  });
}

/**
 * Everything one document now belongs to. A receipt is the worker's, the
 * expense's, the job's, the unit's and the tax year's — one evidence record,
 * several relationships, zero copies.
 */
export type EvidenceEntityType = (typeof evidenceRelationships.$inferInsert)["entityType"];
export type AutoFileRelationship = {
  entityType: Exclude<EvidenceEntityType, undefined>;
  entityId: number | null;
  entityRef: string | null;
  role: string;
};

export function autoFileRelationships(
  intent: { kind: string; targetType: string; values: Record<string, unknown> },
  targetRecordId: number,
  row: { createdByUserId?: number | null; jobId?: number | null; unitId?: number | null; loadId?: number | null; tripId?: number | null }
): AutoFileRelationship[] {
  const rels: AutoFileRelationship[] = [];
  const push = (entityType: AutoFileRelationship["entityType"], entityId: number | null | undefined, role: string, entityRef: string | null = null) => {
    if (entityId != null && entityId > 0) rels.push({ entityType, entityId, entityRef, role });
  };

  if (intent.kind === "expense_draft_create") {
    push("expenseRecord", targetRecordId, "source_document");
    push("financialEntity", intent.values.financialEntityId as number, "books");
    push("user", row.createdByUserId, "captured_by");
    const d = intent.values.transactionDate;
    if (d instanceof Date && !Number.isNaN(d.getTime())) {
      rels.push({ entityType: "taxYear", entityId: null, entityRef: String(d.getUTCFullYear()), role: "organizer" });
    }
    push("job", row.jobId, "incurred_on");
    push("unit", row.unitId, "incurred_for");
  } else if (intent.kind === "fuel_transaction_create") {
    push("fuelTransaction", targetRecordId, "source_document");
    push("financialEntity", intent.values.financialEntityId as number, "books");
    push("user", row.createdByUserId, "captured_by");
    push("unit", (intent.values.unitId as number | null) ?? row.unitId, "fuelled");
    push("trip", (intent.values.tripId as number | null) ?? row.tripId, "evidence");
    push("job", row.jobId, "evidence");
    const d = intent.values.occurredAt;
    if (d instanceof Date && !Number.isNaN(d.getTime())) {
      rels.push({ entityType: "taxYear", entityId: null, entityRef: String(d.getUTCFullYear()), role: "organizer" });
    }
  } else if (intent.kind === "disposal_ticket_create") {
    push("disposalTicket", targetRecordId, "source_document");
    push("load", row.loadId, "evidence");
    push("trip", row.tripId, "evidence");
    push("job", row.jobId, "evidence");
    push("unit", row.unitId, "evidence");
    push("facility", intent.values.facilityId as number, "issued_by");
    push("user", row.createdByUserId, "captured_by");
  }
  return rels;
}
