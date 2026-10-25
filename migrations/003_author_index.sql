-- Deleting your own chirps looks them up by author.
CREATE INDEX IF NOT EXISTS chirps_author_id ON chirps (author_id);
