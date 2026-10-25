import { useCallback, useEffect, useState } from "react";

const MAX = 280;

function timeAgo(iso) {
  const s = Math.max(0, Math.floor((Date.now() - new Date(iso)) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return new Date(iso).toLocaleDateString();
}

function Composer({ handle, setHandle, onPosted }) {
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const left = MAX - body.length;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/chirps", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ handle, body }),
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
      <label className="handle">
        @
        <input
          value={handle}
          onChange={(e) => setHandle(e.target.value.replace(/[^A-Za-z0-9_]/g, ""))}
          placeholder="handle"
          maxLength={30}
          aria-label="Your handle"
        />
      </label>
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="What's happening?"
        rows={3}
        aria-label="Chirp text"
      />
      <div className="composer-footer">
        <span className={left < 0 ? "count over" : left < 20 ? "count low" : "count"}>{left}</span>
        <button disabled={busy || !handle || !body.trim() || left < 0}>Chirp</button>
      </div>
      {error && <p className="error">{error}</p>}
    </form>
  );
}

function ChirpItem({ chirp, onLike }) {
  return (
    <li className="chirp">
      <div className="avatar" aria-hidden>
        {chirp.handle[0].toUpperCase()}
      </div>
      <div className="chirp-main">
        <div className="chirp-meta">
          <b>@{chirp.handle}</b> <span>· {timeAgo(chirp.created_at)}</span>
        </div>
        <p>{chirp.body}</p>
        <button className="like" onClick={() => onLike(chirp.id)} aria-label="Like">
          ♥ {chirp.likes}
        </button>
      </div>
    </li>
  );
}

export default function App() {
  const [handle, setHandle] = useState(() => localStorage.getItem("chirp.handle") || "");
  const [chirps, setChirps] = useState([]);
  const [storage, setStorage] = useState("");
  const [offline, setOffline] = useState(false);

  useEffect(() => localStorage.setItem("chirp.handle", handle), [handle]);

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

  return (
    <main>
      <header>
        <h1>🐦 Chirp</h1>
        {storage === "memory" && (
          <span className="badge" title="Run: berth pg:create chirpdb && berth pg:link chirpdb chirp">
            in-memory · link Postgres to keep chirps
          </span>
        )}
        {offline && <span className="badge warn">reconnecting…</span>}
      </header>
      <Composer handle={handle} setHandle={setHandle} onPosted={(c) => setChirps((cs) => [c, ...cs])} />
      <ul className="timeline">
        {chirps.map((c) => (
          <ChirpItem key={c.id} chirp={c} onLike={like} />
        ))}
        {chirps.length === 0 && <li className="empty">No chirps yet. Say something!</li>}
      </ul>
      <footer>
        Deployed with <a href="https://github.com/dps/berth">Berth</a>
      </footer>
    </main>
  );
}
