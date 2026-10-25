// Applies migrations/*.sql in name order, each once, each in a transaction.
// Berth runs it before every release (Procfile: `release: node migrate.js`),
// in a one-off container from the new image, before the new code takes
// traffic; if it fails, the deploy stops and the old release keeps serving.
import { readdir, readFile } from "node:fs/promises";
import pg from "pg";

const url = process.env.DATABASE_URL;
if (!url) {
  console.log("No DATABASE_URL: chirps live in memory, nothing to migrate.");
  process.exit(0);
}

const dir = new URL("./migrations/", import.meta.url);
const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  // One migrator at a time, even if two releases race.
  await client.query("SELECT pg_advisory_lock(hashtext('chirp-migrate'))");
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version    text PRIMARY KEY,
    applied_at timestamptz NOT NULL DEFAULT now()
  )`);
  const { rows } = await client.query("SELECT version FROM schema_migrations");
  const applied = new Set(rows.map((r) => r.version));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  let ran = 0;
  for (const file of files) {
    const version = file.replace(/\.sql$/, "");
    if (applied.has(version)) continue;
    const sql = await readFile(new URL(file, dir), "utf8");
    const start = Date.now();
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw new Error(`${file}: ${err.message}`);
    }
    console.log(`applied ${version} (${Date.now() - start}ms)`);
    ran++;
  }
  console.log(ran ? `${ran} migration(s) applied` : `schema up to date (${files.length} migrations)`);
} finally {
  await client.end();
}
