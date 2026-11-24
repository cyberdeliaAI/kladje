import {Compartment, EditorState} from "@codemirror/state";
import {markdown, markdownLanguage} from "@codemirror/lang-markdown";
import {javascriptLanguage, typescriptLanguage} from "@codemirror/lang-javascript";
import {htmlLanguage} from "@codemirror/lang-html";
import {cssLanguage} from "@codemirror/lang-css";
import {StreamLanguage} from "@codemirror/language";
import {python} from "@codemirror/legacy-modes/mode/python";
import {rust} from "@codemirror/legacy-modes/mode/rust";
import {shell} from "@codemirror/legacy-modes/mode/shell";
import {yaml} from "@codemirror/legacy-modes/mode/yaml";
import {tags} from "@lezer/highlight";

// Match comrak's exact delimiter at the start of the file, including its
// requirement for a newline between the opening delimiter and the closer.
const lengths = new WeakMap();
export function frontmatterLines(doc) {
  if (lengths.has(doc)) return lengths.get(doc);
  let end = 0;
  if (doc.lines >= 3 && /^\uFEFF?---$/.test(doc.line(1).text)) {
    let n = 2;
    for (const text of doc.iterLines(3)) {
      n++;
      if (text === "---") { end = n; break; }
    }
  }
  lengths.set(doc,end);
  return end;
}

const pythonLanguage = StreamLanguage.define(python), rustLanguage = StreamLanguage.define(rust);
const shellLanguage = StreamLanguage.define(shell), yamlLanguage = StreamLanguage.define(yaml);
const fences = {js:javascriptLanguage, javascript:javascriptLanguage, ts:typescriptLanguage,
  typescript:typescriptLanguage, html:htmlLanguage, css:cssLanguage,
  python:pythonLanguage, py:pythonLanguage, rust:rustLanguage, rs:rustLanguage,
  shell:shellLanguage, sh:shellLanguage, bash:shellLanguage, zsh:shellLanguage,
  yaml:yamlLanguage, yml:yamlLanguage};
function support(lines) {
  return markdown({base:markdownLanguage, addKeymap:false,
    codeLanguages: info => {
      const name = info.toLowerCase().split(/\s/)[0];
      return Object.hasOwn(fences, name) ? fences[name] : null;
    },
    extensions: lines ? {
      defineNodes: [{name:"FrontMatter",block:true,style:tags.meta}],
      parseBlock: [{name:"FrontMatter",before:"HorizontalRule",parse(cx,line) {
        if (cx.lineStart !== 0) return false;
        for (let i=1;i<lines;i++) cx.nextLine();
        cx.addElement(cx.elt("FrontMatter",0,cx.lineStart+line.text.length));
        cx.nextLine();
        return true;
      }}],
    } : [],
  });
}

export function documentLanguage(doc) {
  const lang = new Compartment();
  return [lang.of(support(frontmatterLines(doc))), EditorState.transactionExtender.of(tr => {
    if (!tr.docChanged) return null;
    const previous = frontmatterLines(tr.startState.doc);
    if (previous && !tr.changes.touchesRange(0,tr.startState.doc.line(previous).to)) {
      lengths.set(tr.newDoc, previous);
      return null;
    }
    const next = frontmatterLines(tr.newDoc);
    return previous === next ? null : {effects:lang.reconfigure(support(next))};
  })];
}
