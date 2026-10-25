-- IF NOT EXISTS: databases from before migrate.js already have this table.
CREATE TABLE IF NOT EXISTS chirps (
  id         serial PRIMARY KEY,
  handle     text NOT NULL,
  body       text NOT NULL,
  likes      integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
