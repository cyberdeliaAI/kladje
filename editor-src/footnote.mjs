import { EditorSelection } from "@codemirror/state";

/**
 * Insert a reference to the next free numbered footnote at the cursor and
 * start its definition at the end of the document. A selection becomes the
 * footnote text.
 */
export function footnoteChange(state) {
  const text = state.doc.toString();
  const used = new Set(Array.from(text.matchAll(/\[\^(\d+)\]/g), m => Number(m[1])));
  let n = 1;
  while (used.has(n)) n++;
  const {from, to} = state.selection.main;
  const note = state.sliceDoc(from, to).replace(/\s*\n\s*/g, " ").trim();
  const reference = `[^${n}]`;
  // Keep one blank line between the text and the definitions.
  const trailing = /\n*$/.exec(text)[0].length;
  const end = state.doc.length;
  const lead = "\n".repeat(Math.max(0, 2 - trailing));
  const lastLine = state.doc.line(state.doc.lines).text;
  // Consecutive definitions stay together.
  const separator = /^\[\^[^\]]+\]:/.test(lastLine) && trailing === 0 ? "\n" : lead;
  const definition = `${separator}${reference}: ${note}`;
  const shift = reference.length - (to - from);
  return {
    changes: [{from, to, insert: reference}, {from: end, insert: definition}],
    selection: EditorSelection.cursor(end + shift + definition.length),
    scrollIntoView: true,
    userEvent: "input",
  };
}
