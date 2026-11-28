// The editor half of Kladje: CodeMirror 6 with Markdown highlighting, wrapped in
// a small API so the rest of the app never touches CodeMirror directly.
//
// Rebuild ui/vendor/editor.js after changing this file:  npm run build:editor

import { paragraphFocus, typewriter } from "./writing-modes.mjs";
import { inlineCodeChange } from "./inline-code.mjs";
import { changedSections, compareView } from "./compare.mjs";
import { documentLanguage } from "./markdown-language.mjs";
import { spreadsheetPaste, urlOverSelection } from "./smart-paste.mjs";
import { closeBrackets, closeBracketsKeymap } from "@codemirror/autocomplete";
import { adjacentTableCell, tableRowChange } from "./table-row.mjs";
import { readTable, tableEdit, tableMenuActions } from "./table-edit.mjs";
import { footnoteChange } from "./footnote.mjs";
import { counts, counted, counting, codePoints, countLimit, selectedProseWords, totals } from "./statistics.mjs";
import { EditorState, EditorSelection, Compartment, Text } from "@codemirror/state";
import {
  EditorView,
  lineNumbers,
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
import { deleteMarkupBackward, insertNewlineContinueMarkupCommand } from "@codemirror/lang-markdown";
import { syntaxHighlighting, indentUnit, toggleFold, foldAll, unfoldAll, codeFolding } from "@codemirror/language";
import { search, searchKeymap, openSearchPanel, SearchQuery, setSearchQuery, highlightSelectionMatches } from "@codemirror/search";
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
  { tag: [t.keyword,t.bool,t.number], class: "md-meta" },
  { tag: [t.propertyName,t.typeName], class: "md-html" },
  { tag: t.string, class: "md-string" },
]);

const LIST_PATTERNS = {
  task: /^(\s*)[-*+]\s+\[[ xX]\]\s+/,
  bullet: /^(\s*)[-*+]\s+(?!\[[ xX]\]\s)/,
  numbered: /^(\s*)\d+[.)]\s+/,
  quote: /^(\s*)>\s?/,
};

