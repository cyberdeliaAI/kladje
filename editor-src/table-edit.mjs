// Structural table edits. The table under the cursor is read from the syntax
// tree, so escaped pipes and empty cells keep their place, and written back
// with its columns padded to a common width.
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";
import { codePoints } from "./statistics.mjs";

const ROW = ["TableHeader", "TableRow"];

function cellsOf(state, node) {
  const pipes = node.getChildren("TableDelimiter");
  const bounds = [node.from, ...pipes.flatMap(p => [p.from, p.to]), node.to];
  const cells = [];
  for (let i = 0; i < bounds.length; i += 2) {
    const from = bounds[i], to = bounds[i + 1];
    // A leading or trailing pipe leaves an empty edge segment, not a cell.
    if (from === to && (i === 0 || i === bounds.length - 2)) continue;
    cells.push({ from, to, text: state.sliceDoc(from, to).trim() });
  }
  return cells;
}

function alignOf(cell) {
  const text = cell.trim();
  const left = text.startsWith(":"), right = text.endsWith(":") && text.length > 1;
  return left && right ? "center" : right ? "right" : left ? "left" : "none";
}

/** The table around the cursor, or null. Rows exclude the delimiter row. */
export function readTable(state) {
  if (state.selection.ranges.length !== 1) return null;
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const tree = ensureSyntaxTree(state, line.to, 80);
  if (!tree) return null;
  let table = tree.resolveInner(Math.min(head, line.to), -1);
  while (table && table.name !== "Table") table = table.parent;
  if (!table) {
    // The cursor at the very start of a row resolves to the text before it.
    table = tree.resolveInner(line.from, 1);
    while (table && table.name !== "Table") table = table.parent;
  }
  const delimiter = table?.getChild("TableDelimiter");
  if (!delimiter) return null;
  const rows = [];
  for (let child = table.firstChild; child; child = child.nextSibling) {
    if (!ROW.includes(child.name)) continue;
    const at = state.doc.lineAt(child.from);
    rows.push({ line: at.number, prefix: state.sliceDoc(at.from, child.from), cells: cellsOf(state, child) });
  }
  const delimiterLine = state.doc.lineAt(delimiter.from);
  const aligns = state.sliceDoc(delimiter.from, delimiter.to).trim().replace(/^\||\|$/g, "").split("|").map(alignOf);
  const first = state.doc.line(rows[0]?.line ?? delimiterLine.number);
  const last = state.doc.line(Math.max(delimiterLine.number, ...rows.map(r => r.line)));
  // The row and column of the cursor. The delimiter row counts as the header.
  let row = rows.findIndex(r => r.line === line.number);
  if (row < 0) row = 0;
  const cells = rows[row]?.cells || [];
  let column = cells.findIndex((c, i) => head <= c.to || i + 1 === cells.length || head < cells[i + 1].from - 1);
  if (column < 0) column = 0;
  return {
    from: first.from, to: last.to, delimiterLine: delimiterLine.number,
    prefix: state.sliceDoc(delimiterLine.from, delimiter.from),
    rows: rows.map(r => ({ prefix: r.prefix, cells: r.cells.map(c => c.text) })),
    aligns, row, column,
  };
}

function pad(text, width, align) {
  const room = width - codePoints(text);
  if (room <= 0) return text;
  if (align === "right") return " ".repeat(room) + text;
  if (align === "center") return " ".repeat(Math.floor(room / 2)) + text + " ".repeat(Math.ceil(room / 2));
  return text + " ".repeat(room);
}

function rule(width, align) {
  if (align === "center") return ":" + "-".repeat(Math.max(1, width - 2)) + ":";
  if (align === "left") return ":" + "-".repeat(Math.max(2, width - 1));
  if (align === "right") return "-".repeat(Math.max(2, width - 1)) + ":";
  return "-".repeat(Math.max(3, width));
}

