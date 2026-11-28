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
export function readTable(state, position) {
  if (position === undefined && state.selection.ranges.length !== 1) return null;
  const head = position ?? state.selection.main.head;
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
  const ruleText = state.sliceDoc(delimiter.from, delimiter.to);
  const aligns = ruleText.trim().replace(/^\||\|$/g, "").split("|").map(alignOf);
  const first = state.doc.line(rows[0]?.line ?? delimiterLine.number);
  const last = state.doc.line(Math.max(delimiterLine.number, ...rows.map(r => r.line)));
  // The row and column of the cursor. The delimiter row counts as the header.
  let row = rows.findIndex(r => r.line === line.number);
  if (row < 0) row = 0;
  const cells = rows[row]?.cells || [];
  const columns = rows.reduce((max, r) => Math.max(max, r.cells.length), aligns.length);
  const column = line.number === delimiterLine.number
    ? Math.min(aligns.length - 1, ruleText.slice(0, Math.max(0, head - delimiter.from))
        .replace(/^\s*\|/, "").split("|").length - 1)
    : Math.max(0, cells.findIndex((c, i) => head <= c.to || i + 1 === cells.length || head < cells[i + 1].from - 1));
  return {
    from: first.from, to: last.to, delimiterLine: delimiterLine.number,
    prefix: state.sliceDoc(delimiterLine.from, delimiter.from),
    rows: rows.map(r => ({ prefix: r.prefix, cells: r.cells.map(c => c.text) })),
    aligns, row, column, columns,
  };
}

const tableActions = {
  rowAbove: ({row}) => row > 0,
  rowBelow: () => true,
  columnBefore: () => true,
  columnAfter: () => true,
  moveUp: ({row}) => row > 1,
  moveDown: ({row, rows}) => row > 0 && row < rows.length - 1,
  moveLeft: ({column}) => column > 0,
  moveRight: ({column, columns}) => column < columns - 1,
  deleteRow: ({row}) => row > 0,
  deleteColumn: ({columns}) => columns > 1,
};

export function tableMenuActions(table) {
  return Object.keys(tableActions).filter(op => tableActions[op](table));
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
export function tableEdit(state, op, arg, position) {
  const table = readTable(state, position);
  if (!table || (Object.hasOwn(tableActions, op) && !tableActions[op](table))) return null;
  let { row, column } = table;
  const rows = table.rows.map(r => ({ ...r, cells: [...r.cells] }));
  const aligns = [...table.aligns];
  const { columns } = table;
  const blank = () => ({ prefix: table.prefix, cells: Array(columns).fill("") });
  switch (op) {
    case "rowAbove":
      rows.splice(row, 0, blank());
      break;
    case "rowBelow":
      rows.splice(row + 1, 0, blank());
      row += 1;
      break;
    case "deleteRow":
      rows.splice(row, 1);
      row = Math.min(row, rows.length - 1);
      break;
    case "moveUp":
      [rows[row - 1], rows[row]] = [rows[row], rows[row - 1]];
      row -= 1;
      break;
    case "moveDown":
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
    case "moveLeft":
    case "moveRight": {
      const destination = column + (op === "moveLeft" ? -1 : 1);
      for (const r of rows) {
        [r.cells[column], r.cells[destination]] = [r.cells[destination] ?? "", r.cells[column] ?? ""];
      }
      [aligns[column], aligns[destination]] = [aligns[destination] ?? "none", aligns[column] ?? "none"];
      column = destination;
      break;
    }
    case "deleteColumn":
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
