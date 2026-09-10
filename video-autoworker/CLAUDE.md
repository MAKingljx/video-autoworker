# Mission Control

Open-source dashboard for AI agent orchestration. Manage agent fleets, track tasks, monitor costs, and orchestrate workflows.

**Stack**: Next.js 16, React 19, TypeScript 5, SQLite (better-sqlite3), Tailwind CSS 3, Zustand, pnpm

## Prerequisites

- Node.js >= 22 (LTS recommended; 24.x also supported)
- pnpm (`corepack enable` to auto-install)

## Setup

```bash
pnpm install
pnpm build
```

Production user identity and authorization terminate at OpenClaw. Do not create a
separate Mission Control account, session, or user API key for the 3017 service.

## Run

```bash
pnpm dev              # development (localhost:3000)
pnpm start            # production; managed fail-closed standalone launcher
pnpm start:standalone # explicit alias for the same launcher
```

## Docker Build Check

```bash
docker compose up                 # container-internal loopback health only
```

The compose file does not publish an application port. Docker is not a supported
external production path for the single-host OpenClaw loopback architecture.

## Tests

```bash
pnpm test             # unit tests (vitest)
pnpm test:e2e         # end-to-end (playwright)
pnpm typecheck        # tsc --noEmit
pnpm lint             # eslint
pnpm test:all         # lint + typecheck + test + build + e2e
```

## Key Directories

```
src/app/          Next.js pages + API routes (App Router)
src/components/   UI panels and shared components
src/lib/          Core logic, database, utilities
.data/            SQLite database + runtime state (gitignored)
scripts/          Install, deploy, diagnostics scripts
docs/             Documentation and guides
```

Path alias: `@/*` maps to `./src/*`

## Data Directory

Set `MISSION_CONTROL_DATA_DIR` env var to change the data location (defaults to `.data/`).
Database path: `MISSION_CONTROL_DB_PATH` (defaults to `.data/mission-control.db`).

## Conventions

- **Commits**: Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`)
- **No AI attribution**: Never add `Co-Authored-By` or similar trailers to commits
- **Package manager**: pnpm only (no npm/yarn)
- **Icons**: No icon libraries -- use raw text/emoji in components
- **Standalone output**: `next.config.js` sets `output: 'standalone'`

## Agent Control Interface

Production user and agent requests enter through OpenClaw. Direct Mission
Control MCP, CLI user-key, and browser REST authentication are legacy
development interfaces and are not supported production entrypoints.

## Common Pitfalls

- **Standalone mode**: Use `pnpm start` or `pnpm start:standalone`; never invoke `next start` or `server.js` directly.
- **better-sqlite3**: Native addon -- needs rebuild when switching Node versions (`pnpm rebuild better-sqlite3`)
- **Gateway optional**: Set `NEXT_PUBLIC_GATEWAY_OPTIONAL=true` for standalone deployments without gateway connectivity
