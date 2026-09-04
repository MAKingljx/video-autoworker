# Security Hardening Guide

This project has one external identity and authorization boundary: OpenClaw.
Mission Control `3017`, n8n, and the director brain communicate only through
controlled loopback channels. Local Mission Control accounts, Cookie sessions,
global or agent API keys, trusted proxy headers, and desktop bypasses are not
supported production authentication paths.

## Supported Production Launch

Build and start through the managed launcher:

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm start
```

`pnpm start` delegates to `scripts/start-standalone.sh`. The launcher audits the
immutable artifact, rejects a non-loopback `MC_HOSTNAME`, rejects an auth mode
other than `openclaw-loopback`, disables desktop/no-auth modes, and binds the
listener to `127.0.0.1`. Never run `next start` or `server.js` directly.

The blue/green slot launcher and the legacy migration switch enforce the same
auth and listener contract. A conflicting environment value is a startup error;
it must not be silently accepted or replaced by a weaker mode.

## Network Boundary

- Keep `3017`, n8n, the task broker, model services, and OpenClaw Gateways on
  loopback addresses.
- Do not place `3017` behind a public reverse proxy, Tailscale Serve/Funnel,
  Kubernetes ingress, or a published Docker port.
- Remote users enter through the authorized OpenClaw channel, not through a
  direct Mission Control login or API key.
- A future cross-host or public topology requires a new explicit security
  decision and migration; host allowlists and forwarded headers are not a
  substitute for that decision.

## OpenClaw Gateway Credentials

Gateway tokens authenticate the OpenClaw transport itself and remain allowed.
Store them as an OpenClaw `SecretRef` in an external provider such as Keychain.
The single Gateway adapter resolves a token only for the actual Gateway call.
Never put a token in `NEXT_PUBLIC_*`, SQLite, Git, documentation, a release
artifact, or command-line arguments.

## Runtime State and Permissions

- Keep databases, token metadata, logs, PIDs, backups, and task state outside
  the immutable standalone release.
- Platform environment and private runtime files must be owned by the runtime
  user and must not be group/other writable.
- Keep `.PhoenixBrain`, `.env*`, credentials, databases, logs, and runtime state
  out of Git and release artifacts.
- Before a release switch, verify the canonical repository, immutable release,
  listener PIDs, database identities, queue state, n8n activity, media activity,
  and rollback point with the project release gates.

## Container Boundary

The Docker image is only an isolated build and container-internal health-check
path. It fixes OpenClaw loopback auth, binds inside the container to loopback,
stores disposable data outside `/app/release`, audits the artifact before
startup, and publishes no application port. The hardened overlay adds resource
and network isolation but does not make Docker a supported production exposure
path.

## Verification

Run these checks from the canonical repository:

```bash
pnpm scan:sensitive:source
pnpm typecheck
pnpm test
pnpm build
pnpm audit:standalone
pnpm scan:sensitive:standalone
git diff --check
```

The environment-specific director/video release-readiness verifier is still
required before a production switch. Local unit tests and a successful build do
not prove production listener, database, OpenClaw, n8n, or task state.
