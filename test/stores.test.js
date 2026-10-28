import { describe, it, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { memoryStore, postgresStore } from "../stores.js";

// Every test gets unique authors, so tests stay independent even when they
// share one Postgres database. Created rows are removed afterwards; follow
// rows reference test-only author ids and are invisible to real usage.
const RUN = Date.now().toString(36);
let n = 0;
function authors() {
  n += 1;
  const suffix = `${RUN}_${process.pid}_${n}`;
  return {
    ada: { id: `test:ada:${suffix}`, handle: `ada_${suffix}`, name: "Ada", picture: "" },
    grace: { id: `test:grace:${suffix}`, handle: `grace_${suffix}`, name: "Grace", picture: "" },
  };
}

function suite(name, make) {
  describe(name, () => {
    let store;
    const created = []; // [id, authorId], for cleanup
    beforeEach(async () => {
      store = make();
      await store.init();
    });
    after(async () => {
      for (const [id, authorId] of created) {
        try {
          await store.remove(id, authorId);
        } catch {
          // best effort: the row may already be gone (cascade / toggle-off)
        }
      }
    });

    const post = (author, body, opts) =>
      store.create(author, body, opts).then((c) => {
        if (c) created.push([c.id, author.id]);
        return c;
      });
    const rechirpAs = (author, id) =>
      store.toggleRechirp(id, author).then((r) => {
        if (r?.rechirp) created.push([r.rechirp.id, author.id]);
        return r;
      });

    it("creates and lists newest first, enriched", async () => {
      const { ada, grace } = authors();
      const a = await post(ada, "hello");
      const b = await post(grace, "world");
      const all = await store.list(ada.id);
      const ids = all.map((c) => c.id);
      assert.ok(ids.indexOf(b.id) < ids.indexOf(a.id));
      assert.deepEqual(
        { ...all.find((c) => c.id === b.id), id: 0, created_at: 0 },
        {
          id: 0, author_id: grace.id, handle: grace.handle, name: "Grace", picture: "",
          body: "world", likes: 0, created_at: 0,
          parent_id: null, rechirp_of: null, replies: 0, rechirps: 0,
          liked: false, rechirped: false, parent: null, original: null,
        },
      );
    });

    it("rejects replies to missing parents", async () => {
      const { ada } = authors();
      assert.equal(await store.create(ada, "x", { parentId: 999999999 }), null);
    });

    it("threads show ancestors and chronological replies", async () => {
      const { ada, grace } = authors();
      const root = await post(ada, "root");
      const r1 = await post(grace, "first", { parentId: root.id });
      const r2 = await post(ada, "second", { parentId: root.id });
      const nested = await post(ada, "nested", { parentId: r1.id });

      const t = await store.thread(nested.id, ada.id);
      assert.equal(t.chirp.id, nested.id);
      assert.deepEqual(
        t.ancestors.map((c) => c.id),
        [root.id, r1.id],
      );

      const tr = await store.thread(root.id, grace.id);
      assert.deepEqual(
        tr.replies.map((c) => c.id),
        [r1.id, r2.id],
      );
      assert.equal(tr.chirp.replies, 2);
      assert.equal((await store.get(r1.id, ada.id)).parent.handle, ada.handle);
      assert.equal(await store.thread(999999999, ada.id), null);
    });

    it("rechirp toggles and embeds the original", async () => {
      const { ada, grace } = authors();
      const c = await post(ada, "original");

      let r = await rechirpAs(grace, c.id);
      assert.equal(r.rechirped, true);
      assert.equal(r.chirp.rechirps, 1);
      assert.equal(r.chirp.rechirped, true);
      assert.equal(r.rechirp.rechirp_of, c.id);
      assert.equal(r.rechirp.original.body, "original");
      assert.equal(r.rechirp.original.liked, false);

      const found = (await store.list(grace.id)).find((x) => x.id === r.rechirp.id);
      assert.equal(found.original.id, c.id);

      r = await store.toggleRechirp(c.id, grace);
      assert.equal(r.rechirped, false);
      assert.equal(r.chirp.rechirps, 0);
      assert.equal(r.rechirp, null);
      assert.equal(await store.toggleRechirp(999999999, grace), null);
    });

    it("rechirping a rechirp resolves to the original", async () => {
      const { ada, grace } = authors();
      const c = await post(ada, "original");
      const r1 = await rechirpAs(grace, c.id);
      const r2 = await rechirpAs(ada, r1.rechirp.id);
      assert.equal(r2.rechirped, true);
      assert.equal(r2.chirp.id, c.id);
      assert.equal(r2.rechirp.rechirp_of, c.id);
      assert.equal(r2.chirp.rechirps, 2);
    });

    it("likes return enriched chirps", async () => {
      const { ada, grace } = authors();
      const c = await post(ada, "likeable");
      const liked = await store.toggleLike(c.id, grace.id);
      assert.equal(liked.likes, 1);
      assert.equal(liked.liked, true);
      assert.equal(liked.replies, 0);
      const unliked = await store.toggleLike(c.id, grace.id);
      assert.equal(unliked.likes, 0);
      assert.equal(await store.toggleLike(999999999, grace.id), null);
    });

    it("follows toggle and profiles report stats", async () => {
      const { ada, grace } = authors();
      await post(ada, "post");

      let f = await store.toggleFollow(grace.id, ada.id);
      assert.equal(f.following, true);
      assert.equal(f.followers, 1);

      const p = await store.profile(ada.handle, grace);
      assert.equal(p.chirp_count, 1);
      assert.equal(p.followers_count, 1);
      assert.equal(p.following_count, 0);
      assert.equal(p.following, true);
      assert.equal(p.is_self, false);
      assert.equal(p.chirps.length, 1);

      const self = await store.profile(grace.handle, grace);
      assert.equal(self.is_self, true);
      assert.equal(self.chirp_count, 0);
      assert.equal(self.following_count, 1);

      f = await store.toggleFollow(grace.id, ada.id);
      assert.equal(f.following, false);
      assert.equal(f.followers, 0);
    });

    it("profiles return null for unknown handles", async () => {
      const { grace } = authors();
      const missing = `missing_${RUN}_${process.pid}`;
      assert.equal(await store.profile(missing, grace), null);
      assert.equal(await store.profile(missing, null), null);
    });

    it("tag filter matches case-insensitively", async () => {
      const { ada, grace } = authors();
      const u = `u${RUN}p${process.pid}n${n}`;
      await post(ada, `hello #${u}`);
      await post(grace, "no tags here");
      const found = await store.list(ada.id, { tag: u.toUpperCase() });
      assert.ok(found.length >= 1);
      assert.ok(found.every((c) => c.body.includes(`#${u}`)));
      const hashed = await store.list(ada.id, { tag: `#${u}` });
      assert.deepEqual(
        hashed.map((c) => c.id),
        found.map((c) => c.id),
      );
    });

    it("following timeline shows followed authors and self", async () => {
      const { ada, grace } = authors();
      const mine = await post(ada, "mine");
      const theirs = await post(grace, "theirs");
      await store.toggleFollow(ada.id, grace.id);

      const ids = (await store.list(ada.id, { followingOnly: true })).map((c) => c.id);
      assert.ok(ids.includes(mine.id));
      assert.ok(ids.includes(theirs.id));

      const stranger = authors().ada;
      const s = await post(stranger, "stranger");
      const ids2 = (await store.list(ada.id, { followingOnly: true })).map((c) => c.id);
      assert.ok(!ids2.includes(s.id));

      await store.toggleFollow(ada.id, grace.id);
    });

    it("delete cascades and maintains counters", async () => {
      const { ada, grace } = authors();
      const root = await post(ada, "root");
      const reply = await post(grace, "reply", { parentId: root.id });
      const rt = await rechirpAs(grace, root.id);
      assert.equal((await store.get(root.id, ada.id)).replies, 1);
      assert.equal((await store.get(root.id, ada.id)).rechirps, 1);

      assert.equal(await store.remove(reply.id, grace.id), true);
      assert.equal((await store.get(root.id, ada.id)).replies, 0);

      assert.equal(await store.remove(root.id, ada.id), true);
      assert.equal(await store.get(root.id, ada.id), null);
      assert.equal(await store.get(rt.rechirp.id, ada.id), null);

      const other = await post(grace, "grace post");
      assert.equal(await store.remove(other.id, ada.id), false);
    });
  });
}

suite("memoryStore", () => memoryStore());

const dbUrl = process.env.CHIRP_TEST_DATABASE_URL || process.env.DATABASE_URL;
if (dbUrl) {
  suite("postgresStore", () => postgresStore(dbUrl));
} else {
  describe("postgresStore", () => {
    it("needs a database (skipped: no DATABASE_URL)", { skip: true }, () => {});
  });
}