function create(parent, options = {}) {
  const { onChange, onSelection, onStatistics, placeholderText = "" } = options;
  let cleanDoc = null;
  const layout = new Compartment();
  const input = new Compartment();
  const pairs = new Compartment();
  const modes = new Compartment();
  let modeExtensions = [];
  let pairing = true;
  const pairKeys = [closeBrackets(),keymap.of(closeBracketsKeymap)];
  let layoutExtensions = [EditorView.lineWrapping];

  const extensions = [
    history(),
    drawSelection(),
    dropCursor(),
    highlightSpecialChars(),
    highlightSelectionMatches({ minSelectionLength: 2 }),
    EditorState.allowMultipleSelections.of(true),
    EditorState.tabSize.of(4),
    indentUnit.of("    "),
    counts,
    counting,
    layout.of(layoutExtensions),
    input.of([]),
    pairs.of(pairKeys),
    modes.of(modeExtensions),
    codeFolding(),
    EditorState.phrases.of({next:"Next",previous:"Previous",replace:"Replace","replace all":"Replace all","match case":"Match case","by word":"Whole word"}),

    keymap.of([
      ...[["Tab",1],["Shift-Tab",-1]].map(([key,direction])=>({key,run(view) {
        const change=adjacentTableCell(view.state,direction);
        if (!change) return false;
        view.dispatch(change); return true;
      }})),
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
      if (onStatistics && update.transactions.some(tr => tr.effects.some(effect => effect.is(counted)))) onStatistics();
    }),
  ];

  function createState(text) {
    const doc = Text.of(text.split("\n"));
    return EditorState.create({doc, extensions:[extensions,documentLanguage(doc)]});
  }
  const view = new EditorView({
    parent,
    state: createState(""),
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

  function editTable(op, arg, position) {
    const change = tableEdit(view.state, op, arg, position);
    if (!change) return false;
    view.dispatch(change);
    view.focus();
    return true;
  }

  const api = {
    setFrozen(frozen) {
      view.dispatch({effects:input.reconfigure(frozen ? [
        EditorState.readOnly.of(true), EditorView.editable.of(false), EditorState.changeFilter.of(() => false),
      ] : [])});
    },
    insertTableRow() {
      const change = tableRowChange(view.state);
      if (!change) return false;
      view.dispatch(change);
      view.focus();
      return true;
    },
    inTable: () => readTable(view.state) !== null,
    /** A structural table edit (see table-edit.mjs). False outside a table. */
    editTable,
    contextMenuAt(event) {
      const { state, contentDOM } = view;
      if (state.readOnly || !contentDOM.contains(event.target)) return null;
      const position = view.posAtCoords({ x: event.clientX, y: event.clientY });
      if (position === null) return null;
      const table = readTable(state, position);
      const tableCommands = table ? tableMenuActions(table) : null;
      const insideSelection = state.selection.ranges.some(range =>
        !range.empty && position >= range.from && position <= range.to);
      const selection = insideSelection ? state.selection : EditorSelection.single(position);
      const isCurrent = () => view.state.doc === state.doc && !view.state.readOnly;
      return {
        tableCommands,
        restoreSelection() {
          if (!isCurrent()) return false;
          if (!view.state.selection.eq(selection)) view.dispatch({selection});
          return true;
        },
        chooseTable(op) {
          if (isCurrent() && tableCommands?.includes(op)) {
            editTable(op, undefined, position);
          }
        },
      };
    },
    insertFootnote() {
      view.dispatch(footnoteChange(view.state));
      view.focus();
    },
    /** Insert text at the cursor, replacing a selection. */
    insertText(text) {
      view.dispatch(view.state.replaceSelection(text), {scrollIntoView: true, userEvent: "input"});
      view.focus();
    },
    foldAll() { foldAll(view); view.focus(); },
    unfoldAll() { unfoldAll(view); view.focus(); },
    setWritingModes(focus, center) {
      modeExtensions = [focus ? paragraphFocus : [], center ? typewriter : []];
      view.dispatch({effects:modes.reconfigure(modeExtensions)});
    },
    setPairing(value) { pairing=value; view.dispatch({effects:pairs.reconfigure(value?pairKeys:[])}); },
    pasteTable(text) {
      const change = spreadsheetPaste(view.state, text);
      if (!change) return false;
      view.dispatch(change);
      return true;
    },
    pasteUrl(text) {
      const change=urlOverSelection(view.state,text);
      if (!change) return false;
      view.dispatch(change,{userEvent:"input.paste",scrollIntoView:true}); return true;
    },
    toggleTask(offset, checked) {
      if (!Number.isInteger(offset) || offset < 1 || offset >= view.state.doc.length) return false;
      const marker = view.state.sliceDoc(offset-1, offset+2);
      if (!(checked ? /^\[[xX]\]$/ : /^\[ \]$/).test(marker)) return false;
      view.dispatch({changes:{from:offset,to:offset+1,insert:checked ? " " : "x"},userEvent:"input"});
      return true;
    },
    selectedText() { return view.state.selection.ranges.map(r=>view.state.sliceDoc(r.from,r.to)).join("\n"); },
    pasteText(text) { view.dispatch(view.state.replaceSelection(text),{userEvent:"input.paste",scrollIntoView:true}); },
    fold() { toggleFold(view); view.focus(); },
    findSelection() {
      const selected=view.state.sliceDoc(view.state.selection.main.from,view.state.selection.main.to);
      openSearchPanel(view);
      if (selected) view.dispatch({effects:setSearchQuery.of(new SearchQuery({search:selected,literal:true}))});
    },
    getText: () => view.state.doc.toString(),
    textLength: () => view.state.doc.length,
    selection: () => view.state.selection,
    configureLayout({wrap, gutter}) {
      layoutExtensions = [wrap ? EditorView.lineWrapping : [], gutter ? lineNumbers() : []];
      view.dispatch({effects: layout.reconfigure(layoutExtensions)});
    },
    statistics() {
      const count = totals(view.state);
      return count && {words: count.words, characters: view.state.doc.length - count.pairs};
    },

    /** Replace the whole document; this starts a fresh undo history. */
    setText(text) {
      view.setState(createState(text));
      view.dispatch({effects:pairs.reconfigure(pairing ? pairKeys : [])});
      view.dispatch({effects: layout.reconfigure(layoutExtensions)});
      cleanDoc = view.state.doc;
      view.scrollDOM.scrollTop = 0;
    },

    /** Replace the content as an ordinary (undoable) edit. */
    replaceText(text, keepSelection = false) {
      const current = view.state.selection;
      const selection = keepSelection ? EditorSelection.create(current.ranges.map(r =>
        EditorSelection.range(Math.min(r.anchor, text.length), Math.min(r.head, text.length))), current.mainIndex) : undefined;
      view.dispatch({changes: {from:0, to:view.state.doc.length, insert:text}, selection});
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
      // Cursor movement should not allocate a document-sized string in a huge
      // selection or single-line file. Omit an exact count outside the budget.
      const span = state.selection.ranges.reduce((total, r) => total + r.to - r.from, 0);
      const selected = span > countLimit ? null : state.selection.ranges.reduce(
        (total, r) => total + codePoints(state.sliceDoc(r.from, r.to)), 0);
      const column = head - line.from > countLimit ? null : codePoints(state.sliceDoc(line.from, head)) + 1;
      const selectedWords = span && span <= countLimit ? selectedProseWords(state) : 0;
      return {line: line.number, column, selected, selectedWords, lines: state.doc.lines};
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

    location() { return {offset: view.state.selection.main.head, top: api.topLine()}; },
    restoreLocation({offset, top}) {
      if (!Number.isInteger(offset) || offset < 0 || offset > view.state.doc.length) return;
      view.dispatch({selection: EditorSelection.cursor(offset)});
      if (Number.isFinite(top)) api.scrollToLine(top);
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

window.KladjeEditor = { create, compare: compareView, changedSections };
