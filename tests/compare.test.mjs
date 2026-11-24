import test from "node:test";
import assert from "node:assert/strict";
import { changedSections } from "../editor-src/compare.mjs";

test("the comparison counts separate changed sections and none for identical text", () => {
  const disk = ["# Title", "", "one", "two", "three", "", "four", "five", "six", "", "end"].join("\n");
  assert.equal(changedSections(disk, disk), 0);
  assert.equal(changedSections(disk.replace("two", "TWO"), disk), 1);
  assert.equal(changedSections(disk.replace("two", "TWO").replace("five", "5"), disk), 2);
  assert.equal(changedSections(disk + "\nadded 😀", disk), 1);
  assert.equal(changedSections("", disk), 1);
  // Two edits on neighbouring lines read as one section.
  assert.equal(changedSections(disk.replace("one\ntwo", "1\n2"), disk), 1);
});
