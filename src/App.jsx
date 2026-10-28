import { useCallback, useEffect, useState } from "react";
import { HASHTAG_PATTERN } from "../shared/hashtags.js";

const MAX = 280;

// ---------- tiny hash router ----------
//
// #/             timeline · #/chirp/12  thread · #/user/ada  profile · #/tag/x  tag

function parseRoute() {
  const h = location.hash || "#/";
  let m;
  if ((m = h.match(/^#\/chirp\/(\d+)/))) return { name: "thread", id: Number(m[1]) };
  if ((m = h.match(/^#\/user\/([^/?#]+)/))) return { name: "profile", handle: decodeURIComponent(m[1]) };
  if ((m = h.match(/^#\/tag\/([^/?#]+)/))) return { name: "tag", tag: decodeURIComponent(m[1]) };
  return { name: "home" };
}

function useRoute() {
  const [route, setRoute] = useState(parseRoute);
  useEffect(() => {
    const onChange = () => {
      setRoute(parseRoute());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

function timeAgo(iso) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(iso).toLocaleDateString();
}

// True when the body is just one emoji: a single grapheme cluster that
// contains emoji content. The grapheme split keeps ZWJ sequences (👨‍👩‍👧),
// skin-tone modifiers (👍🏽) and flags (🇺🇸) as one unit; the regex also
// accepts keycap / text-presentation emoji (1️⃣, ©️) via their joiners.
function isSingleEmoji(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return false;
  let graphemes;
  if (typeof Intl !== "undefined" && Intl.Segmenter) {
    graphemes = [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(trimmed)].map(
      (s) => s.segment,
    );
  } else {
    graphemes = Array.from(trimmed);
  }
  if (graphemes.length !== 1) return false;
  return /\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u200D\uFE0F\u20E3]/u.test(graphemes[0]);
}

function renderBody(body) {
  // Link #hashtags; everything else stays plain text (React escapes it).
  const text = String(body ?? "");
  const parts = [];
  let last = 0;
  let key = 0;
  for (const m of text.matchAll(new RegExp(HASHTAG_PATTERN, "gu"))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tag = m[1];
    parts.push(
      <a key={key++} className="tag" href={`#/tag/${encodeURIComponent(tag.toLowerCase())}`}>
        #{tag}
      </a>,
    );
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return parts;
}

// Swap an updated chirp into a list, including embedded originals.
function applyPatch(chirp, id, updated) {
  if (chirp.id === id) return updated;
  if (chirp.original && chirp.original.id === id) return { ...chirp, original: updated };
  return chirp;
}

function patchChirp(list, id, updated) {
  return list.map((c) => applyPatch(c, id, updated));
}

// Berth's sign-in endpoints live on every app with an access policy.
const loginURL = () =>
  "/_berth/login?return=" + encodeURIComponent(location.pathname + location.search + location.hash);

function Avatar({ picture, name, size = 40 }) {
  const [broken, setBroken] = useState(false);
  if (picture && !broken) {
    return (
      <img className="avatar" src={picture} alt="" width={size} height={size} referrerPolicy="no-referrer" onError={() => setBroken(true)} />
    );
  }
  return (
    <div className="avatar" style={{ width: size, height: size }} aria-hidden>
      {(name || "?")[0].toUpperCase()}
    </div>
  );
}

function Account({ me }) {
  if (!me) return null;
  if (!me.signed_in) {
    return (
      <a className="signin" href={loginURL()}>
        Sign in with Google
      </a>
    );
  }
  return (
    <div className="account">
      <Avatar picture={me.picture} name={me.name} size={28} />
      <span className="account-name">{me.name}</span>
      <form method="post" action="/_berth/logout">
        <button className="link">Sign out</button>
      </form>
    </div>
  );
}

function Composer({ me, parentId, onPosted, rows = 3, placeholder = "What's happening?" }) {
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const left = MAX - body.length;

  if (!me?.signed_in) {
    return (
      <div className="composer prompt">
        <p>Join the conversation.</p>
        <a className="signin" href={loginURL()}>
          Sign in to chirp
        </a>
      </div>
    );
  }

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/chirps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body, parent_id: parentId ?? null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "could not post");
      setBody("");
      onPosted(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="composer" onSubmit={submit}>
      <div className="composer-row">
        <Avatar picture={me.picture} name={me.name} />
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          placeholder={placeholder}
          rows={rows}
          aria-label={parentId ? "Reply text" : "Chirp text"}
        />
      </div>
      <div className="composer-footer">
        <span className={left < 0 ? "count over" : left < 20 ? "count low" : "count"}>{left}</span>
        <button disabled={busy || !body.trim() || left < 0}>{parentId ? "Reply" : "Chirp"}</button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function ChirpContent({ chirp, me, onLike, onDelete, onRechirp }) {
  const mine = me?.signed_in && chirp.author_id === me.id;
  return (
    <>
      <div className="chirp-meta">
        <b>
          <a className="quiet" href={`#/user/${encodeURIComponent(chirp.handle)}`}>
            {chirp.name || chirp.handle}
          </a>
        </b>{" "}
        <span>
          @{chirp.handle} · <a className="quiet" href={`#/chirp/${chirp.id}`}>{timeAgo(chirp.created_at)}</a>
        </span>
      </div>
      {chirp.parent && (
        <div className="reply-context">
          Replying to <a href={`#/chirp/${chirp.parent.id}`}>@{chirp.parent.handle}</a>
        </div>
      )}
      <p className={isSingleEmoji(chirp.body) ? "single-emoji" : undefined}>{renderBody(chirp.body)}</p>
      <div className="actions">
        <a className="action" href={`#/chirp/${chirp.id}`} aria-label="Reply">
          Reply{chirp.replies > 0 && ` ${chirp.replies}`}
        </a>
        <button
          className={chirp.rechirped ? "action rechirped" : "action"}
          onClick={() => (me?.signed_in ? onRechirp(chirp.id) : (location.href = loginURL()))}
          aria-pressed={chirp.rechirped}
          aria-label={chirp.rechirped ? "Undo rechirp" : "Rechirp"}
        >
          Rechirp{chirp.rechirps > 0 && ` ${chirp.rechirps}`}
        </button>
        <button
          className={chirp.liked ? "like liked" : "like"}
          onClick={() => (me?.signed_in ? onLike(chirp.id) : (location.href = loginURL()))}
          aria-pressed={chirp.liked}
          aria-label={chirp.liked ? "Unlike" : "Like"}
        >
          {chirp.liked ? "♥" : "♡"} {chirp.likes}
        </button>
        {mine && (
          <button className="link" onClick={() => onDelete(chirp.id)}>
            Delete
          </button>
        )}
      </div>
    </>
  );
}

function ChirpItem({ chirp, me, onLike, onDelete, onRechirp }) {
  // A rechirp renders as "X rechirped" above the original chirp itself.
  // (The server resolves chains, so an original is never itself a rechirp.)
  if (chirp.rechirp_of) {
    const mine = me?.signed_in && chirp.author_id === me.id;
    return (
      <li className="chirp">
        <Avatar picture={chirp.picture} name={chirp.name || chirp.handle} />
        <div className="chirp-main">
          <div className="rechirp-label">
            <a href={`#/user/${encodeURIComponent(chirp.handle)}`}>{chirp.name || chirp.handle}</a> rechirped
            {mine && (
              <>
                {" "}·{" "}
                <button className="link" onClick={() => onDelete(chirp.id)}>
                  Undo
                </button>
              </>
            )}
          </div>
          {chirp.original ? (
            <div className="original">
              <Avatar
                picture={chirp.original.picture}
                name={chirp.original.name || chirp.original.handle}
                size={32}
              />
              <div className="chirp-main">
                <ChirpContent
                  chirp={chirp.original}
                  me={me}
                  onLike={onLike}
                  onDelete={onDelete}
                  onRechirp={onRechirp}
                />
              </div>
            </div>
          ) : (
            <div className="original unavailable">This chirp is unavailable.</div>
          )}
        </div>
      </li>
    );
  }
  return (
    <li className="chirp">
      <Avatar picture={chirp.picture} name={chirp.name || chirp.handle} />
      <div className="chirp-main">
        <ChirpContent chirp={chirp} me={me} onLike={onLike} onDelete={onDelete} onRechirp={onRechirp} />
      </div>
    </li>
  );
}

function Summary() {
  const [state, setState] = useState({ busy: false, text: "", error: "" });
  async function ask() {
    setState({ busy: true, text: "", error: "" });
    try {
      const res = await fetch("/api/summary", { method: "POST" });
      const data = await res.json();
      setState({ busy: false, text: data.summary || "", error: data.error || "" });
    } catch {
      setState({ busy: false, text: "", error: "couldn't reach Chirp" });
    }
  }
  return (
    <section className="summary">
      <button onClick={ask} disabled={state.busy}>
        {state.busy ? "Reading the timeline…" : "✨ What's happening?"}
      </button>
      {state.text && <p>{state.text}</p>}
      {state.error && <p className="error">{state.error}</p>}
    </section>
  );
}

function Timeline({ me, tag }) {
  const home = !tag;
  const [chirps, setChirps] = useState([]);
  const [tab, setTab] = useState("foryou");
  const [offline, setOffline] = useState(false);
  const meKey = me?.signed_in ? me.id : "anon";
  const endpoint = tag
    ? `/api/chirps?tag=${encodeURIComponent(tag)}`
    : home && tab === "following"
      ? "/api/chirps?following=1"
      : "/api/chirps";

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(endpoint);
      if (res.status === 401) {
        setChirps([]);
        setOffline(false);
        return;
      }
      const data = await res.json();
      setChirps(data.chirps);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, [endpoint]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh, meKey]);

  async function like(id) {
    const res = await fetch(`/api/chirps/${id}/like`, { method: "POST" });
    if (res.ok) {
      const updated = await res.json();
      setChirps((cs) => patchChirp(cs, id, updated));
    }
  }

  async function rechirp(id) {
    const res = await fetch(`/api/chirps/${id}/rechirp`, { method: "POST" });
    if (!res.ok) return;
    const data = await res.json();
    setChirps((cs) => patchChirp(cs, data.chirp.id, data.chirp));
    refresh(); // reconcile wrapper rows (created or removed)
  }

  async function remove(id) {
    const res = await fetch(`/api/chirps/${id}`, { method: "DELETE" });
    if (res.ok) setChirps((cs) => cs.filter((c) => c.id !== id));
  }

  const empty = tag
    ? `No chirps tagged #${tag} yet.`
    : tab === "following"
      ? "Chirps from people you follow show up here."
      : "No chirps yet. Say something!";

  return (
    <>
      {home && (
        <Composer
          me={me}
          onPosted={(c) => {
            if (tab === "foryou") setChirps((cs) => [c, ...cs]);
          }}
        />
      )}
      {home && me?.signed_in && me.ai && <Summary />}
      {home && me?.signed_in && (
        <div className="tabs" role="tablist">
          <button
            role="tab"
            aria-selected={tab === "foryou"}
            className={tab === "foryou" ? "tab active" : "tab"}
            onClick={() => setTab("foryou")}
          >
            For you
          </button>
          <button
            role="tab"
            aria-selected={tab === "following"}
            className={tab === "following" ? "tab active" : "tab"}
            onClick={() => setTab("following")}
          >
            Following
          </button>
        </div>
      )}
      {tag && (
        <div className="banner">
          <span>#{tag}</span> <a href="#/">clear</a>
        </div>
      )}
      {offline && <div className="banner warn">reconnecting…</div>}
      <ul className="timeline">
        {chirps.map((c) => (
          <ChirpItem key={c.id} chirp={c} me={me} onLike={like} onDelete={remove} onRechirp={rechirp} />
        ))}
        {chirps.length === 0 && <li className="empty">{empty}</li>}
      </ul>
    </>
  );
}

function ThreadView({ me, id }) {
  const [data, setData] = useState(null);
  const meKey = me?.signed_in ? me.id : "anon";

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/chirps/${id}/thread`);
      if (res.status === 404) {
        setData({ missing: true });
        return;
      }
      if (!res.ok) return;
      setData(await res.json());
    } catch {
      /* keep stale */
    }
  }, [id]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh, meKey]);

  function patch(id, updated) {
    setData((d) =>
      d && !d.missing
        ? {
            ...d,
            chirp: applyPatch(d.chirp, id, updated),
            ancestors: patchChirp(d.ancestors, id, updated),
            replies: patchChirp(d.replies, id, updated),
          }
        : d,
    );
  }

  async function like(cid) {
    const res = await fetch(`/api/chirps/${cid}/like`, { method: "POST" });
    if (res.ok) patch(cid, await res.json());
  }

  async function rechirp(cid) {
    const res = await fetch(`/api/chirps/${cid}/rechirp`, { method: "POST" });
    if (!res.ok) return;
    const result = await res.json();
    patch(result.chirp.id, result.chirp);
    refresh();
  }

  async function remove(cid) {
    const res = await fetch(`/api/chirps/${cid}`, { method: "DELETE" });
    if (res.ok) refresh(); // reconcile cascades (deleting an ancestor removes its thread)
  }

  if (!data) return <div className="empty">Loading…</div>;
  if (data.missing) {
    return (
      <div className="empty">
        This chirp is unavailable. <a href="#/">Back to timeline</a>
      </div>
    );
  }

  return (
    <>
      <a className="back" href="#/">
        ← Timeline
      </a>
      {data.ancestors.length > 0 && (
        <ul className="timeline">
          {data.ancestors.map((c) => (
            <ChirpItem key={c.id} chirp={c} me={me} onLike={like} onDelete={remove} onRechirp={rechirp} />
          ))}
        </ul>
      )}
      <ul className="timeline thread-main">
        <ChirpItem chirp={data.chirp} me={me} onLike={like} onDelete={remove} onRechirp={rechirp} />
      </ul>
      <Composer
        me={me}
        parentId={data.chirp.id}
        rows={2}
        placeholder="Post your reply"
        onPosted={(reply) =>
          setData((d) => ({
            ...d,
            replies: [...d.replies, reply],
            chirp: { ...d.chirp, replies: d.chirp.replies + 1 },
          }))
        }
      />
      <div className="replies-label">Replies</div>
      <ul className="timeline">
        {data.replies.map((c) => (
          <ChirpItem key={c.id} chirp={c} me={me} onLike={like} onDelete={remove} onRechirp={rechirp} />
        ))}
        {data.replies.length === 0 && <li className="empty">No replies yet.</li>}
      </ul>
    </>
  );
}

function ProfileView({ me, handle }) {
  const [profile, setProfile] = useState(null);
  const meKey = me?.signed_in ? me.id : "anon";

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/users/${encodeURIComponent(handle)}`);
      if (res.status === 404) {
        setProfile({ missing: true });
        return;
      }
      if (!res.ok) return;
      setProfile(await res.json());
    } catch {
      /* keep stale */
    }
  }, [handle]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh, meKey]);

  async function follow() {
    const res = await fetch(`/api/users/${encodeURIComponent(handle)}/follow`, { method: "POST" });
    if (!res.ok) return;
    const result = await res.json();
    setProfile((p) => ({ ...p, following: result.following, followers_count: result.followers }));
  }

  async function like(id) {
    const res = await fetch(`/api/chirps/${id}/like`, { method: "POST" });
    if (res.ok) {
      const updated = await res.json();
      setProfile((p) => ({ ...p, chirps: patchChirp(p.chirps, id, updated) }));
    }
  }

  async function rechirp(id) {
    const res = await fetch(`/api/chirps/${id}/rechirp`, { method: "POST" });
    if (!res.ok) return;
    const result = await res.json();
    setProfile((p) => ({ ...p, chirps: patchChirp(p.chirps, result.chirp.id, result.chirp) }));
    refresh();
  }

  async function remove(id) {
    const res = await fetch(`/api/chirps/${id}`, { method: "DELETE" });
    if (res.ok) setProfile((p) => ({ ...p, chirps: p.chirps.filter((c) => c.id !== id) }));
  }

  if (!profile) return <div className="empty">Loading…</div>;
  if (profile.missing) {
    return (
      <div className="empty">
        No such user. <a href="#/">Back to timeline</a>
      </div>
    );
  }

  return (
    <>
      <a className="back" href="#/">
        ← Timeline
      </a>
      <div className="profile">
        <div className="profile-top">
          <Avatar picture={profile.picture} name={profile.name} size={56} />
          <div>
            <p className="profile-name">{profile.name}</p>
            <p className="profile-handle">@{profile.handle}</p>
          </div>
        </div>
        <div className="profile-stats">
          <span>
            <b>{profile.chirp_count}</b> chirps
          </span>
          <span>
            <b>{profile.followers_count}</b> followers
          </span>
          <span>
            <b>{profile.following_count}</b> following
          </span>
        </div>
        {me?.signed_in && !profile.is_self && (
          <div>
            <button className={profile.following ? "follow following" : "follow"} onClick={follow}>
              {profile.following ? "Following" : "Follow"}
            </button>
          </div>
        )}
      </div>
      <ul className="timeline">
        {profile.chirps.map((c) => (
          <ChirpItem key={c.id} chirp={c} me={me} onLike={like} onDelete={remove} onRechirp={rechirp} />
        ))}
        {profile.chirps.length === 0 && <li className="empty">No chirps yet.</li>}
      </ul>
    </>
  );
}

export default function App() {
  const [me, setMe] = useState(null);
  const [storage, setStorage] = useState("");
  const route = useRoute();

  useEffect(() => {
    fetch("/api/me")
      .then((r) => r.json())
      .then(setMe)
      .catch(() => setMe({ signed_in: false }));
  }, []);

  useEffect(() => {
    fetch("/healthz")
      .then((r) => r.json())
      .then((d) => setStorage(d.storage))
      .catch(() => {});
  }, []);

  return (
    <main>
      <header>
        <h1>
          <a className="brand" href="#/">
            🐦 Chirp
          </a>
        </h1>
        {storage === "memory" && (
          <span className="badge" title="Run: berth pg:create chirpdb && berth pg:link chirpdb chirp">
            in-memory
          </span>
        )}
        <Account me={me} />
      </header>
      {route.name === "home" && <Timeline key="home" me={me} />}
      {route.name === "tag" && <Timeline key={`tag:${route.tag}`} me={me} tag={route.tag} />}
      {route.name === "thread" && <ThreadView key={`thread:${route.id}`} me={me} id={route.id} />}
      {route.name === "profile" && <ProfileView key={`profile:${route.handle}`} me={me} handle={route.handle} />}
      <footer>
        Deployed with <a href="https://github.com/dps/berth">Berth</a> · sign-in by Berth
      </footer>
    </main>
  );
}
