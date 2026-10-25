// Chirp: a tiny Twitter clone for Berth.
//
// Express serves a JSON API and the React app that `npm run build` puts in
// dist/. Berth's Google sign-in tells the app who is posting. Chirps live in Postgres when DATABASE_URL is set (berth pg:link),
// and in memory otherwise, so the very first deploy is healthy before any
// database exists.

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const PORT = process.env.PORT || 3000;
const MAX_LENGTH = 280;
const dist = path.join(path.dirname(fileURLToPath(import.meta.url)), "dist");

// ---- who is signed in ----
//
// Berth signs people in with Google and passes who they are as headers
// (`berth access chirp public`). Berth deletes any X-Berth-* headers a client
// sends, so these can be trusted. With no Berth in front (local dev),
// everyone is anonymous unless CHIRP_DEV_USER=you@example.com is set.

function viewer(req) {
  let id = req.get("X-Berth-User-Id");
  let email = req.get("X-Berth-Email");
  let name = req.get("X-Berth-Name");
  const picture = req.get("X-Berth-Picture") || "";
  if (!id && process.env.CHIRP_DEV_USER) {
    email = process.env.CHIRP_DEV_USER;
    id = "dev:" + email;
  }
  if (!id || !email) return null;
  try {
    name = decodeURIComponent(name || ""); // URL-encoded so any Unicode survives
  } catch {
    name = "";
  }
  const handle = email.split("@")[0].toLowerCase().replace(/[^a-z0-9_]/g, "_").slice(0, 30);
  return { id, email, name: name || handle, handle, picture };
}

function requireViewer(req, res, next) {
  req.viewer = viewer(req);
  if (!req.viewer) {
    return res.status(401).json({ error: "sign in to chirp", login: "/_berth/login" });
  }
  next();
}

// ---- storage ----

function memoryStore() {
  const chirps = [];
  const likes = new Set(); // `${chirpId}:${userId}`
  let nextId = 1;
  const view = (c, userId) => ({ ...c, liked: likes.has(`${c.id}:${userId}`) });
  return {
    kind: "memory",
    async init() {},
    async list(userId) {
      return [...chirps].sort((a, b) => b.id - a.id).slice(0, 100).map((c) => view(c, userId));
    },
    async create(author, body) {
      const chirp = {
        id: nextId++, author_id: author.id, handle: author.handle, name: author.name,
        picture: author.picture, body, likes: 0, created_at: new Date().toISOString(),
      };
      chirps.push(chirp);
      return view(chirp, author.id);
    },
    async toggleLike(id, userId) {
      const chirp = chirps.find((c) => c.id === id);
      if (!chirp) return null;
      const key = `${id}:${userId}`;
      if (likes.delete(key)) chirp.likes--;
      else (likes.add(key), chirp.likes++);
      return view(chirp, userId);
    },
    async remove(id, userId) {
      const i = chirps.findIndex((c) => c.id === id && c.author_id === userId);
      if (i < 0) return false;
      chirps.splice(i, 1);
      return true;
    },
  };
}

function postgresStore(url) {
  const pool = new pg.Pool({ connectionString: url });
  const select = `SELECT c.*, EXISTS (SELECT 1 FROM likes l WHERE l.chirp_id = c.id AND l.user_id = $1) AS liked FROM chirps c`;
  return {
    kind: "postgres",
    async init() {
      // The schema is migrate.js's job (Berth runs it before each release).
      try {
        await pool.query("SELECT 1 FROM schema_migrations LIMIT 1");
      } catch {
        throw new Error("the database has no schema yet: run `node migrate.js` (Berth runs it via the Procfile)");
      }
    },
    async list(userId) {
      const { rows } = await pool.query(`${select} ORDER BY c.id DESC LIMIT 100`, [userId || ""]);
      return rows;
    },
    async create(author, body) {
      const { rows } = await pool.query(
        `INSERT INTO chirps (author_id, handle, name, picture, body) VALUES ($1, $2, $3, $4, $5) RETURNING *, false AS liked`,
        [author.id, author.handle, author.name, author.picture, body],
      );
      return rows[0];
    },
    async toggleLike(id, userId) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const added = await client.query(
          "INSERT INTO likes (chirp_id, user_id) SELECT id, $2 FROM chirps WHERE id = $1 ON CONFLICT DO NOTHING",
          [id, userId],
        );
        if (added.rowCount) {
          await client.query("UPDATE chirps SET likes = likes + 1 WHERE id = $1", [id]);
        } else {
          const removed = await client.query("DELETE FROM likes WHERE chirp_id = $1 AND user_id = $2", [id, userId]);
          if (removed.rowCount) await client.query("UPDATE chirps SET likes = likes - 1 WHERE id = $1", [id]);
        }
        const { rows } = await client.query(`${select} WHERE c.id = $2`, [userId, id]);
        await client.query("COMMIT");
        return rows[0];
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
    async remove(id, userId) {
      const { rowCount } = await pool.query("DELETE FROM chirps WHERE id = $1 AND author_id = $2", [id, userId]);
      return rowCount > 0;
    },
  };
}

