// Chirp: a tiny Twitter clone for Berth.
//
// Express serves a JSON API and the React app that `npm run build` puts in
// dist/. Chirps live in Postgres when DATABASE_URL is set (berth pg:link),
// and in memory otherwise, so the very first deploy is healthy before any
// database exists.

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const PORT = process.env.PORT || 3000;
const MAX_LENGTH = 280;
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");

// ---- storage ----

function memoryStore() {
  const chirps = [];
  let nextId = 1;
  return {
    kind: "memory",
    async init() {},
    async list() {
      return [...chirps].sort((a, b) => b.id - a.id).slice(0, 100);
    },
    async create(handle, body) {
      const chirp = { id: nextId++, handle, body, likes: 0, created_at: new Date().toISOString() };
      chirps.push(chirp);
      return chirp;
    },
    async like(id) {
      const chirp = chirps.find((c) => c.id === id);
      if (chirp) chirp.likes++;
      return chirp;
    },
  };
}

function postgresStore(url) {
  const pool = new pg.Pool({ connectionString: url });
  return {
    kind: "postgres",
    async init() {
      await pool.query(`CREATE TABLE IF NOT EXISTS chirps (
        id         serial PRIMARY KEY,
        handle     text NOT NULL,
        body       text NOT NULL,
        likes      integer NOT NULL DEFAULT 0,
        created_at timestamptz NOT NULL DEFAULT now()
      )`);
    },
    async list() {
      const { rows } = await pool.query("SELECT * FROM chirps ORDER BY id DESC LIMIT 100");
      return rows;
    },
    async create(handle, body) {
      const { rows } = await pool.query(
        "INSERT INTO chirps (handle, body) VALUES ($1, $2) RETURNING *",
        [handle, body],
      );
      return rows[0];
    },
    async like(id) {
      const { rows } = await pool.query(
        "UPDATE chirps SET likes = likes + 1 WHERE id = $1 RETURNING *",
        [id],
      );
      return rows[0];
    },
  };
}

const store = process.env.DATABASE_URL ? postgresStore(process.env.DATABASE_URL) : memoryStore();

// ---- HTTP ----

const app = express();
app.use(express.json({ limit: "10kb" }));

app.get("/healthz", (req, res) => res.json({ ok: true, storage: store.kind }));

app.get("/api/chirps", async (req, res, next) => {
  try {
    res.json({ storage: store.kind, chirps: await store.list() });
  } catch (err) {
    next(err);
  }
});

app.post("/api/chirps", async (req, res, next) => {
  const handle = String(req.body?.handle || "").trim().replace(/^@/, "").slice(0, 30);
  const body = String(req.body?.body || "").trim();
  if (!handle || !/^[A-Za-z0-9_]+$/.test(handle)) {
    return res.status(400).json({ error: "handle: letters, digits and _ only" });
  }
  if (!body || body.length > MAX_LENGTH) {
    return res.status(400).json({ error: `chirps are 1-${MAX_LENGTH} characters` });
  }
  try {
    res.status(201).json(await store.create(handle, body));
  } catch (err) {
    next(err);
  }
});

app.post("/api/chirps/:id/like", async (req, res, next) => {
  try {
    const chirp = await store.like(Number(req.params.id));
    chirp ? res.json(chirp) : res.status(404).json({ error: "no such chirp" });
  } catch (err) {
    next(err);
  }
});

// The React app, with client-side routes falling back to index.html.
app.use(express.static(dist));
app.get(/^\/(?!api\/).*/, (req, res) => res.sendFile(path.join(dist, "index.html")));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: "something went wrong" });
});

await store.init();
app.listen(PORT, "0.0.0.0", () => {
  console.log(`chirp listening on :${PORT} (storage: ${store.kind})`);
});
