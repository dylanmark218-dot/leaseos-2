/**
 * Commercial chain numbering — the one allocator behind `JOB-…-C01`, `-S01` and `-L001`.
 *
 * Lifted out of contractorOperationsRouter at 0238 so the marketplace bridge numbers the chain it
 * creates from an award the same way a contractor-office chain is numbered, from the same
 * `commercialChainSequences` row under the same lock, rather than with a second allocator that
 * could drift.
 */
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { commercialChainSequences } from "../../drizzle/schema";
import type { Tx } from "./dbTypes";

/** The next value for `scopeRef`, allocated under the row lock inside the caller's transaction. */
export const nextSequence = async (tx: Tx, scopeRef: string): Promise<number> => {
  await tx.insert(commercialChainSequences).values({ scopeRef, nextValue: 1 }).onDuplicateKeyUpdate({ set: { scopeRef } });
  const [row] = await tx.select().from(commercialChainSequences).where(eq(commercialChainSequences.scopeRef, scopeRef)).for("update").limit(1);
  if (!row) throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: "Sequence allocation failed." });
  const value = row.nextValue;
  await tx.update(commercialChainSequences).set({ nextValue: value + 1 }).where(eq(commercialChainSequences.scopeRef, scopeRef));
  return value;
};

export const pad2 = (n: number) => String(n).padStart(2, "0");
