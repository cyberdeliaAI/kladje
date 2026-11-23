// The editor half of Kladje: CodeMirror 6 with Markdown highlighting, wrapped in
// a small API so the rest of the app never touches CodeMirror directly.
//
// Rebuild ui/vendor/editor.js after changing this file:  npm run build:editor

import { inlineCodeChange } from "./inline-code.mjs";
import { EditorState, EditorSelection } from "@codemirror/state";
import {
  EditorView,
  keymap,
  drawSelection,
  dropCursor,
  highlightSpecialChars,
  placeholder,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  undo,
  redo,
} from "@codemirror/commands";
import { markdown, markdownLanguage, deleteMarkupBackward, insertNewlineContinueMarkupCommand } from "@codemirror/lang-markdown";
import { syntaxHighlighting, indentUnit } from "@codemirror/language";
import { search, searchKeymap, openSearchPanel, highlightSelectionMatches } from "@codemirror/search";
import { tags as t, tagHighlighter } from "@lezer/highlight";

// Tokens get class names; the colours live in app.css so themes are pure CSS.
const highlighter = tagHighlighter([
  { tag: t.heading1, class: "md-h md-h1" },
  { tag: t.heading2, class: "md-h md-h2" },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], class: "md-h md-h3" },
  { tag: t.strong, class: "md-strong" },
  { tag: t.emphasis, class: "md-em" },
  { tag: t.strikethrough, class: "md-strike" },
  { tag: t.link, class: "md-link" },
  { tag: t.url, class: "md-url" },
  { tag: t.monospace, class: "md-code" },
  { tag: t.quote, class: "md-quote" },
  { tag: t.list, class: "md-list" },
  { tag: [t.processingInstruction, t.contentSeparator], class: "md-mark" },
  { tag: [t.meta, t.labelName, t.atom], class: "md-meta" },
  { tag: t.comment, class: "md-comment" },
  { tag: [t.tagName, t.angleBracket, t.attributeName], class: "md-html" },
  { tag: t.string, class: "md-string" },
]);

const LIST_PATTERNS = {
  task: /^(\s*)[-*+]\s+\[[ xX]\]\s+/,
  bullet: /^(\s*)[-*+]\s+(?!\[[ xX]\]\s)/,
  numbered: /^(\s*)\d+[.)]\s+/,
  quote: /^(\s*)>\s?/,
};

