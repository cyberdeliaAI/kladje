import {EditorSelection} from "@codemirror/state";

export function urlOverSelection(state, text) {
  if (text.length > 8192 || !/^https?:\/\//i.test(text) || /[\s\u0000-\u001f<>\\]/u.test(text)) return null;
  let url;
  try { url = new URL(text); } catch { return null; }
  if (!url.hostname || url.username || url.password || state.selection.ranges.some(r => r.empty)) return null;
  const destination = text.replaceAll("(", "%28").replaceAll(")", "%29");
  return state.changeByRange(r => {
    const label = state.sliceDoc(r.from,r.to).replace(/[\\[\]]/g, "\\$&");
    const insert = `[${label}](${destination})`;
    return {changes:{from:r.from,to:r.to,insert},range:EditorSelection.cursor(r.from+insert.length)};
  });
}
