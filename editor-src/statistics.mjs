import { StateEffect, StateField } from "@codemirror/state";
import { ViewPlugin } from "@codemirror/view";

import {frontmatterLines} from "./markdown-language.mjs";

const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, {granularity: "word"}) : null;
/**
 * The most text counted in one synchronous pass: a whole document when it
 * opens, the lines one edit touches, a selection or the cursor's column.
 * Larger documents are counted in the background, in short slices.
 */
export const countLimit = 256 * 1024;
/** Longest stretch a background slice segments at once; longer lines are cut at a space. */
const PIECE = 32 * 1024;
const SLICE_MS = 6;

export function codePoints(text) {
  return text.length - (text.match(/[\u{10000}-\u{10ffff}]/gu)?.length || 0);
}

export function wordCount(text) {
  if (!segmenter) return (text.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) || []).length;
  let words = 0;
  for (const part of segmenter.segment(text)) if (part.isWordLike) words++;
  return words;
}

export function selectedProseWords(state) {
  const metadata = frontmatterLines(state.doc);
  const start = metadata ? state.doc.line(metadata).to : 0;
  return state.selection.ranges.reduce((total, range) => {
    const from = Math.max(start, range.from);
    return total + (from < range.to ? wordCount(state.sliceDoc(from, range.to)) : 0);
  }, 0);
}

function* pieces(text) {
  for (let from = 0; from < text.length;) {
    let to = Math.min(text.length, from + PIECE);
    if (to < text.length) {
      const space = text.lastIndexOf(" ", to);
      if (space > from) to = space;
    }
    yield text.slice(from, to);
    from = to;
  }
}

// One rule for every pass, so removing a line subtracts exactly what adding it counted.
function lineWords(text) {
  if (text.length <= PIECE) return wordCount(text);
  let words = 0;
  for (const piece of pieces(text)) words += wordCount(piece);
  return words;
}

function measure(doc, ranges) {
  let words = 0, pairs = 0;
  const repeated = new Map();
  const metadata = frontmatterLines(doc);
  for (const [first, last] of ranges) {
    let line = first - 1;
    for (const text of doc.iterLines(first, last + 1)) {
      pairs += text.length - codePoints(text);
      if (++line <= metadata || !text.length) continue;
      let count = repeated.get(text);
      if (count === undefined) {
        count = lineWords(text);
        if (repeated.size < 128 && text.length <= 512) repeated.set(text, count);
      }
      words += count;
    }
  }
  return {words, pairs};
}

function addRange(ranges, doc, from, to) {
  const first = doc.lineAt(from).number, last = doc.lineAt(to).number;
  const previous = ranges[ranges.length - 1];
  if (previous && first <= previous[1] + 1) previous[1] = Math.max(previous[1], last);
  else ranges.push([first, last]);
}

const span = (doc, ranges) => ranges.reduce((total, [first, last]) => total + doc.line(last).to - doc.line(first).from, 0);

/** Totals for `doc` arrived from the background count. */
export const counted = StateEffect.define();

// While `pending` names the document being counted in the background, words and
// pairs hold only the difference later edits made to that document.
function initial(doc) {
  return doc.length > countLimit ? {words: 0, pairs: 0, pending: doc} : measure(doc, [[1, doc.lines]]);
}

// Line breaks are word boundaries. An edit need only recount the old and new
// lines it touches, even when several selections change one line.
export const counts = StateField.define({
  create: state => initial(state.doc),
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(counted) && value.pending && effect.value.doc === value.pending) {
        value = {words: value.words + effect.value.words, pairs: value.pairs + effect.value.pairs};
      }
    }
    if (!tr.docChanged) return value;
    if (frontmatterLines(tr.startState.doc) !== frontmatterLines(tr.newDoc)) return initial(tr.newDoc);
    const before = [], after = [];
    tr.changes.iterChangedRanges((a, b, c, d) => {
      addRange(before, tr.startState.doc, a, b);
      addRange(after, tr.newDoc, c, d);
    });
    // Replacing a large part of the text, or editing one enormous line, is a fresh count.
    if (span(tr.startState.doc, before) + span(tr.newDoc, after) > countLimit) return initial(tr.newDoc);
    const removed = measure(tr.startState.doc, before), added = measure(tr.newDoc, after);
    const next = {words: value.words + added.words - removed.words, pairs: value.pairs + added.pairs - removed.pairs};
    if (value.pending) next.pending = value.pending;
    return next;
  },
});

/** Current totals, or null while a large document is still being counted. */
export function totals(state) {
  const value = state.field(counts);
  return value.pending ? null : value;
}

/**
 * Count a whole document a little at a time. `step` works for about `budget`
 * milliseconds and returns the totals once every line has been read.
 */
export function countJob(doc, clock = () => performance.now()) {
  const lines = doc.iterLines(), metadata = frontmatterLines(doc);
  let line = 0, words = 0, pairs = 0, rest = null;
  return {
    step(budget) {
      const deadline = clock() + budget;
      do {
        if (rest) {
          const piece = rest.next();
          if (piece.done) rest = null;
          else words += wordCount(piece.value);
          continue;
        }
        const next = lines.next();
        if (next.done) return {doc, words, pairs};
        const text = next.value;
        pairs += text.length - codePoints(text);
        if (++line <= metadata || !text.length) continue;
        if (text.length > PIECE) rest = pieces(text);
        else words += wordCount(text);
      } while (clock() < deadline);
      return null;
    },
  };
}

/** Runs the background count for whichever document the field is waiting on. */
export const counting = ViewPlugin.fromClass(class {
  constructor(view) {
    this.view = view;
    this.doc = null;
    this.timer = 0;
    this.follow();
  }
  update() { this.follow(); }
  follow() {
    const pending = this.view.state.field(counts).pending || null;
    if (pending === this.doc) return;
    clearTimeout(this.timer);
    this.doc = pending;
    if (!pending) return;
    const job = countJob(pending);
    const slice = () => {
      const done = job.step(SLICE_MS);
      if (done) this.view.dispatch({effects: counted.of(done)});
      else this.timer = setTimeout(slice, 0);
    };
    this.timer = setTimeout(slice, 0);
  }
  destroy() { clearTimeout(this.timer); }
});
