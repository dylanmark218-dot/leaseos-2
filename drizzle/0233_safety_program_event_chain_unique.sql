-- 0233 — Safety program event ledger: one successor per event.
--
-- Slot: 0228 (the Safety & Compliance Program Builder) merged to main as #99 on 2026-10-03. A scan of main and
-- all 133 remote branches the same day found 0229–0232 held by `claude/integration-hub-subsystem-6nzrkw` and
-- nothing above, so this follow-up takes 0233. It is a separate migration, not an edit to 0228: the migration
-- ledger checksums every applied file and refuses one that changed, so a database that has run 0228 would
-- never see an edited copy.
--
-- Why. `safetyProgramEvents` is a hash chain: each row stores the previous row's hash. The writer read the head
-- and inserted without any guard, so two concurrent writers could both link to the same head and fork the
-- chain; `events({ verifyChain: true })` would then report a break that was never tampering. With
-- `previousHash` UNIQUE, the second writer's insert is refused and it re-reads the head and retries (the router
-- does this), so concurrency extends the chain instead of forking it — the same discipline main's document
-- register keeps with its unique per-document sequence.
--
-- Fails closed. If a database already holds a fork (two rows with one previousHash), this ALTER fails rather
-- than silently deleting audit rows; a person reviews the fork before the index is added.
ALTER TABLE `safetyProgramEvents`
  ADD UNIQUE KEY `safetyProgramEvents_previousHash_unique` (`previousHash`);
