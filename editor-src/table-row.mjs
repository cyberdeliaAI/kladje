import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";

export function tableRowChange(state) {
  if (state.selection.ranges.length !== 1) return null;
  const line = state.doc.lineAt(state.selection.main.head);
  const tree = ensureSyntaxTree(state, line.to, 60);
  if (!tree) return null;
  let table = tree.resolveInner(line.to, -1);
  while (table && table.name !== "Table") table = table.parent;
  const divider = table?.getChild("TableDelimiter");
  if (!divider) return null;
  const dividerLine = state.doc.lineAt(divider.from);
  const prefix = state.sliceDoc(dividerLine.from, divider.from);
  const columns = state.sliceDoc(divider.from, divider.to).trim().replace(/^\||\|$/g, "").split("|").length;
  const at = Math.max(line.to, dividerLine.to);
  return {
    changes: {from: at, insert: "\n" + prefix + "|" + "  |".repeat(columns)},
    selection: EditorSelection.cursor(at + prefix.length + 3),
    scrollIntoView: true, userEvent: "input",
  };
}
