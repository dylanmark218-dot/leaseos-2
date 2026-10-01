# LeaseOS FieldRoute

LeaseOS is a fleet and field-operations platform for commercial trucking and oilfield
transport: dispatch, driver and equipment records, hours-of-service and compliance,
maintenance, billing, and the portals that customers and external partners use.

It is a single TypeScript application — a React client, an Express + tRPC server and a
MariaDB schema managed by Drizzle — that is verified as one unit by a repository gate
rather than by per-package test scripts.

## Requirements

|                 |                                                               |
| --------------- | ------------------------------------------------------------- |
| Node            | **22** (see `.nvmrc`)                                         |
| Package manager | **pnpm 10.4.1**, pinned by `packageManager` in `package.json` |
| Database        | **MariaDB 10.11**                                             |

MariaDB, not MySQL. The migrations use MariaDB-only syntax — `0021_active_role_uniqueness.sql`
declares a generated column with `PERSISTENT`, which MySQL 8.0 rejects outright — and
`server/reservedWordColumns.test.ts` pins the reserved-word set that 10.11 reports.

pnpm comes from Corepack, so you do not install it separately:

```bash
corepack enable
```

Corepack reads the pinned version (and its integrity hash) from `package.json`.

## Layout

| Path       | Contents                                                                    |
| ---------- | --------------------------------------------------------------------------- |
| `client/`  | React 19 + Vite front end; `client/src/_core/` holds shared runtime pieces  |
| `server/`  | Express + tRPC server; `server/_core/` holds auth, context, env and engines |
| `shared/`  | Constants and types used by both sides                                      |
| `drizzle/` | Schema (`schema.ts`) and the numbered SQL migrations                        |
| `scripts/` | The CI gate and the generators for the state documents                      |
| `data/`    | Reference datasets the application reads                                    |
| `docs/`    | Design documents, product plans and the remaining-build register            |
| `audit/`   | Reconciliation and provenance evidence                                      |
| `archive/` | Historical source bundles kept for forensic comparison                      |
| `tools/`   | Developer utilities                                                         |

## Install

```bash
corepack enable
pnpm install --frozen-lockfile
```

Use `--frozen-lockfile`. The lockfile is committed and is the source of truth.

## Develop

```bash
pnpm dev
```

Runs the server with `tsx watch` and Vite middleware. The server reads its configuration
from the environment; see **Configuration** below.

## Checks

```bash
pnpm check    # tsc --noEmit over the production sources
pnpm test     # vitest run
pnpm build    # vite build + esbuild bundle of the server and worker
```

These are the fast local checks. They are not the gate.

## The authoritative gate

```bash
bash scripts/ci-gate.sh
```

This is what decides whether a change is acceptable, and it is what CI runs. Do not
replace it with a generic test command, and do not reimplement its steps in YAML. It
checks, in order: reserved migration slots · a freshly recreated database · migrations ·
schema parity · TypeScript · the test-file type-error ceiling · the authorization
boundaries for role, external and integration procedures · the complete Vitest suite ·
that no database-backed suite silently skipped · the production build · and that the
generated current-state document is not stale.

> **The gate destroys the database named in `DATABASE_URL`.**
>
> It issues `DROP DATABASE` / `CREATE DATABASE` for that database _and_ for a second
> `<name>_widgets` database. Point it only at a disposable one, and never at a database
> another gate run is using — two runs sharing a name will corrupt each other's schema
> and produce failures that look like unrelated test bugs.

Give every run its own name:

```bash
DATABASE_URL="mysql://<user>@127.0.0.1:3306/leaseos_$(date +%s)" bash scripts/ci-gate.sh
```

The account needs `DROP DATABASE` and `CREATE DATABASE` rights, which a scoped user
usually lacks.

## Configuration

`server/_core/env.ts` is the authority on configuration. It declares every variable the
server reads, and `assertProductionSecrets` runs at startup — before anything binds a
port — so a deployment that cannot authenticate anyone refuses to start rather than
serving unauthenticated traffic.

Read that file for the current list and its rules; one worth knowing is that `JWT_SECRET`
is measured in **bytes**, not characters, because a 32-character hex string carries only
16 bytes of entropy.

There is no `.env.example` yet. It is deliberately not hand-written — it will be generated
from `env.ts` so the two cannot drift.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the branch strategy, commit expectations and
what evidence a pull request is expected to carry, and [BRANCH_STRATEGY.md](BRANCH_STRATEGY.md)
for the historical milestone and upgrade branches.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).

## Conduct

See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).

## License

MIT — see [LICENSE](LICENSE).
