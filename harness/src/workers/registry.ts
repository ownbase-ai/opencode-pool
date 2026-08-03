import { OPENCODE_REPLICAS, HEALTH_INTERVAL_MS, workerURL } from "../config"
import { sql, type WorkerRow } from "../db/client"

export type WorkerSnapshot = WorkerRow & { url: string }

async function ensureWorkers() {
  for (let i = 0; i < OPENCODE_REPLICAS; i++) {
    await sql`
      INSERT INTO worker (idx, healthy, draining, load)
      VALUES (${i}, false, false, 0)
      ON CONFLICT (idx) DO NOTHING
    `
  }
  // Drop rows beyond declared N (scale-down). Sessions still reference them
  // until cleaned; placement never picks missing indices.
  await sql`DELETE FROM worker WHERE idx >= ${OPENCODE_REPLICAS}`
}

async function probe(idx: number): Promise<{ healthy: boolean; version: string | null }> {
  const url = `${workerURL(idx)}/global/health`
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return { healthy: false, version: null }
    const body = (await res.json()) as { healthy?: boolean; version?: string }
    return { healthy: body.healthy === true, version: body.version ?? null }
  } catch {
    return { healthy: false, version: null }
  }
}

export async function refreshHealth(): Promise<void> {
  await ensureWorkers()
  await Promise.all(
    Array.from({ length: OPENCODE_REPLICAS }, async (_, i) => {
      const { healthy, version } = await probe(i)
      await sql`
        UPDATE worker
        SET healthy = ${healthy},
            version = COALESCE(${version}, version),
            last_seen = CASE WHEN ${healthy} THEN now() ELSE last_seen END
        WHERE idx = ${i}
      `
    }),
  )
}

let timer: ReturnType<typeof setInterval> | null = null

export function startHealthLoop() {
  void refreshHealth()
  timer = setInterval(() => {
    void refreshHealth().catch((err) => console.error("health loop", err))
  }, HEALTH_INTERVAL_MS)
}

export function stopHealthLoop() {
  if (timer) clearInterval(timer)
  timer = null
}

export async function listWorkers(): Promise<WorkerSnapshot[]> {
  const rows = await sql<WorkerRow[]>`
    SELECT idx, healthy, draining, version, last_seen, load
    FROM worker
    ORDER BY idx
  `
  return rows.map((r) => ({ ...r, url: workerURL(r.idx) }))
}

/** Least-loaded healthy non-draining worker, or null if none. */
export async function pickWorker(): Promise<WorkerSnapshot | null> {
  const rows = await sql<WorkerRow[]>`
    SELECT idx, healthy, draining, version, last_seen, load
    FROM worker
    WHERE healthy = true AND draining = false
    ORDER BY load ASC, idx ASC
    LIMIT 1
  `
  if (rows.length === 0) return null
  return { ...rows[0], url: workerURL(rows[0].idx) }
}

export async function setDraining(idx: number, draining: boolean): Promise<WorkerSnapshot | null> {
  const rows = await sql<WorkerRow[]>`
    UPDATE worker SET draining = ${draining}
    WHERE idx = ${idx}
    RETURNING idx, healthy, draining, version, last_seen, load
  `
  if (rows.length === 0) return null
  return { ...rows[0], url: workerURL(rows[0].idx) }
}

export async function bumpLoad(idx: number, delta: number) {
  await sql`
    UPDATE worker SET load = GREATEST(0, load + ${delta}) WHERE idx = ${idx}
  `
}
