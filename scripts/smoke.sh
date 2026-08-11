#!/usr/bin/env bash
# End-to-end smoke against a running harness (+ optional direct worker via tunnel).
#
# Usage:
#   HARNESS_URL=https://agents.example.com ./scripts/smoke.sh
#   HARNESS_URL=http://127.0.0.1:8080 DIRECTORY=/workspaces/demo ./scripts/smoke.sh
#
# Optional:
#   WORKER_URL=http://127.0.0.1:41000  # tunnel to replica 0
set -euo pipefail

HARNESS_URL="${HARNESS_URL:?set HARNESS_URL}"
HARNESS_TOKEN="${HARNESS_TOKEN:?set HARNESS_TOKEN (Bearer for /v1)}"
DIRECTORY="${DIRECTORY:-/workspaces/smoke-demo}"
WORKER_URL="${WORKER_URL:-}"
AUTH=(-H "Authorization: Bearer ${HARNESS_TOKEN}")

bold() { printf '\n==> %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

bold "harness health (unauthenticated)"
health=$(curl -fsS "${HARNESS_URL}/health")
echo "$health" | jq .
echo "$health" | jq -e '.healthy == true' >/dev/null || fail "harness unhealthy"

bold "v1 without token is 401"
code=$(curl -sS -o /dev/null -w '%{http_code}' "${HARNESS_URL}/v1/workers" || true)
[[ "$code" == "401" || "$code" == "503" ]] || fail "expected 401/503 without token, got $code"

bold "workers"
workers=$(curl -fsS "${AUTH[@]}" "${HARNESS_URL}/v1/workers")
echo "$workers" | jq .
healthy_n=$(echo "$workers" | jq '[.[] | select(.healthy==true)] | length')
[[ "$healthy_n" -ge 1 ]] || fail "no healthy workers"

if [[ -n "$WORKER_URL" ]]; then
  bold "direct worker health (tunnel replica 0)"
  curl -fsS "${WORKER_URL}/global/health" | jq .
fi

bold "prepare workspace note (clone must exist on the worker volume)"
# Harness cannot mkdir on the worker; for a real Base the agent or a prior
# step clones into DIRECTORY. For local smoke against a worker with an empty
# volume, create a tiny git repo via a one-shot message is not possible —
# document that DIRECTORY must already exist. We still exercise placement.

bold "reject directory outside /workspaces"
code=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "${HARNESS_URL}/v1/sessions" \
  "${AUTH[@]}" -H 'content-type: application/json' \
  -d '{"directory":"/etc/passwd"}' || true)
[[ "$code" == "400" ]] || fail "expected 400 for bad directory, got $code"

bold "create session on least-loaded worker"
create=$(curl -fsS -X POST "${HARNESS_URL}/v1/sessions" \
  "${AUTH[@]}" \
  -H 'content-type: application/json' \
  -d "$(jq -n --arg d "$DIRECTORY" --arg t "smoke $(date -u +%Y%m%dT%H%M%SZ)" \
        '{directory:$d, title:$t}')")
echo "$create" | jq .
sid=$(echo "$create" | jq -r .id)
widx=$(echo "$create" | jq -r .worker_idx)
[[ "$sid" == ses* ]] || fail "expected session id, got $sid"
[[ "$widx" =~ ^[0-9]+$ ]] || fail "expected worker_idx"

bold "get session (affinity metadata)"
got=$(curl -fsS "${AUTH[@]}" "${HARNESS_URL}/v1/sessions/${sid}")
echo "$got" | jq .
echo "$got" | jq -e --argjson w "$widx" '.worker_idx == $w' >/dev/null \
  || fail "worker_idx drift"

bold "affinity: second lookup still same worker"
got2=$(curl -fsS "${AUTH[@]}" "${HARNESS_URL}/v1/sessions/${sid}")
echo "$got2" | jq -e --argjson w "$widx" '.worker_idx == $w' >/dev/null \
  || fail "affinity broken"

bold "list sessions includes ours"
curl -fsS "${AUTH[@]}" "${HARNESS_URL}/v1/sessions" | jq --arg id "$sid" '[.[] | select(.id==$id)] | length' \
  | grep -qx 1 || fail "session missing from list"

bold "drain worker ${widx} then undrain"
curl -fsS -X POST "${HARNESS_URL}/v1/workers/${widx}/drain" \
  "${AUTH[@]}" \
  -H 'content-type: application/json' \
  -d '{"draining":true}' | jq .
curl -fsS -X POST "${HARNESS_URL}/v1/workers/${widx}/drain" \
  "${AUTH[@]}" \
  -H 'content-type: application/json' \
  -d '{"draining":false}' | jq .

bold "SMOKE OK session=${sid} worker=${widx}"
echo "Next (needs model key + real repo at ${DIRECTORY}):"
echo "  curl -X POST ${HARNESS_URL}/v1/sessions/${sid}/messages \\"
echo "    -H \"Authorization: Bearer \$HARNESS_TOKEN\" \\"
echo "    -H 'content-type: application/json' \\"
echo "    -d '{\"parts\":[{\"type\":\"text\",\"text\":\"run: echo \\\$OWNBASE_REPLICA_INDEX\"}]}'"
