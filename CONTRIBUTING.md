# Contributing to LeaseOS

## Branches

Branch from current `main`, one branch per change:

```
upgrade/<version>-<feature>    a product upgrade
feature/<name>                 a feature
fix/<name>                     a correction
docs/<name>                    documentation only
chore/<name>                   repository scaffolding
```

`main` is protected. **Do not push to it directly** — every change arrives through a pull
request, including documentation.

[BRANCH_STRATEGY.md](BRANCH_STRATEGY.md) describes the historical milestone, `upgrade/…`
and `candidate/…` branches. Those are for historical review and merge planning; do not
mistake them for isolated one-feature patches.

## Commits

Keep a commit to one idea. A reviewer should be able to read the message, read the diff,
and find nothing in the diff the message did not mention.

Do not mix a fix with a refactor, or a feature with a reformat. If a change needs a
supporting rename, make the rename its own commit.

Say _why_ in the message, not just _what_ — the diff already says what.

## Migrations

Migrations are numbered and append-only.

- **Never edit a migration that has been merged.** It has already run somewhere.
- **Never reuse a migration number.** Several branches are usually open at once, so check
  which numbers they already claim before taking one; the gate's first step refuses
  reserved slots.
- Adding a table or a nullable column is ordinary. Changing or dropping an existing one
  needs a plan for the rows that already exist.
- Do not delete historical rows, and do not silently deduplicate them.

## Generated truth

Several documents are generated, not written — `LEASEOS_CURRENT_STATE.md` is regenerated
by `scripts/current-state.sh`, and the gate's last step fails if the committed copy is
stale.

If your change moves a number in one of those documents, **regenerate it and commit the
result**. Do not hand-edit a generated file to match: the generator is the truth, and the
gate exists because a document that merely _claims_ something drifted from the code once
already and no run noticed.

## Checks before you push

```bash
pnpm check    # tsc --noEmit
pnpm test     # vitest run
```

Then the authoritative gate, on a database of its own:

```bash
DATABASE_URL="mysql://<user>@127.0.0.1:3306/leaseos_$(date +%s)" bash scripts/ci-gate.sh
```

The gate drops and recreates that database and a `<name>_widgets` companion. Never point
it at a database another run is using — two runs on one name corrupt each other and the
result looks like a set of unrelated test failures.

## Gates are not negotiable

The gate's pinned counts, authorization boundaries and type-error ceilings exist because
something once passed that should not have.

- **Do not weaken a check to make CI green.** Do not skip, disable or quarantine a test.
- **Do not loosen production validation so a test passes.** If a test and the production
  rule disagree, one of them is wrong — find out which before changing either.
- If a pinned count must move, move it in the same commit as the change that moves it,
  and say in the message what the new number counts.
- "Flaky" is a conclusion, not a starting assumption. Reproduce it, or find the shared
  state that caused it.

## Pull requests

The repository template asks for scope, compliance impact, migration impact, offline/sync
impact, tests, the gate result and a rollback plan. Fill it in from the change itself.

State the gate result honestly, including anything that failed and why you believe it is
unrelated — with the evidence that makes you believe it, such as the same suite passing on
`main` under the same conditions. An unexplained failure waved through is worse than a red
PR.

Where a change is meant to make something impossible, show that the test would fail if the
protection were removed. A test that passes against broken code protects nothing.

## Secrets

Never commit credentials, tokens, private keys, connection strings with passwords, or a
`.env` file. Never paste one into an issue, a pull request, a commit message or a log
excerpt.

Provider credentials belong server-side only. They must not appear in client bundles,
mobile bundles, client-visible API responses, logs, analytics or error messages.

If a secret is committed, treat it as disclosed: rotate it first, then clean up the
history. Removing the commit is not sufficient on its own.
