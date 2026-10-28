-- Replies, rechirps and follows.
ALTER TABLE chirps
  ADD COLUMN IF NOT EXISTS parent_id integer REFERENCES chirps ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS rechirp_of integer REFERENCES chirps ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS replies integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS rechirps integer NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS follows (
  follower_id text NOT NULL,
  followee_id text NOT NULL,
  PRIMARY KEY (follower_id, followee_id)
);

-- Thread replies and "did I rechirp this" lookups.
CREATE INDEX IF NOT EXISTS chirps_parent_id ON chirps (parent_id);
CREATE INDEX IF NOT EXISTS chirps_rechirp_of ON chirps (rechirp_of);
