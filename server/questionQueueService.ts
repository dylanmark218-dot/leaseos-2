/**
 * The persistent question queue.
 *
 * An unanswered question is a row, not a modal. A driver photographs a receipt
 * at a fuel stop, the total needs confirming, and the phone dies — the question
 * is still there in the morning, attached to the proposal, with the OCR's
 * reading and the region text alongside it.
 *
 * Answering a question does not confirm a field. It records the answer, with
 * who gave it and how; the proposal's read-back and commit path still apply.
 */

import { and, desc, eq } from "drizzle-orm";
import { getDb } from "./db";
import { assistantQuestions } from "../drizzle/schema";
import type { ExtractionQuestion } from "./_core/documentExtraction";

export async function persistQuestions(args: {
  proposalId: string;
  askedToUserId: number;
  questions: readonly ExtractionQuestion[];
}): Promise<string[]> {
  const db = await getDb();
  if (!db) return [];
  const refs: string[] = [];

  // Re-extracting supersedes earlier pending questions on the same proposal
  // rather than stacking duplicates.
  await db
    .update(assistantQuestions)
    .set({ status: "superseded" })
    .where(
      and(
        eq(assistantQuestions.proposalId, args.proposalId),
        eq(assistantQuestions.status, "pending")
      )
    );

  for (const q of args.questions) {
    const questionRef = `Q-${args.proposalId.slice(0, 24)}-${q.fieldKey}-${Date.now().toString(36)}`.slice(0, 64);
    await db.insert(assistantQuestions).values({
      questionRef,
      proposalId: args.proposalId,
      fieldKey: q.fieldKey,
      question: q.question.slice(0, 400),
      reason: q.reason,
      optionsJson: q.options ? JSON.stringify(q.options) : null,
      priority: q.priority,
      askedToUserId: args.askedToUserId,
      status: "pending",
    });
    refs.push(questionRef);
  }
  return refs;
}

export async function pendingQuestionsFor(userId: number) {
  const db = await getDb();
  if (!db) return [];
  return db
    .select()
    .from(assistantQuestions)
    .where(
      and(
        eq(assistantQuestions.askedToUserId, userId),
        eq(assistantQuestions.status, "pending")
      )
    )
    .orderBy(desc(assistantQuestions.priority), assistantQuestions.createdAt);
}

export async function answerQuestion(args: {
  questionRef: string;
  answeredByUserId: number;
  answerValue: string;
  answerSource: "typed" | "voice" | "selected";
}): Promise<{ ok: true } | { ok: false; reason: string }> {
  const db = await getDb();
  if (!db) return { ok: false, reason: "Database unavailable" };

  const rows = await db
    .select()
    .from(assistantQuestions)
    .where(eq(assistantQuestions.questionRef, args.questionRef))
    .limit(1);
  const q = rows[0];
  if (!q) return { ok: false, reason: "No such question" };
  if (q.status !== "pending") return { ok: false, reason: `Question is ${q.status}` };
  // The person it was asked of answers it. A dispatcher does not answer a
  // driver's "what was the total" on the driver's behalf.
  if (q.askedToUserId !== null && q.askedToUserId !== args.answeredByUserId) {
    return { ok: false, reason: "Question was asked of a different user" };
  }
  if (q.optionsJson) {
    const options = JSON.parse(q.optionsJson) as string[];
    if (!options.includes(args.answerValue)) {
      return { ok: false, reason: `Answer must be one of: ${options.join(", ")}` };
    }
  }

  await db
    .update(assistantQuestions)
    .set({
      status: "answered",
      answerValue: args.answerValue,
      answerSource: args.answerSource,
      answeredByUserId: args.answeredByUserId,
      answeredAt: new Date(),
    })
    .where(eq(assistantQuestions.questionRef, args.questionRef));
  return { ok: true };
}
