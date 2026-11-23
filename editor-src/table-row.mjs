import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection } from "@codemirror/state";

export function tableRowChange(state) {
  if (state.selection.ranges.length !== 1) return null;
  const line = state.doc.lineAt(state.selection.main.head);
  const tree = ensureSyntaxTree(state, line.to, 60);
  if (!tree) return null;
  let table = tree.resolveInner(line.to, -1);
  while (table && table.name !== "Table") table = table.parent;
  const divider = table?.getChild("TableDelimiter");
  if (!divider) return null;
  const dividerLine = state.doc.lineAt(divider.from);
  const prefix = state.sliceDoc(dividerLine.from, divider.from);
  const columns = state.sliceDoc(divider.from, divider.to).trim().replace(/^\||\|$/g, "").split("|").length;
  const at = Math.max(line.to, dividerLine.to);
  return {
    changes: {from: at, insert: "\n" + prefix + "|" + "  |".repeat(columns)},
    selection: EditorSelection.cursor(at + prefix.length + 3),
    scrollIntoView: true, userEvent: "input",
  };
}

// Use parsed pipe delimiters so escaped pipes and empty cells retain their positions.
export function adjacentTableCell(state, direction) {
  if (state.selection.ranges.length !== 1) return null;
  const pos = state.selection.main.head, line = state.doc.lineAt(pos);
  const tree = ensureSyntaxTree(state,line.to,50);
  let row = tree?.resolveInner(pos,pos === line.from ? 1 : -1);
  while (row && !["TableHeader","TableRow"].includes(row.name)) row = row.parent;
  if (!row) return null;
  function cells(node) {
    const pipes = node.getChildren("TableDelimiter");
    const bounds = [node.from, ...pipes.flatMap(p=>[p.from,p.to]),node.to];
    const result=[];
    for (let i=0;i<bounds.length;i+=2) {
      let from=bounds[i], to=bounds[i+1];
      if (from===to && (i===0 || i===bounds.length-2)) continue;
      const text=state.sliceDoc(from,to);
      const first=text.search(/\S/);
      if (first<0) from=to;
      else { from+=first; to-=text.length-text.trimEnd().length; }
      result.push({from,to});
    }
    return result;
  }
  const current=cells(row);
  let index=current.findIndex((c,i)=>pos<=c.to || i+1===current.length || pos<current[i+1].from-1);
  let cell=current[index+direction];
  if (!cell) {
    let next=direction>0?row.nextSibling:row.prevSibling;
    if (next?.name==="TableDelimiter") next=direction>0?next.nextSibling:next.prevSibling;
    if (next && ["TableHeader","TableRow"].includes(next.name)) cell=cells(next).at(direction>0?0:-1);
  }
  if (!cell && direction > 0) return tableRowChange(state);
  // Backtab at the first cell must not outdent the entire table row.
  cell ||= current[0];
  if (!cell) return null;
  return {selection:EditorSelection.range(cell.from,cell.to),scrollIntoView:true,userEvent:"select"};
}
