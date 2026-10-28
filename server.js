// Chirp: a tiny Twitter clone for Berth.
//
// Express serves a JSON API and the React app that `npm run build` puts in
// dist/. Berth's Google sign-in tells the app who is posting. Chirps live in Postgres when DATABASE_URL is set (berth pg:link),
// and in memory otherwise, so the very first deploy is healthy before any
// database exists. Storage lives in stores.js; both stores share one interface.

import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { memoryStore, postgresStore } from "./stores.js";

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

// Numeric chirp id, or null for garbage (which can never match a row).
function chirpId(value) {
  const id = Number(value);
  return Number.isInteger(id) ? id : null;
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
    const me = viewer(req);
    const followingOnly = req.query.following === "1";
    if (followingOnly && !me) {
      return res.status(401).json({ error: "sign in to see your timeline", login: "/_berth/login" });
    }
    const tag = typeof req.query.tag === "string" && req.query.tag.trim() ? req.query.tag : null;
    res.json({ storage: store.kind, chirps: await store.list(me?.id, { tag, followingOnly }) });
  } catch (err) {
    next(err);
  }
});

app.get("/api/chirps/:id/thread", async (req, res, next) => {
  try {
    const id = chirpId(req.params.id);
    const thread = id == null ? null : await store.thread(id, viewer(req)?.id);
    thread ? res.json(thread) : res.status(404).json({ error: "no such chirp" });
  } catch (err) {
    next(err);
  }
});

app.post("/api/chirps", requireViewer, async (req, res, next) => {
  const body = String(req.body?.body || "").trim();
  if (!body || body.length > MAX_LENGTH) {
    return res.status(400).json({ error: `chirps are 1-${MAX_LENGTH} characters` });
  }
  const rawParent = req.body?.parent_id;
  const parentId = rawParent == null || rawParent === "" ? null : chirpId(rawParent);
  if (rawParent != null && rawParent !== "" && parentId == null) {
    return res.status(400).json({ error: "bad parent_id" });
  }
  try {
    const chirp = await store.create(req.viewer, body, { parentId });
    chirp ? res.status(201).json(chirp) : res.status(404).json({ error: "no such chirp" });
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

app.post("/api/chirps/:id/rechirp", requireViewer, async (req, res, next) => {
  try {
    const id = chirpId(req.params.id);
    const result = id == null ? null : await store.toggleRechirp(id, req.viewer);
    result ? res.json(result) : res.status(404).json({ error: "no such chirp" });
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
    // Rechirps carry no text of their own, so they would only dilute the summary.
    const chirps = (await store.list(req.viewer.id)).filter((c) => !c.rechirp_of);
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

app.get("/api/users/:handle", async (req, res, next) => {
  try {
    res.set("Cache-Control", "no-store");
    const profile = await store.profile(req.params.handle, viewer(req));
    profile ? res.json(profile) : res.status(404).json({ error: "no such user" });
  } catch (err) {
    next(err);
  }
});

app.post("/api/users/:handle/follow", requireViewer, async (req, res, next) => {
  try {
    if (req.params.handle.toLowerCase() === req.viewer.handle.toLowerCase()) {
      return res.status(400).json({ error: "you cannot follow yourself" });
    }
    const profile = await store.profile(req.params.handle, req.viewer);
    if (!profile) return res.status(404).json({ error: "no such user" });
    res.json({ ...(await store.toggleFollow(req.viewer.id, profile.author_id)), handle: profile.handle });
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
if (!process.env.CHIRP_TEST) {
  // test/http.test.js imports the app and owns its own socket.
  app.listen(PORT, "0.0.0.0", () => {
    console.log(`chirp listening on :${PORT} (storage: ${store.kind})`);
  });
}

export { app, store };
