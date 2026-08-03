import { readdir, readFile } from "node:fs/promises"
import { join } from "node:path"
import { sql } from "./client"

async function migrate() {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `

  const dir = join(import.meta.dir, "../../migrations")
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()

  for (const file of files) {
    const [{ exists }] = await sql<{ exists: boolean }[]>`
      SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE id = ${file}) AS exists
    `
    if (exists) {
      console.log(`skip ${file}`)
      continue
    }
    const body = await readFile(join(dir, file), "utf8")
    console.log(`apply ${file}`)
    await sql.begin(async (tx) => {
      await tx.unsafe(body)
      await tx`INSERT INTO schema_migrations (id) VALUES (${file})`
    })
  }
  console.log("migrations complete")
}

migrate()
  .then(() => sql.end({ timeout: 2 }))
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err)
    process.exit(1)
  })
