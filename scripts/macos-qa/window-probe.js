// Only the disposable QA bundle receives this driver. Every document operation
// goes through the shipped UI, native menu or document bridge.
const createEditor = window.KladjeEditor.create;
let editor;
window.KladjeEditor.create = (...args) => (editor = createEditor(...args));
window.addEventListener("load", async () => {
  const {core, window:windows, event} = window.__TAURI__;
  const current = windows.getCurrentWindow(), label = current.label;
  const folder = window.qaResultPath + ".";
  const read = path => core.invoke("read_file", {path});
  const write = (path, value) => core.invoke("write_file", {path, content:JSON.stringify(value),
    expected:null, format:{encoding:"utf8", eol:"lf"}});
  const delay = ms => new Promise(done => setTimeout(done,ms));
  const run = (await read(folder+"run.txt")).content;
  const filename = folder + run + "." + label;
  while (document.getElementById("editor-pane").inert) await delay(60);
  for (let step = 0;;step++) {
    let command;
    while (!command) {
      try { command = JSON.parse((await read(filename+"."+step+".in.txt")).content); }
      catch { await delay(100); }
    }
    try {
      if (typeof command.autosave === "boolean") {
        const control = document.getElementById("autosave");
        control.checked = command.autosave;
        control.dispatchEvent(new Event("change"));
      }
      if (command.edit) editor.replaceText(command.edit);
      if (command.menu) await event.emitTo(label,"menu",command.menu);
      if (command.wait) await delay(command.wait);
      const status = {
        text:editor.getText(), title:document.getElementById("doc-name").title,
        windows:(await windows.getAllWindows()).map(w=>w.label),
        focused:await current.isFocused(), notice:document.getElementById("notice").textContent, gutter:!!document.querySelector(".cm-lineNumbers"),
        frozen:document.getElementById("app").inert,
        recent:(await core.invoke("update_history",{change:{kind:"read"}})).paths,
      };
      await write(filename+"."+step+".out.txt",status);
    } catch (error) { await write(filename+"."+step+".out.txt",{error:String(error)}); }
  }
});