/** Write a table model back as aligned Markdown; returns the text and cell offsets. */
export function writeTable(table) {
  const columns = Math.max(1, table.aligns.length, ...table.rows.map(r => r.cells.length));
  const aligns = Array.from({ length: columns }, (_, i) => table.aligns[i] || "none");
  const rows = table.rows.map(r => ({ ...r, cells: Array.from({ length: columns }, (_, i) => r.cells[i] ?? "") }));
  const widths = aligns.map((align, i) => Math.max(3, align === "center" ? 3 : 2, ...rows.map(r => codePoints(r.cells[i]))));
  const lines = [], starts = [];
  const emit = (prefix, cells) => {
    let text = prefix + "|";
    const at = [];
    cells.forEach(cell => { at.push(text.length + 1); text += " " + cell + " |"; });
    lines.push(text);
    starts.push(at);
  };
  rows.forEach((r, i) => {
    emit(r.prefix ?? table.prefix, r.cells.map((c, col) => pad(c, widths[col], aligns[col])));
    if (i === 0) emit(table.prefix, widths.map((w, col) => rule(w, aligns[col])));
  });
  if (!rows.length) emit(table.prefix, widths.map((w, col) => rule(w, aligns[col])));
  return { text: lines.join("\n"), lines, starts };
}

/**
 * Apply `op` to the table under the cursor. Returns a transaction spec or null
 * when the cursor is not in a table or the operation does not apply there.
 */
export function tableEdit(state, op, arg) {
  const table = readTable(state);
  if (!table) return null;
  let { row, column } = table;
  const rows = table.rows.map(r => ({ ...r, cells: [...r.cells] }));
  const aligns = [...table.aligns];
  const columns = Math.max(aligns.length, ...rows.map(r => r.cells.length));
  const blank = () => ({ prefix: table.prefix, cells: Array(columns).fill("") });
  switch (op) {
    case "rowAbove":
      if (row === 0) return null; // nothing goes above the header
      rows.splice(row, 0, blank());
      break;
    case "rowBelow":
      rows.splice(row + 1, 0, blank());
      row += 1;
      break;
    case "deleteRow":
      if (row === 0) return null;
      rows.splice(row, 1);
      row = Math.min(row, rows.length - 1);
      break;
    case "moveUp":
      if (row <= 1) return null;
      [rows[row - 1], rows[row]] = [rows[row], rows[row - 1]];
      row -= 1;
      break;
    case "moveDown":
      if (row === 0 || row >= rows.length - 1) return null;
      [rows[row + 1], rows[row]] = [rows[row], rows[row + 1]];
      row += 1;
      break;
    case "columnBefore":
    case "columnAfter": {
      const at = op === "columnAfter" ? column + 1 : column;
      for (const r of rows) {
        while (r.cells.length < columns) r.cells.push("");
        r.cells.splice(at, 0, "");
      }
      while (aligns.length < columns) aligns.push("none");
      aligns.splice(at, 0, "none");
      column = at;
      break;
    }
    case "deleteColumn":
      if (columns <= 1) return null;
      for (const r of rows) r.cells.splice(column, 1);
      aligns.splice(column, 1);
      column = Math.min(column, columns - 2);
      break;
    case "align":
      while (aligns.length < columns) aligns.push("none");
      aligns[column] = arg;
      break;
    case "format":
      break;
    default:
      return null;
  }
  const written = writeTable({ prefix: table.prefix, rows, aligns });
  // Place the cursor in the affected cell. Line 1 of the output is the delimiter.
  const outputLine = row === 0 ? 0 : row + 1;
  const offset = written.lines.slice(0, outputLine).reduce((n, l) => n + l.length + 1, 0) +
    (written.starts[outputLine][Math.min(column, written.starts[outputLine].length - 1)] ?? 0);
  return {
    changes: { from: table.from, to: table.to, insert: written.text },
    selection: EditorSelection.cursor(table.from + offset),
    scrollIntoView: true,
    userEvent: "input",
  };
}
