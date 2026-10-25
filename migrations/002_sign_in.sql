-- Authors and per-user likes, from when Chirp moved to Berth sign-in.
ALTER TABLE chirps
  ADD COLUMN IF NOT EXISTS author_id text,
  ADD COLUMN IF NOT EXISTS name text,
  ADD COLUMN IF NOT EXISTS picture text;

CREATE TABLE IF NOT EXISTS likes (
  chirp_id integer NOT NULL REFERENCES chirps ON DELETE CASCADE,
  user_id  text NOT NULL,
  PRIMARY KEY (chirp_id, user_id)
);
