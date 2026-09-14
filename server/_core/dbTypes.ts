/**
 * v22.20 — the transaction handle, typed.
 *
 * Every transaction in this codebase took `tx: any`, which was the shortest way
 * past a signature mismatch and quietly switched off Drizzle's type checking
 * inside the block. Two schema mismatches shipped through that hole in one
 * checkpoint: a `maintenanceDefects.severity` of "out_of_service" and an
 * `actorSource` of "user", neither of which exists. Both failed at the database
 * on first run rather than at compile time, and both would have been caught
 * here.
 *
 * Naming the type once means the next transaction inherits the checking instead
 * of inheriting the `any`.
 */
import type { ExtractTablesWithRelations } from "drizzle-orm";
import type { MySql2Database, MySql2PreparedQueryHKT, MySql2QueryResultHKT } from "drizzle-orm/mysql2";
import type { MySqlTransaction } from "drizzle-orm/mysql-core";

export type Tx = MySqlTransaction<
  MySql2QueryResultHKT,
  MySql2PreparedQueryHKT,
  Record<string, unknown>,
  ExtractTablesWithRelations<Record<string, unknown>>
>;

/**
 * A database handle that is not inside a transaction. Same reason: `db: any`
 * turns off exactly the checking that catches a column that does not exist.
 */
export type Db = MySql2Database<Record<string, unknown>>;

/** Either. Most helpers work the same on both and should say so. */
export type DbOrTx = Db | Tx;
