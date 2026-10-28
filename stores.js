// Chirp storage: an in-memory store (used until Postgres is linked) and a
// Postgres store behind the same interface:
//
//   list(userId, { tag, followingOnly, authorHandle }) -> newest-first chirps
//   get(id, userId)           -> one enriched chirp, or null
//   thread(id, userId)        -> { chirp, ancestors, replies }, or null
//   create(author, body, { parentId }) -> enriched chirp, or null (bad parent)
//   toggleLike(id, userId)    -> enriched chirp, or null
//   toggleRechirp(id, author) -> { rechirped, chirp, rechirp }, or null
//   toggleFollow(followerId, followeeId) -> { following, followers }
//   profile(handle, viewer)   -> profile + chirps, or null
//   remove(id, userId)        -> bool
//
// An enriched chirp is the row plus viewer flags (liked, rechirped), reply /
// rechirp counts, a parent summary for replies, and the embedded original
// for rechirps (null when the original is gone).
//
// The tag filter applies to the newest 100 chirps in both stores, so memory
// and Postgres behave the same.

import pg from "pg";
import { extractHashtags, normalizeTag } from "./shared/hashtags.js";

// ---------- in-memory store ----------

export function memoryStore() {
  const chirps = [];
  const likes = new Set(); // `${chirpId}:${userId}`
  const follows = new Map(); // followerId -> Set(followeeId)
  let nextId = 1;

  const byId = (id) => chirps.find((c) => c.id === id);
  const followersOf = (id) => [...follows.values()].filter((s) => s.has(id)).length;

  function enrich(c, userId) {
    const parent = c.parent_id ? byId(c.parent_id) : null;
    const orig = c.rechirp_of ? byId(c.rechirp_of) : null;
    return {
      ...c,
      liked: likes.has(`${c.id}:${userId}`),
      rechirped: chirps.some((r) => r.rechirp_of === c.id && r.author_id === userId),
      parent: c.parent_id ? (parent ? { id: parent.id, handle: parent.handle } : null) : null,
      original: c.rechirp_of
        ? orig
          ? {
              id: orig.id, handle: orig.handle, name: orig.name, picture: orig.picture,
              body: orig.body, created_at: orig.created_at,
              likes: orig.likes, replies: orig.replies, rechirps: orig.rechirps,
              liked: likes.has(`${orig.id}:${userId}`),
              rechirped: chirps.some((r) => r.rechirp_of === orig.id && r.author_id === userId),
            }
          : null
        : null,
    };
  }

  // Unchecked recursive delete: replies and rechirps of a deleted chirp go
  // with it, mirroring the Postgres ON DELETE CASCADE.
  function removeRow(id) {
    const i = chirps.findIndex((c) => c.id === id);
    if (i < 0) return;
    chirps.splice(i, 1);
    for (const key of [...likes]) if (key.startsWith(`${id}:`)) likes.delete(key);
    for (const child of chirps.filter((c) => c.parent_id === id || c.rechirp_of === id)) {
      removeRow(child.id);
    }
  }

  return {
    kind: "memory",
    async init() {},

    async list(userId, { tag, followingOnly, authorHandle } = {}) {
      let rows = chirps;
      if (authorHandle) {
        rows = rows.filter((c) => c.handle.toLowerCase() === String(authorHandle).toLowerCase());
      }
      if (followingOnly) {
        rows = rows.filter((c) => c.author_id === userId || (follows.get(userId)?.has(c.author_id)));
      }
      rows = [...rows].sort((a, b) => b.id - a.id).slice(0, 100);
      if (tag) {
        const t = normalizeTag(tag);
        if (t) rows = rows.filter((c) => extractHashtags(c.body).includes(t));
      }
      return rows.map((c) => enrich(c, userId));
    },

    async get(id, userId) {
      const c = byId(id);
      return c ? enrich(c, userId) : null;
    },

    async thread(id, userId) {
      const c = byId(id);
      if (!c) return null;
      const ancestors = [];
      let cur = c;
      while (cur.parent_id && ancestors.length < 50) {
        const p = byId(cur.parent_id);
        if (!p) break;
        ancestors.unshift(enrich(p, userId));
        cur = p;
      }
      const replies = chirps
        .filter((r) => r.parent_id === id)
        .sort((a, b) => a.id - b.id)
        .slice(0, 100)
        .map((r) => enrich(r, userId));
      return { chirp: enrich(c, userId), ancestors, replies };
    },

    async create(author, body, { parentId } = {}) {
      const pid = parentId ?? null;
      if (pid != null && !byId(pid)) return null;
      const chirp = {
        id: nextId++, author_id: author.id, handle: author.handle, name: author.name,
        picture: author.picture, body, likes: 0, replies: 0, rechirps: 0,
        parent_id: pid, rechirp_of: null, created_at: new Date().toISOString(),
      };
      chirps.push(chirp);
      if (pid != null) byId(pid).replies++;
      return enrich(chirp, author.id);
    },

    async toggleLike(id, userId) {
      const chirp = byId(id);
      if (!chirp) return null;
      const key = `${id}:${userId}`;
      if (likes.delete(key)) chirp.likes--;
      else (likes.add(key), chirp.likes++);
      return enrich(chirp, userId);
    },

    async toggleRechirp(id, author) {
      const target = byId(id);
      if (!target) return null;
      // Rechirping a rechirp resolves to the original; chains stay one deep.
      const original = target.rechirp_of ? byId(target.rechirp_of) : target;
      if (!original) return null;
      const mine = chirps.find((r) => r.rechirp_of === original.id && r.author_id === author.id);
      if (mine) {
        removeRow(mine.id);
        original.rechirps--;
        return { rechirped: false, chirp: enrich(original, author.id), rechirp: null };
      }
      const chirp = {
        id: nextId++, author_id: author.id, handle: author.handle, name: author.name,
        picture: author.picture, body: "", likes: 0, replies: 0, rechirps: 0,
        parent_id: null, rechirp_of: original.id, created_at: new Date().toISOString(),
      };
      chirps.push(chirp);
      original.rechirps++;
      return { rechirped: true, chirp: enrich(original, author.id), rechirp: enrich(chirp, author.id) };
    },

    async toggleFollow(followerId, followeeId) {
      let set = follows.get(followerId);
      if (!set) follows.set(followerId, (set = new Set()));
      const following = set.has(followeeId) ? (set.delete(followeeId), false) : (set.add(followeeId), true);
      return { following, followers: followersOf(followeeId) };
    },

    async profile(handle, viewer) {
      const h = String(handle).toLowerCase();
      const mine = chirps.filter((c) => c.handle.toLowerCase() === h);
      let authorId, name, picture, pHandle = h;
      if (mine.length) {
        const latest = mine.reduce((a, b) => (a.id > b.id ? a : b));
        ({ author_id: authorId, name, picture, handle: pHandle } = latest);
      } else if (viewer && viewer.handle.toLowerCase() === h) {
        // Your own profile resolves even before your first chirp.
        ({ id: authorId, name, picture, handle: pHandle } = viewer);
      } else {
        return null;
      }
      return {
        handle: pHandle, name, picture, author_id: authorId,
        chirp_count: mine.length,
        followers_count: followersOf(authorId),
        following_count: follows.get(authorId)?.size || 0,
        following: viewer ? follows.get(viewer.id)?.has(authorId) || false : false,
        is_self: viewer?.id === authorId,
        chirps: [...mine].sort((a, b) => b.id - a.id).slice(0, 100).map((c) => enrich(c, viewer?.id)),
      };
    },

    async remove(id, userId) {
      const c = byId(id);
      if (!c || c.author_id !== userId) return false;
      removeRow(id);
      if (c.parent_id) {
        const p = byId(c.parent_id);
        if (p) p.replies--;
      }
      if (c.rechirp_of) {
        const o = byId(c.rechirp_of);
        if (o) o.rechirps--;
      }
      return true;
    },
  };
}

