// HTTP contract tests: routes, status codes and auth. Runs the real Express
// app in-process against the memory store (DATABASE_URL is unset before the
// server is imported) on an ephemeral port.
import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";

process.env.CHIRP_TEST = "1";
delete process.env.DATABASE_URL;
const { app } = await import("../server.js");

let base;
let server;
before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => new Promise((resolve) => server.close(resolve)));

const user = (local, name) => ({
  "X-Berth-User-Id": `test:${local}`,
  "X-Berth-Email": `${local}@example.com`,
  "X-Berth-Name": encodeURIComponent(name || local),
});

async function api(method, path, { headers, body } = {}) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

describe("http", () => {
  it("serves healthz and me", async () => {
    const h = await api("GET", "/healthz");
    assert.equal(h.status, 200);
    assert.equal(h.data.storage, "memory");
    const anon = await api("GET", "/api/me");
    assert.equal(anon.data.signed_in, false);
    const me = await api("GET", "/api/me", { headers: user("ada", "Ada") });
    assert.equal(me.data.signed_in, true);
    assert.equal(me.data.handle, "ada");
  });

  it("requires sign-in for writes", async () => {
    assert.equal((await api("POST", "/api/chirps", { body: { body: "x" } })).status, 401);
    assert.equal((await api("POST", "/api/chirps/1/like")).status, 401);
    assert.equal((await api("POST", "/api/chirps/1/rechirp")).status, 401);
    assert.equal((await api("DELETE", "/api/chirps/1")).status, 401);
    assert.equal((await api("POST", "/api/users/ada/follow")).status, 401);
    assert.equal((await api("POST", "/api/summary")).status, 401);
    assert.equal((await api("GET", "/api/chirps?following=1")).status, 401);
  });

  it("validates chirp bodies", async () => {
    const ada = user("ada", "Ada");
    assert.equal((await api("POST", "/api/chirps", { headers: ada, body: { body: "" } })).status, 400);
    assert.equal((await api("POST", "/api/chirps", { headers: ada, body: { body: "x".repeat(281) } })).status, 400);
    assert.equal((await api("POST", "/api/chirps", { headers: ada, body: { body: "ok", parent_id: "abc" } })).status, 400);
    assert.equal((await api("POST", "/api/chirps", { headers: ada, body: { body: "ok", parent_id: 999999 } })).status, 404);
  });

  it("posts, replies and serves threads", async () => {
    const ada = user("ada", "Ada");
    const grace = user("grace", "Grace");
    const c = await api("POST", "/api/chirps", { headers: ada, body: { body: "root" } });
    assert.equal(c.status, 201);
    assert.equal(c.data.replies, 0);
    assert.equal(c.data.liked, false);
    const r = await api("POST", "/api/chirps", { headers: grace, body: { body: "reply", parent_id: c.data.id } });
    assert.equal(r.status, 201);
    assert.equal(r.data.parent.handle, "ada");
    const t = await api("GET", `/api/chirps/${c.data.id}/thread`);
    assert.equal(t.status, 200);
    assert.equal(t.data.chirp.replies, 1);
    assert.equal(t.data.replies.length, 1);
    assert.equal(t.data.replies[0].id, r.data.id);
    const nested = await api("GET", `/api/chirps/${r.data.id}/thread`);
    assert.deepEqual(
      nested.data.ancestors.map((x) => x.id),
      [c.data.id],
    );
    assert.equal((await api("GET", "/api/chirps/999999/thread")).status, 404);
    assert.equal((await api("GET", "/api/chirps/abc/thread")).status, 404);
  });

  it("likes and rechirps toggle", async () => {
    const ada = user("ada", "Ada");
    const grace = user("grace", "Grace");
    const c = await api("POST", "/api/chirps", { headers: ada, body: { body: "toggle me" } });
    const id = c.data.id;
    let l = await api("POST", `/api/chirps/${id}/like`, { headers: grace });
    assert.equal(l.data.likes, 1);
    assert.equal(l.data.liked, true);
    l = await api("POST", `/api/chirps/${id}/like`, { headers: grace });
    assert.equal(l.data.likes, 0);
    let rt = await api("POST", `/api/chirps/${id}/rechirp`, { headers: grace });
    assert.equal(rt.status, 200);
    assert.equal(rt.data.rechirped, true);
    assert.equal(rt.data.chirp.rechirps, 1);
    assert.ok(rt.data.rechirp.id);
    rt = await api("POST", `/api/chirps/${id}/rechirp`, { headers: grace });
    assert.equal(rt.data.rechirped, false);
    assert.equal(rt.data.chirp.rechirps, 0);
    assert.equal((await api("POST", "/api/chirps/999999/rechirp", { headers: grace })).status, 404);
    assert.equal((await api("POST", "/api/chirps/999999/like", { headers: grace })).status, 404);
  });

  it("filters by tag and following", async () => {
    const u = `htag${Date.now().toString(36)}`;
    const ada = user("ada", "Ada");
    const fan = user("fan_f1", "Fan");
    await api("POST", "/api/chirps", { headers: ada, body: { body: `hello #${u}` } });
    const tagged = await api("GET", `/api/chirps?tag=${u}`);
    assert.ok(tagged.data.chirps.length >= 1);
    assert.ok(tagged.data.chirps.every((c) => c.body.includes(`#${u}`)));
    await api("POST", "/api/chirps", { headers: fan, body: { body: "fan post" } });
    let tl = await api("GET", "/api/chirps?following=1", { headers: fan });
    assert.ok(tl.data.chirps.length >= 1);
    assert.ok(tl.data.chirps.every((c) => c.author_id === "test:fan_f1"));
    await api("POST", "/api/users/ada/follow", { headers: fan });
    tl = await api("GET", "/api/chirps?following=1", { headers: fan });
    const handles = new Set(tl.data.chirps.map((c) => c.handle));
    assert.ok(handles.has("ada"));
    assert.ok(handles.has("fan_f1"));
    await api("POST", "/api/users/ada/follow", { headers: fan }); // undo
  });

  it("serves profiles and follows", async () => {
    const ada = user("ada", "Ada");
    const bob = user("bob_p1", "Bob");
    await api("POST", "/api/chirps", { headers: ada, body: { body: "ada post" } });
    const p = await api("GET", "/api/users/ada");
    assert.equal(p.status, 200);
    assert.ok(p.data.chirp_count >= 1);
    assert.equal(p.data.is_self, false);
    let f = await api("POST", "/api/users/ada/follow", { headers: bob });
    assert.equal(f.status, 200);
    assert.equal(f.data.following, true);
    const p2 = await api("GET", "/api/users/ada", { headers: bob });
    assert.equal(p2.data.following, true);
    f = await api("POST", "/api/users/ada/follow", { headers: bob });
    assert.equal(f.data.following, false);
    assert.equal((await api("POST", "/api/users/bob_p1/follow", { headers: bob })).status, 400);
    assert.equal((await api("POST", "/api/users/nobody_zz9/follow", { headers: bob })).status, 404);
    assert.equal((await api("GET", "/api/users/nobody_zz9")).status, 404);
    const self = await api("GET", "/api/users/bob_p1", { headers: bob });
    assert.equal(self.data.is_self, true);
  });

  it("deletes own chirps with their threads", async () => {
    const ada = user("ada", "Ada");
    const c = await api("POST", "/api/chirps", { headers: ada, body: { body: "doomed" } });
    const r = await api("POST", "/api/chirps", { headers: ada, body: { body: "doomed reply", parent_id: c.data.id } });
    assert.equal((await api("DELETE", `/api/chirps/${c.data.id}`, { headers: ada })).status, 204);
    assert.equal((await api("GET", `/api/chirps/${c.data.id}/thread`)).status, 404);
    assert.equal((await api("GET", `/api/chirps/${r.data.id}/thread`)).status, 404);
    assert.equal((await api("DELETE", "/api/chirps/999999", { headers: ada })).status, 404);
    const grace = user("grace", "Grace");
    const g = await api("POST", "/api/chirps", { headers: grace, body: { body: "not yours" } });
    assert.equal((await api("DELETE", `/api/chirps/${g.data.id}`, { headers: ada })).status, 404);
  });
});
