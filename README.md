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

## Client: run a turn and read the result

Talk only to the **harness** (public). It picks a worker, stores affinity, and proxies OpenCode’s session API. The workspace path must already exist on that worker’s volume (clone it first, or have an agent create it).

### Sync (recommended day-1)

One request blocks until the agent finishes the turn; the response body *is* the result.

```bash
HARNESS=https://agents.example.com

# 1. Place a session (directory = absolute path ON the worker)
sid=$(curl -fsS -X POST "$HARNESS/v1/sessions" \
  -H 'content-type: application/json' \
  -d '{"directory":"/workspaces/myrepo","title":"fix"}' | jq -r .id)

# 2. Send a user message; wait for the full assistant turn
curl -fsS -X POST "$HARNESS/v1/sessions/$sid/messages" \
  -H 'content-type: application/json' \
  -d '{
    "parts": [{"type":"text","text":"Summarize the README in three bullets"}]
  }' | jq .
```

**Request body** (OpenCode `POST /session/:id/message`):

| Field | Required | Notes |
|---|---|---|
| `parts` | yes | At least one part. Text: `{ "type":"text", "text":"..." }` |
| `model` | no | `{ "providerID":"anthropic", "modelID":"claude-sonnet-4-5" }` |
| `agent` | no | OpenCode agent name |
| `system` | no | Extra system prompt for this turn |

**Response** (`200`):

```json
{
  "info": { /* AssistantMessage metadata */ },
  "parts": [
    { "type": "text", "text": "…" },
    { "type": "tool", /* … */ },
    { "type": "reasoning", /* … */ }
  ]
}
```

- Assistant prose: `parts[]` where `type == "text"`.
- Tool calls / other steps: same array (`tool`, `reasoning`, `step-start`, …).
- Which replica ran it: response header `x-ownbase-worker`.
- Follow-ups: `POST` again with the **same** `$sid` — harness always routes to the same worker.

```bash
# Extract concatenated assistant text
curl -fsS -X POST "$HARNESS/v1/sessions/$sid/messages" \
  -H 'content-type: application/json' \
  -d '{"parts":[{"type":"text","text":"What files changed?"}]}' \
  | jq -r '[.parts[] | select(.type=="text") | .text] | join("\n")'
```

Abort an in-flight sync turn (from another client):

```bash
curl -fsS -X POST "$HARNESS/v1/sessions/$sid/abort"
```

### Async (progressive UI)

```bash
# Accept immediately (204); agent keeps running on the affine worker
curl -fsS -o /dev/null -w '%{http_code}\n' -X POST \
  "$HARNESS/v1/sessions/$sid/prompt_async" \
  -H 'content-type: application/json' \
  -d '{"parts":[{"type":"text","text":"…"}]}'

# Poll message history (proxied to the worker)
curl -fsS "$HARNESS/v1/sessions/$sid/message" | jq .

# Or SSE event stream (proxied OpenCode /event)
curl -N "$HARNESS/v1/sessions/$sid/event"
```

`prompt_async` does **not** return the assistant text in the body. Read it from history or SSE after the fact.

### What the harness does on each message

1. Resolve `session_id` → `worker_idx` (immutable affinity).  
2. Acquire a per-worker **lease** (409 if that worker is already mid-turn).  
3. `POST` to `http://ownbase-opencode-<idx>:4096/session/:id/message?directory=…`.  
4. Return upstream JSON; release the lease.

Model credentials live on the **worker** (`ownbasectl secrets set <base> opencode ANTHROPIC_API_KEY=…`), not on the client.

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
