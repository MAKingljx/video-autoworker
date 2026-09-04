# Deployment Guide

## Prerequisites

- **Node.js** >= 22 (use the latest stable version supported by the target runtime)
- **pnpm** 10.33.0 (installed via corepack: `corepack enable && corepack prepare pnpm@10.33.0 --activate`)

### Ubuntu / Debian

`better-sqlite3` requires native compilation tools:

```bash
sudo apt-get update
sudo apt-get install -y python3 make g++
```

### macOS

Xcode command line tools are required:

```bash
xcode-select --install
```

## Quick Start (Development)

```bash
cp .env.example .env.local
pnpm install
pnpm dev
```

Open http://127.0.0.1:3000. Development mode is local-only and is not a
supported production entrypoint.

## Production

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

`pnpm start` delegates to the managed standalone launcher. The launcher fixes
`MC_AUTH_MODE=openclaw-loopback`, binds only to `127.0.0.1`, audits the
immutable artifact, and rejects conflicting host or authentication settings.
OpenClaw remains the only external user authentication boundary. Override only
the loopback port when necessary:

```bash
PORT=3000 pnpm start
```

**Important:** The production build bundles platform-specific native binaries. You must run `pnpm install` and `pnpm build` on the same OS and architecture as the target server. A build created on macOS will not work on Linux.

## Explicit Standalone Alias

`pnpm start:standalone` is an explicit alias for the same supported launcher.
Never run `next start` or `.next/standalone/server.js` directly.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start:standalone
```

For a full in-place update on the target host:

```bash
BRANCH=fix/refactor PORT=3000 pnpm deploy:standalone
```

What `deploy:standalone` does:
- fetches and fast-forwards the requested branch
- reinstalls dependencies with the lockfile
- rebuilds from a clean `.next/`
- stops the old process bound to the target port
- starts the standalone server through `scripts/start-standalone.sh`
- verifies that the rendered login page references a CSS asset and that the CSS is served as `text/css`

## Docker Development Image

The Docker configuration is retained only for isolated build and container-
internal health checks. It fixes `MC_AUTH_MODE=openclaw-loopback`, binds the
application to the container loopback address, keeps runtime data outside the
immutable release, and does not publish an application port. It is not a
supported browser-facing or production exposure path.

```bash
docker compose up
docker compose exec mission-control node /app/healthcheck.js
```

Or build and run manually:

```bash
docker build -t mission-control .
docker run --rm \
  -v mission-control-data:/app/data \
  -e OPENCLAW_GATEWAY_HOST=host.docker.internal \
  --add-host=host.docker.internal:host-gateway \
  mission-control
```

The Docker image:
- Builds from the verified Node.js `22.22.3` and pnpm `10.33.0` baseline
- excludes host Git metadata, `.PhoenixBrain`, `.run`, `.runtime`, and runtime data from the build context
- creates a synthetic dirty Git identity inside the build stage, so its provenance is always ineligible for release
- Compiles `better-sqlite3` natively inside the container (Linux x64)
- audits the Next.js standalone artifact before every start
- Runs as non-root user `nextjs`
- rejects non-OpenClaw auth mode and non-loopback host overrides

### Gateway Connectivity from Docker

`OPENCLAW_GATEWAY_HOST=host.docker.internal` is only for server-side diagnostic
connectivity during an isolated check. The container is not a browser or API
entrypoint. Do not add `ports:`, `-p`, a reverse proxy, or a public ingress.

### Persistent Data

Disposable check state is stored in `/app/data/`, outside `/app/release`:

```bash
docker run --rm -v /path/to/data:/app/data mission-control
```

### Additional Container Isolation

```bash
docker compose -f docker-compose.yml -f docker-compose.hardened.yml up -d
```

This adds bounded logging and an internal-only network. It does not turn Docker
into a supported production exposure path.

## Environment Variables

See `.env.example` for the full list. Key variables:

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MC_AUTH_MODE` | Fixed | `openclaw-loopback` | Only supported production authentication mode |
| `MC_HOSTNAME` | Fixed | `127.0.0.1` | Application listener trust boundary |
| `PORT` | No | `3000` | Loopback listener port |
| `OPENCLAW_HOME` | No | - | Path to OpenClaw installation |
| `MC_ALLOWED_HOSTS` | No | `localhost,127.0.0.1` | Allowed hosts in production |

## Unsupported Network Topologies

