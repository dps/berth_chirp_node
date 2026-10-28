import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { extractHashtags, normalizeTag, HASHTAG_PATTERN } from "../shared/hashtags.js";

describe("extractHashtags", () => {
  it("finds tags and lowercases them", () => {
    assert.deepEqual(extractHashtags("hello #World, #birds!"), ["world", "birds"]);
  });

  it("dedupes repeated tags", () => {
    assert.deepEqual(extractHashtags("#a #A #a"), ["a"]);
  });

  it("ignores a lone # and empty bodies", () => {
    assert.deepEqual(extractHashtags("a # b"), []);
    assert.deepEqual(extractHashtags(""), []);
    assert.deepEqual(extractHashtags(null), []);
  });

  it("supports Unicode, digits and underscores", () => {
    assert.deepEqual(extractHashtags("#café #100days #good_morning"), ["café", "100days", "good_morning"]);
  });
});

describe("normalizeTag", () => {
  it("strips leading hashes and lowercases", () => {
    assert.equal(normalizeTag("##Birds"), "birds");
    assert.equal(normalizeTag(""), "");
  });
});

describe("HASHTAG_PATTERN", () => {
  it("matches exactly what extractHashtags extracts (client render parity)", () => {
    const bodies = ["hi #There", "#a#b", "##x", "#café #100", "no tags", "#a #A"];
    for (const body of bodies) {
      const viaPattern = [...body.matchAll(new RegExp(HASHTAG_PATTERN, "gu"))].map((m) =>
        m[1].toLowerCase(),
      );
      assert.deepEqual([...new Set(viaPattern)], extractHashtags(body));
    }
  });
});
