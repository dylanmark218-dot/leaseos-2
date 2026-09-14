import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { grantUserRole } from "./db";
import { executeAssistantCommit } from "./_core/assistantCommitService";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let seq = 980000 + Math.floor(Math.random() * 10000);
const nextUser = () => seq++;
const key = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

beforeAll(async () => {
  if (!URL) return;
  pool = mysql.createPool({ uri: URL, connectionLimit: 4 });
});

async function role(userId: number, name: "office" | "management" | "bookkeeper" | "dispatcher") {
  await grantUserRole({
    userId,
    role: name,
    scopeType: "global",
    grantedByUserId: 1,
    grantedAt: new Date(),
  });
}

async function insertFields(
  proposalId: string,
  fields: Array<[string, string, string | number | boolean]>
) {
  for (const [fieldKey, label, value] of fields) {
    await pool.execute(
      `INSERT INTO proposalFields
       (proposalId, fieldKey, label, fieldValue, \`precision\`, source, confidence, status)
       VALUES (?, ?, ?, ?, 'exact', 'human_corrected', 'high', 'confirmed')`,
      [proposalId, fieldKey, label, JSON.stringify(value)]
    );
  }
}

d("typed Assistant commit service", () => {
  it("updates an unload trip stop exactly once and leaves an idempotent receipt", async () => {
    const actor = nextUser();
    await role(actor, "office");
    const tripId = 700000 + Math.floor(Math.random() * 100000);
    const [stopInsert] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO tripStops (tripId, stopType, sequence, notes) VALUES (?, 'unload', 1, 'existing note')",
      [tripId]
    );
    const stopId = Number(stopInsert.insertId);
    const proposalId = key("PROP-UNLOAD");

    await pool.execute(
      `INSERT INTO assistantProposals
       (proposalId, formKey, formVersion, title, targetRef, targetRecordId,
        eventDateLocal, utcOffsetMinutes, tripId, createdByUserId,
        readBack, readBackAcknowledged, commitState)
       VALUES (?, 'unload_stop', 1, 'Unload stop', ?, ?, '2026-09-09', -360,
               ?, ?, 'confirmed readback', 1, 'awaiting_readback')`,
      [proposalId, `TRIP-${tripId} unload stop`, stopId, tripId, actor]
    );
    await insertFields(proposalId, [
      ["arrivedAt", "Arrived", "10:00"],
      ["waitMinutes", "Wait", 8],
      ["delayReason", "Delay reason", "Queue"],
      ["operationStartedAt", "Unloading started", "10:15"],
      ["operationCompletedAt", "Unloading complete", "10:40"],
      ["quantity", "Quantity", 8000],
      ["measurementMethod", "Measured by", "Meter"],
    ]);

    const first = await executeAssistantCommit({ proposalId, actorUserId: actor });
    expect(first.committed).toBe(true);
    if (!first.committed) return;
    expect(first.replayed).toBe(false);
    expect(first.targetType).toBe("trip_stop");
    expect(first.targetRecordId).toBe(stopId);

    const second = await executeAssistantCommit({ proposalId, actorUserId: actor });
    expect(second.committed).toBe(true);
    if (!second.committed) return;
    expect(second.replayed).toBe(true);
    expect(second.receiptId).toBe(first.receiptId);

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT quantity, quantityUnit, waitMinutes, notes, arrivedAt, operationStartedAt, operationCompletedAt FROM tripStops WHERE id = ?",
      [stopId]
    );
    expect(Number(rows[0].quantity)).toBe(8000);
    expect(rows[0].quantityUnit).toBe("L");
    expect(Number(rows[0].waitMinutes)).toBe(8);
    expect(rows[0].arrivedAt).not.toBeNull();
    expect(rows[0].operationStartedAt).not.toBeNull();
    expect(rows[0].operationCompletedAt).not.toBeNull();
    expect(String(rows[0].notes).match(/Assistant-confirmed delay reason/g)?.length).toBe(1);

    const [receipts] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT fieldManifestHash, requiredPermission FROM assistantCommitReceipts WHERE proposalId = ?",
      [proposalId]
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0].requiredPermission).toBe("trip.write");
    expect(String(receipts[0].fieldManifestHash)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("creates an advisory defect observation and cross-checks the structured unit id", async () => {
    const actor = nextUser();
    await role(actor, "office");
    const unitNumber = key("VAC").slice(0, 40);
    const [unitInsert] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO units (unitNumber, vehicleType) VALUES (?, 'hydrovac')",
      [unitNumber]
    );
    const unitId = Number(unitInsert.insertId);
    const proposalId = key("PROP-DEFECT");

    await pool.execute(
      `INSERT INTO assistantProposals
       (proposalId, formKey, formVersion, title, targetRef, unitId, createdByUserId,
        readBack, readBackAcknowledged, commitState)
       VALUES (?, 'defect_report', 1, 'Defect report', ?, ?, ?,
               'confirmed readback', 1, 'awaiting_readback')`,
      [proposalId, unitNumber, unitId, actor]
    );
    await insertFields(proposalId, [
      ["unitNumber", "Unit", unitNumber],
      ["system", "System", "Brakes"],
      ["observation", "What you noticed", "Pedal feels softer than yesterday"],
      ["isNew", "New since last trip", true],
    ]);

    const result = await executeAssistantCommit({ proposalId, actorUserId: actor });
    expect(result.committed).toBe(true);
    if (!result.committed) return;
    expect(result.targetType).toBe("maintenance_defect");

    const [defects] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT unitId, severity, status, title, detail FROM maintenanceDefects WHERE id = ?",
      [result.targetRecordId]
    );
    expect(Number(defects[0].unitId)).toBe(unitId);
    expect(defects[0].severity).toBe("advisory");
    expect(defects[0].status).toBe("open");
    expect(defects[0].title).toContain("Brakes observation");
    expect(defects[0].detail).toBe("Pedal feels softer than yesterday");
  });

  it("commits a photographed receipt to an expense DRAFT with treatment untouched", async () => {
    // v20.15. The receipt was read by OCR, every money field was confirmed by
    // a human, and the result is a draft whose tax treatment nobody has
    // decided — because OCR is not an accountant.
    const actor = nextUser();
    await role(actor, "bookkeeper");

    const [ent] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction, ownerUserId) VALUES (?, 'Receipt Test Co', 'corporation', 'CA-AB', ?)",
      [key("ENT").slice(0, 40), actor]
    );
    const entityId = Number(ent.insertId);
    const proposalId = key("PROP-RECEIPT");

    await pool.execute(
      `INSERT INTO assistantProposals
       (proposalId, formKey, formVersion, title, targetRef, targetRecordId,
        createdByUserId, readBack, readBackAcknowledged, commitState)
       VALUES (?, 'expense_receipt', 1, 'Expense receipt', ?, ?, ?, 'confirmed readback', 1, 'awaiting_readback')`,
      [proposalId, `ENT-${entityId}`, entityId, actor]
    );
    // Unique per run: the fingerprint gate now enforces document uniqueness,
    // so a fixed vendor/date/total would collide with a previous run's receipt.
    const vendor = key("Fuel Stop");
    await insertFields(proposalId, [
      ["vendorName", "Vendor", vendor],
      ["transactionDate", "Date", "2026-09-08"],
      ["total", "Total", 546],
      ["subtotal", "Subtotal", 520],
      ["salesTaxAmount", "Sales tax", 26],
      ["currency", "Currency", "CAD"],
    ]);

    const first = await executeAssistantCommit({ proposalId, actorUserId: actor });
    expect(first.committed, JSON.stringify(first)).toBe(true);
    if (!first.committed) return;
    expect(first.targetType).toBe("expense_record");

    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT status, taxTreatment, treatmentDeterminedByUserId, total, vendorName, categorySource, financialEntityId FROM expenseRecords WHERE id = ?",
      [first.targetRecordId]
    );
    expect(rows[0].status).toBe("draft");
    // The whole point: a receipt is not a deduction.
    expect(rows[0].taxTreatment).toBe("unknown_review_required");
    expect(rows[0].treatmentDeterminedByUserId).toBeNull();
    expect(Number(rows[0].total)).toBe(546);
    expect(rows[0].vendorName).toBe(vendor);
    expect(rows[0].categorySource).toBe("ai_proposed");
    expect(Number(rows[0].financialEntityId)).toBe(entityId);

    // Idempotent, like the other targets.
    const second = await executeAssistantCommit({ proposalId, actorUserId: actor });
    expect(second.committed && second.replayed).toBe(true);

    const [receipts] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT targetType, requiredPermission FROM assistantCommitReceipts WHERE proposalId = ?",
      [proposalId]
    );
    expect(receipts).toHaveLength(1);
    expect(receipts[0].targetType).toBe("expense_record");
    expect(receipts[0].requiredPermission).toBe("tax.expense.create");
  });

  it("refuses a receipt commit from a role without tax.expense.create", async () => {
    // Holding assistant.commit is not authority to write into the books.
    const actor = nextUser();
    await role(actor, "dispatcher");
    const [ent] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO financialEntities (entityRef, legalName, taxpayerType, jurisdiction, ownerUserId) VALUES (?, 'Refuse Co', 'corporation', 'CA-AB', ?)",
      [key("ENT").slice(0, 40), actor]
    );
    const proposalId = key("PROP-RECEIPT-NO");
    await pool.execute(
      `INSERT INTO assistantProposals
       (proposalId, formKey, formVersion, title, targetRef, targetRecordId,
        createdByUserId, readBack, readBackAcknowledged, commitState)
       VALUES (?, 'expense_receipt', 1, 'Expense receipt', 'ENT', ?, ?, 'ok', 1, 'awaiting_readback')`,
      [proposalId, Number(ent.insertId), actor]
    );
    await insertFields(proposalId, [
      ["vendorName", "Vendor", "X"], ["transactionDate", "Date", "2026-09-08"],
      ["total", "Total", 10], ["subtotal", "Subtotal", 10], ["salesTaxAmount", "Sales tax", 0],
    ]);
    const r = await executeAssistantCommit({ proposalId, actorUserId: actor });
    expect(r.committed).toBe(false);
    if (!r.committed) expect(r.refusals.join(" ")).toMatch(/tax\.expense\.create|permission|not authorized/i);
  });

  it("requires the target-domain permission in addition to assistant.commit", async () => {
    const actor = nextUser();
    // Management can assistant.commit and trip.write, but intentionally does
    // NOT hold maintenance.write_defect. The second gate must still refuse.
    await role(actor, "management");
    const unitNumber = key("VAC").slice(0, 40);
    const [unitInsert] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO units (unitNumber, vehicleType) VALUES (?, 'hydrovac')",
      [unitNumber]
    );
    const unitId = Number(unitInsert.insertId);
    const proposalId = key("PROP-DENY");

    await pool.execute(
      `INSERT INTO assistantProposals
       (proposalId, formKey, formVersion, title, targetRef, unitId, createdByUserId,
        readBack, readBackAcknowledged, commitState)
       VALUES (?, 'defect_report', 1, 'Defect report', ?, ?, ?,
               'confirmed readback', 1, 'awaiting_readback')`,
      [proposalId, unitNumber, unitId, actor]
    );
    await insertFields(proposalId, [
      ["unitNumber", "Unit", unitNumber],
      ["system", "System", "Brakes"],
      ["observation", "What you noticed", "New vibration"],
      ["isNew", "New since last trip", true],
    ]);

    const result = await executeAssistantCommit({ proposalId, actorUserId: actor });
    expect(result.committed).toBe(false);
    if (result.committed) return;
    expect(result.refusals.join(" ")).toMatch(/maintenance\.write_defect/);

    const [receipts] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT id FROM assistantCommitReceipts WHERE proposalId = ?",
      [proposalId]
    );
    expect(receipts).toHaveLength(0);
    const [audits] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT outcome, permission FROM authorizationDecisions WHERE actorUserId = ? AND procedureName = 'assistant.commit.target.maintenance_defect' ORDER BY id DESC LIMIT 1",
      [actor]
    );
    expect(audits[0].outcome).toBe("denied_permission");
    expect(audits[0].permission).toBe("maintenance.write_defect");
  });

  it("commits a scanned disposal ticket as needs_review, refuses the same ticket twice, and never advances the load", async () => {
    const actor = nextUser();
    await role(actor, "office");

    const [fac] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO facilities (name, status) VALUES (?, 'unknown')",
      [key("Northgate").slice(0, 60)]
    );
    const facilityId = Number(fac.insertId);
    const loadNumber = key("LD").slice(0, 40);
    const [ld] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO loads (loadNumber, jobId, measurementMethod, chainState) VALUES (?, 1, 'scale', 'arrived_disposal')",
      [loadNumber]
    );
    const loadId = Number(ld.insertId);

    const makeProposal = async () => {
      const proposalId = key("PROP-DSP");
      await pool.execute(
        `INSERT INTO assistantProposals
         (proposalId, formKey, formVersion, title, targetRef, loadId, facilityId, utcOffsetMinutes,
          createdByUserId, readBack, readBackAcknowledged, commitState)
         VALUES (?, 'disposal_ticket', 1, 'Disposal ticket', ?, ?, ?, -360, ?, 'ok', 1, 'awaiting_readback')`,
        [proposalId, loadNumber, loadId, facilityId, actor]
      );
      await insertFields(proposalId, [
        ["facilityName", "Facility", "Northgate"],
        ["facilityTicketNumber", "Ticket", "A-88431"],
        ["loadRef", "Load", loadNumber],
        ["ticketDate", "Date", "2026-09-09"],
        ["grossWeightKg", "Gross", 41200],
        ["tareWeightKg", "Tare", 18400],
        ["netWeightKg", "Net", 22800],
      ]);
      return proposalId;
    };

    const p1 = await makeProposal();
    const first = await executeAssistantCommit({ proposalId: p1, actorUserId: actor });
    expect(first.committed, JSON.stringify(first)).toBe(true);
    if (!first.committed) return;
    expect(first.targetType).toBe("disposal_ticket");

    const [tickets] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT verificationStatus, source, netKg, quantityUnit, loadId, facilityId, facilityTicketNumber FROM disposalTickets WHERE id = ?",
      [first.targetRecordId]
    );
    // The whole point: needs_review, so billing's verified count does not move.
    expect(tickets[0].verificationStatus).toBe("needs_review");
    expect(tickets[0].source).toBe("photo_ocr");
    expect(Number(tickets[0].netKg)).toBe(22800);
    expect(tickets[0].quantityUnit).toBe("kg");
    expect(Number(tickets[0].loadId)).toBe(loadId);
    expect(Number(tickets[0].facilityId)).toBe(facilityId);

    // The load's chain state is the verifier's to advance, not the scanner's.
    const [loadRows] = await pool.execute<mysql.RowDataPacket[]>("SELECT chainState FROM loads WHERE id = ?", [loadId]);
    expect(loadRows[0].chainState).toBe("arrived_disposal");

    // The same facility ticket captured again by the office is refused, not
    // duplicated. Two layers catch it: the fingerprint gate (v20.17) sees the
    // same facility+ticket+load key first; the write path's own check
    // ("already recorded for this load") stands behind it. Either refusal is
    // correct; the outer one wins.
    const p2 = await makeProposal();
    const second = await executeAssistantCommit({ proposalId: p2, actorUserId: actor });
    expect(second.committed).toBe(false);
    if (!second.committed) {
      expect(second.refusals.join(" ")).toMatch(/Duplicate gate|already recorded for this load/);
      expect(second.duplicate).toBe("possible_duplicate");
    }

    const [count] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT COUNT(*) AS n FROM disposalTickets WHERE loadId = ? AND facilityTicketNumber = 'A-88431'", [loadId]
    );
    expect(Number(count[0].n)).toBe(1);
  });

  it("refuses a disposal ticket from a role without load.write", async () => {
    const actor = nextUser();
    await role(actor, "bookkeeper");
    const [fac] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO facilities (name, status) VALUES (?, 'unknown')", [key("F").slice(0, 60)]);
    const loadNumber = key("LDR").slice(0, 40);
    const [ld] = await pool.execute<mysql.ResultSetHeader>(
      "INSERT INTO loads (loadNumber, jobId, measurementMethod, chainState) VALUES (?, 1, 'scale', 'arrived_disposal')", [loadNumber]
    );
    const proposalId = key("PROP-DSP-R");
    await pool.execute(
      `INSERT INTO assistantProposals
       (proposalId, formKey, formVersion, title, targetRef, loadId, facilityId, utcOffsetMinutes, createdByUserId, readBack, readBackAcknowledged, commitState)
       VALUES (?, 'disposal_ticket', 1, 'Disposal ticket', ?, ?, ?, -360, ?, 'ok', 1, 'awaiting_readback')`,
      [proposalId, loadNumber, Number(ld.insertId), Number(fac.insertId), actor]
    );
    await insertFields(proposalId, [
      ["facilityName", "F", "F"], ["facilityTicketNumber", "T", "R-1"], ["loadRef", "L", loadNumber],
      ["ticketDate", "D", "2026-09-09"], ["netWeightKg", "N", 1000],
    ]);
    const r = await executeAssistantCommit({ proposalId, actorUserId: actor });
    expect(r.committed).toBe(false);
    if (!r.committed) expect(r.refusals.join(" ")).toMatch(/load\.write|permission|forbidden/i);
  });

});
