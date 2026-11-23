import {EditorState} from "@codemirror/state";
import {Decoration, EditorView, ViewPlugin} from "@codemirror/view";
import {syntaxTree} from "@codemirror/language";

export function focusedBlock(state) {
  const pos = state.selection.main.head;
  for (let node = syntaxTree(state).resolve(pos, 1); node; node = node.parent) {
    if (/^(?:Paragraph|ATXHeading[1-6]|SetextHeading[12]|TableRow|TableHeader)$/.test(node.name)) return node;
  }
  return state.doc.lineAt(pos);
}

const active = Decoration.line({class:"writing-paragraph"});
function visibleParagraph(view) {
  const {from, to} = focusedBlock(view.state);
  const decorations = [];
  for (const visible of view.visibleRanges) {
    if (visible.to < from || visible.from > to) continue;
    let line = view.state.doc.lineAt(Math.max(from, visible.from));
    const end = Math.min(to, visible.to);
    for (;;) {
      if (decorations.at(-1)?.from !== line.from) decorations.push(active.range(line.from));
      if (line.to >= end) break;
      line = view.state.doc.line(line.number + 1);
    }
  }
  return Decoration.set(decorations);
}

export const paragraphFocus = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = visibleParagraph(view); }
  update(update) {
    if (update.docChanged || update.selectionSet || update.viewportChanged ||
        syntaxTree(update.startState) !== syntaxTree(update.state)) {
      this.decorations = visibleParagraph(update.view);
    }
  }
}, {decorations: plugin => plugin.decorations});

// Only composing, typing and deleting request centering. Scrolling, selection,
// Find, changing a preference, and restoring a document keep their own positions.
export const typewriter = EditorState.transactionExtender.of(tr => {
  if (!tr.docChanged || !(tr.isUserEvent("input") || tr.isUserEvent("delete"))) return null;
  return {effects:EditorView.scrollIntoView(tr.newSelection.main.head, {y:"center"})};
});
