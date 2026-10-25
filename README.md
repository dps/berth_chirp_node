# Chirp: a Twitter clone on Berth

A small Twitter clone that shows how a Node app with a React frontend runs on
[Berth](https://github.com/dps/berth): an Express API on Postgres, and a
React UI built with Vite. There's no Dockerfile. Berth sees `package.json`,
installs with `npm ci`, runs `npm run build` (Vite → `dist/`) and starts
`npm start`.

```bash
berth create chirp --repo you/berth_chirp_node     # live at https://chirp.<your domain>
berth pg:create chirpdb && berth pg:link chirpdb chirp
```

Until Postgres is linked, chirps are kept in memory (and lost on each
deploy); the page says so. Once `DATABASE_URL` is set, the table is created
on startup.

| Path | What |
| --- | --- |
| `/` | the timeline (React) |
| `GET /api/chirps` | newest 100 chirps |
| `POST /api/chirps` | `{"handle": "dps", "body": "hello"}` |
| `POST /api/chirps/:id/like` | like a chirp |
| `/healthz` | health check: `berth config:set chirp BERTH_HEALTHCHECK=/healthz` |

Local development: `npm install`, then `npm start` in one terminal and
`npm run dev` in another.
