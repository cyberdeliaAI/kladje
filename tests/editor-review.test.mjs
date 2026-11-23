import test from "node:test";
import assert from "node:assert/strict";
import {EditorState, Text} from "@codemirror/state";
import {ensureSyntaxTree} from "@codemirror/language";
import {insertBracket, closeBrackets} from "@codemirror/autocomplete";
import {history, undo, redo} from "@codemirror/commands";
import {documentLanguage, frontmatterLines} from "../editor-src/markdown-language.mjs";
import {counts} from "../editor-src/statistics.mjs";
import {urlOverSelection} from "../editor-src/smart-paste.mjs";
import {adjacentTableCell} from "../editor-src/table-row.mjs";

function setup(source, selection) {
  const doc = Text.of(source.split("\n"));
  return EditorState.create({doc, selection, extensions:[documentLanguage(doc), counts, history(), closeBrackets()]});
}
const tree = state => ensureSyntaxTree(state, state.doc.length, 200).toString();
test("closed frontmatter is metadata in both the syntax tree and word counts across edits", () => {
  let state = setup("---\ntitle: My title 🌏\n---\nBody text\n\nAnother heading\n---");
  assert.equal(frontmatterLines(state.doc), 3);
  assert.match(tree(state), /FrontMatter,Paragraph,SetextHeading2/);
  assert.equal(state.field(counts).words, 4);
  const edit = changes => { state = state.update({changes}).state; };
  edit({from:0,to:1,insert:" "});
  assert.equal(frontmatterLines(state.doc), 0);
  assert.equal(state.field(counts).words, 7);
  edit({from:0,to:1,insert:"-"});
  assert.equal(state.field(counts).words, 4);
  assert.match(tree(state), /FrontMatter/);
  for (const text of ["---", "---\n---", "---\nkey: value", "--- \nkey\n---"]) {
    assert.equal(frontmatterLines(setup(text).doc), 0);
  }
  assert.equal(frontmatterLines(setup("\uFEFF---\n\n---").doc), 3);
});
test("registered fenced languages highlight their bodies and unknown aliases stay plain", () => {
  for (const [name, code, node] of [["JS","let n = 23", "VariableDeclaration"],["ts","type T = number","TypeAliasDeclaration"],
    ["html","<b>A</b>","OpenTag"],["css","a { color: red }","RuleSet"]]) {
    const state = setup("```"+name+"\n"+code+"\n```");
    assert.ok(ensureSyntaxTree(state,state.doc.length,200).resolveInner(state.doc.line(2).from+2,1).toString());
    let cursor = ensureSyntaxTree(state,state.doc.length,200).resolveInner(state.doc.line(2).from+2,1);
    const ancestors = [];
    while (cursor) {ancestors.push(cursor.name); cursor=cursor.parent;}
    assert.ok(ancestors.includes(node), String(ancestors));
  }
  assert.match(tree(setup("```constructor\nliteral\n```")), /FencedCode/);
});
test("URI paste escapes a selected label and the edit undoes and redoes as one step", () => {
  const source = "read [this]";
  let state = setup(source, {anchor:5,head:11});
  const target = {get state(){return state;}, dispatch(tr){state=tr.state;}};
  const url = "https://example.org/a(b)";
  state = state.update(urlOverSelection(state,url), {userEvent:"input.paste"}).state;
  assert.equal(state.doc.toString(),"read [\\[this\\]](https://example.org/a%28b%29)");
  assert.ok(undo(target)); assert.equal(state.doc.toString(),source);
  assert.ok(redo(target)); assert.match(state.doc.toString(), /%28b%29/);
  for (const input of ["file:///a","ftp://example.org","https://user:secret@example.org","two words", "https://a/\nb"])
    assert.equal(urlOverSelection(setup("a",{anchor:0,head:1}),input),null);
  assert.equal(urlOverSelection(setup("a"),url),null);
});
test("paired punctuation wraps the selection without changing its contents", () => {
  for (const [open,close] of [["(",")"],["[","]"],['"','"'],["'","'"]]) {
    const state=setup("ab",{anchor:0,head:2});
    assert.equal(insertBracket(state,open).state.doc.toString(),open+"ab"+close);
  }
});
test("table navigation crosses delimiter rows, empty cells and escaped pipes", () => {
  const doc="| A | B |\n| --- | --- |\n| x \\| y |   |";
  let state=setup(doc,{anchor:2});
  function move(direction) {
    const spec = adjacentTableCell(state,direction);
    assert.ok(spec);
    state=state.update(spec).state;
    return state.sliceDoc(state.selection.main.from,state.selection.main.to);
  }
  assert.equal(move(1),"B"); assert.equal(move(1),"x \\| y"); assert.equal(move(1),"");
  assert.equal(move(-1),"x \\| y");
  assert.equal(adjacentTableCell(setup("prose"),1),null);
});
