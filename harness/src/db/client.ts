import postgres from "postgres"
import { DATABASE_URL } from "../config"

export const sql = postgres(DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
})

export type WorkerRow = {
  idx: number
  healthy: boolean
  draining: boolean
  version: string | null
  last_seen: Date | null
  load: number
}

export type SessionRow = {
  id: string
  worker_idx: number
  directory: string | null
  title: string | null
  status: string
  created_at: Date
  last_used_at: Date
}