const store = process.env.DATABASE_URL ? postgresStore(process.env.DATABASE_URL) : memoryStore();

// ---- AI: "what's happening?" ----
//
// `berth ai:enable chirp` points the standard OpenAI variables at Berth's AI
// gateway, with a token of Chirp's own; the model behind it (local or cloud)
// is the gateway's business. Any OpenAI-compatible endpoint works the same
// way. CHIRP_AI_MODEL picks the model (default: the gateway's "default").

const ai = process.env.OPENAI_BASE_URL && process.env.OPENAI_API_KEY
  ? { base: process.env.OPENAI_BASE_URL.replace(/\/$/, ""), key: process.env.OPENAI_API_KEY, model: process.env.CHIRP_AI_MODEL || "default" }
  : null;

let lastSummary = { newest: -1, text: "" }; // the timeline hasn't changed: reuse it

async function summarize(chirps) {
  const timeline = chirps.slice(0, 50).reverse().map((c) => `@${c.handle}: ${c.body}`).join("\n");
  const res = await fetch(`${ai.base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ai.key}` },
    signal: AbortSignal.timeout(120_000),
    body: JSON.stringify({
      model: ai.model,
      messages: [
        { role: "system", content: "You summarize a small social timeline. In two or three short, friendly sentences, say what people are chirping about. Mention people as @handle. No preamble, no lists." },
        { role: "user", content: timeline },
      ],
    }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error?.message || res.statusText);
  // Some local models think out loud first; keep only the answer.
  return (data.choices?.[0]?.message?.content || "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

// ---- HTTP ----

const app = express();
app.use(express.json({ limit: "10kb" }));

app.get("/healthz", (req, res) => res.json({ ok: true, storage: store.kind }));

app.get("/api/me", (req, res) => {
  res.set("Cache-Control", "no-store");
  const me = viewer(req);
  res.json({ ...(me ? { signed_in: true, ...me } : { signed_in: false }), ai: !!ai });
});

app.get("/api/chirps", async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    res.json({ storage: store.kind, chirps: await store.list(viewer(req)?.id) });
  } catch (err) {
    next(err);
  }
});

app.post("/api/chirps", requireViewer, async (req, res, next) => {
  const body = String(req.body?.body || "").trim();
  if (!body || body.length > MAX_LENGTH) {
    return res.status(400).json({ error: `chirps are 1-${MAX_LENGTH} characters` });
  }
  try {
    res.status(201).json(await store.create(req.viewer, body));
  } catch (err) {
    next(err);
  }
});

app.post("/api/chirps/:id/like", requireViewer, async (req, res, next) => {
  try {
    const chirp = await store.toggleLike(Number(req.params.id), req.viewer.id);
    chirp ? res.json(chirp) : res.status(404).json({ error: "no such chirp" });
  } catch (err) {
    next(err);
  }
});

app.delete("/api/chirps/:id", requireViewer, async (req, res, next) => {
  try {
    (await store.remove(Number(req.params.id), req.viewer.id))
      ? res.status(204).end()
      : res.status(404).json({ error: "no such chirp of yours" });
  } catch (err) {
    next(err);
  }
});

app.post("/api/summary", requireViewer, async (req, res, next) => {
  if (!ai) return res.status(404).json({ error: "no AI here (berth ai:enable chirp)" });
  try {
    const chirps = await store.list(req.viewer.id);
    if (chirps.length === 0) return res.json({ summary: "Nothing yet: the timeline is empty." });
    if (chirps[0].id !== lastSummary.newest) {
      lastSummary = { newest: chirps[0].id, text: await summarize(chirps) };
    }
    res.json({ summary: lastSummary.text });
  } catch (err) {
    console.error("summary:", err.message);
    res.status(502).json({ error: "the AI didn't answer; try again in a moment" });
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
