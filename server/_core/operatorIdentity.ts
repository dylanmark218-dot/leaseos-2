/**
 * An operator id is not a user id.
 *
 * `users.id` and `operators.id` come from different sequences. A person is linked to their
 * operator record through `operators.userId`, and the numbers on either side coincide only by
 * accident. Code that passes a user id where an operator id is expected works while they happen
 * to match and, when they do not, answers about whichever operator carries that number — another
 * person's hours, documents or readiness.
 *
 * `OperatorId` makes that mistake a type error where it matters: a bare `number` (a user id,
 * say) does not satisfy it. It is minted in two places only — the scoped lookup that resolves a
 * user to their operator record, and `operatorIdFromRecord` for a value read from a column that
 * already holds an operator id.
 */

declare const operatorIdBrand: unique symbol;
export type OperatorId = number & { readonly [operatorIdBrand]: true };

/** Only for a value read from an operator-id column (`operators.id`, `trips.operatorId`, …). Never for a user id. */
export const operatorIdFromRecord = (id: number): OperatorId => id as OperatorId;

/**
 * The caller's operator record in the acting scope.
 *
 * `none` and `ambiguous` are both refusals. `operators.userId` carries no unique constraint, so
 * more than one record can name the same person; which one is theirs is not something row order
 * gets to decide.
 */
export type OperatorResolution =
  | { kind: "resolved"; operatorId: OperatorId }
  | { kind: "none" }
  | { kind: "ambiguous" };
