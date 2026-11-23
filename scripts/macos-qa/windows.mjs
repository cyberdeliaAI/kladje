// Native integration test using a uniquely identified copy of Kladje and disposable files.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFileSync, spawn} from "node:child_process";
import {setTimeout as delay} from "node:timers/promises";
import {fileURLToPath} from "node:url";

export async function verifyWindows({app, executable, tmp, id, fixture}) {
  const prefix = path.join(tmp,"result.txt.");
  const data = path.join(os.homedir(),"Library/Application Support",id);
  let run, processId, child, steps;
  const checks = [];
  const wait = async (fn, description, ms = 30000) => {
    const deadline = Date.now()+ms;
    while (Date.now() < deadline) {
      const result = await fn();
      if (result) return result;
      await delay(150);
    }
    throw Error("Timed out waiting for "+description);
  };
  const launch = async (name, args) => {
    run = name;
    steps = new Map();
    fs.writeFileSync(prefix+"run.txt",name);
    child = spawn("/usr/bin/open",["-n","-W","-a",app,"--args",...args]);
    processId = await wait(() => JSON.parse(execFileSync("python3",[
      fileURLToPath(new URL("./rss.py",import.meta.url)), executable],{encoding:"utf8"})).pid, "QA process");
  };
  const command = async (label, value={}) => {
    const step = steps.get(label) || 0;
    steps.set(label,step+1);
    const base = prefix+run+"."+label+"."+step;
    fs.writeFileSync(base+".in.txt",JSON.stringify(value));
    await wait(()=>fs.existsSync(base+".out.txt"),label+" command "+step);
    const result = JSON.parse(fs.readFileSync(base+".out.txt","utf8"));
    assert.ifError(result.error);
    return result;
  };
  const ui = (script, ...args) => execFileSync("osascript",["-e",`on run argv
    tell application "System Events"
      set proc to first application process whose unix id is (item 1 of argv as integer)
      tell proc
        ${script}
      end tell
    end tell
  end run`,String(processId),...args],{encoding:"utf8",timeout:5000}).trim();
  const menu = (parent,item) => ui("set frontmost to true\nclick menu item (item 3 of argv) of menu 1 of menu bar item (item 2 of argv) of menu bar 1",parent,item);
  const quit = () => ui('set frontmost to true\nclick menu item "Quit Kladje" of menu 1 of menu bar item 2 of menu bar 1');
  const answer = async (title, expectedFile) => {
    const result = await wait(()=>ui(`repeat with w in windows
    if exists button (item 2 of argv) of w then
      set detail to value of static texts of w as text
      click button (item 2 of argv) of w
      return "clicked " & detail
    end if
    repeat with s in sheets of w
      if exists button (item 2 of argv) of s then
        set detail to value of static texts of s as text
        click button (item 2 of argv) of s
        return "clicked " & detail
      end if
    end repeat
  end repeat
  return ""`,title),"native "+title+" button");
    if (expectedFile) assert.ok(result.includes("/" + path.basename(tmp) + "/" + path.basename(expectedFile)),
      "The native prompt must identify the document folder and filename");
  };
  const openFiles = (...files) => execFileSync("/usr/bin/open",["-a",app,...files]);
  const ended = () => wait(()=>child.exitCode!==null,"isolated app to exit");
  const sibling = path.join(tmp,"sibling note.md");
  const third = path.join(tmp,"third.md");
  const alias = path.join(tmp,"alias.md");
  fs.writeFileSync(third,"third document"); fs.linkSync(sibling,alias);
  try {
    await launch("first",[fixture]);
    const original = await command("main");
    assert.match(original.text,/# Start/);
    await command("main",{edit:"unsaved first document"});
    openFiles(sibling,third);
    const peers = ["document-1","document-2"];
    const snapshots = await Promise.all(peers.map(p=>command(p)));
    const b = peers[snapshots.findIndex(s=>s.text.includes("# Café"))];
    const c = peers[snapshots.findIndex(s=>s.text==="third document")];
    assert.ok(b && c && b!==c);
    assert.equal((await command("main")).text,"unsaved first document");
    checks.push("Finder opens both files while the dirty source stays intact");
    openFiles(alias);
    await wait(async()=>{ const s=await command(b); return s.focused && s.windows.length===3; },"hard-link owner focus");
    menu("Format","Bold");
    await wait(async()=> (await command(b)).text.includes("****"),"active menu routing");
    assert.equal((await command("main")).text,"unsaved first document");
    assert.equal((await command(c)).text,"third document");
    menu("Edit","Undo");
    await wait(async()=> (await command(b)).text===fs.readFileSync(sibling,"utf8"),"independent Undo");
    checks.push("Hard-link reopen focuses the owner and native Bold and Undo affect only that editor");
    await command(b,{menu:"gutter",wait:150});
    await wait(async()=> (await command("main")).gutter, "shared line-number preference");
    const recent = (await command(b)).recent.map(p=>fs.realpathSync(p));
    assert.ok([fixture,sibling,third].every(p=>recent.includes(fs.realpathSync(p))));
    menu("File","New Tab");
    const tab = (await command("document-3")).windows;
    assert.equal(tab.length,4);
    const nativeTabs = () => ui('return count of radio buttons of tab groups of window 1');
    await wait(()=>Number(nativeTabs()) >= 2, "AppKit tab group");
    menu("Window","Move Tab to New Window");
    await wait(()=>Number(nativeTabs()) < 2, "detached AppKit tab");
    menu("File","Close Window");
    await wait(async()=> (await command("main")).windows.length===3,"detached tab to close");
    checks.push("New Tab creates an AppKit tab and the Window menu detaches it");
    checks.push("Native windows share editor preferences and recent documents");
    openFiles(third);
    await wait(async()=> (await command(c)).focused,"third document focus");
    menu("File","Close Window");
    await wait(async()=> (await command("main")).windows.length===2,"one window to close");
    checks.push("Close removes only the chosen document");
    openFiles(sibling);
    await wait(async()=> (await command(b)).focused,"second document focus");
    await command(b,{edit:"unsaved second document"});
    openFiles(fixture);
    await wait(async()=> (await command("main")).focused, "first document focus");
    const siblingBytes = fs.readFileSync(sibling);
    fs.writeFileSync(sibling,"external edit");
    openFiles(sibling);
    await answer("Keep Edits");
    assert.equal((await command(b)).text,"unsaved second document");
    assert.equal(fs.readFileSync(sibling,"utf8"),"external edit");
    fs.writeFileSync(sibling,siblingBytes);
    checks.push("An external change prompts only its dirty owner and Keep Edits preserves both versions");
    quit();
    await answer("Don't Save",sibling);
    const provisional = await command(b,{edit:"late input must be blocked"});
    assert.equal(provisional.frozen,true);
    assert.equal(provisional.text,"unsaved second document");
    await answer("Cancel",fixture);
    for (const [label,expected] of [["main","unsaved first document"],[b,"unsaved second document"]]) {
      const s = await command(label);
      assert.equal(s.text,expected); assert.equal(s.frozen,false); assert.equal(s.windows.length,2);
    }
    checks.push("Cancelling the second native Quit prompt preserves both dirty documents");
    process.kill(processId,"SIGKILL"); await ended(); processId=null;
    await launch("restart",[]);
    await answer("Restore"); await answer("Restore");
    const restored = await Promise.all(["main","document-1"].map(label=>command(label)));
    assert.deepEqual(restored.map(w=>w.text).sort(),["unsaved first document","unsaved second document"]);
    checks.push("After forced process termination both edited revisions restore in separate windows");
    openFiles(sibling);
    const restoredLabels = ["main","document-1"];
    const siblingOwner = restoredLabels[restored.findIndex(w=>w.text==="unsaved second document")];
    await wait(async()=> (await command(siblingOwner)).focused,"restored hard-link owner");
    quit(); await answer("Save"); await answer("OK");
    await wait(async()=>!(await command(siblingOwner)).frozen,"failed Save to veto Quit");
    assert.equal((await command(siblingOwner)).windows.length,2);
    checks.push("A refused hard-link Save vetoes Quit and keeps both windows");
    openFiles(fixture);
    const firstOwner = restoredLabels.find(label=>label!==siblingOwner);
    await wait(async()=> (await command(firstOwner)).focused,"restored first document");
    quit(); await answer("Save"); await answer("Don't Save"); await ended(); processId=null;
    const saved = [fs.readFileSync(fixture,"utf8"),fs.readFileSync(sibling,"utf8")];
    assert.deepEqual(saved,["unsaved first document",snapshots[peers.indexOf(b)].text]);
    assert.equal(fs.readdirSync(path.join(data,"recovery-v1")).length,0);
    checks.push("Unanimous Quit saves the selected revision and retires both recovery leases");
    await launch("closed-primary",[fixture]);
    await command("main");
    openFiles(third);
    await command("document-1");
    openFiles(fixture);
    await wait(async()=> (await command("main")).focused,"original window focus");
    menu("File","Close Window");
    await wait(async()=> (await command("document-1")).windows.length===1,"original window to close");
    openFiles(sibling,fixture);
    const arrivals = await Promise.all(["document-2","document-3"].map(label=>command(label)));
    assert.deepEqual(arrivals.map(w=>w.text).sort(),saved.slice().sort());
    assert.equal((await command("document-1")).text,"third document");
    quit(); await ended(); processId=null;
    checks.push("Finder still routes a batch after the original window closes");
    console.log(JSON.stringify({checks},null,2));
    fs.rmSync(data,{recursive:true,force:true}); fs.rmSync(tmp,{recursive:true,force:true});
  } finally {
    if (processId && child.exitCode===null) { try {process.kill(processId,"SIGTERM");} catch {} }
  }
}
