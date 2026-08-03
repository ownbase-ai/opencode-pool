import { LEASE_TTL_MS, workerURL } from "../config"
import { sql } from "../db/client"
import { bumpLoad } from "./registry"

export class HarnessError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

export async function getSessionWorker(sessionID: string): Promise<{
  id: string
  worker_idx: number
  directory: string | null
  url: string
}> {
  const rows = await sql<{ id: string; worker_idx: number; directory: string | null }[]>`
    SELECT id, worker_idx, directory FROM session WHERE id = ${sessionID}
  `
  if (rows.length === 0) throw new HarnessError(404, `session ${sessionID} not found`)
  const s = rows[0]
  return { ...s, url: workerURL(s.worker_idx) }
}

/** Acquire exclusive lease on the session's worker. Throws 409 if busy. */
export async function acquireLease(sessionID: string, workerIdx: number): Promise<string> {
  // Expire stale leases first.
  await sql`
    UPDATE lease
    SET released_at = now()
    WHERE released_at IS NULL AND expires_at < now()
  `
  const expires = new Date(Date.now() + LEASE_TTL_MS)
  try {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO lease (session_id, worker_idx, expires_at)
      VALUES (${sessionID}, ${workerIdx}, ${expires})
      RETURNING id
    `
    await bumpLoad(workerIdx, 1)
    return rows[0].id
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes("one_active_lease_per_worker") || msg.includes("unique")) {
      throw new HarnessError(409, `worker ${workerIdx} is busy`)
    }
    throw err
  }
}

export async function releaseLease(leaseID: string, workerIdx: number) {
  await sql`
    UPDATE lease SET released_at = now()
    WHERE id = ${leaseID}::uuid AND released_at IS NULL
  `
  await bumpLoad(workerIdx, -1)
}

function withDirectory(url: string, directory: string | null | undefined, extra?: Record<string, string>) {
  const u = new URL(url)
  if (directory) u.searchParams.set("directory", directory)
  if (extra) {
    for (const [k, v] of Object.entries(extra)) u.searchParams.set(k, v)
  }
  return u.toString()
}

/** Forward JSON to a worker, attaching ?directory= when known. */
export async function forwardJSON(
  workerBase: string,
  path: string,
  init: RequestInit & { directory?: string | null } = {},
): Promise<Response> {
  const { directory, ...rest } = init
  const url = withDirectory(`${workerBase}${path}`, directory)
  const headers = new Headers(rest.headers)
  if (rest.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json")
  }
  return fetch(url, { ...rest, headers })
}

export async function touchSession(sessionID: string) {
  await sql`UPDATE session SET last_used_at = now() WHERE id = ${sessionID}`
}
