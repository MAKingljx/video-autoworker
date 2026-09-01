# Video AutoWorker

`video-autoworker` is an OpenClaw-powered control center for local and remote AI video workflows.

Current focus:

- OpenClaw profile management for the second Mac Studio node.
- Chinese-first operation UI for profiles, logs, tasks, and materials.
- Materials center for video learning, summarization, and later vector search.
- Remote deployment under `~/Documents/Phoenix/video-autoworker`.

## Director Brain (non-editing scope)

The repository contains one director-knowledge subsystem inside Video AutoWorker. It uses an
isolated Feishu Bitable schema, but it does not create a second project, task queue, or video
execution chain.

- OpenClaw can query the director brain by a work name or alias; users do not need to provide an
  internal work ID.
- A single-video submission may explicitly name the director work it belongs to. Mission Control resolves
  that name once, persists a trusted work binding, and rejects caller-injected internal bindings.
- A successful canonical video result atomically creates one SQLite outbox entry. The existing
  scheduler transforms only governed result fields and writes stable, work-scoped evidence through
  the idempotent Feishu `project-evidence` entry.
- `scripts/verify-director-video-release-readiness.mjs` is the centralized pre-switch gate for the
  Mission Control release, video-command plugin, task-flow Skill, director-brain plugin, and the
  complete evidence-projection dependency closure. Pending outbox rows are bound to that projection
  contract, so a release cannot mix partially written evidence across transformer versions.
- All three shared OpenClaw installers take the same blue-green deployment lock. A rolling install
  requires paused intake, explicit physical Mission Control and n8n databases, no active n8n
  execution or media node, an existing private durable-batch root, no formal waiting/running work,
  and no pending director outbox row. Both intake mutations and every new `directorWork`
  resolution-to-admission transaction take that same lock. This prevents a drain, resume, work-name
  resolution, or installer rollback/commit from observing different shared component trees; exact
  idempotent replays remain available without contacting Feishu. The initial legacy migration can
  use only a fresh, database-and-target-bound bootstrap evidence chain.

The current candidate versions are director-brain `0.3.1` and video-command `0.5.14`. The remote
OpenClaw read/query entry was previously accepted on director-brain `0.3.0`; the `0.3.1` projection
chain must not be described as production until its immutable release is installed, switched, and
verified against a real video. DaVinci integration, editing-software timelines, rendering, export,
and every other editing side effect are intentionally outside the current scope.

See [Director Brain architecture](docs/architecture/director-brain.md) for the data contract and
the exact candidate-versus-production boundary.

## Tech Stack

- Next.js 16
- React 19
- TypeScript
- Tailwind CSS
- better-sqlite3
- OpenClaw Gateway integration

Node.js 22 or newer is required.

## Local Start

```bash
pnpm install
PORT=3017 MC_OPENCLAW_PROFILES_REBUILD=0 pnpm openclaw:profiles:server
```

Open:

```text
http://127.0.0.1:3017/profiles
```

## Production Build

```bash
pnpm install --frozen-lockfile
pnpm build
PORT=3017 MC_OPENCLAW_PROFILES_REBUILD=0 pnpm start
```

## Runtime Data

Runtime data is generated locally and is not committed:

- `.data/`
- `.next/`
- `node_modules/`
- `.playwright-cli/`
- `output/`
- `report/`
- `src-tauri/target/`

Do not commit passwords, API keys, private keys, or generated runtime databases.
