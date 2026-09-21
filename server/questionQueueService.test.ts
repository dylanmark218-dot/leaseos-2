import { beforeAll, describe, expect, it } from "vitest";
import mysql from "mysql2/promise";
import { answerQuestion, pendingQuestionsFor, persistQuestions } from "./questionQueueService";

const URL = process.env.DATABASE_URL;
const d = URL ? describe : describe.skip;
let pool: mysql.Pool;
let nextId = 910000 + Math.floor(Math.random() * 50000);
const user = () => nextId++;

beforeAll(async () => {
  if (!URL) return;
  pool = mysql.createPool({ uri: URL, connectionLimit: 4 });
});

d("an unanswered question is a row, not a modal", () => {
  it("persists questions in priority order for the person asked", async () => {
    const driver = user();
    const proposalId = `P-${driver}`;
    await persistQuestions({
      proposalId, askedToUserId: driver,
      questions: [
        { fieldKey: "categoryKey", question: "Category?", reason: "low_confidence", options: ["fuel", "other"], priority: 60 },
        { fieldKey: "total", question: "Confirm total: 546", reason: "sensitive_human_only", priority: 95 },
      ],
    });
    const pending = await pendingQuestionsFor(driver);
    expect(pending.map(q => q.fieldKey)).toEqual(["total", "categoryKey"]);
    expect(pending[0].reason).toBe("sensitive_human_only");
  });

  it("supersedes earlier pending questions when a proposal is re-extracted", async () => {
    const driver = user();
    const proposalId = `P-${driver}`;
    await persistQuestions({ proposalId, askedToUserId: driver, questions: [
      { fieldKey: "total", question: "v1", reason: "sensitive_human_only", priority: 95 },
    ]});
    await persistQuestions({ proposalId, askedToUserId: driver, questions: [
      { fieldKey: "total", question: "v2", reason: "sensitive_human_only", priority: 95 },
    ]});
    const pending = await pendingQuestionsFor(driver);
    expect(pending).toHaveLength(1);
    expect(pending[0].question).toBe("v2");
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT status FROM assistantQuestions WHERE proposalId = ? AND question = 'v1'", [proposalId]
    );
    expect(rows[0].status).toBe("superseded");
  });

  it("lets only the person asked answer, and validates against the options", async () => {
    const driver = user();
    const dispatcher = user();
    const [ref] = await persistQuestions({ proposalId: `P-${driver}`, askedToUserId: driver, questions: [
      { fieldKey: "categoryKey", question: "Category?", reason: "low_confidence", options: ["fuel", "other"], priority: 60 },
    ]});

    const wrongPerson = await answerQuestion({ questionRef: ref, answeredByUserId: dispatcher, answerValue: "fuel", answerSource: "selected" });
    expect(wrongPerson.ok).toBe(false);

    const offList = await answerQuestion({ questionRef: ref, answeredByUserId: driver, answerValue: "lodging", answerSource: "selected" });
    expect(offList.ok).toBe(false);
    if (!offList.ok) expect(offList.reason).toContain("must be one of");

    const ok = await answerQuestion({ questionRef: ref, answeredByUserId: driver, answerValue: "fuel", answerSource: "selected" });
    expect(ok.ok).toBe(true);

    const again = await answerQuestion({ questionRef: ref, answeredByUserId: driver, answerValue: "fuel", answerSource: "selected" });
    expect(again.ok).toBe(false);
    expect(await pendingQuestionsFor(driver)).toHaveLength(0);
  });

  it("records who answered and how, without confirming the field", async () => {
    // Answering is an answer. Confirmation is still the read-back and commit.
    const driver = user();
    const [ref] = await persistQuestions({ proposalId: `P-${driver}`, askedToUserId: driver, questions: [
      { fieldKey: "total", question: "Confirm total", reason: "sensitive_human_only", priority: 95 },
    ]});
    await answerQuestion({ questionRef: ref, answeredByUserId: driver, answerValue: "546", answerSource: "voice" });
    const [rows] = await pool.execute<mysql.RowDataPacket[]>(
      "SELECT answerSource, answeredByUserId, answeredAt FROM assistantQuestions WHERE questionRef = ?", [ref]
    );
    expect(rows[0].answerSource).toBe("voice");
    expect(Number(rows[0].answeredByUserId)).toBe(driver);
    expect(rows[0].answeredAt).not.toBeNull();
  });
});
