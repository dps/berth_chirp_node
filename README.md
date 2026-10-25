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
deploy); the page says so.

## AI summary

Signed-in visitors get a "✨ What's happening?" button that sums up the
timeline in two or three sentences. Chirp has no AI keys and no model
choice of its own: it calls whatever `OPENAI_BASE_URL` points at, which
Berth's AI gateway sets up:

```bash
berth ai:setup            # once per Berth: Ollama and a local model
berth ai:enable chirp     # gives Chirp OPENAI_BASE_URL and its own token
```

It asks for the model `default` (the gateway's alias for the local model);
set `CHIRP_AI_MODEL=smart` or any other alias to change it. The summary is
cached until someone chirps again. Without AI enabled, the button doesn't
appear. Any other OpenAI-compatible endpoint works too: set
`OPENAI_BASE_URL`, `OPENAI_API_KEY` and `CHIRP_AI_MODEL` yourself.

## Migrations

The schema lives in `migrations/*.sql`, applied in name order by
`migrate.js` (about 50 lines, no dependencies beyond `pg`). Each runs once,
in a transaction, and is recorded in `schema_migrations`. The `Procfile`
tells Berth to run it before every release:

```
release: node migrate.js
```

Berth runs it in a one-off container from the new image, with the new
release's config, before the new code takes traffic. If it fails, the deploy
stops and the running version keeps serving. On production Berth backs up
the database first, so `berth rollback chirp --with-data` can put code and
data back together. The server itself never changes the schema; it refuses
to start against a database `migrate.js` hasn't set up.

To change the schema, add the next file (`004_something.sql`) and try it on
the dev version first, against a copy of production's data:

```bash
berth dev:db:copy chirp     # production's data into chirp-dev's database
berth dev:push              # builds your working tree, runs migrate.js, starts it
```

`dev:push` exits 3 if the migration fails, with the error in its output.
The old code keeps running while the new release starts, so make changes
it can live with: add a column before the code that uses it, and drop one
only in a release after the code stops using it.

| Path | What |
| --- | --- |
| `/` | the timeline (React) |
| `GET /api/me` | who is signed in |
| `GET /api/chirps` | newest 100 chirps (with `liked` for the viewer) |
| `POST /api/chirps` | `{"body": "hello"}` (signed in) |
| `POST /api/chirps/:id/like` | like or unlike (signed in) |
| `DELETE /api/chirps/:id` | delete your own chirp |
| `POST /api/summary` | an AI summary of the timeline (signed in, AI enabled) |
| `/healthz` | health check: `berth config:set chirp BERTH_HEALTHCHECK=/healthz` |

Local development: `npm install`, then (with a `DATABASE_URL`) `node
migrate.js`, then `CHIRP_DEV_USER=you@example.com npm start` in one terminal (a pretend signed-in user, since there's no Berth in
front) and `npm run dev` in another.
