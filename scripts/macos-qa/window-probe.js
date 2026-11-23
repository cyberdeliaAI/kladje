// A two-window experiment in a temporary app identity. Neither window opens user files.
const createEditor = window.KladjeEditor.create;
let editor;
window.KladjeEditor.create = (...args) => (editor = createEditor(...args));
window.addEventListener("load", async () => {
  const {core, window:windows} = window.__TAURI__;
  const label = windows.getCurrentWindow().label;
  const write = (suffix, content) => core.invoke("write_file", {path:window.qaResultPath+"."+label+suffix,
    content, expected:null, format:{encoding:"utf8",eol:"lf"}});
  const until = async fn => {
    const started = Date.now();
    while (!await fn()) {
      if (Date.now()-started > 30000) throw Error("Window probe timed out");
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  };
  try {
    await until(() => editor && !document.getElementById("editor-pane").inert);
    editor.setText(label);
    editor.goToLine(1);
    editor.replaceText(label+" draft");
    editor.undo();
    const undoIsolated = editor.getText() === label;
    await new Promise(resolve => setTimeout(resolve,150));
    await windows.getCurrentWindow().setTitle("Window probe "+label);
    await write(".ready.txt","ready");
    await until(() => core.invoke("file_version",{path:window.qaResultPath+".routed.txt"}));
    await write(".observed.txt",JSON.stringify({label, ready:true, undoIsolated, afterNativeBold:editor.getText()}));
  } catch(error) { await write(".observed.txt",JSON.stringify({label,error:String(error)})); }
});
