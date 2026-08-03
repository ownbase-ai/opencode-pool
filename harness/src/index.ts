import { HOST, PORT, OPENCODE_REPLICAS } from "./config"
import { sql } from "./db/client"
import { startHealthLoop, stopHealthLoop, listWorkers, setDraining } from "./workers/registry"
import {
  abortSession,
  createSession,
  getSession,
  handleProxyError,
  listSessions,
  postMessage,
  postPromptAsync,
  proxySessionPath,
} from "./routes/sessions"

async function migrate() {
  // Inline migrate so the container is one-shot ready.
  const { readdir, readFile } = await import("node:fs/promises")
  const { join } = await import("node:path")
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `
  const dir = join(import.meta.dir, "../migrations")
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()
  for (const file of files) {
    const [{ exists }] = await sql<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE id = ${file}) AS exists
    `
    if (exists) continue
    const body = await readFile(join(dir, file), "utf8")
    console.log(`migrate: ${file}`)
    await sql.begin(async (tx) => {
      await tx.unsafe(body)
      await tx`INSERT INTO schema_migrations (id) VALUES (${file})`
    })
  }
}

async function route(req: Request): Promise<Response> {
  const url = new URL(req.url)
  const { pathname } = url
  const method = req.method.toUpperCase()

  if (method === "GET" && pathname === "/health") {
    // OwnBase gates start on 2xx. Report worker stats but only fail when DB is down —
    // workers are a separate service and may still be rolling when we come up.
    try {
      await sql`SELECT 1`
      const workers = await listWorkers()
      const healthy = workers.filter((w) => w.healthy).length
      return Response.json({
        healthy: true,
        replicas: OPENCODE_REPLICAS,
        workers_healthy: healthy,
        workers_total: workers.length,
      })
    } catch (err) {
      console.error("health db", err)
      return Response.json({ healthy: false, error: "database unavailable" }, { status: 503 })
    }
  }

  if (method === "GET" && pathname === "/v1/workers") {
    return Response.json(await listWorkers())
  }

  const drainMatch = pathname.match(/^\/v1\/workers\/(\d+)\/drain$/)
  if (drainMatch && method === "POST") {
    const idx = Number(drainMatch[1])
    const body = req.headers.get("content-type")?.includes("json")
      ? ((await req.json()) as { draining?: boolean })
      : {}
    const draining = body.draining !== false
    const w = await setDraining(idx, draining)
    if (!w) return Response.json({ error: "worker not found" }, { status: 404 })
    return Response.json(w)
  }

  if (method === "GET" && pathname === "/v1/sessions") {
    return listSessions()
  }

  if (method === "POST" && pathname === "/v1/sessions") {
    return createSession(req)
  }

  const sessionMatch = pathname.match(/^\/v1\/sessions\/([^/]+)(.*)$/)
  if (sessionMatch) {
    const sessionID = decodeURIComponent(sessionMatch[1])
    const rest = sessionMatch[2] || ""

    if (method === "GET" && rest === "") return getSession(sessionID)
    if (method === "POST" && rest === "/messages") return postMessage(sessionID, req)
    if (method === "POST" && rest === "/prompt_async") return postPromptAsync(sessionID, req)
    if (method === "POST" && rest === "/abort") return abortSession(sessionID)

    // Escape hatch: proxy remaining /session/:id/* paths for SDK parity.
    if (rest.startsWith("/")) {
      return proxySessionPath(sessionID, rest, req)
    }
  }

  return Response.json({ error: "not found" }, { status: 404 })
}

await migrate()
startHealthLoop()

const server = Bun.serve({
  hostname: HOST,
  port: PORT,
  async fetch(req) {
    try {
      return await route(req)
    } catch (err) {
      return handleProxyError(err)
    }
  },
})

console.log(`harness listening on http://${server.hostname}:${server.port} (replicas=${OPENCODE_REPLICAS})`)

async function shutdown() {
  console.log("shutting down")
  stopHealthLoop()
  server.stop()
  await sql.end({ timeout: 5 })
  process.exit(0)
}
process.on("SIGTERM", () => void shutdown())
process.on("SIGINT", () => void shutdown())
