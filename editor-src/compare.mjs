// A read-only, side-by-side comparison of two text snapshots. Neither side can
// be edited and nothing here writes to the document or to disk.
import { EditorState, Text } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { Chunk, MergeView, goToNextChunk, goToPreviousChunk } from "@codemirror/merge";

const lines = (text) => Text.of(text.split("\n"));

/** The number of separate places where the two texts differ. */
export function changedSections(mine, disk) {
  return mine === disk ? 0 : Chunk.build(lines(mine), lines(disk)).length;
}

const side = (label) => [
  lineNumbers(),
  EditorView.lineWrapping,
  EditorState.readOnly.of(true),
  EditorView.editable.of(false),
  // Not editable, but reachable and readable with the keyboard and a screen reader.
  EditorView.contentAttributes.of({ "aria-label": label, tabindex: "0" }),
];

/** Show `mine` on the left and `disk` on the right inside `parent`. */
export function compareView(parent, mine, disk) {
  const view = new MergeView({
    parent,
    a: { doc: lines(mine), extensions: side("This window, read-only") },
    b: { doc: lines(disk), extensions: side("On disk, read-only") },
    highlightChanges: true,
    gutter: true,
    // Long unchanged stretches fold away. Three lines of context stay visible.
    collapseUnchanged: { margin: 3, minSize: 6 },
  });
  const first = view.chunks[0];
  if (first) {
    view.a.dispatch({
      selection: { anchor: Math.min(first.fromA, view.a.state.doc.length) },
      effects: EditorView.scrollIntoView(Math.min(first.fromA, view.a.state.doc.length), { y: "center" }),
    });
  }
  return {
    next: () => goToNextChunk(view.a),
    previous: () => goToPreviousChunk(view.a),
    destroy: () => view.destroy(),
  };
}
