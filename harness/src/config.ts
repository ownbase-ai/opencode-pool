function required(name: string): string {
  const v = process.env[name]
  if (!v) throw new Error(`missing required env ${name}`)
  return v
}

function intEnv(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const n = Number.parseInt(raw, 10)
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative integer`)
  return n
}

/** Declared replica count. Must match opencode.replicas in ownbase.yaml. */
export const OPENCODE_REPLICAS = intEnv("OPENCODE_REPLICAS", 1)

/** DNS prefix for workers. ownbase-opencode-0 … N-1 when service key is "opencode". */
export const OPENCODE_SERVICE = process.env.OPENCODE_SERVICE ?? "opencode"
export const OPENCODE_PORT = intEnv("OPENCODE_PORT", 4096)

export const DATABASE_URL = required("DATABASE_URL")

export const HOST = process.env.HOST ?? "0.0.0.0"
export const PORT = intEnv("PORT", 8080)

/** How often to poll worker /global/health. */
export const HEALTH_INTERVAL_MS = intEnv("HEALTH_INTERVAL_MS", 10_000)

/** Lease TTL for an in-flight prompt. */
export const LEASE_TTL_MS = intEnv("LEASE_TTL_MS", 30 * 60_000)

/**
 * Bearer token for every /v1 route. Fail-closed: empty means the management
 * API refuses all callers (OwnBase health still uses unauthenticated /health).
 * Deliver via OwnBase secret HARNESS_TOKEN.
 */
export const HARNESS_TOKEN = process.env.HARNESS_TOKEN ?? ""

/**
 * Absolute root under which session directories must live. Create-session and
 * proxy refuse paths outside this tree (no /, no ~/.ssh, no host escapes).
 */
export const WORKSPACE_ROOT = process.env.WORKSPACE_ROOT ?? "/workspaces"

export function workerURL(idx: number): string {
  return `http://ownbase-${OPENCODE_SERVICE}-${idx}:${OPENCODE_PORT}`
}