Kubernetes ingress, public Docker port publication, reverse proxies, Tailscale
Serve/Funnel, and cross-host direct access are intentionally unsupported. They
would leave the controlled loopback trust boundary and require a new explicit
authentication and migration decision before implementation.

## Troubleshooting

### "Internal server error" / NODE_MODULE_VERSION mismatch

`better-sqlite3` is a native addon compiled for a specific Node.js version.
If you switch Node versions (e.g. via nvm), the compiled binary won't load.

```bash
pnpm rebuild better-sqlite3
```

The health endpoint (`/api/status?action=health`) will report this error explicitly.

### "Module not found: better-sqlite3"

Native compilation failed. On Ubuntu/Debian:
```bash
sudo apt-get install -y python3 make g++
rm -rf node_modules
pnpm install
```

### Docker: gateway unreachable

**Checklist:**

1. Verify the gateway is reachable from inside the container:
   ```bash
   docker exec mission-control curl -s http://host.docker.internal:18789
   ```

2. Check env vars are set:
   ```bash
   docker exec mission-control env | grep -i gateway
   ```
   You should see `OPENCLAW_GATEWAY_HOST=host.docker.internal`.

3. If using a **mounted `~/.openclaw`** directory, the `openclaw.json` inside may have
   `gateway.host = "127.0.0.1"` — this is the host's loopback, not reachable from the
   container. Environment variables take precedence over `openclaw.json`, so set
   `OPENCLAW_GATEWAY_HOST=host.docker.internal` in your `.env` or docker-compose.

4. Do not publish the container application port or configure a browser-facing
   WebSocket URL. Docker remains a container-internal diagnostic path.

5. **Linux-specific**: `host.docker.internal` requires Docker 20.10+. The `extra_hosts`
   entry in `docker-compose.yml` handles this. If using `docker run` directly, add
   `--add-host=host.docker.internal:host-gateway`.

### "pnpm-lock.yaml not found" during Docker build

If your deployment context omits `pnpm-lock.yaml`, Docker build now falls back to
`pnpm install --no-frozen-lockfile`.

For reproducible builds, include `pnpm-lock.yaml` in the build context.

### "Invalid ELF header" or "Mach-O" errors

The native binary was compiled on a different platform. Rebuild:
```bash
rm -rf node_modules .next
pnpm install
pnpm build
```

### Database locked errors

Ensure only one instance is running against the same `.data/` directory. SQLite uses WAL mode but does not support multiple writers.

### "Gateway error: origin not allowed"

Your gateway is rejecting the Mission Control browser origin. Add the Control UI origin
to your gateway config allowlist, for example:

```json
{
  "gateway": {
    "controlUi": {
      "allowedOrigins": ["http://YOUR_HOST:3000"]
    }
  }
}
```

Then restart the gateway and reconnect from Mission Control.

### "Gateway error: device identity required"

Device identity signing uses WebCrypto and requires a secure browser context.
Open Mission Control over HTTPS (or localhost), then reconnect.

### "Gateway shows offline on VPS deployment"

Browser WebSocket connections to non-standard ports (like 18789/18790) are often blocked by VPS firewall/provider rules.

Quick option:

```bash
NEXT_PUBLIC_GATEWAY_OPTIONAL=true
```

This runs Mission Control in standalone mode (core features available, live gateway streams unavailable).

Production option: reverse-proxy gateway WebSocket over 443.

nginx example:

```nginx
location /gateway-ws {
  proxy_pass http://127.0.0.1:18789;
  proxy_http_version 1.1;
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_set_header Host $host;
  proxy_read_timeout 86400;
}
```

Then point UI to:

```bash
NEXT_PUBLIC_GATEWAY_URL=wss://your-domain.com/gateway-ws
```

Mission Control now retries common reverse-proxy websocket paths (`/gateway-ws`, `/gw`) automatically when root-path handshake fails, but setting `NEXT_PUBLIC_GATEWAY_URL` is still recommended for deterministic production behavior.

## Next Steps

Once deployed, set up your agents and orchestration:

- **[Quickstart](quickstart.md)** — Register your first agent and complete a task in 5 minutes
- **[Agent Setup](agent-setup.md)** — SOUL personalities, heartbeats, config sync, agent sources
- **[Orchestration Patterns](orchestration.md)** — Auto-dispatch, quality review, multi-agent workflows
- **[CLI Reference](cli-agent-control.md)** — Full CLI command list for headless/scripted usage
