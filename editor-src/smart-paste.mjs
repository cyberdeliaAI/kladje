import {ensureSyntaxTree} from "@codemirror/language";
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

// Rectangular TSV only. Decline ambiguous input so the normal paste can proceed.
function spreadsheetRows(text) {
  if (text.length > 256 * 1024 || !text.includes("\t") || !/[\r\n]/.test(text)) return null;
  const rows = [];
  let row = [], field = "", quoted = false, closed = false;
  const input = text.replace(/\r\n?/g, "\n");
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (input[i + 1] === '"') { field += '"'; i++; }
      else { quoted = false; closed = true; }
    } else if (c === "\t" || c === "\n") {
      row.push(field);
      field = ""; closed = false;
      if (c === "\n") { rows.push(row); row = []; }
    } else if (closed) return null;
    else if (c === '"' && !field) quoted = true;
    else field += c;
  }
  if (quoted) return null;
  if (!input.endsWith("\n")) { row.push(field); rows.push(row); }
  const width = rows[0]?.length;
  return rows.length >= 2 && width >= 2 && rows.every(r => r.length === width) ? rows : null;
}

export function spreadsheetPaste(state, text) {
  if (!text.includes("\t") || state.selection.ranges.length !== 1) return null;
  const {from, to} = state.selection.main;
  const line = state.doc.lineAt(from);
  if (line.from !== from || state.doc.lineAt(to).to !== to) return null;
  const tree = ensureSyntaxTree(state, to, 40);
  if (!tree) return null;
  for (let node = tree.resolve(from, 1); node; node = node.parent) {
    if (["FencedCode","CodeBlock","FrontMatter","Table"].includes(node.name)) return null;
  }
  const rows = spreadsheetRows(text);
  if (!rows) return null;
  // Keep cells literal; even pasted HTML, Markdown images and pipes are ordinary text.
  const cell = value => value.replace(/[\\|`*_\[\]~<>!&$^=]/g, "\\$&").replace(/\s+/gu, " ").trim();
  const lines = rows.map(row => "| " + row.map(cell).join(" | ") + " |");
  lines.splice(1, 0, "| " + rows[0].map(() => "---").join(" | ") + " |");
  const insert = lines.join("\n");
  return {changes:{from, to, insert}, selection:EditorSelection.cursor(from + insert.length),
    userEvent:"input.paste", scrollIntoView:true};
}