function create(parent, options = {}) {
  const { onChange, onSelection, placeholderText = "" } = options;
  let cleanDoc = null;

  const extensions = [
    history(),
    drawSelection(),
    dropCursor(),
    highlightSpecialChars(),
    highlightSelectionMatches({ minSelectionLength: 2 }),
    EditorState.allowMultipleSelections.of(true),
    EditorState.tabSize.of(4),
    indentUnit.of("    "),
    EditorView.lineWrapping,
    markdown({ base: markdownLanguage, addKeymap: false }),
    keymap.of([
      { key: "Enter", run: insertNewlineContinueMarkupCommand({ nonTightLists: false }) },
      { key: "Backspace", run: deleteMarkupBackward },
    ]),
    syntaxHighlighting(highlighter),
    search({ top: true }),
    placeholder(placeholderText),
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),
    EditorView.contentAttributes.of({ "aria-label": "Markdown source editor", spellcheck: "true", autocorrect: "off", autocapitalize: "off" }),
    EditorView.updateListener.of((update) => {
      if (update.docChanged && onChange) onChange();
      if ((update.selectionSet || update.docChanged) && onSelection) onSelection();
    }),
  ];

  const view = new EditorView({
    parent,
    state: EditorState.create({ doc: "", extensions }),
  });
  cleanDoc = view.state.doc;

  const lineRange = (state, range) => ({
    first: state.doc.lineAt(range.from).number,
    last: state.doc.lineAt(range.empty ? range.to : range.to - 1).number,
  });

  // Apply `edit(line) -> newText | null` to every line touched by the selection.
  function editLines(edit) {
    const { state } = view;
    const changes = [];
    const seen = new Set();
    for (const range of state.selection.ranges) {
      const { first, last } = lineRange(state, range);
      for (let n = first; n <= last; n++) {
        if (seen.has(n)) continue;
        seen.add(n);
        const line = state.doc.line(n);
        const next = edit(line.text, n - first);
        if (next != null && next !== line.text) {
          changes.push({ from: line.from, to: line.to, insert: next });
        }
      }
    }
    if (changes.length) view.dispatch({ changes, scrollIntoView: true, userEvent: "input" });
    view.focus();
  }

  const stripListPrefix = (text) => {
    for (const pattern of Object.values(LIST_PATTERNS)) {
      const m = pattern.exec(text);
      if (m) return m[1] + text.slice(m[0].length);
    }
    return text;
  };

  const api = {
    getText: () => view.state.doc.toString(),

    /** Replace the whole document; this starts a fresh undo history. */
    setText(text) {
      view.setState(EditorState.create({ doc: text, extensions }));
      cleanDoc = view.state.doc;
      view.scrollDOM.scrollTop = 0;
    },

    /** Replace the content as an ordinary (undoable) edit. */
    replaceText(text) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    },

    isClean: () => cleanDoc !== null && view.state.doc.eq(cleanDoc),
    markClean() {
      cleanDoc = view.state.doc;
    },
    /** Treat the current content as unsaved (e.g. right after an import). */
    markDirty() {
      cleanDoc = null;
    },

    focus: () => view.focus(),
    undo: () => undo(view),
    redo: () => redo(view),
    find() {
      openSearchPanel(view);
    },

    /** Toggle an inline marker such as ** or ` around every selection. */
    toggleWrap(marker) {
      const { state } = view;
      const len = marker.length;
      const ch = marker[0];
      // `*` and `**` share a character: one star is italic, two bold, three both.
      const present = (run) => (ch === "*" ? (len === 1 ? run % 2 === 1 : run >= 2) : run >= len);
      const runBefore = (pos) => {
        let n = 0;
        while (n < 3 && pos - n > 0 && state.sliceDoc(pos - n - 1, pos - n) === ch) n++;
        return n;
      };
      const runAfter = (pos) => {
        let n = 0;
        while (n < 3 && state.sliceDoc(pos + n, pos + n + 1) === ch) n++;
        return n;
      };
      const tr = state.changeByRange((range) => {
        if (marker === "`") return inlineCodeChange(state, range);
        const text = state.sliceDoc(range.from, range.to);
        if (present(Math.min(runBefore(range.from), runAfter(range.to)))) {
          return {
            changes: [
              { from: range.from - len, to: range.from },
              { from: range.to, to: range.to + len },
            ],
            range: EditorSelection.range(range.from - len, range.to - len),
          };
        }
        const lead = /^(.)\1{0,2}/.exec(text);
        const trail = /(.)\1{0,2}$/.exec(text);
        const inner =
          lead && trail && lead[1] === ch && trail[1] === ch ? Math.min(lead[0].length, trail[0].length) : 0;
        if (text.length >= 2 * len && present(inner)) {
          return {
            changes: { from: range.from, to: range.to, insert: text.slice(len, -len) },
            range: EditorSelection.range(range.from, range.to - 2 * len),
          };
        }
        return {
          changes: [
            { from: range.from, insert: marker },
            { from: range.to, insert: marker },
          ],
          range: EditorSelection.range(range.from + len, range.to + len),
        };
      });
      view.dispatch(tr, { scrollIntoView: true, userEvent: "input" });
      view.focus();
    },

    /** Level 1-6 makes the selected lines headings; 0 turns them back into text. */
    setHeading(level) {
      const prefix = level ? "#".repeat(level) + " " : "";
      editLines((text) => {
        const body = text.replace(/^\s{0,3}#{1,6}(\s+|$)/, "");
        return body === "" && !level ? text.replace(/^\s{0,3}#{1,6}\s*$/, "") : prefix + body;
      });
    },

    /** kind: "bullet" | "numbered" | "task" | "quote". Toggles on the selected lines. */
    toggleList(kind) {
      const { state } = view;
      const pattern = LIST_PATTERNS[kind];
      let allHave = true;
      let any = false;
      for (const range of state.selection.ranges) {
        const { first, last } = lineRange(state, range);
        for (let n = first; n <= last; n++) {
          const text = state.doc.line(n).text;
          if (!text.trim() && first !== last) continue;
          any = true;
          if (!pattern.test(text)) allHave = false;
        }
      }
      const single = state.selection.ranges.length === 1 && state.selection.main.empty;
      editLines((text, index) => {
        if (!text.trim() && !single) return null;
        if (any && allHave) {
          const m = pattern.exec(text);
          return m[1] + text.slice(m[0].length);
        }
        const bare = kind === "quote" ? text : stripListPrefix(text);
        const indent = /^\s*/.exec(bare)[0];
        const body = bare.slice(indent.length);
        const marker =
          kind === "bullet" ? "- " : kind === "task" ? "- [ ] " : kind === "numbered" ? `${index + 1}. ` : "> ";
        return indent + marker + body;
      });
    },

    insertImage(relative) {
      const url = relative.split("/").map(part => encodeURIComponent(part).replace(/[()]/g, c => "%" + c.charCodeAt(0).toString(16))).join("/");
      const {from,to} = view.state.selection.main;
      const label = "Image description";
      view.dispatch({changes: {from,to,insert: `![${label}](${url})`}, selection: EditorSelection.range(from+2,from+2+label.length), userEvent: "input"});
      view.focus();
    },

    /** Insert a link; the part the user most likely wants to type is selected. */
    insertLink() {
      const { state } = view;
      const tr = state.changeByRange((range) => {
        const text = state.sliceDoc(range.from, range.to);
        if (/^(https?:\/\/|mailto:|www\.)\S+$/i.test(text)) {
          return {
            changes: { from: range.from, to: range.to, insert: `[](${text})` },
            range: EditorSelection.cursor(range.from + 1),
          };
        }
        const label = text || "text";
        const insert = `[${label}](url)`;
        const urlFrom = range.from + label.length + 3;
        return {
          changes: { from: range.from, to: range.to, insert },
          range: text
            ? EditorSelection.range(urlFrom, urlFrom + 3)
            : EditorSelection.range(range.from + 1, range.from + 1 + label.length),
        };
      });
      view.dispatch(tr, { scrollIntoView: true, userEvent: "input" });
      view.focus();
    },

    /**
     * Insert a block on its own lines. `build(selectedText)` returns
     * { text, selectFrom, selectTo } with offsets relative to `text`.
     */
    insertBlock(build) {
      const { state } = view;
      const range = state.selection.main;
      const startLine = state.doc.lineAt(range.from);
      const endLine = state.doc.lineAt(range.to);
      const selected = state.sliceDoc(range.from, range.to);
      const block = build(selected);

      const from = range.empty && startLine.text.trim() === "" ? startLine.from : range.from;
      const to = range.empty && startLine.text.trim() === "" ? startLine.to : range.to;
      const textBefore = state.sliceDoc(startLine.from, from);
      const textAfter = state.sliceDoc(to, endLine.to);

      let lead = "";
      if (textBefore.trim() !== "") lead = "\n\n";
      else if (startLine.number > 1 && state.doc.line(startLine.number - 1).text.trim() !== "") lead = "\n";
      let tail = "";
      if (textAfter.trim() !== "") tail = "\n\n";
      else if (endLine.number < state.doc.lines && state.doc.line(endLine.number + 1).text.trim() !== "") tail = "\n";

      const base = from + lead.length;
      view.dispatch({
        changes: { from, to, insert: lead + block.text + tail },
        selection: EditorSelection.range(base + block.selectFrom, base + block.selectTo),
        scrollIntoView: true,
        userEvent: "input",
      });
      view.focus();
    },

    /** Cursor position and selection size for the status bar. */
    cursor() {
      const { state } = view;
      const head = state.selection.main.head;
      const line = state.doc.lineAt(head);
      let selected = 0;
      for (const r of state.selection.ranges) selected += r.to - r.from;
      return { line: line.number, column: head - line.from + 1, selected, lines: state.doc.lines };
    },

    get scroller() {
      return view.scrollDOM;
    },

    /** The (fractional, 1-based) source line at the top edge of the viewport. */
    topLine() {
      const top = view.scrollDOM.scrollTop;
      const block = view.lineBlockAtHeight(top);
      const number = view.state.doc.lineAt(block.from).number;
      const fraction = block.height > 0 ? Math.min(1, Math.max(0, (top - block.top) / block.height)) : 0;
      return number + fraction;
    },

    scrollToLine(lineNumber) {
      const doc = view.state.doc;
      const whole = Math.min(doc.lines, Math.max(1, Math.floor(lineNumber)));
      const block = view.lineBlockAt(doc.line(whole).from);
      view.scrollDOM.scrollTop = block.top + (lineNumber - whole) * block.height;
    },

    /** Move the cursor to a line and bring it into view. */
    goToLine(lineNumber) {
      const doc = view.state.doc;
      const line = doc.line(Math.min(doc.lines, Math.max(1, lineNumber)));
      view.dispatch({
        selection: EditorSelection.cursor(line.from),
        effects: EditorView.scrollIntoView(line.from, { y: "start", yMargin: 24 }),
      });
    },

    /** Call after the font size or the pane width changes. */
    remeasure: () => view.requestMeasure(),
  };

  return api;
}

window.KladjeEditor = { create };
