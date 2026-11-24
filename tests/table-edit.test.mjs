import test from "node:test";
import assert from "node:assert/strict";
import { EditorState } from "@codemirror/state";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { readTable, tableEdit } from "../editor-src/table-edit.mjs";

const doc = "Intro\n\n| Name | Qty |\n| :-- | --: |\n| Apple \\| pear | 2 |\n| Fig | 10 |\n\nAfter";
const at = (needle, text = doc) =>
  EditorState.create({doc: text, selection: {anchor: text.indexOf(needle)}, extensions: [markdown({base: markdownLanguage})]});
const run = (op, where, arg, text = doc) => {
  const state = at(where, text);
  const spec = tableEdit(state, op, arg);
  if (!spec) return null;
  const next = state.update(spec).state;
  const head = next.selection.main.head, line = next.doc.lineAt(head);
  return {text: next.doc.toString(), before: line.text.slice(0, head - line.from)};
};
const body = text => text.split("\n").slice(2, -2);

test("a table is read from the syntax tree with escaped pipes, alignment and the cursor cell", () => {
  const table = readTable(at("Fig"));
  assert.deepEqual(table.rows.map(r => r.cells), [["Name", "Qty"], ["Apple \\| pear", "2"], ["Fig", "10"]]);
  assert.deepEqual(table.aligns, ["left", "right"]);
  assert.deepEqual([table.row, table.column], [2, 0]);
  assert.equal(readTable(at("Intro")), null);
  assert.equal(readTable(at("After")), null);
});

test("formatting pads columns by their alignment and keeps the text around the table", () => {
  const {text} = run("format", "Fig");
  assert.deepEqual(body(text), [
    "| Name          | Qty |",
    "| :------------ | --: |",
    "| Apple \\| pear |   2 |",
    "| Fig           |  10 |",
  ]);
  assert.ok(text.startsWith("Intro\n\n") && text.endsWith("\n\nAfter"));
});

test("rows are added, moved and deleted below the header only", () => {
  assert.deepEqual(body(run("rowBelow", "Apple").text)[3], "|               |     |");
  assert.deepEqual(body(run("rowAbove", "Fig").text)[3], "|               |     |");
  assert.equal(run("rowAbove", "Name"), null);
  assert.equal(run("deleteRow", "Name"), null);
  assert.deepEqual(body(run("deleteRow", "Apple").text), ["| Name | Qty |", "| :--- | --: |", "| Fig  |  10 |"]);
  assert.deepEqual(body(run("moveUp", "Fig").text).slice(2), ["| Fig           |  10 |", "| Apple \\| pear |   2 |"]);
  assert.equal(run("moveUp", "Apple"), null);
  assert.equal(run("moveDown", "Fig"), null);
  assert.deepEqual(body(run("moveDown", "Apple").text).slice(2), ["| Fig           |  10 |", "| Apple \\| pear |   2 |"]);
});

test("columns are added before or after the cursor, deleted and aligned", () => {
  const after = run("columnAfter", "Qty");
  assert.deepEqual(body(after.text)[1], "| :------------ | --: | --- |");
  assert.equal(after.before, "| Name          | Qty | ", "the cursor moves into the new column");
  assert.deepEqual(body(run("columnBefore", "Name").text)[0], "|     | Name          | Qty |");
  assert.deepEqual(body(run("deleteColumn", "Qty").text), ["| Name          |", "| :------------ |", "| Apple \\| pear |", "| Fig           |"]);
  assert.equal(run("deleteColumn", "1", null, "| A |\n| --- |\n| 1 |"), null, "the last column stays");
  assert.deepEqual(body(run("align", "Qty", "center").text).slice(1, 3), ["| :------------ | :-: |", "| Apple \\| pear |  2  |"]);
  assert.deepEqual(body(run("align", "Name", "none").text)[1], "| ------------- | --: |");
});

test("a table inside a quote keeps its prefix on every line", () => {
  const quoted = "> | a | b |\n> | --- | --- |\n> | 1 | 2 |\n";
  assert.equal(run("columnAfter", "1", null, quoted).text, "> | a   |     | b   |\n> | --- | --- | --- |\n> | 1   |     | 2   |\n");
});

import { footnoteChange } from "../editor-src/footnote.mjs";

test("a footnote takes the next free number and its definition goes to the end", () => {
  const make = (text, from, to = from) => EditorState.create({doc: text, selection: {anchor: from, head: to}});
  const apply = state => {
    const next = state.update(footnoteChange(state)).state;
    return {text: next.doc.toString(), cursor: next.selection.main.head};
  };
  const first = apply(make("A claim.", 7));
  assert.equal(first.text, "A claim[^1].\n\n[^1]: ");
  assert.equal(first.cursor, first.text.length);
  const second = apply(make("One[^1] two.\n\n[^1]: First.", 11));
  assert.equal(second.text, "One[^1] two[^2].\n\n[^1]: First.\n[^2]: ");
  const selected = apply(make("Say it\nloudly now", 0, 13));
  assert.equal(selected.text, "[^1] now\n\n[^1]: Say it loudly");
  assert.equal(apply(make("", 0)).text, "[^1]\n\n[^1]: ");
});
