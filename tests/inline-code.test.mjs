import test from "node:test";
import assert from "node:assert/strict";
import {EditorState, EditorSelection} from "@codemirror/state";
import {markdown, markdownLanguage} from "@codemirror/lang-markdown";
import {inlineCodeChange} from "../editor-src/inline-code.mjs";

const toggle = state => state.update(state.changeByRange(range => inlineCodeChange(state, range))).state;
test("inline code delimits literal backticks and round-trips padding", () => {
  for (const [source, expected] of [
    ["a`b", "``a`b``"], ["a``b", "```a``b```"], ["`start", "`` `start ``"],
    [" padded ", "`  padded  `"], ["   ", "`   `"], ["", "``"],
  ]) {
    const s = EditorState.create({doc: source, selection:{anchor:0,head:source.length}, extensions:[markdown({base:markdownLanguage})]});
    const next = toggle(s);
    assert.equal(next.doc.toString(), expected);
    assert.equal(toggle(next).doc.toString(), source);
  }
});
test("mixed selections independently wrap plain source and unwrap a complete code span", () => {
  const s = EditorState.create({doc:"`foo` and a`b", selection:EditorSelection.create([
    EditorSelection.range(0,5), EditorSelection.range(10,13)
  ]), extensions:[EditorState.allowMultipleSelections.of(true), markdown({base:markdownLanguage})]});
  assert.equal(toggle(s).doc.toString(),"foo and ``a`b``");
});
