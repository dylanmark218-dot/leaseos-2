/**
 * v23.27 — printing, as a delivery that knows what it put on paper.
 *
 * commercialDocumentDeliveries already accepted channel "print", and commercialOffice already
 * refused to deliver a superseded version. What a print could not say was which printer, whether
 * that paper was the first issued or a reprint, whether a guess went out looking like a fact, and —
 * the one that matters in a dispute — which paper in circulation no longer matches the record,
 * because the record changed after the printer ran.
 *
 * Three permissions. Printing is ordinary work and the printer is in the cab, so drivers hold
 * `print.record`. Registering printers and saying which unit carries which is fleet administration,
 * `printer.manage`. Reading print history and the stale-paper list is `print.read`.
 */
import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { roleProcedure, router } from "./_core/trpc";
import { getDb } from "./db";
import { resolveActingScope, SINGLE_TENANT_ID } from "./_core/actingScope";
import { commercialDocumentDeliveries, commercialDocuments, fieldPrinterAssignments, fieldPrinters, units } from "../drizzle/schema";
import { assessPrintability, copyKindFor, staleCopies, type ChainDocument } from "@shared/printability";

const ref = (p: string) => `${p}-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;

async function scopeFor(userId: number) {
  const db = await getDb();
  if (!db) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Database unavailable" });
  const scope = await resolveActingScope(db, userId);
  return { db, orgRef: scope.tenantId === SINGLE_TENANT_ID ? null : scope.tenantId };
}
/** The rule commercialOffice applies to one document: another book's rows do not exist for you. */
const inScope = (rowOrg: string | null, orgRef: string | null) => (orgRef ? rowOrg === orgRef : rowOrg === null);

const FIELD = z.object({
  key: z.string().min(1).max(80),
  label: z.string().min(1).max(160),
  required: z.boolean(),
  state: z.enum(["confirmed", "provisional", "unknown", "absent"]),
});
const CLASS = z.enum(["regulatory", "commercial", "informational"]);

export const printingRouter = router({
  registerPrinter: roleProcedure("printing.registerPrinter")
    .input(z.object({
      manufacturer: z.string().min(1).max(80),
      model: z.string().min(1).max(80),
      serialNumber: z.string().max(80).nullish(),
      connectionType: z.enum(["bluetooth_classic", "bluetooth_le", "wifi", "wifi_direct", "usb", "network"]),
      paperFormat: z.enum(["letter", "receipt_4in", "receipt_3in", "receipt_2in", "label"]),
      printTechnology: z.enum(["direct_thermal", "thermal_transfer", "inkjet", "laser"]),
      iosMfiCertified: z.boolean().nullish(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { db, orgRef } = await scopeFor(ctx.user.id);
      const printerRef = ref("PRN");
      await db.insert(fieldPrinters).values({
        printerRef, orgRef,
        manufacturer: input.manufacturer, model: input.model, serialNumber: input.serialNumber ?? null,
        connectionType: input.connectionType, paperFormat: input.paperFormat, printTechnology: input.printTechnology,
        iosMfiCertified: input.iosMfiCertified ?? null,
        createdByUserId: ctx.user.id,
      });
      const notes: string[] = [];
      if (input.printTechnology === "direct_thermal") {
        notes.push("Direct thermal paper fades, in months on a hot dashboard. Its paper is the copy handed over; the record kept for retention is the one in LeaseOS.");
      }
      if (input.connectionType === "bluetooth_classic" && input.iosMfiCertified == null) {
        notes.push("Bluetooth Classic on iOS needs Apple MFi certification. Recorded as not established, not assumed.");
      }
      return { printerRef, notes };
    }),

  /** Assignments are superseded, never edited, so "which printer was in unit 14 that day" stays answerable. */
  assignPrinter: roleProcedure("printing.assignPrinter")
    .input(z.object({
      printerRef: z.string().min(1).max(40),
      assignedToType: z.enum(["unit", "yard", "office"]),
      assignedToId: z.number().int().positive().nullish(),
    }))
    .mutation(async ({ ctx, input }) => {
      const { db, orgRef } = await scopeFor(ctx.user.id);
      if (input.assignedToType === "unit" && !input.assignedToId) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "Assigning a printer to a unit must name the unit" });
      }
      const printer = (await db.select().from(fieldPrinters).where(eq(fieldPrinters.printerRef, input.printerRef)).limit(1))[0];
      if (!printer || !inScope(printer.orgRef, orgRef)) throw new TRPCError({ code: "NOT_FOUND", message: `No printer ${input.printerRef}` });
      if (printer.status === "retired") throw new TRPCError({ code: "BAD_REQUEST", message: "A retired printer cannot be assigned" });
      if (input.assignedToType === "unit") {
        const unit = (await db.select({ id: units.id }).from(units).where(eq(units.id, input.assignedToId as number)).limit(1))[0];
        if (!unit) throw new TRPCError({ code: "NOT_FOUND", message: `No unit ${input.assignedToId}` });
      }
      const now = new Date();
      await db.transaction(async (tx) => {
        // Two assignments recorded at once must not leave the printer in two places.
        await tx.select({ id: fieldPrinters.id }).from(fieldPrinters).where(eq(fieldPrinters.id, printer.id)).for("update");
        await tx.update(fieldPrinterAssignments)
          .set({ assignedUntil: now, endedByUserId: ctx.user.id })
          .where(and(eq(fieldPrinterAssignments.printerId, printer.id), isNull(fieldPrinterAssignments.assignedUntil)));
        await tx.insert(fieldPrinterAssignments).values({
          printerId: printer.id, assignedToType: input.assignedToType, assignedToId: input.assignedToId ?? null,
          assignedFrom: now, assignedByUserId: ctx.user.id,
        });
      });
      return { printerRef: printer.printerRef, assignedToType: input.assignedToType, assignedToId: input.assignedToId ?? null, note: "Any earlier assignment was ended, not overwritten." };
    }),

  listPrinters: roleProcedure("printing.listPrinters")
    .query(async ({ ctx }) => {
      const { db, orgRef } = await scopeFor(ctx.user.id);
      const printers = await db.select().from(fieldPrinters).where(orgRef ? eq(fieldPrinters.orgRef, orgRef) : isNull(fieldPrinters.orgRef));
      if (printers.length === 0) return [];
      const open = await db.select().from(fieldPrinterAssignments)
        .where(and(inArray(fieldPrinterAssignments.printerId, printers.map(p => p.id)), isNull(fieldPrinterAssignments.assignedUntil)));
      return printers.map(p => {
        const a = open.find(x => x.printerId === p.id);
        return { ...p, assignment: a ? { assignedToType: a.assignedToType, assignedToId: a.assignedToId, assignedFrom: a.assignedFrom } : null };
      });
    }),

  /** The same check the device runs before it prints. No side effects. */
  assess: roleProcedure("printing.assess")
    .input(z.object({ documentClass: CLASS, fields: z.array(FIELD).max(400) }))
    .query(({ input }) => assessPrintability(input.documentClass, input.fields)),

  record: roleProcedure("printing.record")
    .input(z.object({
      documentRef: z.string().min(1).max(40),
      printerRef: z.string().min(1).max(40),
      documentClass: CLASS,
      fields: z.array(FIELD).max(400),
      outcome: z.enum(["printed", "failed"]),
      failureReason: z.string().max(500).nullish(),
      printedAt: z.coerce.date().nullish(),
      printedOffline: z.boolean().default(false),
    }))
    .mutation(async ({ ctx, input }) => {
      const { db, orgRef } = await scopeFor(ctx.user.id);
      if (input.outcome === "failed" && !input.failureReason?.trim()) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "A failed print must say why" });
      }
      /*
       * Offline prints arrive late, which is expected. One that claims to have happened in the future
       * is a device clock, and an audit built on it would be wrong in a way nobody could see.
       */
      if (input.printedAt && input.printedAt.getTime() > Date.now() + 5 * 60 * 1000) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "The print time is in the future" });
      }
      const doc = (await db.select().from(commercialDocuments).where(eq(commercialDocuments.documentRef, input.documentRef)).limit(1))[0];
      if (!doc || !inScope(doc.bookOrgRef, orgRef)) throw new TRPCError({ code: "NOT_FOUND", message: `No document ${input.documentRef}` });
      const printer = (await db.select().from(fieldPrinters).where(eq(fieldPrinters.printerRef, input.printerRef)).limit(1))[0];
      if (!printer || !inScope(printer.orgRef, orgRef)) throw new TRPCError({ code: "NOT_FOUND", message: `No printer ${input.printerRef}` });

      const assessment = assessPrintability(input.documentClass, input.fields);
      /*
       * A print the check refused is still recorded if it produced paper. Refusing to record it would
       * not unprint it — it would only remove the one record that the paper exists. It goes in
       * flagged, and the caller is told. The same reasoning records paper of a version that was
       * superseded while the device was out of signal: stale on arrival, and said so.
       */
      const breach = input.outcome === "printed" && assessment.verdict === "refused";
      const printedAt = input.printedAt ?? new Date();

      const written = await db.transaction(async (tx) => {
        // Serialized per document, so two prints recorded at once cannot both be the original.
        await tx.select({ id: commercialDocuments.id }).from(commercialDocuments).where(eq(commercialDocuments.id, doc.id)).for("update");
        const prior = await tx.select({ status: commercialDocumentDeliveries.status }).from(commercialDocumentDeliveries)
          .where(and(eq(commercialDocumentDeliveries.documentId, doc.id), eq(commercialDocumentDeliveries.channel, "print")));
        const copyKind = input.outcome === "printed" ? copyKindFor(prior) : null;
        const deliveryRef = ref("DLV");
        await tx.insert(commercialDocumentDeliveries).values({
          deliveryRef,
          documentId: doc.id,
          channel: "print",
          recipientAddress: `${printer.manufacturer} ${printer.model} (${printer.printerRef})`.slice(0, 300),
          status: input.outcome === "printed" ? "sent" : "failed",
          sentAt: input.outcome === "printed" ? printedAt : null,
          sentByUserId: ctx.user.id,
          deliveryEvidence: printer.printerRef,
          failureReason: input.outcome === "failed" ? (input.failureReason ?? null) : null,
          printerId: printer.id,
          copyKind,
          printabilityVerdict: assessment.verdict,
          printabilityDetail: JSON.stringify({ documentClass: input.documentClass, blockers: assessment.blockers, markings: assessment.markings }),
          printedOffline: input.printedOffline,
        });
        return { deliveryRef, copyKind };
      });

      const notes: string[] = [];
      if (breach) notes.push(`Printed although the paper check refused it (${assessment.blockers.map(b => b.label).join(", ")}). Recorded anyway and flagged, because the paper exists.`);
      if (input.outcome === "printed" && doc.status !== "current") notes.push(`This version is ${doc.status}; the paper was stale when it was recorded.`);
      if (written.copyKind === "reprint") notes.push("Recorded as a REPRINT: the original of this version was printed earlier.");
      if (input.outcome === "printed" && printer.printTechnology === "direct_thermal" && input.documentClass === "regulatory") {
        notes.push("Direct thermal paper fades. The record kept for retention is the one in LeaseOS, not this paper.");
      }
      return { ...written, assessment, policyBreach: breach, documentStatus: doc.status, notes };
    }),

  /** Paper printed from any version of this document that is no longer current. */
  staleCopies: roleProcedure("printing.staleCopies")
    .input(z.object({ documentRef: z.string().min(1).max(40) }))
    .query(async ({ ctx, input }) => {
      const { db, orgRef } = await scopeFor(ctx.user.id);
      const start = (await db.select().from(commercialDocuments).where(eq(commercialDocuments.documentRef, input.documentRef)).limit(1))[0];
      if (!start || !inScope(start.bookOrgRef, orgRef)) throw new TRPCError({ code: "NOT_FOUND", message: `No document ${input.documentRef}` });
      /*
       * Walk the version chain both ways from whichever version was named. Bounded, and a chain that
       * loops is an error: a malformed chain should be reported, not walked forever.
       */
      const chain = [start];
      const seen: Record<number, true> = {};
      seen[start.id] = true;
      for (const direction of ["back", "forward"] as const) {
        let cursor = start;
        for (let steps = 0; steps < 500; steps++) {
          const nextId = direction === "back" ? cursor.supersedesDocumentId : cursor.supersededByDocumentId;
          if (!nextId) break;
          if (seen[nextId]) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: `The version chain of ${input.documentRef} loops at document ${nextId}` });
          const next = (await db.select().from(commercialDocuments).where(eq(commercialDocuments.id, nextId)).limit(1))[0];
          if (!next) break;
          seen[nextId] = true;
          chain.push(next);
          cursor = next;
        }
      }
      const prints = await db.select().from(commercialDocumentDeliveries)
        .where(and(inArray(commercialDocumentDeliveries.documentId, chain.map(d => d.id)), eq(commercialDocumentDeliveries.channel, "print")));
      const view: ChainDocument[] = chain.map(d => ({ id: d.id, documentRef: d.documentRef, version: d.version, status: d.status }));
      return {
        versions: view.slice().sort((a, b) => a.version - b.version).map(d => ({ documentRef: d.documentRef, version: d.version, status: d.status })),
        stale: staleCopies(view, prints.map(p => ({ deliveryRef: p.deliveryRef, documentId: p.documentId, status: p.status, copyKind: p.copyKind ?? null, sentAt: p.sentAt ?? null }))),
      };
    }),
});
