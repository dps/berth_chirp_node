// Hashtag helpers shared by the API (timeline filter) and the React UI (links).
// A tag is letters, numbers or underscores after a `#`; tags compare in
// lowercase, so #Birds and #birds are the same tag.

// The single source of truth for what counts as a hashtag. Exported as a
// pattern string (not a RegExp) so the client can build its own global
// RegExp for rendering without sharing matcher state with the server.
export const HASHTAG_PATTERN = "#([\\p{L}\\p{N}_]+)";

const TAG_RE = new RegExp(HASHTAG_PATTERN, "gu");

export function extractHashtags(body) {
  const tags = [];
  for (const m of String(body || "").matchAll(TAG_RE)) tags.push(m[1].toLowerCase());
  return [...new Set(tags)];
}

export function normalizeTag(tag) {
  return String(tag || "").replace(/^#+/, "").toLowerCase();
}
