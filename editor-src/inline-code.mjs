import { EditorSelection } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";

// Unwrap only a whole parsed code span or its exact selectable content.
// Literal backticks inside a selection need a longer delimiter.
export function inlineCodeChange(state, range) {
  const {from, to} = range;
  const text = state.sliceDoc(from, to);
  let span = syntaxTree(state).resolveInner(from, 1);
  while (span && span.name !== "InlineCode") span = span.parent;
  if (span) {
    const [open, close] = span.getChildren("CodeMark");
    if (close) {
      let content = state.sliceDoc(open.to, close.from);
      const padded = content.startsWith(" ") && content.endsWith(" ") && /[^ ]/.test(content);
      const pad = Number(padded);
      if ((from === span.from && to === span.to) ||
          (from === open.to + pad && to === close.from - pad)) {
        if (padded) content = content.slice(1, -1);
        return {
          changes: {from: span.from, to: span.to, insert: content},
          range: EditorSelection.range(span.from, span.from + content.length),
        };
      }
    }
  }
  if (range.empty && from > 0 && state.sliceDoc(from - 1, to + 1) === "``") {
    return {changes: {from: from - 1, to: to + 1}, range: EditorSelection.cursor(from - 1)};
  }
  let width = 1;
  for (const match of text.matchAll(/`+/g)) width = Math.max(width, match[0].length + 1);
  const fence = "`".repeat(width);
  const pad = text.startsWith("`") || text.endsWith("`") ||
    (text.startsWith(" ") && text.endsWith(" ") && /[^ ]/.test(text)) ? " " : "";
  const prefix = fence + pad;
  return {
    changes: {from, to, insert: prefix + text + pad + fence},
    range: EditorSelection.range(range.anchor + prefix.length, range.head + prefix.length),
  };
}
