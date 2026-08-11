import { resolve } from "node:path"
import { HARNESS_TOKEN, WORKSPACE_ROOT } from "./config"

/** Require Bearer HARNESS_TOKEN. Returns an error Response, or null when ok. */
export function requireAuth(req: Request): Response | null {
  if (!HARNESS_TOKEN) {
    return Response.json(
      { error: "harness auth not configured (set HARNESS_TOKEN)" },
      { status: 503 },
    )
  }
  const header = req.headers.get("authorization") ?? ""
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim())
  if (!m || m[1] !== HARNESS_TOKEN) {
    return Response.json({ error: "unauthorized" }, { status: 401 })
  }
  return null
}

/**
 * Normalize and enforce that directory is an absolute path under WORKSPACE_ROOT.
 * Returns the resolved path, or a 400 Response.
 */
export function allowDirectory(directory: string): string | Response {
  const raw = directory.trim()
  if (!raw.startsWith("/")) {
    return Response.json(
      { error: `directory must be absolute under ${WORKSPACE_ROOT}` },
      { status: 400 },
    )
  }
  if (raw.includes("\0")) {
    return Response.json({ error: "directory contains NUL" }, { status: 400 })
  }
  const root = resolve(WORKSPACE_ROOT)
  const resolved = resolve(raw)
  if (resolved !== root && !resolved.startsWith(root + "/")) {
    return Response.json(
      { error: `directory must be under ${root}` },
      { status: 400 },
    )
  }
  return resolved
}
