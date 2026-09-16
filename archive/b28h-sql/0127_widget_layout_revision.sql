-- v22.23 (planned) — 0127: renumbered from B28h sql/0090_widget_layout_revision.sql; NOT in drizzle/ until the B28 reconciliation checkpoint applies it.

-- B26 — 0090: a layout has a revision.
--
-- Offline editing needs a way to notice that the board moved underneath it.
-- A driver stages a reorder in a coulee; dispatch changes the same board from
-- the office; the truck reconnects. Without a revision the later write wins
-- silently and somebody's work disappears with no error and no trace.
--
-- The column is an integer incremented inside the same transaction as the
-- write it describes, and the update carries `WHERE revision = :expected`, so
-- the check and the write cannot be separated by another connection. A
-- timestamp would have been tempting and wrong: two saves inside one second
-- are exactly the case this has to catch.

ALTER TABLE `widgetLayouts`
  ADD COLUMN `revision` int NOT NULL DEFAULT 1;
--> statement-breakpoint
-- Existing rows start at 1 rather than 0, so "never saved" and "saved once"
-- are not both zero to a client comparing them.
UPDATE `widgetLayouts` SET `revision` = 1 WHERE `revision` = 0;
