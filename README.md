# opencode-pool

Warm, indexed [OpenCode](https://opencode.ai) workers on an [OwnBase](https://ownbase.ai) Base, plus a small harness that places sessions with **sticky affinity**.

```
Internet → Caddy → harness → ownbase-opencode-{0..N-1}
                     │
                     └── postgres (affinity + leases)
```

OwnBase gives each replica a stable name and a durable volume (`replicas:`).  
The harness gives that identity meaning: a session always returns to the worker that holds its state.

## Layout

| Path | OwnBase service | Role |
|---|---|---|
| `worker/` | `opencode` | `opencode serve` image, `replicas: N`, `internal: true` |
| `harness/` | `harness` | Public API, placement, leases |
| `deploy/ownbase.yaml.example` | — | Fragment to merge into the Base config |
| `scripts/smoke.sh` | — | Health + affinity checks |

One git repo, two build contexts (same pattern as OwnBase’s seeded `pgbackrest`/`postgres` pair).

## Phase 0 findings (locked in)

| Gate | Result |
|---|---|
| `/global/health` + basic auth | **401** when `OPENCODE_SERVER_PASSWORD` is set. Workers must leave it unset; OwnBase’s probe has no credentials. Isolation = capability network + `internal: true`. |
| Session directory | `POST /session?directory=/workspaces/...` (query param on essentially every route). |
| Install | Official `opencode-linux-{x64,arm64}.tar.gz` release asset (not the npm stub). |

## Deploy

Requires OwnBase with `replicas:` (PR [#24](https://github.com/ownbase-ai/ownbase/pull/24) or later `main`).

1. Merge `deploy/ownbase.yaml.example` into the Base’s `ownbase.yaml` (domains, `ref`, replica count).
2. Register the Base deploy key on this repo (read-only).
3. Set the model key (shared by every replica):

   ```bash
   ownbasectl secrets set <base> opencode ANTHROPIC_API_KEY=sk-ant-...
   ```

4. Debut at **one** replica, then scale:

   ```bash
   # first bring-up
   ownbasectl service update <base> opencode --replicas 1
   ownbasectl deploy <base> opencode --ref <sha>
   ownbasectl deploy <base> harness  --ref <sha>
   ownbasectl tunnel <base>   # inspect replica 0 at opencode.<domain>.localhost

   # after healthy
   ownbasectl service update <base> opencode --replicas 4
   # keep harness env OPENCODE_REPLICAS in sync, then redeploy harness
   ```

5. Smoke:

   ```bash
   HARNESS_URL=https://agents.example.com ./scripts/smoke.sh
   ```

### Why `OPENCODE_REPLICAS` is duplicated

OwnBase injects `OWNBASE_REPLICA_COUNT` only into the replicated service itself, not into consumers. The harness therefore takes `OPENCODE_REPLICAS` and probes `ownbase-opencode-0 … N-1`. Keep it equal to `opencode.replicas`.

### Git push from agents

`generated_secrets` mints an ed25519 keypair into the worker. Copy the public half out and add it as a deploy key (write) on target repos:

```bash
ownbasectl secrets get <base> opencode WORKER_GIT_PUBKEY
```

## Harness API

| Method | Path | Notes |
|---|---|---|
| `GET` | `/health` | OwnBase probe; 200 if ≥1 worker healthy |
| `GET` | `/v1/workers` | Registry snapshot |
| `POST` | `/v1/workers/:i/drain` | `{ "draining": true\|false }` before scale/deploy |
| `GET` | `/v1/sessions` | Harness-side index |
| `POST` | `/v1/sessions` | `{ "directory": "/workspaces/...", "title"? }` → places on least-loaded worker |
| `GET` | `/v1/sessions/:id` | Affinity metadata + upstream session |
| `POST` | `/v1/sessions/:id/messages` | Sync turn; holds per-worker lease |
| `POST` | `/v1/sessions/:id/prompt_async` | Async turn |
| `POST` | `/v1/sessions/:id/abort` | Abort + release lease |
| `*` | `/v1/sessions/:id/*` | Proxied to the affine worker (SDK escape hatch) |

Affinity is stored in Postgres (`session.worker_idx`) and **never changes**. Worker state volumes make that sound across restarts.

## Worker image

- Debian bookworm, non-root UID 1000  
- Node 22, Python 3, Go 1.23, git, ripgrep  
- Pinned OpenCode release binary  
- Baked `opencode.json` with `autoupdate: false`  
- Volumes: state (`~/.local/share/opencode`), workspaces (`/workspaces`) — **per-replica**

Agents cannot use Docker (no socket, `DropCapability=ALL`). Whatever they need must be in the image or installed into the workspace volume at runtime.

## Local harness dev

```bash
cd harness
bun install
export DATABASE_URL=postgres://…/harness
export OPENCODE_REPLICAS=1
# point at a local opencode serve on 4096, or mock DNS:
#   export OPENCODE_SERVICE=…  # advanced
bun run src/index.ts
```

## Sizing

Budget ~2 GB RAM per replica + headroom for Postgres/Caddy/harness.  
`replicas: 4` → plan on ~16 GB / 200 GB disk. OwnBase does not yet emit cgroup memory limits; do not run unbounded agent pools on a small Base.

## License

MIT
