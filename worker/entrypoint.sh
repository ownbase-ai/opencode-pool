#!/usr/bin/env bash
# Runtime glue OwnBase cannot express in static env: values that depend on
# OWNBASE_REPLICA_INDEX, and secrets that arrive as env vars (base64 PEM).
set -euo pipefail

IDX="${OWNBASE_REPLICA_INDEX:-0}"
COUNT="${OWNBASE_REPLICA_COUNT:-1}"
PORT="${OPENCODE_PORT:-4096}"
HOSTNAME_BIND="${OPENCODE_HOSTNAME:-0.0.0.0}"

echo "opencode-worker: replica ${IDX}/${COUNT} binding ${HOSTNAME_BIND}:${PORT}"

# Git identity for agents that push branches / open PRs.
git config --global user.name  "${GIT_AUTHOR_NAME:-opencode-worker-${IDX}}"
git config --global user.email "${GIT_AUTHOR_EMAIL:-agents@localhost}"
git config --global --add safe.directory '*'

# Optional deploy key (OwnBase generated_secrets type: ssh-ed25519,
# private_encoding: base64 → WORKER_GIT_KEY_B64).
if [[ -n "${WORKER_GIT_KEY_B64:-}" ]]; then
  mkdir -p "${HOME}/.ssh"
  chmod 700 "${HOME}/.ssh"
  umask 077
  echo "${WORKER_GIT_KEY_B64}" | base64 -d > "${HOME}/.ssh/id_ed25519"
  chmod 600 "${HOME}/.ssh/id_ed25519"
  if [[ ! -f "${HOME}/.ssh/known_hosts" ]]; then
    ssh-keyscan -t ed25519,rsa github.com gitlab.com 2>/dev/null \
      >> "${HOME}/.ssh/known_hosts" || true
    chmod 644 "${HOME}/.ssh/known_hosts"
  fi
  cat > "${HOME}/.ssh/config" <<'EOF'
Host *
  IdentityFile ~/.ssh/id_ed25519
  IdentitiesOnly yes
  StrictHostKeyChecking accept-new
EOF
  chmod 600 "${HOME}/.ssh/config"
fi

mkdir -p /workspaces \
  "${HOME}/.local/share/opencode" \
  "${HOME}/.config/opencode"

# Do NOT set OPENCODE_SERVER_PASSWORD here. OwnBase's health probe is an
# unauthenticated GET of health_probe.http; with basic auth enabled that
# path returns 401 and the whole reconcile plan rolls back. Workers are
# reachable only on the capability network (internal: true, no Caddy route).
# The harness is the sole consumer and sits on the same network.

export OPENCODE_DISABLE_AUTOUPDATE=true

exec opencode serve --hostname "${HOSTNAME_BIND}" --port "${PORT}"
