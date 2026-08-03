import { pickWorker } from "../workers/registry"
import {
  HarnessError,
  acquireLease,
  forwardJSON,
  getSessionWorker,
  releaseLease,
  touchSession,
} from "../workers/proxy"
import { sql } from "../db/client"

type CreateBody = {
  title?: string
  directory?: string
  parentID?: string
  agent?: string
  model?: { id: string; providerID: string; variant?: string }
  metadata?: Record<string, unknown>
}

export async function createSession(req: Request): Promise<Response> {
  let body: CreateBody = {}
  if (req.headers.get("content-type")?.includes("application/json")) {
    body = (await req.json()) as CreateBody
  }

  const directory = body.directory ?? null
  if (!directory) {
    return Response.json({ error: "directory is required (absolute path on the worker, e.g. /workspaces/myrepo)" }, { status: 400 })
  }

  const worker = await pickWorker()
  if (!worker) {
    return Response.json({ error: "no healthy workers available" }, { status: 503 })
  }

  const upstream = await forwardJSON(worker.url, "/session", {
    method: "POST",
    directory,
    body: JSON.stringify({
      title: body.title,
      parentID: body.parentID,
      agent: body.agent,
      model: body.model,
      metadata: body.metadata,
    }),
  })

  if (!upstream.ok) {
    const text = await upstream.text()
    return new Response(text, { status: upstream.status, headers: { "content-type": upstream.headers.get("content-type") ?? "text/plain" } })
  }

  const session = (await upstream.json()) as { id: string; title?: string }
  await sql`
    INSERT INTO session (id, worker_idx, directory, title, status)
    VALUES (${session.id}, ${worker.idx}, ${directory}, ${body.title ?? session.title ?? null}, 'open')
  `

  return Response.json({
    ...session,
    worker_idx: worker.idx,
    worker_url: worker.url,
    directory,
  })
}

export async function getSession(sessionID: string): Promise<Response> {
  const s = await getSessionWorker(sessionID)
  const upstream = await forwardJSON(s.url, `/session/${encodeURIComponent(sessionID)}`, {
    method: "GET",
    directory: s.directory,
  })
  const text = await upstream.text()
  if (!upstream.ok) return new Response(text, { status: upstream.status })
  const data = JSON.parse(text)
  return Response.json({ ...data, worker_idx: s.worker_idx, directory: s.directory })
}

export async function listSessions(): Promise<Response> {
  const rows = await sql`
    SELECT id, worker_idx, directory, title, status, created_at, last_used_at
    FROM session
    ORDER BY last_used_at DESC
    LIMIT 200
  `
  return Response.json(rows)
}

type MessageBody = {
  parts: unknown[]
  model?: { providerID: string; modelID: string }
  agent?: string
  system?: string
  noReply?: boolean
  tools?: Record<string, boolean>
  variant?: string
  messageID?: string
}

/** Synchronous message — holds the lease for the full agent turn. */
export async function postMessage(sessionID: string, req: Request): Promise<Response> {
  const s = await getSessionWorker(sessionID)
  const body = (await req.json()) as MessageBody
  if (!body.parts?.length) {
    return Response.json({ error: "parts is required" }, { status: 400 })
  }

  const leaseID = await acquireLease(sessionID, s.worker_idx)
  try {
    await touchSession(sessionID)
    const upstream = await forwardJSON(s.url, `/session/${encodeURIComponent(sessionID)}/message`, {
      method: "POST",
      directory: s.directory,
      body: JSON.stringify(body),
    })
    const text = await upstream.text()
    return new Response(text, {
      status: upstream.status,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        "x-ownbase-worker": String(s.worker_idx),
      },
    })
  } finally {
    await releaseLease(leaseID, s.worker_idx)
  }
}

/** Async prompt — acquire briefly, fire-and-forget, release after 204. */
export async function postPromptAsync(sessionID: string, req: Request): Promise<Response> {
  const s = await getSessionWorker(sessionID)
  const body = (await req.json()) as MessageBody
  if (!body.parts?.length) {
    return Response.json({ error: "parts is required" }, { status: 400 })
  }

  const leaseID = await acquireLease(sessionID, s.worker_idx)
  try {
    await touchSession(sessionID)
    const upstream = await forwardJSON(s.url, `/session/${encodeURIComponent(sessionID)}/prompt_async`, {
      method: "POST",
      directory: s.directory,
      body: JSON.stringify(body),
    })
    // Hold lease until upstream accepts; client should poll/stream events.
    // For long-running async work, extend via a follow-up if needed.
    if (!upstream.ok) {
      const text = await upstream.text()
      return new Response(text, { status: upstream.status })
    }
    return new Response(null, {
      status: 204,
      headers: { "x-ownbase-worker": String(s.worker_idx) },
    })
  } finally {
    await releaseLease(leaseID, s.worker_idx)
  }
}

export async function abortSession(sessionID: string): Promise<Response> {
  const s = await getSessionWorker(sessionID)
  const upstream = await forwardJSON(s.url, `/session/${encodeURIComponent(sessionID)}/abort`, {
    method: "POST",
    directory: s.directory,
  })
  // Best-effort release any active lease for this session's worker.
  await sql`
    UPDATE lease SET released_at = now()
    WHERE session_id = ${sessionID} AND released_at IS NULL
  `
  const text = await upstream.text()
  return new Response(text || "true", {
    status: upstream.status,
    headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
  })
}

export async function proxySessionPath(
  sessionID: string,
  suffix: string,
  req: Request,
): Promise<Response> {
  const s = await getSessionWorker(sessionID)
  const url = new URL(req.url)
  const path = `/session/${encodeURIComponent(sessionID)}${suffix}${url.search}`
  const init: RequestInit & { directory?: string | null } = {
    method: req.method,
    directory: s.directory,
    headers: req.headers,
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    init.body = await req.arrayBuffer()
  }
  const upstream = await forwardJSON(s.url, path, init)
  return new Response(upstream.body, {
    status: upstream.status,
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "x-ownbase-worker": String(s.worker_idx),
    },
  })
}

export function handleProxyError(err: unknown): Response {
  if (err instanceof HarnessError) {
    return Response.json({ error: err.message }, { status: err.status })
  }
  console.error(err)
  return Response.json({ error: "internal error" }, { status: 500 })
}
