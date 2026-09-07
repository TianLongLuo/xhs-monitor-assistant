"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const { sanitize, orderedKeys, move } = require("../column-order.js");

test("sanitize accepts only bounded string keys and keeps their first occurrence", () => {
  const longest = "x".repeat(160);
  const keys = Object.freeze([
    "title", null, undefined, "", 0, false, {}, [], "note_id", "title",
    longest, "x".repeat(161), "post__source_published_at", "__proto__", "constructor", "note_id",
  ]);
  assert.deepEqual(sanitize(keys), [
    "title", "note_id", longest, "post__source_published_at", "__proto__", "constructor",
  ]);
  for (const invalid of [null, undefined, "title", 1, {}, new Set(["title"]), { 0: "title", length: 1 }]) {
    assert.deepEqual(sanitize(invalid), []);
  }
});

test("sanitize limits saved preferences to 1000 unique keys, not 1000 input entries", () => {
  const unique = Array.from({ length: 1003 }, (_, index) => "field_" + index);
  const input = Object.freeze(unique.flatMap((key, index) => index % 100 === 0 ? [key, key] : [key]));
  assert.deepEqual(sanitize(input), unique.slice(0, 1000));
});

test("orderedKeys applies saved order once and appends unsaved keys in canonical order", () => {
  const available = Object.freeze(["id", "title", "status", "date", "title", "", null]);
  const saved = Object.freeze(["status", "title", "status", "removed", null]);
  assert.deepEqual(orderedKeys(available, saved), ["status", "title", "id", "date"]);
  assert.deepEqual(orderedKeys(available), ["id", "title", "status", "date"]);
  assert.deepEqual(orderedKeys(available, "invalid"), ["id", "title", "status", "date"]);
  assert.deepEqual(orderedKeys([], saved), []);
  assert.deepEqual(orderedKeys(null, saved), []);
});

test("hidden keys keep their saved order when visibility changes or another column moves", () => {
  const available = Object.freeze(["id", "hidden_a", "title", "hidden_b", "date"]);
  const saved = Object.freeze(["date", "hidden_b", "id", "hidden_a", "title"]);
  const visible = Object.freeze(["id", "title", "date"]);
  assert.deepEqual(orderedKeys(visible, saved), ["date", "id", "title"]);
  assert.deepEqual(orderedKeys(available, saved), [...saved], "showing hidden keys restores their places");
  const moved = move(available, saved, "title", "date");
  assert.deepEqual(moved, ["title", "date", "hidden_b", "id", "hidden_a"]);
  assert.deepEqual(moved.filter((key) => key.startsWith("hidden_")), ["hidden_b", "hidden_a"]);
  assert.deepEqual(orderedKeys(visible, moved), ["title", "date", "id"]);
  assert.deepEqual(orderedKeys(available, moved), moved);
});

test("schema additions append canonically and removals never appear as phantom columns", () => {
  const saved = Object.freeze(["gamma", "beta", "retired", "alpha"]);
  assert.deepEqual(orderedKeys(["alpha", "beta", "gamma"], saved), ["gamma", "beta", "alpha"]);
  assert.deepEqual(orderedKeys(["delta", "alpha", "gamma", "epsilon"], saved),
    ["gamma", "alpha", "delta", "epsilon"]);
  assert.deepEqual(move(["delta", "alpha", "gamma", "epsilon"], saved, "epsilon", "gamma"),
    ["epsilon", "gamma", "alpha", "delta"]);
  assert.deepEqual(orderedKeys(["alpha", "beta", "gamma", "delta"], saved),
    ["gamma", "beta", "alpha", "delta"], "an unchanged saved preference still remembers a returning key");
});

for (const { name, source, target, side, expected } of [
  { name: "before, left to right", source: "a", target: "c", side: "before", expected: ["b", "a", "c", "d"] },
  { name: "before, right to left", source: "d", target: "b", side: "before", expected: ["a", "d", "b", "c"] },
  { name: "after, left to right", source: "a", target: "c", side: "after", expected: ["b", "c", "a", "d"] },
  { name: "after, right to left", source: "d", target: "b", side: "after", expected: ["a", "b", "d", "c"] },
]) {
  test("move handles " + name + " without duplicates or off-by-one placement", () => {
    const available = Object.freeze(["a", "b", "c", "d"]);
    const result = move(available, Object.freeze([]), source, target, side);
    assert.deepEqual(result, expected);
    assert.equal(new Set(result).size, available.length);
    assert.deepEqual([...result].sort(), [...available]);
  });
}

test("move uses the saved visual order and defaults to insertion before the target", () => {
  const available = Object.freeze(["a", "b", "c", "d"]);
  const saved = Object.freeze(["c", "a", "d", "b"]);
  assert.deepEqual(move(available, saved, "b", "a"), ["c", "b", "a", "d"]);
  assert.deepEqual(move(available, saved, "c", "b", "after"), ["a", "d", "b", "c"]);
});

test("invalid moves and already-adjacent drops return the unchanged effective order", () => {
  const available = Object.freeze(["id", "title", "date"]);
  const saved = Object.freeze(["date", "id", "title", "stale", "id"]);
  const current = ["date", "id", "title"];
  for (const args of [
    ["id", "id"], ["missing", "id"], ["id", "missing"], ["stale", "id"],
    [null, "id"], ["id", undefined], ["", "id"], ["id", {}],
    ["title", "date", "sideways"], ["title", "date", ""], ["title", "date", null],
    ["id", "title", "before"], ["id", "date", "after"],
  ]) {
    assert.deepEqual(move(available, saved, ...args), current, JSON.stringify(args));
  }
  assert.deepEqual(move([], saved, "date", "id"), []);
  assert.deepEqual(move(null, saved, "date", "id"), []);
  assert.deepEqual(move(["id"], [], "id", "id"), ["id"]);
});

test("all helpers leave inputs untouched and return independent arrays, including no-ops", () => {
  const available = Object.freeze(["a", "b", "c", "a"]);
  const saved = Object.freeze(["c", "stale", "a", "c"]);
  const beforeAvailable = [...available], beforeSaved = [...saved];
  const results = [
    sanitize(available), sanitize(saved), orderedKeys(available, saved),
    move(available, saved, "b", "c"), move(available, saved, "a", "a"),
  ];
  assert.deepEqual(results[2], ["c", "a", "b"]);
  assert.deepEqual(results[3], ["b", "c", "a"]);
  assert.deepEqual(results[4], ["c", "a", "b"]);
  for (const result of results) {
    assert.notEqual(result, available);
    assert.notEqual(result, saved);
    result.push("output-only");
  }
  assert.deepEqual([...available], beforeAvailable);
  assert.deepEqual([...saved], beforeSaved);
  assert.deepEqual(orderedKeys(available, saved), ["c", "a", "b"]);
});
