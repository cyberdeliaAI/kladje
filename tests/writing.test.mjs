import test from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { counts, codePoints } from "../editor-src/statistics.mjs";
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
  assert.equal(make("a".repeat(256*1024+1)).field(counts),null);
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
