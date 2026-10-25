# Chirp: a Twitter clone on Berth

A small Twitter clone that shows how a Node app with a React frontend runs on
[Berth](https://github.com/dps/berth): an Express API on Postgres, and a
React UI built with Vite. There's no Dockerfile. Berth sees `package.json`,
installs with `npm ci`, runs `npm run build` (Vite → `dist/`) and starts
`npm start`.

```bash
berth create chirp --repo you/berth_chirp_node     # live at https://chirp.<your domain>
berth pg:create chirpdb && berth pg:link chirpdb chirp
berth access chirp public                          # Google sign-in, timeline stays open
```

## Sign-in

Chirp has no login code. Berth signs people in with Google
(`berth auth:setup google`, once per Berth) and, with `berth access chirp
public`, passes every request through with who is signed in:

| Header | Example |
| --- | --- |
| `X-Berth-User-Id` | `google:1043…` (stable; Chirp keys authors and likes on it) |
| `X-Berth-Email` | `you@gmail.com` |
| `X-Berth-Name` | `Ada%20Lovelace` (URL-encoded) |
| `X-Berth-Picture` | avatar URL |

Anyone can read the timeline; posting, liking and deleting answer 401 without
a signed-in user. The page links to `/_berth/login?return=/` and signs out
with a form that POSTs to `/_berth/logout`; both are served by Berth. Berth
removes any `X-Berth-*` headers a visitor sends, so the app can trust them.
To make the whole site members-only instead:
`berth access chirp allow you@gmail.com @family`.

Until Postgres is linked, chirps are kept in memory (and lost on each
deploy); the page says so. Once `DATABASE_URL` is set, the table is created
on startup.

| Path | What |
| --- | --- |
| `/` | the timeline (React) |
| `GET /api/me` | who is signed in |
| `GET /api/chirps` | newest 100 chirps (with `liked` for the viewer) |
| `POST /api/chirps` | `{"body": "hello"}` (signed in) |
| `POST /api/chirps/:id/like` | like or unlike (signed in) |
| `DELETE /api/chirps/:id` | delete your own chirp |
| `/healthz` | health check: `berth config:set chirp BERTH_HEALTHCHECK=/healthz` |

Local development: `npm install`, then `CHIRP_DEV_USER=you@example.com npm
start` in one terminal (a pretend signed-in user, since there's no Berth in
front) and `npm run dev` in another.
