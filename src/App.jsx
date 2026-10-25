import { useCallback, useEffect, useState } from "react";

const MAX = 280;

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

// Berth's sign-in endpoints live on every app with an access policy.
const loginURL = () => "/_berth/login?return=" + encodeURIComponent(location.pathname + location.search);

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

function Composer({ me, onPosted }) {
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
        body: JSON.stringify({ body }),
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
          placeholder="What's happening?"
          rows={3}
          aria-label="Chirp text"
        />
      </div>
      <div className="composer-footer">
        <span className={left < 0 ? "count over" : left < 20 ? "count low" : "count"}>{left}</span>
        <button disabled={busy || !body.trim() || left < 0}>Chirp</button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function ChirpItem({ chirp, me, onLike, onDelete }) {
  const mine = me?.signed_in && chirp.author_id === me.id;
  return (
    <li className="chirp">
      <Avatar picture={chirp.picture} name={chirp.name || chirp.handle} />
      <div className="chirp-main">
        <div className="chirp-meta">
          <b>{chirp.name || chirp.handle}</b> <span>@{chirp.handle} · {timeAgo(chirp.created_at)}</span>
        </div>
        <p className={isSingleEmoji(chirp.body) ? "single-emoji" : undefined}>{chirp.body}</p>
        <div className="actions">
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
      </div>
    </li>
  );
}

export default function App() {
  const [me, setMe] = useState(null);
  const [chirps, setChirps] = useState([]);
  const [storage, setStorage] = useState("");
  const [offline, setOffline] = useState(false);

  useEffect(() => {
    fetch("/api/me")
      .then((r) => r.json())
      .then(setMe)
      .catch(() => setMe({ signed_in: false }));
  }, []);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/chirps");
      const data = await res.json();
      setChirps(data.chirps);
      setStorage(data.storage);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  async function like(id) {
    const res = await fetch(`/api/chirps/${id}/like`, { method: "POST" });
    if (res.ok) {
      const updated = await res.json();
      setChirps((cs) => cs.map((c) => (c.id === id ? updated : c)));
    }
  }

  async function remove(id) {
    const res = await fetch(`/api/chirps/${id}`, { method: "DELETE" });
    if (res.ok) setChirps((cs) => cs.filter((c) => c.id !== id));
  }

  return (
    <main>
      <header>
        <h1>🐦 Chirp</h1>
        {storage === "memory" && (
          <span className="badge" title="Run: berth pg:create chirpdb && berth pg:link chirpdb chirp">
            in-memory
          </span>
        )}
        {offline && <span className="badge warn">reconnecting…</span>}
        <Account me={me} />
      </header>
      <Composer me={me} onPosted={(c) => setChirps((cs) => [c, ...cs])} />
      <ul className="timeline">
        {chirps.map((c) => (
          <ChirpItem key={c.id} chirp={c} me={me} onLike={like} onDelete={remove} />
        ))}
        {chirps.length === 0 && <li className="empty">No chirps yet. Say something!</li>}
      </ul>
      <footer>
        Deployed with <a href="https://github.com/dps/berth">Berth</a> · sign-in by Berth
      </footer>
    </main>
  );
}
