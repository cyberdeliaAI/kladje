import test from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { counts, counted, countJob, countLimit, codePoints, totals, wordCount } from "../editor-src/statistics.mjs";
import { tableRowChange } from "../editor-src/table-row.mjs";

test("Unicode counts survive multi-range edits, joined lines and cursor movement", () => {
  const make = doc => EditorState.create({doc,extensions:[counts]});
  let s = make("hello 🌍\n日本語 東京\nlast");
  assert.equal(codePoints("a🌍"),2);
  for (const changes of [[{from:1,to:2,insert:"😀\nx"}, {from:3,to:4,insert:"É "}], {from:1,to:4,insert:""}, {from:0,insert:"שלום "}]) {
    s = s.update({changes}).state;
    assert.deepEqual(s.field(counts),make(s.doc.toString()).field(counts));
  }
  assert.equal(s.update({selection:{anchor:0}}).state.field(counts),s.field(counts));
});

test("a large document is counted in background slices and keeps the edits made meanwhile", () => {
  const make = doc => EditorState.create({doc,extensions:[counts]});
  const line = "alpha beta 🌍 gamma\n";
  let s = make(line.repeat(20000));
  assert.ok(s.doc.length > countLimit);
  assert.equal(totals(s), null);
  let ticks = 0, steps = 0, done;
  const job = countJob(s.doc, () => ticks++);
  s = s.update({changes:{from:0,insert:"three more words\n"}}).state;
  assert.equal(totals(s), null);
  while (!(done = job.step(50))) steps++;
  assert.ok(steps > 100, "the count yields between slices");
  const replaced = s.update({changes:{from:0,to:s.doc.length,insert:"other ".repeat(60000)}}).state;
  assert.equal(totals(replaced.update({effects:counted.of(done)}).state), null, "a count of the replaced text is ignored");
  s = s.update({effects:counted.of(done)}).state;
  assert.deepEqual(totals(s), {words:60003, pairs:20000});
  s = s.update({changes:{from:0,to:6,insert:""}}).state;
  assert.deepEqual(totals(s), {words:60002, pairs:20000});
});

test("typing past the synchronous budget keeps exact totals, and long lines count the same in every pass", () => {
  const make = doc => EditorState.create({doc,extensions:[counts]});
  let s = make("a\n".repeat(countLimit / 2));
  assert.equal(totals(s).words, countLimit / 2);
  s = s.update({changes:{from:0,insert:"b "}}).state;
  assert.ok(s.doc.length > countLimit);
  assert.equal(totals(s).words, countLimit / 2 + 1);
  const oneLine = make("a ".repeat(countLimit / 2)).update({changes:{from:0,insert:"b "}}).state;
  assert.equal(totals(oneLine), null, "an edit in one enormous line is recounted in the background");
  const long = "word ".repeat(20000) + "漢字".repeat(40000);
  const whole = make("short\n" + long);
  const job = countJob(whole.doc);
  let done;
  while (!(done = job.step(1)));
  assert.equal(done.words, totals(whole).words);
  assert.ok(Math.abs(done.words - 1 - wordCount(long)) <= 3, "cutting a line without spaces moves the total by a word at most per cut");
});

test("adding a table row preserves existing escaped content and alignment", () => {
  const doc = "| A | B |\n| :-- | --: |\n| hello \\| there | x |";
  const go = (doc, anchor) => EditorState.create({doc,selection:{anchor},extensions:[markdown({base:markdownLanguage})]});
  for (const pos of [1,doc.length]) {
    const s=go(doc,pos); const next=s.update(tableRowChange(s)).state;
    assert.ok(next.doc.toString().includes("| hello \\| there | x |"));
    assert.equal(next.doc.lines,4);
    assert.equal(next.doc.lineAt(next.selection.main.head).text,"|  |  |");
    assert.equal(next.doc.line(2).text,"| :-- | --: |");
  }
  assert.equal(tableRowChange(go("```\n"+doc+"\n```",8)),null);
});
