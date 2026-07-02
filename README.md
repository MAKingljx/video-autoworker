# Video AutoWorker

`video-autoworker` is an OpenClaw-powered control center for local and remote AI video workflows.

Current focus:

- OpenClaw profile management for the second Mac Studio node.
- Chinese-first operation UI for profiles, logs, tasks, and materials.
- Materials center for video learning, summarization, and later vector search.
- Remote deployment under `~/Documents/Phoenix/video-autoworker`.

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
