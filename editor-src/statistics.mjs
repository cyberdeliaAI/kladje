import { StateField } from "@codemirror/state";

const segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, {granularity: "word"}) : null;
const countLimit = 256 * 1024;

export function codePoints(text) {
  return text.length - (text.match(/[\u{10000}-\u{10ffff}]/gu)?.length || 0);
}

function wordCount(text) {
  if (!segmenter) return (text.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*/gu) || []).length;
  let words = 0;
  for (const part of segmenter.segment(text)) if (part.isWordLike) words++;
  return words;
}

function measure(doc, ranges) {
  let words = 0, pairs = 0;
  const repeated = new Map();
  for (const [first, last] of ranges) {
    for (const text of doc.iterLines(first, last + 1)) {
      pairs += text.length - codePoints(text);
      if (!text.length) continue;
      let count = repeated.get(text);
      if (count === undefined) {
        count = wordCount(text);
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

function initial(doc) {
  return doc.length > countLimit ? null : measure(doc, [[1, doc.lines]]);
}

// Line breaks are word boundaries. An edit need only recount the old and new
// lines it touches, even when several selections change one line.
export const counts = StateField.define({
  create: state => initial(state.doc),
  update(value, tr) {
    if (!tr.docChanged) return value;
    if (tr.newDoc.length > countLimit) return null;
    if (!value) return initial(tr.newDoc);
    const before = [], after = [];
    tr.changes.iterChangedRanges((a, b, c, d) => {
      addRange(before, tr.startState.doc, a, b);
      addRange(after, tr.newDoc, c, d);
    });
    const removed = measure(tr.startState.doc, before), added = measure(tr.newDoc, after);
    return {words: value.words + added.words - removed.words, pairs: value.pairs + added.pairs - removed.pairs};
  },
});