// ---------- Postgres store ----------

export function postgresStore(url) {
  const pool = new pg.Pool({ connectionString: url });

  // One enriched chirp: the row, viewer flags ($1 is the viewer id), a
  // parent summary for replies, and the embedded original for rechirps.
  const COLS = `c.*,
    EXISTS (SELECT 1 FROM likes l WHERE l.chirp_id = c.id AND l.user_id = $1) AS liked,
    EXISTS (SELECT 1 FROM chirps r WHERE r.rechirp_of = c.id AND r.author_id = $1) AS rechirped,
    p.handle AS parent_handle,
    o.id AS original_id, o.handle AS original_handle, o.name AS original_name,
    o.picture AS original_picture, o.body AS original_body, o.created_at AS original_created_at,
    o.likes AS original_likes, o.replies AS original_replies, o.rechirps AS original_rechirps,
    EXISTS (SELECT 1 FROM likes ol WHERE ol.chirp_id = o.id AND ol.user_id = $1) AS original_liked,
    EXISTS (SELECT 1 FROM chirps r2 WHERE r2.rechirp_of = o.id AND r2.author_id = $1) AS original_rechirped`;
  const FROM = `FROM chirps c
    LEFT JOIN chirps p ON p.id = c.parent_id
    LEFT JOIN chirps o ON o.id = c.rechirp_of`;

  function view(r) {
    return {
      id: r.id, author_id: r.author_id, handle: r.handle, name: r.name, picture: r.picture,
      body: r.body, likes: r.likes, created_at: r.created_at,
      parent_id: r.parent_id ?? null, rechirp_of: r.rechirp_of ?? null,
      replies: r.replies ?? 0, rechirps: r.rechirps ?? 0,
      liked: !!r.liked, rechirped: !!r.rechirped,
      parent: r.parent_id ? { id: r.parent_id, handle: r.parent_handle } : null,
      original: r.rechirp_of
        ? r.original_id
          ? {
              id: r.original_id, handle: r.original_handle, name: r.original_name,
              picture: r.original_picture, body: r.original_body, created_at: r.original_created_at,
              likes: r.original_likes, replies: r.original_replies, rechirps: r.original_rechirps,
              liked: !!r.original_liked, rechirped: !!r.original_rechirped,
            }
          : null
        : null,
    };
  }

  async function get(id, userId) {
    const { rows } = await pool.query(`SELECT ${COLS} ${FROM} WHERE c.id = $2`, [userId || "", id]);
    return rows[0] ? view(rows[0]) : null;
  }

  async function list(userId, { tag, followingOnly, authorHandle } = {}) {
    const conds = [];
    const params = [userId || ""];
    if (authorHandle) {
      params.push(String(authorHandle).toLowerCase());
      conds.push(`LOWER(c.handle) = $${params.length}`);
    }
    if (followingOnly) {
      conds.push(`(c.author_id = $1 OR c.author_id IN (SELECT followee_id FROM follows WHERE follower_id = $1))`);
    }
    const where = conds.length ? `WHERE ${conds.join(" AND ")}` : "";
    const { rows } = await pool.query(
      `SELECT ${COLS} ${FROM} ${where} ORDER BY c.id DESC LIMIT 100`, params,
    );
    let out = rows.map(view);
    if (tag) {
      const t = normalizeTag(tag);
      if (t) out = out.filter((c) => extractHashtags(c.body).includes(t));
    }
    return out;
  }

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

    list,
    get,

    async thread(id, userId) {
      const chirp = await get(id, userId);
      if (!chirp) return null;
      const ancestors = [];
      let cur = chirp;
      while (cur.parent_id && ancestors.length < 50) {
        const p = await get(cur.parent_id, userId);
        if (!p) break;
        ancestors.unshift(p);
        cur = p;
      }
      const { rows } = await pool.query(
        `SELECT ${COLS} ${FROM} WHERE c.parent_id = $2 ORDER BY c.id ASC LIMIT 100`,
        [userId || "", id],
      );
      return { chirp, ancestors, replies: rows.map(view) };
    },

    async create(author, body, { parentId } = {}) {
      const pid = parentId ?? null;
      if (pid != null) {
        const p = await pool.query(`SELECT id FROM chirps WHERE id = $1`, [pid]);
        if (!p.rows[0]) return null;
      }
      const ins = await pool.query(
        `INSERT INTO chirps (author_id, handle, name, picture, body, parent_id)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [author.id, author.handle, author.name, author.picture, body, pid],
      );
      if (pid != null) {
        await pool.query(`UPDATE chirps SET replies = replies + 1 WHERE id = $1`, [pid]);
      }
      return get(ins.rows[0].id, author.id);
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
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
      return get(id, userId);
    },

    async toggleRechirp(id, author) {
      const target = await get(id, author.id);
      if (!target) return null;
      // Rechirping a rechirp resolves to the original; chains stay one deep.
      const origId = target.rechirp_of || target.id;
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const orig = await client.query(`SELECT id FROM chirps WHERE id = $1`, [origId]);
        if (!orig.rows[0]) {
          await client.query("ROLLBACK");
          return null;
        }
        const mine = await client.query(
          `SELECT id FROM chirps WHERE rechirp_of = $1 AND author_id = $2`, [origId, author.id],
        );
        let rechirped, rechirpId = null;
        if (mine.rows[0]) {
          await client.query(`DELETE FROM chirps WHERE id = $1`, [mine.rows[0].id]);
          await client.query(`UPDATE chirps SET rechirps = rechirps - 1 WHERE id = $1`, [origId]);
          rechirped = false;
        } else {
          const ins = await client.query(
            `INSERT INTO chirps (author_id, handle, name, picture, body, rechirp_of)
             VALUES ($1, $2, $3, $4, '', $5) RETURNING id`,
            [author.id, author.handle, author.name, author.picture, origId],
          );
          await client.query(`UPDATE chirps SET rechirps = rechirps + 1 WHERE id = $1`, [origId]);
          rechirped = true;
          rechirpId = ins.rows[0].id;
        }
        await client.query("COMMIT");
        return {
          rechirped,
          chirp: await get(origId, author.id),
          rechirp: rechirpId ? await get(rechirpId, author.id) : null,
        };
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },

    async toggleFollow(followerId, followeeId) {
      const added = await pool.query(
        `INSERT INTO follows (follower_id, followee_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [followerId, followeeId],
      );
      let following;
      if (added.rowCount) {
        following = true;
      } else {
        await pool.query(`DELETE FROM follows WHERE follower_id = $1 AND followee_id = $2`, [followerId, followeeId]);
        following = false;
      }
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS n FROM follows WHERE followee_id = $1`, [followeeId],
      );
      return { following, followers: rows[0].n };
    },

    async profile(handle, viewer) {
      const h = String(handle).toLowerCase();
      const ident = await pool.query(
        `SELECT author_id, handle, name, picture FROM chirps
         WHERE LOWER(handle) = $1 ORDER BY id DESC LIMIT 1`, [h],
      );
      let authorId, name, picture, pHandle = h;
      if (ident.rows[0]) {
        ({ author_id: authorId, name, picture, handle: pHandle } = ident.rows[0]);
      } else if (viewer && viewer.handle.toLowerCase() === h) {
        // Your own profile resolves even before your first chirp.
        ({ id: authorId, name, picture, handle: pHandle } = viewer);
      } else {
        return null;
      }
      const [cc, frs, fing] = await Promise.all([
        pool.query(`SELECT COUNT(*)::int AS n FROM chirps WHERE author_id = $1`, [authorId]),
        pool.query(`SELECT COUNT(*)::int AS n FROM follows WHERE followee_id = $1`, [authorId]),
        pool.query(`SELECT COUNT(*)::int AS n FROM follows WHERE follower_id = $1`, [authorId]),
      ]);
      let following = false;
      if (viewer) {
        const r = await pool.query(
          `SELECT 1 FROM follows WHERE follower_id = $1 AND followee_id = $2`, [viewer.id, authorId],
        );
        following = r.rows.length > 0;
      }
      return {
        handle: pHandle, name, picture, author_id: authorId,
        chirp_count: cc.rows[0].n,
        followers_count: frs.rows[0].n,
        following_count: fing.rows[0].n,
        following,
        is_self: viewer?.id === authorId,
        chirps: await list(viewer?.id, { authorHandle: h }),
      };
    },

    async remove(id, userId) {
      const sel = await pool.query(
        `SELECT parent_id, rechirp_of FROM chirps WHERE id = $1 AND author_id = $2`, [id, userId],
      );
      if (!sel.rows[0]) return false;
      await pool.query(`DELETE FROM chirps WHERE id = $1`, [id]);
      if (sel.rows[0].parent_id) {
        await pool.query(`UPDATE chirps SET replies = replies - 1 WHERE id = $1`, [sel.rows[0].parent_id]);
      }
      if (sel.rows[0].rechirp_of) {
        await pool.query(`UPDATE chirps SET rechirps = rechirps - 1 WHERE id = $1`, [sel.rows[0].rechirp_of]);
      }
      return true;
    },
  };
}
