// Drive the shipped app through its menu/focus/close entry points. Only the
// native bridge, CodeMirror view and DOM are doubled; I/O gates are explicit.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { EditorSelection } = require("@codemirror/state");
const path = require("node:path");
const source = name => fs.readFileSync(path.join(__dirname, "../ui", name), "utf8");

function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { resolve, promise };
}

async function app(initial = {}, configure = () => {}, drawImage) {
  const ready = gate(), events = {}, calls = [], values = new Map(Object.entries(initial));
  const disk = { path: "/notes/a.md", content: "original", version: { target: "/notes/a.md", digest: "a" } };
  const format = { encoding: "utf8", eol: "lf" };
  disk.format = format;
  let text = "", change;
  const element = () => ({
    scrollTop: 0, scrollHeight: 100, clientHeight: 100, children: [], childNodes: [], dataset: {}, style: { setProperty() {} },
    classList: (() => { const set = new Set(); return { add: (...c) => c.forEach(x => set.add(x)), remove: (...c) => c.forEach(x => set.delete(x)),
      toggle(c, on = !set.has(c)) { if (on) set.add(c); else set.delete(c); return on; }, contains: c => set.has(c) }; })(),
    removeAttribute(k) { delete this.attrs[k]; },
    firstElementChild: {}, content: { childNodes: [], querySelectorAll: () => [] }, append() {}, replaceChildren(...nodes) { this.children = nodes; }, show() { this.open = true; }, showModal() { this.open = true; }, close() { this.open = false; },
    attrs: {}, handlers: {}, setSelectionRange(from, to) { this.selection = [from, to]; }, setAttribute(k,v) { this.attrs[k]=v; }, getAttribute(k) { return this.attrs[k]; }, focus() {}, scrollIntoView() {},
    addEventListener(k,f) { this.handlers[k]=f; }, querySelector: () => null, querySelectorAll: () => [], getBoundingClientRect: () => ({ top: 0 }),
  });
  const rendered = [], comparisons = [];
  // A test can make a preview update cost main-thread time and supply the parsed blocks.
  const clock = { skew: 0 }, hooks = { patchMs: () => 0, parse: () => [] };
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const view = {
    setFrozen() {}, selection: () => EditorSelection.single(0), textLength: () => text.length, location: () => ({offset:0,top:1}), restored:[], restoreLocation(p) {this.restored.push(p.offset);}, setPairing() {}, setWritingModes() {}, pasteUrl() { return false; }, configureLayout() {}, statistics: () => ({words: 1, characters: text.length}),
    getText: () => text, setText(v) { text = v; }, replaceText(v) { text = v; change(); },
    insertImage(relative) { text += " IMAGE " + relative; change(); },
    cursor: () => ({ line: 1, column: 1, lines: 1 }), scroller: element(), remeasure() {}, focus() {},
  };
  let history;
  const children = [];
  let nativeSettings = {}, prefRevision = 0;
  const api = {
    read_preferences({seed}) {nativeSettings = {...seed}; return {revision:prefRevision, values:{...nativeSettings}};},
    set_preference({key,value}) {nativeSettings[key]=value; return {revision:++prefRevision,values:{...nativeSettings}};},
    file_stamp: () => disk.version && {target:disk.path, change:disk.version.digest},
    take_fragment() {}, document_ready() {}, accept_reload() {}, begin_close:()=>true, cancel_close() {},
    diagram_sources: () => [], store_diagrams() {},
    update_history({change,seed}) {
      history ||= structuredClone(seed);
      if (change.kind === "touch" && change.resume) history.lastPath = change.path;
      if (change.kind === "touch") history.paths = [change.path,...history.paths.filter(p=>p!==change.path)].slice(0,10);
      if (change.kind === "remove") history.paths = history.paths.filter(p=>p!==change.path);
      if (change.kind === "clear") history = {paths:[],places:[]};
      if (change.kind === "position") history.places = [change.place,...history.places.filter(p=>p.path!==change.place.path)];
      history.places = history.places.filter(p=>history.paths.includes(p.path));
      return structuredClone(history);
    },
    async open_document_window({request}) {
      let launch = request;
      if (request.kind === "open" || request.kind === "template") {
        const file = await api.read_file(request);
        launch = request.kind === "open" ? {...request,file} : {...request,content:file.content};
      }
      children.push(await app(Object.fromEntries(values), child => {
        child.api.setup = () => ({launch});
        child.api.update_history = api.update_history;
      }));
    },
    quit_vote({allow,epoch}) { if (!allow) events["cancel-quit"]({payload:epoch}); },
    window_bounds: () => null, set_menu_checks() {}, sync_document_icon() {},
    setup: () => ({ pendingOpen: disk.path }), take_pending_open: () => null, read_file: () => ({ ...disk }),
    file_version: () => disk.version, render: () => "", log_message: ({ message }) => { if (message === "ready") ready.resolve(); },
    recovery_list: () => [], recovery_clear() {}, recovery_write() {},
    write_file: ({content}) => { disk.content = content; return {version: disk.version, confirmed: true}; }, quit() { return events["prepare-quit"]({payload:{epoch:1,rememberWindow:true}}); },
  };
  const dialog = { message: () => "Cancel", ask: () => false };
  configure({ api, dialog, disk });
  const pendingTimers = new Map();
  let nextTimer = 0;
  const nativeWindow = { label:"main", setTitle: async () => {}, onCloseRequested: cb => { events.close = cb; }, destroy: async () => { calls.push(["destroy"]); } };
  const win = {
    KladjeEditor: { create(_, options) { change = options.onChange; return view; },
      // Stands in for the bundled comparison. Line-based, which is enough for these flows.
      changedSections(mine, disk) {
        const a = mine.split("\n"), b = disk.split("\n");
        let count = 0, inside = false;
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
          if (a[i] !== b[i]) { if (!inside) count++; inside = true; } else inside = false;
        }
        return count;
      },
      compare(parent, mine, disk) {
        const shown = {parent, mine, disk, moves: [], destroyed: false,
          next() { this.moves.push("next"); }, previous() { this.moves.push("previous"); }, destroy() { this.destroyed = true; }};
        comparisons.push(shown);
        return shown;
      } },
    addEventListener: (name, cb) => { events[name] = cb; }, matchMedia: () => ({ addEventListener() {} }),
    __TAURI__: { core: { invoke: async (name, args = {}) => { calls.push([name, args]); return api[name](args); } },
      dialog, window: { getCurrentWindow: () => nativeWindow }, event: { listen: (name, cb) => { events[name] = cb; } },
      webview: { getCurrentWebview: () => ({onDragDropEvent: cb => { events.drop = cb; }}) } },
  };
  const context = vm.createContext({ window: win, document: { getElementById: get, documentElement: element(), createElement(tag) {
    const node = element();
    if (tag === "template") Object.defineProperty(node, "innerHTML", {set(html) {
      rendered.push(html);
      clock.skew += hooks.patchMs(html);
      node.content.childNodes = hooks.parse(html);
    }});
    return node;
  }, fonts: { ready: Promise.resolve() } },
    FileReader: class { readAsDataURL(file) { this.result = "data:" + file.type + ";base64," + file.encoded; this.onload(); } },
    getComputedStyle: () => ({lineHeight:"18px"}), performance: { now: () => performance.now() + clock.skew }, Intl,
    requestAnimationFrame: fn => setImmediate(fn), crypto: require("node:crypto").webcrypto, console, clearTimeout: id => pendingTimers.delete(id),
    setTimeout(fn, delay) { pendingTimers.set(++nextTimer, {fn, delay}); return nextTimer; },
    localStorage: { getItem: k => values.get(k), setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) } });
  vm.runInContext(source("document-session.js"),context);
  if (drawImage) context.KladjeDiagrams = { create: () => ({image:drawImage}) };
  else vm.runInContext(source("diagrams.js"),context);
  vm.runInContext(source("preferences.js"),context);
  vm.runInContext(source("app.js"),context);
  await ready.promise;
  async function fire(delay, callback = null) {
    const entry = [...pendingTimers].find(([, timer]) => {
      if (callback) return timer.fn.name === callback;
      if (timer.fn.name === "pollDisk") return false;
      return typeof delay === "function" ? delay(timer.delay) : timer.delay === delay;
    });
    assert.ok(entry, `no pending timer at ${delay} ms`);
    pendingTimers.delete(entry[0]);
    return entry[1].fn();
  }
  const pending = delay => [...pendingTimers.values()].some(timer => timer.fn.name !== "pollDisk" && timer.delay === delay);
  return { settings: () => nativeSettings, comparisons, children, history:()=>history, disk, api, calls, dialog, events, get, values, fire, pending, hooks, clock, rendered, view, pollDisk: () => fire(null,"pollDisk"), menu: id => events.menu({payload: id}), edit: v => view.replaceText(v), text: view.getText };
}

test("actual Save and Quit wait for outstanding I/O and retain later edits", async () => {
  const a = await app(), started = gate(), finish = gate();
  a.api.write_file = async ({content}) => { started.resolve(); await finish.promise; a.disk.content = content; return {version: a.disk.version, confirmed: true}; };
  a.edit("A");
  const first = a.menu("save");
  await started.promise;
  a.edit("B");
  const quit = a.menu("quit");
  finish.resolve();
  await Promise.all([first, quit]);
  assert.equal(a.disk.content, "A");
  assert.equal(a.text(), "B");
  assert.equal(a.calls.findLast(([name]) => name === "quit_vote")[1].allow, false);
  assert.ok(a.get("doc-name").title.includes("edited"));
});

test("focus reload cannot replace input that arrives during the disk read", async () => {
  const a = await app(), started = gate(), finish = gate();
  a.disk.version = {target: a.disk.path, digest: "b"};
  a.api.read_file = async () => { started.resolve(); await finish.promise; return {...a.disk, content:"external"}; };
  const pending = a.events.focus();
  await started.promise;
  a.edit("local");
  finish.resolve();
  await pending;
  assert.equal(a.text(), "local");
  assert.match(a.get("notice").textContent, /editing/);
});

test("keeping local edits retains the original disk baseline on the next Save", async () => {
  const a = await app();
  const originalVersion = a.disk.version;
  a.edit("local"); a.disk.version = {target: a.disk.path, digest:"new"}; a.disk.content = "external";
  await a.events.focus();
  a.api.write_file = ({expected}) => { assert.deepEqual(expected, originalVersion); throw Error("conflict"); };
  await a.menu("save");
  assert.equal(a.disk.content,"external");
  assert.equal(a.text(),"local");
  await a.menu("quit");
  assert.equal(a.calls.findLast(([name]) => name === "quit_vote")[1].allow, false);
});

test("rapid Saves write in order before the requested window close", async () => {
  const a = await app();
  const writing = gate(), finish = gate();
  const writes = [];
  a.api.write_file = async ({ content }) => {
    writes.push(content);
    if (content === "A") {
      writing.resolve();
      await finish.promise;
    }
    a.disk.content = content;
    return { version: a.disk.version, confirmed: true };
  };
  a.edit("A");
  const first = a.menu("save");
  await writing.promise;
  a.edit("B");
  const second = a.menu("save");
  let prevented = false;
  const close = a.events.close({ preventDefault() { prevented = true; } });
  assert.ok(prevented);
  assert.deepEqual(writes, ["A"]);
  assert.ok(!a.calls.some(([name]) => name === "destroy"));
  finish.resolve();
  await Promise.all([first, second, close]);
  assert.deepEqual(writes, ["A", "B"]);
  assert.equal(a.disk.content, "B");
  assert.ok(a.calls.some(([name]) => name === "destroy"));
});

test("an unsupported drop leaves the dirty editor and its draft in place", async () => {
  const a = await app();
  const dialogs = [];
  a.dialog.message = (_, options) => { dialogs.push(options.title); return "Don't Save"; };
  a.api.insert_image = () => { throw Error("Unsupported image"); };
  a.edit("private draft");
  await a.fire(900);
  await a.events.drop({ payload: { type: "drop", paths: ["/notes/image.png"] } });
  assert.deepEqual(dialogs, ["Kladje"]);
  assert.equal(a.text(), "private draft");
  assert.equal(a.calls.filter(([name]) => name === "recovery_clear").length, 0);
});

test("Save As asks about encoding, cancellation preserves the original binding", async () => {
  const a = await app({}, ({ disk }) => { disk.format.encoding = "latin1"; });
  const copy = "/notes/copy.md", saved = [];
  a.dialog.save = () => copy;
  a.api.file_version = () => null;
  a.api.write_file = args => {
    saved.push(args);
    return { version: {target: copy, digest: "copy"}, confirmed: true };
  };
  a.edit("漢字");
  await a.menu("save_as");
  assert.equal(saved.length, 0);
  assert.equal(a.history().lastPath, a.disk.path);
  a.dialog.ask = (_, {title}) => title === "Encoding conversion";
  await a.menu("save_as");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].format.encoding, "utf8");
  assert.equal(saved[0].expected, null);
  assert.equal(a.disk.content, "original");
  assert.equal(a.history().lastPath, copy);
  assert.equal(a.get("notice").textContent, "Saved");
  a.edit("next");
  assert.notEqual(a.get("notice").textContent, "Saved");
});

test("a recovered draft resumes its revision and survives another snapshot failure", async () => {
  const a = await app({}, ({api, dialog, disk}) => {
    const draft = { ...disk, name: "a.md", id: "0123456789abcdef0123456789abcdef", revision: 9, time: 1, content: "unsaved" };
    api.recovery_list = () => [draft];
    api.recovery_claim = () => draft;
    dialog.message = () => "Restore";
  });
  assert.equal(a.text(), "unsaved");
  assert.match(a.get("doc-name").title, /edited/);
  assert.match(a.get("doc-name").firstElementChild.textContent, /recovered/);
  assert.ok(!a.calls.some(([name]) => name === "recovery_write"));
  a.api.recovery_write = () => { throw Error("disk full"); };
  a.edit("newer");
  await a.fire(5000);
  assert.match(a.get("notice").textContent, /disk full/);
  const writes = () => a.calls.filter(([name]) => name === "recovery_write");
  assert.equal(writes()[0][1].draft.revision, 10);
  assert.ok(!a.calls.some(([name]) => name === "recovery_clear"));
  a.api.recovery_write = () => {};
  await a.fire(5000);
  assert.equal(writes()[1][1].draft.content, "newer");
});

test("failed legacy migration keeps the last browser copy", async () => {
  const key = "kladje.recovery";
  const previous = JSON.stringify({name: "legacy", content: "my draft", path: "/notes/old.md"});
  const a = await app({[key]: previous}, ({api, dialog}) => {
    dialog.message = () => "Restore";
    api.recovery_write = () => { throw Error("disk full"); };
  });
  assert.equal(a.values.get(key), previous);
  const [, {draft}] = a.calls.find(([name]) => name === "recovery_write");
  assert.equal(draft.path, null);
  assert.equal(draft.content, "my draft");
});

test("an unconfirmed commit keeps recovery and requires a decision before closing", async () => {
  const a = await app();
  a.api.write_file = () => ({version: a.disk.version, confirmed: false, warning: "Directory flush failed"});
  a.edit("my edits");
  await a.menu("save");
  assert.match(a.get("doc-name").title, /edited/);
  assert.match(a.get("notice").textContent, /unconfirmed/);
  await a.events.close({preventDefault() {}});
  assert.ok(a.calls.some(([name, args]) => name === "recovery_write" && args.draft.content === "my edits"));
  assert.ok(!a.calls.some(([name]) => name === "destroy" || name === "recovery_clear"));
});

test("Undo to the old disk text during a pending Save still snapshots that text", async () => {
  const a = await app(), started = gate(), finish = gate();
  a.api.write_file = async ({content}) => {
    started.resolve();
    await finish.promise;
    a.disk.content = content;
    return {version: a.disk.version, confirmed: true};
  };
  a.edit("revision A");
  const save = a.menu("save");
  await started.promise;
  a.edit("original");
  await a.fire(900);
  assert.ok(a.calls.some(([name, args]) => name === "recovery_write" && args.draft.content === "original"));
  finish.resolve();
  await save;
  assert.equal(a.disk.content, "revision A");
  assert.equal(a.text(), "original");
  assert.match(a.get("doc-name").title, /edited/);
});

test("mixed ending normalization needs consent after the number of lines changes", async () => {
  const a = await app({}, ({disk}) => {
    disk.content = "a\r\nb\nc";
    disk.format = {encoding: "utf8bom", eol: "mixed", separators: "wn"};
  });
  a.edit("a\nb\nc\nd");
  await a.menu("save");
  assert.ok(!a.calls.some(([name]) => name === "write_file"));
  a.dialog.ask = (_, options) => options.title === "Line-ending conversion";
  await a.menu("save");
  const [, {format}] = a.calls.find(([name]) => name === "write_file");
  assert.equal(format.eol, "lf");
  assert.equal(format.encoding, "utf8bom");
});

test("clean external reload adopts the new baseline and Keep Edits remembers only that version", async () => {
  const a = await app();
  a.disk.content = "update";
  a.disk.version = {target: a.disk.path, digest: "one"};
  await a.events.focus();
  assert.equal(a.text(), "update");
  assert.doesNotMatch(a.get("doc-name").title, /edited/);
  let prompts = 0;
  a.dialog.ask = () => { prompts++; return false; };
  a.edit("local");
  a.disk.version = {target: a.disk.path, digest: "two"};
  await a.events.focus();
  await a.events.focus();
  assert.equal(prompts, 1);
  a.disk.version = {target: a.disk.path, digest: "three"};
  await a.events.focus();
  assert.equal(prompts, 2);
  assert.equal(a.text(), "local");
});

test("the active window reloads without refocusing and idle probes do not read file contents", async () => {
  const a = await app();
  await a.pollDisk();
  const count = cmd => a.calls.filter(([name]) => name === cmd).length;
  const reads = count("file_version");
  await a.pollDisk();
  assert.equal(count("file_version"), reads);
  a.disk.content = "external"; a.disk.version = {target:a.disk.path, digest:"external"};
  await a.pollDisk();
  assert.equal(a.text(), "external");
  assert.doesNotMatch(a.get("doc-name").title, /edited/);
  await a.pollDisk();
  assert.equal(count("file_version"), reads + 1);
  await a.events.focus();
  assert.equal(count("file_version"), reads + 2);
});

test("automatic conflict detection pauses autosave and keeps each disk version and local draft", async () => {
  const a = await app({"kladje.autosave":"true"});
  await a.pollDisk();
  a.edit("local");
  a.disk.content = "external"; a.disk.version = {target:a.disk.path, digest:"external"};
  let prompts = 0;
  a.dialog.ask = () => { prompts++; return false; };
  await a.pollDisk();
  await a.fire(2000);
  await a.pollDisk();
  await a.events.blur();
  assert.equal(prompts, 1);
  assert.equal(writes(a), 0);
  assert.equal(a.disk.content, "external");
  assert.equal(a.text(), "local");
  await a.fire(900);
  assert.ok(a.calls.some(([cmd,args]) => cmd === "recovery_write" && args.draft.content === "local"));
});

test("a late edit during automatic reload is retained and the same change is retried", async () => {
  const a = await app(), started = gate(), done = gate();
  await a.pollDisk();
  a.disk.version = {target:a.disk.path, digest:"external"};
  a.api.read_file = async () => { started.resolve(); await done.promise; return {...a.disk,content:"external"}; };
  const poll = a.pollDisk();
  await started.promise;
  a.edit("late keystroke");
  done.resolve(); await poll;
  assert.equal(a.text(), "late keystroke");
  let asked = 0;
  a.dialog.ask = () => { asked++; return false; };
  await a.pollDisk();
  assert.equal(asked, 1);
  assert.equal(a.text(), "late keystroke");
});

test("a disappearing file keeps its recoverable text and reappearance is detected", async () => {
  const a = await app();
  await a.pollDisk();
  a.disk.version = null;
  await a.pollDisk();
  assert.match(a.get("notice").textContent,/moved or deleted/);
  assert.equal(a.text(), "original");
  await a.pollDisk();
  assert.equal(a.calls.filter(([name]) => name === "file_version").length, 2);
  a.disk.content = "returned"; a.disk.version = {target:a.disk.path, digest:"returned"};
  a.dialog.ask = () => true;
  await a.pollDisk();
  assert.equal(a.text(), "returned");
  assert.doesNotMatch(a.get("doc-name").title, /edited/);
});

test("focus detects a digest change hidden by coarse file timestamps and retries on late typing", async () => {
  const a = await app();
  a.api.file_stamp = () => ({target:a.disk.path, change:"constant"});
  await a.pollDisk();
  a.disk.version = {target:a.disk.path, digest:"changed"};
  const started = gate(), done = gate();
  a.api.read_file = async () => { started.resolve(); await done.promise; return {...a.disk,content:"external"}; };
  const focus = a.events.focus();
  await started.promise;
  a.edit("working"); done.resolve(); await focus;
  let prompts = 0;
  a.dialog.ask = () => { prompts++; return false; };
  await a.pollDisk();
  assert.equal(prompts, 1);
  assert.equal(a.text(),"working");
});

test("a failed disk probe backs off on idle ticks and can be retried on focus", async () => {
  const a = await app();
  let probes = 0;
  a.api.file_stamp = () => { probes++; throw Error("volume offline"); };
  await a.pollDisk(); await a.pollDisk();
  assert.equal(probes, 1);
  assert.match(a.get("notice").textContent,/volume offline/);
  a.api.file_stamp = () => ({target:a.disk.path, change:"back"});
  a.disk.version = {target:a.disk.path, digest:"back"}; a.disk.content = "back online";
  await a.events.focus();
  assert.equal(a.text(),"back online");
});

test("image drops preserve the document binding and require consent before copying", async () => {
  const a = await app();
  a.edit("working text");
  a.api.insert_image = ({copy}) => copy ? "image-2.png" : null;
  const drop = () => a.events.drop({payload: {type: "drop", paths: ["/elsewhere/art.png"]}});
  await drop();
  assert.equal(a.text(), "working text");
  a.dialog.ask = () => true;
  await drop();
  assert.match(a.text(), /working text IMAGE image-2.png/);
  const requests = a.calls.filter(([name]) => name === "insert_image").map(([,args]) => args);
  assert.deepEqual(requests.map(args => args.copy), [false,false,true]);
  assert.ok(requests.every(args => args.source === a.disk.path));
  assert.equal(a.disk.content, "original");
});

test("remote image consent expires when another document opens", async () => {
  const a = await app();
  a.dialog.ask = () => true;
  await a.menu("remote_images");
  assert.ok(a.calls.some(([name,args]) => name === "render" && args.remote));
  a.dialog.open = () => "/notes/next.md";
  a.api.read_file = () => ({...a.disk, path: "/notes/next.md", content: "second"});
  await a.menu("open");
  const latest = a.children[0].calls.filter(([name]) => name === "render").at(-1)[1];
  assert.equal(latest.remote,false);
  assert.equal(latest.source,"/notes/next.md");
});

test("one line-break preference reaches the preview, HTML export and formatted copy", async () => {
  const a = await app();
  const last = name => a.calls.filter(([cmd]) => cmd === name).at(-1)[1];
  assert.equal(a.get("lineBreaks").checked, true);
  assert.equal(last("render").lineBreaks, true);
  const renders = a.calls.filter(([cmd]) => cmd === "render").length;
  await a.menu("settings");
  a.get("lineBreaks").checked = false;
  await a.get("lineBreaks").handlers.change();
  a.get("settings").close();
  await new Promise(setImmediate);
  assert.equal(a.settings().lineBreaks, false);
  assert.equal(a.calls.filter(([cmd]) => cmd === "render").length, renders + 1);
  assert.equal(last("render").lineBreaks, false);
  a.dialog.save = () => "/notes/a.html";
  a.api.file_version = () => null;
  a.api.export_html = () => ({confirmed: true});
  await a.menu("export_html");
  assert.equal(last("export_html").lineBreaks, false);
  a.view.selectedText = () => "one\ntwo";
  a.api.formatted_selection = () => "";
  await a.menu("copy_formatted");
  assert.equal(last("formatted_selection").lineBreaks, false);
  const reopened = await app({}, ({api}) => {
    api.read_preferences = () => ({revision: 1, values: a.settings()});
  });
  assert.equal(reopened.get("lineBreaks").checked, false);
  const render = reopened.calls.find(([cmd]) => cmd === "render");
  assert.equal(render[1].lineBreaks, false);
});

test("a preview failure leaves edited text available for Save", async () => {
  const a = await app();
  a.api.render = () => { throw Error("Renderer unavailable"); };
  a.edit("unsaved revision");
  await a.menu("view_split");
  await new Promise(resolve => setImmediate(resolve));
  assert.match(a.get("preview").textContent, /Preview unavailable/);
  assert.equal(a.text(), "unsaved revision");
  assert.equal(a.disk.content, "original");
  await a.menu("save");
  assert.equal(a.disk.content, "unsaved revision");
});

test("a delayed preview cannot replace a newer revision", async () => {
  const a = await app(), started = gate(), finish = gate();
  a.api.render = async ({markdown}) => {
    if (markdown === "earlier") {
      started.resolve();
      await finish.promise;
    }
    return markdown;
  };
  a.edit("earlier");
  await a.menu("view_split");
  await started.promise;
  a.edit("latest");
  finish.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(!a.rendered.includes("earlier"));
  assert.equal(a.rendered.at(-1), "latest");
  assert.equal(a.text(), "latest");
});

test("cancelling image insertion into an untitled draft preserves the draft", async () => {
  const parent = await app();
  await parent.menu("new");
  const a = parent.children[0];
  a.edit("untitled work");
  const before = a.calls.length;
  a.dialog.ask = () => false;
  await a.menu("insert_image");
  assert.equal(a.text(), "untitled work");
  assert.ok(!a.calls.slice(before).some(([name]) => ["insert_image","write_file","recovery_clear"].includes(name)));
});

test("startup drains Finder documents delivered before event registration in order", async () => {
  const paths = ["/notes/two.md", "/notes/three.md"];
  const a = await app({}, ({api, disk}) => {
    api.take_pending_open = () => paths.shift() || null;
    api.read_file = ({path}) => ({...disk, path, content: path});
  });
  assert.equal(a.text(), a.disk.path);
  assert.deepEqual(a.children.map(w=>w.text()), ["/notes/two.md", "/notes/three.md"]);
});

test("a failed obsolete render cannot hide a newer preview", async () => {
  const a = await app(), started = gate(), finish = gate();
  a.api.render = async ({markdown}) => {
    if (markdown === "earlier") {
      started.resolve();
      await finish.promise;
      throw Error("Obsolete render failed");
    }
    return markdown;
  };
  a.edit("earlier");
  await a.menu("view_split");
  await started.promise;
  a.edit("latest");
  finish.resolve();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(a.rendered.at(-1), "latest");
});

test("print annotations use external destinations and leave local document paths out", async () => {
  const a = await app();
  const links = ["https://example.com", "mailto:editor@example.org", "#part", "sibling.md"].map(destination => ({
    dataset: {destination}, href: "#",
    setAttribute(_, value) { this.href = value; },
    removeAttribute() { this.href = null; },
  }));
  a.get("preview").querySelectorAll = selector => selector.startsWith("a[") ? links : [];
  a.events.beforeprint();
  assert.deepEqual(links.map(link => link.href), ["https://example.com", "mailto:editor@example.org", "#part", null]);
  a.events.afterprint();
  assert.ok(links.every(link => link.href === "#"));
});

test("HTML export hands over the diagrams it could draw and exports the rest as source", async () => {
  const a = await app();
  a.edit("```mermaid\ngraph TD\n```");
  a.dialog.save = () => "/notes/a.html";
  a.api.file_version = () => null;
  a.api.diagram_sources = ({markdown}) => { assert.match(markdown, /graph TD/); return ["graph TD\n", "broken\n"]; };
  a.api.export_html = () => ({confirmed: true});
  // No engine is installed in this harness, so nothing can be drawn.
  await a.menu("export_html");
  assert.ok(!a.calls.some(([cmd]) => cmd === "store_diagrams"));
  assert.ok(a.calls.some(([cmd]) => cmd === "export_html"));
  assert.match(a.get("notice").textContent, /Exported a\.html/);
});

test("recent documents deduplicate, cap at ten, and clear paths and saved positions", async () => {
  const a = await app({"kladje.recent": JSON.stringify(["/notes/old.md", "/notes/old.md", null])});
  a.api.read_file = ({path}) => ({...a.disk, path, content:path});
  for (let i = 0; i < 12; i++) {
    a.dialog.open = () => "/notes/" + i + ".md";
    await a.menu("open");
  }
  await a.menu("recent:/notes/4.md");
  const paths = a.history().paths;
  assert.equal(paths.length,10);
  assert.equal(paths[0],"/notes/4.md");
  assert.equal(new Set(paths).size,10);
  a.edit("still editing");
  await a.menu("clear_recent");
  for (const key of ["recent","places","lastPath"]) assert.equal(a.values.has("kladje."+key), false);
  assert.equal(a.text(),"still editing");
  await a.menu("save");
  assert.equal(a.disk.content, "still editing");
  const restarted = await app(Object.fromEntries(a.values), ({api}) => { api.setup = () => ({}); });
  assert.equal(restarted.text(), "");
  assert.equal(restarted.values.has("kladje.recent"), false);
});

test("Quick Open deduplicates and filters saved documents and focuses open drafts", async () => {
  const a = await app({"kladje.recent": JSON.stringify(["/drafts/notes.md", "/work/notes.md"])}, ({api}) => {
    api.open_documents = () => [
      {label:"document-1", path:"/work/notes.md", title:"notes.md — Kladje"},
      {label:"document-2", path:null, title:"• Untitled — Kladje"},
      {label:"main", path:"/notes/a.md", title:"a.md — Kladje"},
    ];
  });
  a.api.open_document_window = () => {};
  await a.menu("quick_open");
  const results = a.get("quick-open-results");
  const filter = a.get("quick-open-filter");
  const submit = () => a.get("quick-open-form").handlers.submit({preventDefault() {}});
  assert.equal(results.children.length, 4);

  filter.value = "NOTES WORK";
  filter.handlers.input();
  assert.equal(results.children.length, 1);
  await submit();
  assert.equal(a.calls.findLast(([cmd]) => cmd === "open_document_window")[1].request.label, "document-1");

  await a.menu("quick_open");
  filter.handlers.keydown({key:"ArrowDown", preventDefault() {}});
  filter.handlers.keydown({key:"ArrowDown", preventDefault() {}});
  assert.equal(filter.getAttribute("aria-activedescendant"), "quick-open-result-2");
  await submit();
  assert.equal(a.calls.findLast(([cmd]) => cmd === "open_document_window")[1].request.label, "document-2");

  await a.menu("quick_open");
  filter.value = "drafts";
  filter.handlers.input();
  await submit();
  assert.equal(a.calls.findLast(([cmd]) => cmd === "open_document_window")[1].request.path, "/drafts/notes.md");
});

test("the Focus Mode menu and settings share the same preference and keep typewriter independent", async () => {
  const a = await app({"kladje.typewriter":"true"});
  await a.menu("focus_mode");
  assert.equal(a.get("focusParagraph").checked, true);
  assert.equal(a.get("editor-pane").dataset.focusParagraph, "true");
  assert.equal(a.settings().focusParagraph, true);
  assert.ok(a.calls.some(([cmd, args]) => cmd === "set_menu_checks" && args.checked.includes("focus_mode")));
  a.get("focusParagraph").checked = false;
  a.get("focusParagraph").handlers.change();
  await a.menu("settings");
  assert.equal(a.settings().focusParagraph, false);
  assert.equal(a.get("editor-pane").dataset.focusParagraph, "false");
  assert.equal(a.get("editor-pane").dataset.typewriter, "true");
  assert.ok(!a.calls.findLast(([cmd]) => cmd === "set_menu_checks")[1].checked.includes("focus_mode"));
});

test("Quick Open previews the selected file and ignores a slower previous response", async () => {
  const older = gate();
  const second = "<h1>Second document</h1>";
  const a = await app({"kladje.recent": JSON.stringify(["/notes/b.md"])}, ({api}) => {
    api.open_documents = () => [{label:"main", path:"/notes/a.md", title:"a.md — Kladje"}];
    api.quick_open_preview = ({path}) => path === "/notes/a.md" ? older.promise : {html:second,truncated:false};
  });
  await a.menu("quick_open");
  const firstPreview = a.fire(100);
  a.get("quick-open-results").children[1].handlers.click();
  await a.fire(100);
  const count = a.rendered.length;
  assert.equal(a.rendered.at(-1), second);
  assert.ok(a.get("quick-open").open);
  assert.ok(!a.calls.some(([cmd]) => cmd === "open_document_window"));

  older.resolve({html:"<h1>First document</h1>",truncated:false});
  await firstPreview;
  assert.equal(a.rendered.length, count);
  assert.equal(a.rendered.at(-1), second);
});

test("a missing recent file and a cancelled Locate keep dirty work and recovery", async () => {
  const path = "/missing/note.md";
  const a = await app({"kladje.recent": JSON.stringify([path])});
  a.edit("unsaved text");
  a.api.read_file = () => {throw Error("missing");};
  a.api.file_version = () => null;
  a.dialog.message = () => "Locate…";
  a.dialog.open = () => null;
  await a.menu("recent:"+path);
  assert.ok(a.history().paths.includes(path));
  a.dialog.message = () => "Remove from Recent";
  await a.menu("recent:"+path);
  assert.ok(!a.history().paths.includes(path));
  assert.equal(a.text(),"unsaved text");
  assert.equal(a.disk.content,"original");
});

test("Open Recent respects Cancel and only a confirmed Save As adds its new path", async () => {
  const a = await app({"kladje.recent": JSON.stringify(["/notes/b.md"])});
  a.api.read_file = ({path}) => ({...a.disk,path,content:"B"});
  a.edit("A changed");
  await a.menu("recent:/notes/b.md");
  assert.equal(a.text(),"A changed");
  a.dialog.save = () => "/notes/c.md"; a.api.file_version = () => null;
  await a.menu("save_as");
  assert.equal(a.history().paths[0],"/notes/c.md");
});

test("invalid preferences fall back and toggles update storage and native checkmarks", async () => {
  const a = await app({"kladje.zoom":'"invalid"', "kladje.split":"null", "kladje.wrap":'"no"', "kladje.gutter":"{}"});
  await new Promise(setImmediate);
  assert.equal(JSON.stringify(a.settings().zoom), "1");
  await new Promise(setImmediate);
  assert.ok(a.settings().split == null || a.settings().split === 50);
  await a.menu("gutter"); await a.menu("wrap");
  await new Promise(done => setImmediate(done));
  await new Promise(setImmediate);
  assert.equal(JSON.stringify(a.settings().gutter), "true");
  await new Promise(setImmediate);
  assert.equal(JSON.stringify(a.settings().wrap), "false");
  const last=a.calls.filter(([cmd]) => cmd==="set_menu_checks").at(-1)[1].checked;
  assert.ok(last.includes("gutter") && !last.includes("wrap"));
});

test("Close records the clean document position, and a new window restores only a matching digest", async () => {
  const a = await app();
  a.view.location = () => ({offset:4, top:2});
  await a.menu("close_window");
  const {places} = a.history();
  assert.equal(places[0].offset,4);
  for (const [digest, expected] of [["a",[4]], ["changed",[]]]) {
    const w = await app({"kladje.places":JSON.stringify(places)}, ({disk}) => { disk.version.digest = digest; });
    assert.deepEqual(w.view.restored,expected);
  }
});

test("heading search pages through repeated titles and filtering resets the page", async () => {
  const a = await app();
  a.api.document_headings = () => Array.from({length: 120}, (_, i) => ({level: 2, line: i + 1, text: i === 119 ? "Last" : "Repeated"}));
  await a.menu("jump_heading");
  assert.equal(a.get("heading-list").children.length, 100);
  a.get("heading-next").handlers.click();
  assert.equal(a.get("heading-list").children[0].dataset.line, "101");
  a.get("heading-filter").value = "last";
  a.get("heading-filter").handlers.input();
  assert.equal(a.get("heading-list").children[0].dataset.line, "120");
  assert.equal(a.get("heading-pages").hidden, true);
});

test("the outline indents by level, numbers only repeated titles, follows the cursor and jumps on one click", async () => {
  const a = await app();
  let line = 1, went;
  a.view.cursor = () => ({line, column: 1, lines: 9});
  a.view.goToLine = value => { went = value; };
  a.api.document_headings = () => [
    {level: 2, line: 2, text: "Intro"}, {level: 3, line: 4, text: "Detail"},
    {level: 2, line: 6, text: "Notes"}, {level: 3, line: 8, text: "Detail"},
  ];
  await a.menu("document_outline");
  assert.equal(a.get("outline-toggle").attrs["aria-pressed"], "true");
  const list = a.get("heading-list");
  const rows = () => list.children;
  const key = (k, extra = {}) => list.handlers.keydown({key: k, preventDefault() {}, ...extra});
  const on = (row, part) => ({target: {closest: selector => selector === ".heading-row" ? row : selector === ".heading-toggle" && part === "toggle" ? {} : null}});
  assert.deepEqual(rows().map(o => o.attrs["aria-label"]), ["Intro", "Detail, line 4", "Notes", "Detail, line 8"]);
  assert.deepEqual(rows().map(o => o.attrs["aria-level"]), ["1", "2", "1", "2"]);
  assert.equal(rows()[1].title, "Heading level 3 · line 4");
  assert.equal(rows()[0].attrs["aria-expanded"], "true");
  assert.equal(rows()[1].attrs["aria-expanded"], undefined);
  // Above the first heading nothing is marked or selected, so Enter goes nowhere.
  assert.equal(list.attrs["aria-activedescendant"], undefined);
  assert.ok(!rows().some(o => o.classList.contains("current")));
  await key("Enter");
  assert.equal(went, undefined);
  // Further down, the enclosing section is marked and selected.
  line = 7;
  a.get("heading-filter").value = "";
  a.get("heading-filter").handlers.input();
  assert.ok(rows()[2].classList.contains("current"));
  assert.equal(rows()[2].attrs["aria-selected"], "true");
  assert.equal(list.attrs["aria-activedescendant"], rows()[2].id);
  // Arrow keys move the selection and Enter jumps to it.
  await key("ArrowDown");
  await key("Enter");
  assert.equal(went, 8);
  // Collapsing a heading hides its subheadings, with the mouse or the keyboard.
  await list.handlers.click(on(rows()[0], "toggle"));
  assert.deepEqual(rows().map(o => o.attrs["aria-label"]), ["Intro", "Notes", "Detail, line 8"]);
  assert.equal(rows()[0].attrs["aria-expanded"], "false");
  assert.equal(list.attrs["aria-activedescendant"], rows()[0].id);
  await key("ArrowRight");
  assert.equal(rows().length, 4);
  await key("ArrowRight");
  assert.equal(list.attrs["aria-activedescendant"], rows()[1].id);
  await key("ArrowLeft");
  assert.equal(list.attrs["aria-activedescendant"], rows()[0].id);
  await key("ArrowLeft");
  assert.equal(rows().length, 3);
  // A filter lists every match flat, without collapsing, and selects the first.
  a.get("heading-filter").value = "detail";
  a.get("heading-filter").handlers.input();
  assert.deepEqual(rows().map(o => o.attrs["aria-label"]), ["Detail, line 4", "Detail, line 8"]);
  assert.ok(rows().every(o => o.attrs["aria-expanded"] === undefined));
  assert.equal(rows()[0].attrs["aria-selected"], "true");
  // In the side panel one click jumps.
  went = undefined;
  await list.handlers.click(on(rows()[1]));
  assert.equal(went, 8);
  // The close button hides the panel and releases the toolbar toggle.
  a.get("outline-close").handlers.click();
  assert.equal(a.get("outline").open, false);
  assert.equal(a.get("outline-toggle").attrs["aria-pressed"], "false");
  // The modal picker selects on a click and jumps on a double click.
  await a.menu("jump_heading");
  went = undefined;
  await list.handlers.click(on(rows()[1]));
  assert.equal(went, undefined);
  assert.equal(rows()[1].attrs["aria-selected"], "true");
  await list.handlers.dblclick(on(rows()[1]));
  assert.equal(went, 6);
});

test("rename, move and duplicate keep the window's edits, update recent documents and never replace a file", async () => {
  const a = await app();
  const moves = [];
  a.api.move_document = ({from, to, expected}) => {
    assert.deepEqual(expected, a.disk.version, "the move is checked against the version the editor read");
    moves.push([from, to]);
    return {target: to, digest: "a", identity: ""};
  };
  a.edit("unsaved words");
  const submit = () => a.get("rename-form").handlers.submit({preventDefault() {}});
  const renaming = a.menu("rename");
  await new Promise(setImmediate);
  assert.equal(a.get("rename").open, true);
  assert.equal(a.get("rename-name").value, "a.md");
  assert.deepEqual(a.get("rename-name").selection, [0, 1], "the name is selected without its extension");
  a.get("rename-name").value = "with/slash";
  await submit();
  assert.match(a.get("rename-error").textContent, /cannot contain/);
  assert.equal(moves.length, 0);
  a.get("rename-name").value = "Report";
  await submit();
  assert.deepEqual(moves, [["/notes/a.md", "/notes/Report.md"]], "the extension is kept");
  assert.equal(a.get("rename").open, false);
  a.get("rename").handlers.close();
  await renaming;
  assert.match(a.get("doc-name").title, /^\/notes\/Report\.md/);
  assert.match(a.get("doc-name").title, /edited/, "unsaved edits stay unsaved");
  assert.equal(a.text(), "unsaved words");
  assert.ok(a.history().paths.includes("/notes/Report.md") && !a.history().paths.includes("/notes/a.md"));

  // A refused rename is explained in the dialog and changes nothing.
  a.api.move_document = () => { throw "“Taken.md” already exists. Choose another name."; };
  const again = a.menu("rename");
  await new Promise(setImmediate);
  a.get("rename-name").value = "Taken.md";
  await submit();
  assert.match(a.get("rename-error").textContent, /already exists/);
  assert.equal(a.get("rename").open, true);
  a.get("rename").close();
  a.get("rename").handlers.close();
  await again;
  assert.match(a.get("doc-name").title, /^\/notes\/Report\.md/);

  // Move To chooses a place with the save panel.
  a.api.move_document = ({from, to}) => { moves.push([from, to]); return {target: to, digest: "a", identity: ""}; };
  a.dialog.save = () => "/archive/Report.md";
  await a.menu("move_to");
  assert.deepEqual(moves.at(-1), ["/notes/Report.md", "/archive/Report.md"]);

  // Duplicate writes this window's text beside the document under a free name and opens it.
  const written = [];
  a.api.file_version = ({path}) => path === "/archive/Report copy.md" ? {target: path} : null;
  a.api.write_file = args => { written.push(args); return {version: {target: args.path}, confirmed: true}; };
  await a.menu("duplicate");
  assert.equal(written.length, 1);
  assert.equal(written[0].path, "/archive/Report copy 2.md");
  assert.equal(written[0].content, "unsaved words");
  assert.equal(written[0].expected, null);
  assert.ok(a.calls.some(([cmd, args]) => cmd === "open_document_window" && args.request.path === "/archive/Report copy 2.md"));
  assert.match(a.get("doc-name").title, /edited/, "the original window keeps its unsaved state");
});

test("Duplicate preserves mixed endings and requests conversion if the number of lines changes", async () => {
  const a = await app({}, ({disk}) => {
    disk.content = "a\r\nb\nc";
    disk.format = {encoding: "utf8bom", eol: "mixed", separators: "wn"};
  });
  a.api.file_version = () => null;
  const copies = [];
  a.api.write_file = args => { copies.push(args); return {confirmed:false, warning:"Copy needs checking"}; };
  await a.menu("duplicate");
  assert.deepEqual({...copies[0].format}, {encoding:"utf8bom", eol:"mixed", separators:"wn"});
  assert.ok(!a.calls.some(([name]) => name === "open_document_window"));
  a.edit("one\ntwo");
  await a.menu("duplicate");
  assert.equal(copies.length, 1);
  a.dialog.ask = (_, options) => options.title === "Line-ending conversion";
  await a.menu("duplicate");
  assert.deepEqual({...copies[1].format}, {encoding:"utf8bom", eol:"lf"});
  await a.fire(50);
  assert.match(a.get("doc-name").title, /edited/);
});

test("table, callout, footnote and date commands reach the editor and explain where they do not apply", async () => {
  const a = await app();
  const edits = [], inserted = [];
  let inTable = false;
  a.view.editTable = (op, arg) => { edits.push(arg ? [op, arg] : [op]); return inTable && op !== "deleteRow"; };
  a.view.inTable = () => inTable;
  a.view.insertText = text => inserted.push(text);
  a.view.insertFootnote = () => inserted.push("footnote");
  a.view.toggleWrap = marker => inserted.push("wrap " + marker);
  a.view.insertBlock = build => inserted.push(build("line one\nline two").text);
  await a.menu("table_column_after");
  assert.match(a.get("notice").textContent, /inside a Markdown table/);
  inTable = true;
  await a.menu("table_delete_row");
  assert.match(a.get("notice").textContent, /header row cannot be deleted/);
  await a.menu("table_align_center");
  await a.menu("table_row");
  assert.deepEqual(edits, [["columnAfter"], ["deleteRow"], ["align", "center"], ["rowBelow"]]);
  await a.menu("callout_warning");
  await a.menu("math_block");
  await a.menu("highlight");
  await a.menu("footnote");
  await a.menu("date_iso");
  assert.deepEqual(inserted.slice(0, 5), ["> [!WARNING]\n> line one\n> line two", "$$\nline one\nline two\n$$", "wrap ==", "footnote", inserted[4]]);
  assert.match(inserted[4], /^\d{4}-\d{2}-\d{2}$/);
});

test("the formatting bar runs menu actions, opens its menus and can be hidden", async () => {
  const a = await app();
  const bar = a.get("format-bar"), menu = a.get("format-menu");
  assert.equal(bar.children.filter(b => b.dataset?.format).length, 10);
  assert.equal(a.get("app").dataset.formatBar, "true");
  let bold = 0;
  a.view.toggleWrap = marker => { if (marker === "**") bold++; };
  const press = button => bar.handlers.click({detail: 1, target: {closest: () => button}});
  await press(bar.children.find(b => b.dataset?.action === "bold"));
  assert.equal(bold, 1);
  const tables = bar.children.find(b => b.dataset?.menu === "table");
  await press(tables);
  assert.equal(menu.hidden, false);
  assert.equal(tables.attrs["aria-expanded"], "true");
  const items = menu.children.filter(i => i.dataset?.action);
  assert.deepEqual(items.slice(0, 3).map(i => i.dataset.action), ["table", "table_row_above", "table_row"]);
  // Choosing an item closes the menu and runs the action.
  let added;
  a.view.editTable = op => { added = op; return true; };
  await menu.handlers.click({target: {closest: () => items[2]}});
  assert.equal(added, "rowBelow");
  assert.equal(menu.hidden, true);
  assert.equal(tables.attrs["aria-expanded"], "false");
  // The same button closes an open menu again.
  await press(tables);
  await press(tables);
  assert.equal(menu.hidden, true);
  // The View menu item and the settings checkbox both hide the bar, and it is remembered.
  await a.menu("format_bar");
  assert.equal(a.get("app").dataset.formatBar, "false");
  await new Promise(setImmediate);
  assert.equal(JSON.stringify(a.settings().formatBar), "false");
  assert.ok(!a.calls.filter(([cmd]) => cmd === "set_menu_checks").at(-1)[1].checked.includes("format_bar"));
  assert.equal(a.get("formatBar").checked, false);
  a.get("formatBar").checked = true;
  a.get("formatBar").handlers.change();
  assert.equal(a.get("app").dataset.formatBar, "true");
  await new Promise(setImmediate);
  assert.ok(a.calls.filter(([cmd]) => cmd === "set_menu_checks").at(-1)[1].checked.includes("format_bar"));
});

test("the settings window switches sections and mirrors the View menu", async () => {
  const a = await app();
  await a.menu("settings");
  assert.equal(a.get("settings").open, true);
  assert.equal(a.get("pane-general").hidden, false);
  a.get("tab-appearance").handlers.click();
  assert.equal(a.get("pane-general").hidden, true);
  assert.equal(a.get("pane-appearance").hidden, false);
  assert.equal(a.get("tab-appearance").attrs["aria-selected"], "true");
  a.get("tab-appearance").handlers.keydown({key: "ArrowRight", preventDefault() {}});
  assert.equal(a.get("pane-general").hidden, false, "arrow keys wrap around the tabs");
  // A checkbox that mirrors a View menu item changes the same preference.
  a.get("pref-gutter").checked = true;
  a.get("pref-gutter").handlers.change();
  await new Promise(setImmediate);
  assert.equal(JSON.stringify(a.settings().gutter), "true");
  await new Promise(setImmediate);
  assert.ok(a.calls.filter(([cmd]) => cmd === "set_menu_checks").at(-1)[1].checked.includes("gutter"));
  // Theme, font and text size.
  a.get("settings").handlers.change({target: {name: "theme", value: "dark"}});
  await new Promise(setImmediate);
  assert.equal(JSON.stringify(a.settings().theme), "\"dark\"");
  a.get("settings").handlers.change({target: {name: "editorFont", value: "sans"}});
  assert.equal(a.get("app").dataset.editorFont, "sans");
  await new Promise(setImmediate);
  assert.equal(JSON.stringify(a.settings().editorFont), "\"sans\"");
  a.get("zoom-larger").handlers.click();
  assert.equal(a.get("zoom-value").textContent, "110%");
  a.get("zoom-default").handlers.click();
  assert.equal(a.get("zoom-value").textContent, "100%");
  // Reopening shows the section that was open last.
  a.get("settings").close();
  await a.menu("settings");
  assert.equal(a.get("pane-general").hidden, false);
  a.get("tab-preview").handlers.click();
  a.get("settings").close();
  await a.menu("settings");
  assert.equal(a.get("pane-preview").hidden, false);
});

test("an empty document shows the ways to begin and other recent documents in its preview", async () => {
  const a = await app({"kladje.recent": JSON.stringify(["/notes/b.md", "/notes/a.md"])});
  const start = a.get("start");
  assert.equal(a.get("app").dataset.empty, "false");
  assert.equal(start.hidden, true);
  a.edit("");
  await a.fire(50);
  assert.equal(a.get("app").dataset.empty, "true");
  assert.equal(start.hidden, false);
  assert.equal(a.get("start-actions").children.length, 4);
  // The open document itself is not offered again.
  assert.equal(a.get("start-recent").children.length, 1);
  assert.equal(a.get("start-recent-group").hidden, false);
  const press = action => start.handlers.click({target: {closest: () => ({dataset: {action}})}});
  await press("recent:/notes/b.md");
  assert.equal(a.children.length, 1);
  assert.ok(a.calls.some(([cmd, args]) => cmd === "open_document_window" && args.request.path === "/notes/b.md"));
  await press("guide");
  assert.equal(a.children.length, 2);
  a.edit("typing hides it");
  await a.fire(50);
  assert.equal(start.hidden, true);
  assert.equal(a.get("app").dataset.empty, "false");
});

function imagePaste(a, file = {type:"image/png", size:8, encoded:"iVBORw0KGgo="}, text = "", inSource = true) {
  const event = { target: {closest: () => inSource}, clipboardData: {files:[file], getData: () => text}, preventDefault() { this.prevented = true; }, stopPropagation() {} };
  return {event, done: a.get("editor-pane").handlers.paste(event)};
}

test("paste stages only a confirmed clipboard raster and inserts the resulting relative path", async () => {
  const a = await app();
  a.api.paste_image = ({source, encoded}) => {
    assert.equal(source, a.disk.path);
    assert.equal(encoded, "iVBORw0KGgo=");
    return "assets/screenshot-1.png";
  };
  assert.equal(imagePaste(a, undefined, "plain text").event.prevented, undefined);
  await imagePaste(a).done;
  await imagePaste(a, {type:"image/svg+xml", size:20}).done;
  assert.ok(!a.calls.some(([cmd]) => cmd === "paste_image"));
  a.dialog.ask = () => true;
  const paste = imagePaste(a);
  await paste.done;
  assert.equal(paste.event.prevented, true);
  assert.match(a.text(), /assets\/screenshot-1.png$/);
  assert.equal(a.disk.content, "original");
});

test("cancel untitled paste and preserve edits or cursor movement during screenshot publication", async () => {
  const a = await app(), started = gate(), finish = gate();
  const original = a.text();
  a.dialog.ask = () => true;
  a.api.paste_image = async () => { started.resolve(); await finish.promise; return "assets/screenshot-2.png"; };
  const pending = imagePaste(a).done;
  await started.promise;
  a.view.selection = () => EditorSelection.single(17);
  finish.resolve();
  await pending;
  assert.equal(a.text(), original);
  assert.match(a.get("notice").textContent, /Saved assets/);
  await a.menu("new");
  const other = a.children[0];
  other.edit("new draft");
  other.dialog.ask = () => true;
  other.dialog.save = () => null;
  await imagePaste(other).done;
  assert.equal(other.text(), "new draft");
  assert.equal(a.calls.filter(([cmd]) => cmd === "paste_image").length, 1);
});

test("comparison displays two read-only text snapshots and retains the original save baseline", async () => {
  const a = await app();
  const diskVersion = a.disk.version;
  a.edit("shared\nlocal 😀\nend");
  a.api.comparison_text = () => "shared\r\n<svg>disk</svg>\r\nend";
  await a.menu("compare_disk");
  assert.equal(a.get("comparison").open, true);
  assert.match(a.get("comparison-summary").textContent, /^1 changed section\. Both versions are read-only/);
  const [shown] = a.comparisons;
  assert.equal(shown.parent, a.get("comparison-view"));
  assert.equal(shown.mine, "shared\nlocal 😀\nend");
  assert.equal(shown.disk, "shared\n<svg>disk</svg>\nend");
  assert.equal(a.get("comparison-next").disabled, false);
  a.get("comparison-next").handlers.click();
  a.get("comparison-previous").handlers.click();
  assert.deepEqual(shown.moves, ["next", "previous"]);
  a.get("comparison").close();
  a.get("comparison").handlers.close();
  assert.equal(shown.destroyed, true);
  // Reopening builds a fresh view and never leaves the old one behind.
  await a.menu("compare_disk");
  assert.equal(a.comparisons.length, 2);
  a.get("comparison").close();
  a.get("comparison").handlers.close();
  assert.equal(a.comparisons[1].destroyed, true);
  assert.equal(a.disk.content, "original");
  await a.menu("save");
  assert.deepEqual(a.calls.find(([cmd]) => cmd === "write_file")[1].expected, diskVersion);
});

test("comparison honors the size limit and drops a result if typing continues", async () => {
  const a = await app(), started = gate(), finish = gate();
  a.api.comparison_text = async () => { started.resolve(); await finish.promise; return "old"; };
  const pending = a.menu("compare_disk");
  await started.promise;
  a.edit("new input");
  finish.resolve();
  await pending;
  assert.ok(!a.get("comparison").open);
  a.edit("a".repeat(512*1024+1));
  await a.menu("compare_disk");
  assert.equal(a.calls.filter(([cmd]) => cmd === "comparison_text").length, 1);
  assert.match(a.get("notice").textContent, /512 KiB/);
});

test("local template creates an unbound recoverable draft without changing the template or recent paths", async () => {
  const a = await app();
  a.dialog.open = () => "/notes/template.md";
  a.api.read_file = () => ({...a.disk, path:"/notes/template.md", content:"# Template\r\n"});
  a.edit("existing draft");
  await a.menu("new_template");
  assert.equal(a.text(), "existing draft");
  const other = a.children[0];
  assert.equal(other.text(), "# Template\n");
  assert.match(other.get("doc-name").title, /Not saved yet.*edited/);
  const recovery = other.calls.filter(([cmd]) => cmd === "recovery_write").at(-1);
  assert.equal(recovery[1].draft.path, null);
  assert.ok(!a.history().paths.includes("/notes/template.md"));
  let defaultPath;
  other.dialog.save = options => { defaultPath = options.defaultPath; return null; };
  await other.menu("save");
  assert.equal(defaultPath, "Untitled.md");
  assert.equal(a.disk.content, "original");
});

test("a template reads the saved source while its owner keeps unsaved edits", async () => {
  const a = await app();
  a.dialog.open = () => a.disk.path;
  a.edit("unsaved template text");
  await a.menu("new_template");
  assert.equal(a.children[0].text(), "original");
  assert.equal(a.text(), "unsaved template text");
});

test("comparison treats CRLF as the same text and a missing disk version leaves edits intact", async () => {
  const a = await app();
  a.edit("one\ntwo");
  a.api.comparison_text = () => "one\r\ntwo";
  await a.menu("compare_disk");
  assert.match(a.get("comparison-summary").textContent, /same text/);
  assert.equal(a.get("comparison-next").disabled, true);
  assert.equal(a.get("comparison-previous").disabled, true);
  a.get("comparison").close();
  a.api.comparison_text = () => { throw Error("File missing"); };
  await a.menu("compare_disk");
  assert.ok(!a.get("comparison").open);
  assert.equal(a.text(), "one\ntwo");
  assert.ok(!a.calls.some(([cmd]) => cmd === "write_file"));
});

test("the document's accessible status follows dirty edits, saves and failed saves", async () => {
  const a = await app();
  assert.equal(a.get("doc-state").textContent, "");
  a.edit("revised");
  await a.fire(50);
  assert.match(a.get("doc-state").textContent, /Unsaved changes/);
  a.api.write_file = () => { throw Error("Disk full"); };
  await a.menu("save");
  assert.match(a.get("doc-state").textContent, /Unsaved changes/);
  a.api.write_file = () => ({version:a.disk.version, confirmed:true});
  await a.menu("save");
  assert.equal(a.get("doc-state").textContent, "");
});

test("pasting an image in the search panel leaves the document and filesystem alone", async () => {
  const a = await app();
  let asked = false;
  a.dialog.ask = () => { asked = true; return true; };
  const paste = imagePaste(a, undefined, "", false);
  await paste.done;
  assert.equal(paste.event.prevented, undefined);
  assert.equal(asked, false);
  assert.equal(a.text(), a.disk.content);
  assert.ok(!a.calls.some(([cmd]) => cmd === "paste_image"));
});

test("a native toggle behind a modal restores its actual checked state", async () => {
  const a = await app();
  a.get("comparison").open = true;
  const count = a.calls.filter(([cmd]) => cmd === "set_menu_checks").length;
  await a.menu("gutter");
  assert.equal(a.calls.filter(([cmd]) => cmd === "set_menu_checks").length, count + 1);
  const last = a.calls.filter(([cmd]) => cmd === "set_menu_checks").at(-1);
  assert.ok(last);
  assert.ok(!last[1].checked.includes("gutter"));
  assert.ok(!a.values.has("kladje.gutter"));
});

test("unsupported volume copy needs consent and acknowledges only its saved revision", async () => {
  const a = await app(), started = gate(), finish = gate();
  a.edit("version one");
  a.api.write_file = () => { throw "KLADJE_COPY_REQUIRED"; };
  await a.menu("save");
  assert.ok(!a.calls.some(([cmd]) => cmd === "save_protected_copy"));
  a.dialog.ask = () => true;
  a.api.save_protected_copy = async args => {
    assert.equal(args.content, "version one"); started.resolve(); await finish.promise;
    return {confirmed:true,version:{target:"/notes/Kladje Copy abc/a.md",digest:"new"}};
  };
  const pending = a.menu("save"); await started.promise;
  a.edit("version two"); finish.resolve(); await pending;
  assert.equal(a.text(), "version two");
  assert.equal(a.disk.content, "original");
  assert.match(a.get("doc-name").title, /Kladje Copy abc/);
  assert.match(a.get("doc-name").title, /edited/);
});

function contestedWrite(path) {
  return {basic:true, confirmed:false, conflict:true, version:{target:path,digest:"unconfirmed"},
    warning:"Another program changed the file. The previous file was kept at /notes/.kladje-previous-id."};
}

test("a contested Save As keeps the current path, disk baseline and recovery when declined", async () => {
  const a = await app(), original = a.disk.version;
  const other = "/notes/destination.md";
  a.edit("my revision");
  a.dialog.save = () => other;
  a.api.file_version = () => null;
  a.api.write_file = () => contestedWrite(other);
  a.dialog.ask = (message, options) => {
    assert.equal(options.okLabel, "Save My Version Separately…");
    assert.match(message,/\.kladje-previous-id/);
    return false;
  };
  await a.menu("save_as");
  assert.match(a.get("doc-name").title,/^\/notes\/a\.md.*edited/);
  assert.equal(a.history().lastPath, a.disk.path);
  assert.ok(!a.calls.some(([cmd]) => cmd==="save_protected_copy"));
  assert.ok(a.calls.some(([cmd,{draft}]) => cmd==="recovery_write" && draft.path===a.disk.path && draft.content==="my revision"));
  a.api.write_file = args => {
    assert.equal(args.path,a.disk.path); assert.deepEqual(args.expected,original);
    return {version:original,confirmed:true};
  };
  await a.menu("save");
});

test("an autosave conflict pauses silently and manual Save copies the latest revision without retrying the original", async () => {
  const a = await app({"kladje.autosave":"true"});
  a.api.write_file = ({path}) => contestedWrite(path);
  noDialogs(a);
  a.edit("first");
  await a.fire(2000);
  assert.match(a.get("notice").textContent,/Autosave paused/);
  a.edit("second");
  await a.fire(2000); await a.events.blur(); await a.pollDisk();
  assert.equal(writes(a),1);
  assert.ok(!a.calls.some(([cmd]) => cmd==="save_protected_copy"));
  const warning = gate(), accept = gate(), copying = gate(), finish = gate();
  a.dialog.ask = async (message, options) => {
    assert.match(message,/new folder/); assert.equal(options.title,"Conflicting save");
    warning.resolve(); await accept.promise; return true;
  };
  const target = "/notes/Kladje Copy test/a.md";
  a.api.save_protected_copy = async ({path,content,format}) => {
    assert.equal(path,a.disk.path); assert.equal(content,"third"); assert.equal(format.encoding,"utf8");
    copying.resolve(); await finish.promise; return {confirmed:true,version:{target,digest:"third"}};
  };
  const saving = a.menu("save");
  await warning.promise; a.edit("third"); accept.resolve();
  await copying.promise; a.edit("fourth"); finish.resolve(); await saving;
  assert.equal(writes(a),1);
  assert.equal(a.text(),"fourth");
  assert.match(a.get("doc-name").title,/Kladje Copy test.*edited/);
  assert.equal(a.history().lastPath,target);
  assert.ok(a.calls.some(([cmd,{draft}]) => cmd==="recovery_write" && draft.path===target && draft.content==="fourth"));
});

test("dismissing a native save conflict handles its disk revision once and still detects later changes", async () => {
  const a = await app();
  a.edit("my version");
  a.api.write_file = ({path}) => {
    a.disk.version = {target:path, digest:"other editor"};
    return contestedWrite(path);
  };
  const prompts = [];
  a.dialog.ask = (_, options) => { prompts.push(options.title); return false; };
  await a.menu("save");
  await a.events.focus();
  await a.pollDisk();
  assert.deepEqual(prompts, ["Conflicting save"]);
  assert.equal(a.text(), "my version");
  a.disk.version = {target:a.disk.path, digest:"another change"};
  await a.pollDisk();
  await a.events.focus();
  assert.deepEqual(prompts, ["Conflicting save", "Conflicting changes"]);
  await a.menu("save");
  assert.equal(prompts.at(-1), "Conflicting save");
  assert.equal(writes(a), 1);
  assert.match(a.get("doc-name").title, /edited/);
});

test("failure of a separate conflict copy keeps the original open and vetoes Close", async () => {
  const a = await app();
  a.edit("keep me");
  a.api.write_file = ({path}) => contestedWrite(path);
  a.dialog.ask = () => true;
  a.api.save_protected_copy = () => { throw Error("disk full"); };
  a.dialog.message = (_, options) => options.title==="Unsaved changes" ? "Save" : "OK";
  await a.menu("close_window");
  assert.equal(writes(a),1);
  assert.ok(!a.calls.some(([cmd]) => cmd==="destroy"));
  assert.match(a.get("doc-name").title,/^\/notes\/a\.md.*edited/);
  assert.ok(a.calls.some(([cmd,{draft}]) => cmd==="recovery_write" && draft.content==="keep me"));
});

test("a volume without atomic replacement saves in place and is mentioned once", async () => {
  const a = await app();
  a.api.write_file = ({content}) => { a.disk.content = content; return {version: a.disk.version, confirmed: true, basic: true}; };
  a.dialog.ask = () => { throw Error("an in-place save must not ask for a copy"); };
  a.edit("first");
  await a.menu("save");
  assert.equal(a.disk.content, "first");
  assert.match(a.get("notice").textContent, /^Saved · this volume does not support protected replacement$/);
  assert.match(a.get("doc-name").title, /a\.md$/);
  a.edit("second");
  await a.menu("save");
  assert.equal(a.disk.content, "second");
  assert.equal(a.get("notice").textContent, "Saved");
  assert.ok(!a.calls.some(([cmd]) => cmd === "save_protected_copy"));
});

test("rich paste is opt-in and an async conversion cannot overwrite a newer selection or edit", async () => {
  const a = await app(), started = gate(), finish = gate();
  const paste = () => {
    const event = {target:{closest:()=>true}, clipboardData:{files:[],getData:t=>t==="text/html"?"<b>one</b>":"one"},
      preventDefault(){this.prevented=true;}, stopPropagation(){}};
    return {event, done:a.get("editor-pane").handlers.paste(event)};
  };
  assert.equal(paste().event.prevented, undefined);
  await a.menu("settings");
  a.get("htmlPaste").checked=true;
  a.get("htmlPaste").handlers.change();
  a.get("settings").close();
  a.api.clipboard_markdown=async()=>{started.resolve(); return finish.promise;};
  a.view.pasteText=value=>a.edit(value);
  const first=paste(); assert.equal(first.event.prevented,true);
  await started.promise;
  a.edit("more recent");
  finish.resolve("**one**\n");
  await first.done;
  assert.equal(a.text(),"more recent");
  assert.match(a.get("notice").textContent,/insertion point changed/);
  await paste().done;
  assert.equal(a.text(),"**one**");
  assert.equal(a.disk.content,"original");
  await a.menu("save");
  assert.equal(a.disk.content,"**one**");
});
const noDialogs = a => {
  a.dialog.ask = () => { throw Error("autosave must not ask"); };
  a.dialog.message = () => { throw Error("autosave must not open a dialog"); };
  a.dialog.save = () => { throw Error("autosave must not choose a path"); };
};
const writes = a => a.calls.filter(([cmd]) => cmd === "write_file").length;

test("autosave is off by default and, once on, saves after a typing pause and on blur without a dialog", async () => {
  const a = await app();
  noDialogs(a);
  a.edit("not saved unasked");
  await assert.rejects(a.fire(2000), /no pending timer/);
  await a.events.blur();
  assert.equal(writes(a), 0);
  assert.equal(a.disk.content, "original");

  await a.menu("settings");
  a.get("autosave").checked = true;
  await a.get("autosave").handlers.change();
  a.get("settings").close();
  await new Promise(setImmediate);
  assert.equal(JSON.stringify(a.settings().autosave), "true");
  // Turning it on saves the pending edit. Later edits wait for a pause.
  assert.equal(a.disk.content, "not saved unasked");
  a.edit("after a pause");
  assert.equal(a.disk.content, "not saved unasked");
  await a.fire(2000);
  assert.equal(a.disk.content, "after a pause");
  assert.doesNotMatch(a.get("doc-name").title, /edited/);
  a.edit("on switching away");
  await a.events.blur();
  assert.equal(a.disk.content, "on switching away");
  const expected = a.calls.filter(([cmd]) => cmd === "write_file").at(-1)[1].expected;
  assert.deepEqual(expected, a.disk.version);
});

test("autosave leaves untitled, recovered and undecided documents to an explicit Save", async () => {
  const untitled = await app({"kladje.autosave": "true"}, ({api}) => { api.setup = () => ({}); });
  noDialogs(untitled);
  untitled.edit("draft without a file");
  await untitled.fire(2000);
  assert.equal(writes(untitled), 0);

  const latin = await app({"kladje.autosave": "true"}, ({disk}) => { disk.format = {encoding: "latin1", eol: "lf"}; });
  noDialogs(latin);
  latin.edit("needs UTF-8 \u{1f600}");
  await latin.fire(2000);
  await latin.events.blur();
  assert.equal(writes(latin), 0);
  await latin.fire(50);
  assert.match(latin.get("doc-name").title, /edited/);
  latin.edit("plain again");
  await latin.fire(2000);
  assert.equal(latin.disk.content, "plain again");
});

test("a refused autosave pauses quietly until an explicit Save or reload settles the file", async () => {
  const a = await app({"kladje.autosave": "true"});
  noDialogs(a);
  let attempts = 0;
  a.api.write_file = () => { attempts++; throw "/notes/a.md: The file changed on disk. Your edits are still open. Use Save As to keep a separate copy."; };
  a.edit("mine");
  await a.fire(2000);
  assert.equal(attempts, 1);
  assert.match(a.get("notice").textContent, /^Autosave paused · the file changed on disk/);
  assert.match(a.get("doc-name").title, /edited/);
  assert.ok(a.calls.some(([cmd, args]) => cmd === "recovery_write" && args.draft.content === "mine"));
  a.edit("mine, still typing");
  await a.fire(2000);
  await a.events.blur();
  assert.equal(attempts, 1);
  // An explicit Save reports the failure in the usual dialog and keeps autosave paused.
  let shown = 0;
  a.dialog.message = () => { shown++; };
  await a.menu("save");
  assert.equal(attempts, 2);
  assert.equal(shown, 1);
  // A successful explicit Save resumes it.
  a.api.write_file = ({content}) => { attempts++; a.disk.content = content; return {version: a.disk.version, confirmed: true}; };
  await a.menu("save");
  a.edit("resumed");
  await a.fire(2000);
  assert.equal(a.disk.content, "resumed");
});

test("with autosave on, Close saves a titled document instead of asking, and still asks when that fails", async () => {
  const a = await app({"kladje.autosave": "true"});
  noDialogs(a);
  a.edit("saved on the way out");
  await a.menu("close_window");
  assert.equal(a.disk.content, "saved on the way out");
  assert.ok(a.calls.some(([cmd]) => cmd === "destroy"));

  const b = await app({"kladje.autosave": "true"});
  b.api.write_file = () => { throw "disk full"; };
  let asked = 0;
  b.dialog.message = () => { asked++; return "Cancel"; };
  b.edit("cannot be written");
  await b.menu("close_window");
  assert.equal(asked, 1);
  assert.ok(!b.calls.some(([cmd]) => cmd === "destroy"));
  assert.equal(b.text(), "cannot be written");
});

test("Close Window uses the same dirty-document veto as Quit", async () => {
  const a = await app();
  a.edit("retain unsaved source");
  await a.menu("close_window");
  assert.equal(a.text(),"retain unsaved source");
  assert.ok(!a.calls.some(([name])=>name==="destroy"));
});

test("a full portable volume retains the active draft, recovery and the Close veto", async () => {
  const a = await app();
  a.edit("keep this draft");
  a.api.write_file = () => { throw "KLADJE_COPY_REQUIRED"; };
  a.dialog.ask = () => true;
  a.api.save_protected_copy = () => { throw "No space left on device"; };
  await a.menu("save");
  assert.equal(a.disk.content, "original");
  assert.match(a.get("doc-name").title, /a\.md.*edited/);
  assert.ok(a.calls.some(([cmd, args]) => cmd === "recovery_write" && args.draft.content === "keep this draft"));
  await a.menu("close_window");
  assert.ok(!a.calls.some(([cmd]) => cmd === "destroy"));
  assert.equal(a.text(), "keep this draft");
});

test("a delayed sidebar outline cannot replace the headings of a newer revision", async () => {
  const a = await app(), started = gate(), finish = gate();
  let calls = 0;
  a.api.document_headings = async () => {
    if (++calls === 1) { started.resolve(); await finish.promise; return [{line:1,level:1,text:"Stale"}]; }
    return [{line:1,level:1,text:"Current"}];
  };
  a.edit("# Stale");
  const opening = a.menu("document_outline"); await started.promise;
  a.edit("# Current"); await a.fire(500);
  finish.resolve(); await opening; await new Promise(setImmediate);
  assert.equal(a.get("heading-list").children.length,1);
  assert.match(a.get("heading-list").children[0].attrs["aria-label"],/Current/);
  await a.menu("document_outline");
  assert.equal(a.get("outline").open,false);
});

test("a provisional discard freezes the approved editor and cancellation retains its recovery and save binding", async () => {
  const a = await app();
  a.edit("keep this after Cancel");
  a.dialog.message = () => "Don't Save";
  await a.events["prepare-quit"]({payload:{epoch:17}});
  assert.equal(a.get("app").inert,true);
  assert.ok(a.calls.some(([n,v])=>n==="quit_vote" && v.epoch===17 && v.allow && v.draft));
  assert.ok(!a.calls.some(([n])=>n==="destroy" || n==="recovery_clear"));
  await a.menu("save");
  assert.equal(a.disk.content,"original");
  a.events["cancel-quit"]({payload:17});
  await a.menu("save");
  assert.equal(a.disk.content,"keep this after Cancel");
});

test("a save failure during coordinated Quit vetoes exit and leaves the window editable", async () => {
  const a = await app();
  a.edit("unsaved revision");
  a.dialog.message = (_, options) => options.title==="Unsaved changes" ? "Save" : "OK";
  a.api.write_file = () => {throw Error("disk full");};
  await a.events["prepare-quit"]({payload:{epoch:8}});
  assert.equal(a.calls.findLast(([n])=>n==="quit_vote")[1].allow,false);
  assert.equal(a.get("app").inert,false);
  assert.equal(a.disk.content,"original");
  assert.equal(a.text(),"unsaved revision");
});

test("multi-file drops keep source edits and open each Markdown file in its own editor", async () => {
  const a = await app();
  a.edit("private source");
  a.api.read_file = ({path})=>({...a.disk,path,content:path});
  await a.events.drop({payload:{type:"drop",paths:["/a.md","/b.md"]}});
  assert.deepEqual(a.children.map(w=>w.text()),["/a.md","/b.md"]);
  assert.equal(a.text(),"private source");
});

test("a restored startup draft and an incoming Finder file retain separate document identities", async () => {
  const a = await app({},({api,dialog,disk}) => {
    const draft = {...disk,id:"aa".repeat(16),name:"draft",content:"recovered text",revision:7};
    api.recovery_list = ()=>[draft];
    api.recovery_claim = ()=>draft;
    dialog.message = ()=>"Restore";
  });
  assert.equal(a.text(),"recovered text");
  assert.equal(a.children[0].text(),"original");
  assert.equal(a.children[0].calls.some(([cmd])=>cmd==="recovery_list"),false);
});

test("a later recovery failure cannot replace or retire an already restored draft", async () => {
  const first = {id:"aa".repeat(16), name:"First", content:"only surviving edits", revision:7};
  const other = {id:"bb".repeat(16), name:"Other"};
  const a = await app({}, ({api,dialog}) => {
    api.recovery_list = () => [first, other];
    dialog.message = text => text.includes("“Other”") ? "Discard Draft" : "Restore";
    api.recovery_claim = ({id}) => {
      if (id === other.id) throw Error("Draft already claimed by another process");
      return first;
    };
  });
  assert.equal(a.text(), first.content);
  assert.ok(!a.calls.some(([cmd,args]) => cmd === "recovery_clear" && args.id === first.id));
  assert.equal(a.children[0].text(), "original");
});

test("Quit identifies the folder of each same-named document before asking for a decision", async () => {
  for (const folder of ["work", "home"]) {
    const path = "/notes/" + folder + "/notes.md";
    const a = await app({}, ({disk}) => { disk.path = path; });
    a.edit("unsaved revision");
    let prompt;
    a.dialog.message = message => { prompt = message; return "Cancel"; };
    await a.menu("quit");
    assert.ok(prompt.includes(path));
    assert.equal(a.text(), "unsaved revision");
    assert.equal(a.disk.content, "original");
  }
});

test("an untitled Close prompt gives a bounded identifying line and Cancel keeps the draft", async () => {
  const parent = await app();
  await parent.menu("new");
  const a = parent.children[0];
  const note = "A walk at low tide\n" + "🪶".repeat(600);
  a.edit(note);
  let prompt;
  a.dialog.message = message => { prompt = message; return "Cancel"; };
  await a.events.close({preventDefault() {}});
  assert.match(prompt, /A walk at low tide/);
  assert.ok(prompt.length < 200);
  assert.equal(a.text(), note);
});

const KIB = 1024, MIB = 1024 * KIB;
const settle = () => new Promise(resolve => setImmediate(resolve));
const status = a => a.get("preview-status").hidden ? "" : a.get("preview-status-text").textContent;
// The stub DOM patches in no time. Charge each update what the release build measured on an Apple M4.
const measuredCost = a => { a.hooks.patchMs = html => Number(html) / MIB * 22; };

test("a megabyte of text keeps its live preview and a larger document waits for a typing pause", async () => {
  const a = await app();
  measuredCost(a);
  a.api.render = ({markdown}) => String(markdown.length);
  a.edit("a".repeat(256 * KIB + 1));
  await a.fire(70);
  assert.equal(a.rendered.at(-1), String(256 * KIB + 1), "the former fixed pause is gone");
  a.edit("a".repeat(900 * KIB));
  assert.ok(a.pending(70) && !a.pending(1500));
  await a.fire(70);
  assert.equal(a.rendered.at(-1), String(900 * KIB));
  assert.equal(status(a), "");

  a.edit("a".repeat(4 * MIB));
  assert.ok(!a.pending(70), "no render while typing continues");
  assert.equal(status(a), "Preview updates when you pause typing");
  assert.match(a.get("notice").textContent, /pause typing/);
  await a.fire(1500);
  assert.equal(a.rendered.at(-1), String(4 * MIB));
  assert.equal(status(a), "");
  a.edit("short draft");
  await a.fire(delay => delay > 70 && delay < 700); // the delay follows the cost of the previous update
  assert.equal(a.rendered.at(-1), "11");
});

test("a very large document renders on request only and never shows an obsolete result", async () => {
  const a = await app();
  await a.menu("view_editor");
  a.edit("a".repeat(16 * MIB));
  let reads = 0;
  const read = a.view.getText;
  a.view.getText = () => { reads++; return read(); };
  await a.menu("view_split");
  await settle();
  assert.equal(reads, 0, "an unrendered preview does not copy the document");
  assert.ok(!a.calls.some(([name, args]) => name === "render" && args.markdown.length === 16 * MIB));
  assert.equal(status(a), "Preview is out of date");
  assert.match(a.get("notice").textContent, /Refresh Preview/);
  assert.equal(a.get("preview-refresh").hidden, false);

  const started = gate(), finish = gate();
  measuredCost(a);
  a.api.render = async ({markdown}) => {
    if (markdown.length === 16 * MIB) { started.resolve(); await finish.promise; }
    return String(markdown.length);
  };
  const refresh = a.menu("refresh_preview");
  await started.promise;
  assert.equal(status(a), "Rendering preview…");
  assert.equal(a.get("preview-refresh").hidden, true);
  a.edit("b".repeat(16 * MIB + 1));
  finish.resolve();
  assert.equal(await refresh, false);
  assert.ok(!a.rendered.includes(String(16 * MIB)), "the result for the replaced text is dropped");
  assert.equal(status(a), "Preview is out of date");
  assert.ok(!a.pending(70), "and a large render is not repeated while typing continues");
  a.edit("b".repeat(16 * MIB + 2));
  assert.equal(await a.fire(1500), true);
  assert.equal(a.rendered.at(-1), String(16 * MIB + 2), "the request is honoured at the next pause in typing");
  assert.equal(status(a), "");

  a.edit("c".repeat(16 * MIB + 3));
  assert.ok(!a.pending(70) && !a.pending(1500), "later edits wait for another request");
  assert.equal(status(a), "Preview is out of date");
  a.get("preview-refresh").handlers.click();
  await settle();
  assert.equal(a.rendered.at(-1), String(16 * MIB + 3));
  assert.equal(status(a), "");

  const opened = await app({}, ({disk}) => { disk.content = "a".repeat(16 * MIB); });
  assert.match(status(opened), /not rendered automatically/);
  assert.ok(!opened.calls.some(([name, args]) => name === "render" && args.markdown.length));
});

test("ticking a task in the preview of a very large document refreshes it for the next tick", async () => {
  const a = await app();
  const box = {getAttribute: () => "1:1-1:9", closest: () => ({textContent: "Buy milk"}), setAttribute() {}, removeAttribute() {}};
  a.get("preview").querySelectorAll = selector => selector === "input[data-kladje-task]" ? [box] : [];
  let checked = false;
  a.api.render = ({markdown}) => ({html: String(markdown.length), assets: {}, tasks: {"1:1-1:9": {offset: 3, checked}}});
  a.view.toggleTask = () => { checked = !checked; a.edit((checked ? "- [x] " : "- [ ] ") + "a".repeat(16 * MIB)); return true; };
  a.edit("- [ ] " + "a".repeat(16 * MIB));
  await a.menu("refresh_preview");
  const renders = () => a.calls.filter(([name]) => name === "render").length;
  for (const expected of [true, false]) {
    const before = renders();
    box.checked = expected;
    a.get("preview").handlers.change({target: box});
    await settle();
    assert.equal(renders(), before + 1, "each tick renders once, on request of the click");
    assert.equal(box.checked, expected);
    assert.equal(a.text().startsWith(expected ? "- [x]" : "- [ ]"), true);
    assert.equal(status(a), "");
  }
});

test("a checkbox from an older preview cannot edit the new revision", async () => {
  const a = await app();
  const box = {getAttribute: () => "1:1-1:9", closest: () => ({textContent: "One"}), setAttribute() {}, removeAttribute() {}};
  a.get("preview").querySelectorAll = selector => selector === "input[data-kladje-task]" ? [box] : [];
  a.api.render = () => ({html: "list", tasks: {"1:1-1:9": {offset: 3, checked: false}}});
  a.edit("- [ ] One");
  await a.menu("refresh_preview");
  assert.equal(box.disabled, false);
  a.edit("- [ ] Two");
  a.view.toggleTask = () => assert.fail("stale preview changed the source");
  box.checked = true;
  a.get("preview").handlers.change({target: box});
  assert.equal(box.checked, false);
  assert.equal(a.text(), "- [ ] Two");
});

test("an edit during a pause-tier render waits for the next pause instead of rendering again at once", async () => {
  const a = await app(), started = gate(), finish = gate();
  measuredCost(a);
  a.api.render = async ({markdown}) => {
    if (markdown.length === 4 * MIB) { started.resolve(); await finish.promise; }
    return String(markdown.length);
  };
  a.edit("a".repeat(4 * MIB));
  const first = a.fire(1500);
  await started.promise;
  a.edit("a".repeat(4 * MIB + 1));
  finish.resolve();
  assert.equal(await first, false);
  const renders = () => a.calls.filter(([name]) => name === "render").length;
  const before = renders();
  await settle();
  assert.equal(renders(), before);
  assert.ok(!a.rendered.includes(String(4 * MIB)));
  assert.equal(status(a), "Preview updates when you pause typing");
  assert.equal(await a.fire(1500), true);
  assert.equal(a.rendered.at(-1), String(4 * MIB + 1));
});

test("a slow render that typing overtakes is dropped and the next one waits for its own delay", async () => {
  const a = await app(), started = gate(), finish = gate();
  a.api.render = async ({markdown}) => {
    if (markdown === "earlier") {
      started.resolve();
      await finish.promise;
      a.clock.skew += 300;
    }
    return markdown;
  };
  a.edit("earlier");
  const first = a.fire(70);
  await started.promise;
  a.edit("latest");
  finish.resolve();
  assert.equal(await first, false);
  await settle();
  assert.deepEqual(a.calls.filter(([name]) => name === "render").map(([, args]) => args.markdown).slice(-1), ["earlier"],
    "a render slower than the typing delay is not repeated back to back");
  assert.ok(!a.rendered.includes("earlier"));
  assert.equal(await a.fire(70), true);
  assert.equal(a.rendered.at(-1), "latest");
});

test("the measured cost of an update, not only the size, decides how live the preview stays", async () => {
  const a = await app();
  a.api.render = ({markdown}) => String(markdown.length);
  // A small document says little about the cost per megabyte and is not used as a sample.
  a.hooks.patchMs = () => 40;
  a.edit("tiny");
  await a.fire(70);
  const text = n => "a".repeat(600 * KIB + n);
  a.edit(text(0));
  assert.ok(a.pending(70), "600 KiB starts out live");
  let perMib = 300;
  a.hooks.patchMs = html => Number(html) / MIB * perMib;
  await a.fire(70);
  a.edit(text(1));
  assert.ok(a.pending(1500) && !a.pending(70), "a slow machine waits for a pause at 600 KiB");
  perMib = 5;
  await a.fire(1500);
  a.edit("a".repeat(3 * MIB));
  assert.ok(!a.pending(1500), "a fast machine follows 3 MiB live");
  assert.equal(status(a), "");
});

test("a window starts from the update cost an earlier window measured on this machine", async () => {
  const first = await app();
  first.api.render = ({markdown}) => String(markdown.length);
  first.hooks.patchMs = html => Number(html) / MIB * 10;
  first.edit("a".repeat(MIB));
  await first.fire(70);
  const remembered = JSON.parse(first.values.get("kladje.previewRate"));
  assert.ok(Math.abs(remembered * MIB - 10) < 1);

  const next = await app({"kladje.previewRate": JSON.stringify(remembered)}, ({disk}) => { disk.content = "a".repeat(8 * MIB); });
  assert.equal(status(next), "", "8 MiB is within the pause budget at the remembered cost and renders on opening");
  assert.ok(next.calls.some(([name, args]) => name === "render" && args.markdown.length === 8 * MIB));
  const unknown = await app({"kladje.previewRate": JSON.stringify("fast")}, ({disk}) => { disk.content = "a".repeat(8 * MIB); });
  assert.match(status(unknown), /not rendered automatically/, "an invalid stored value falls back to the cautious default");
});

test("print renders a document that is too large for the live preview and shows that it is preparing", async () => {
  const a = await app(), started = gate(), finish = gate();
  a.api.print_document = () => {};
  a.api.render = async ({markdown}) => { started.resolve(); await finish.promise; return String(markdown.length); };
  a.edit("a".repeat(16 * MIB));
  assert.equal(status(a), "Preview is out of date");
  const printing = a.menu("export_pdf");
  await started.promise;
  assert.equal(a.get("notice").textContent, "Preparing the document for printing…");
  assert.equal(status(a), "Rendering preview…");
  assert.ok(!a.calls.some(([name]) => name === "print_document"));
  finish.resolve();
  await printing;
  const order = a.calls.map(([name]) => name).filter(name => name === "render" || name === "print_document");
  assert.deepEqual(order.slice(-2), ["render", "print_document"]);
  assert.equal(a.rendered.at(-1), String(16 * MIB));
  assert.equal(status(a), "");

  // From the editor-only view the preview is hidden, and print still renders it.
  await a.menu("view_editor");
  a.edit("b".repeat(16 * MIB + 1));
  await a.menu("export_pdf");
  assert.equal(a.rendered.at(-1), String(16 * MIB + 1));
  assert.equal(a.calls.filter(([name]) => name === "print_document").length, 2);
});

test("print keeps a separately themed diagram across native preview and final pagination", async () => {
  const a = await app({}, undefined, async (_, dark) => ({src:dark ? "dark-image" : "light-image", width:80, height:40}));
  a.api.render = ({markdown}) => String(markdown.length);
  const images = [];
  const block = {dataset:{}, isConnected:true, getAttribute:()=>"1:1-3:3", firstElementChild:{textContent:"graph TD"},
    append(node){images.push(node);}, classList:{add(){},remove(){}},
    querySelector(selector){
      if (selector === ".diagram-paper") return images.find(n=>n.className.includes("diagram-paper"));
      if (selector.startsWith("img.diagram-image")) return images.find(n=>n.className==="diagram-image");
      return null;
    }};
  const code = {parentElement:block,textContent:"graph TD"};
  a.get("preview").querySelectorAll = selector => selector.includes("language-mermaid") ? [code] : [];
  await a.menu("theme_dark");
  a.edit("a".repeat(16 * MIB));
  delete block.dataset.diagram;
  await settle();
  assert.equal(block.dataset.diagram, undefined);
  await a.menu("refresh_preview");
  assert.equal(images[0].src,"dark-image");
  a.api.print_document = () => {
    a.events.afterprint(); // WebKit can finish print preview before producing the PDF.
    assert.equal(images[0].src,"dark-image");
    assert.equal(images[1].src,"light-image");
  };
  await a.menu("export_pdf");
  assert.equal(images.length,2);
  a.get("darkExport").checked=true;
  await a.get("darkExport").handlers.change();
  a.api.print_document = () => assert.equal(images[1].src,"dark-image");
  await a.menu("export_pdf");
  assert.equal(images.length,2);
});

test("print stops when the text changes while it prepares or when rendering fails", async () => {
  const a = await app(), started = gate(), finish = gate();
  a.api.print_document = () => {};
  a.api.render = async ({markdown}) => {
    if (markdown === "first") { started.resolve(); await finish.promise; }
    return markdown;
  };
  a.edit("first");
  const printing = a.menu("export_pdf");
  await started.promise;
  a.edit("second");
  finish.resolve();
  await printing;
  assert.ok(!a.rendered.includes("first"));
  assert.equal(a.rendered.at(-1), "second");
  assert.match(a.get("notice").textContent, /changed while preparing print/);
  assert.ok(!a.calls.some(([name]) => name === "print_document"));

  // A large document is not rendered again while typing continues, and print still stops.
  const slow = gate(), release = gate();
  a.api.render = async ({markdown}) => { slow.resolve(); await release.promise; return String(markdown.length); };
  a.edit("a".repeat(16 * MIB));
  const large = a.menu("export_pdf");
  await slow.promise;
  a.edit("a".repeat(16 * MIB + 1));
  release.resolve();
  await large;
  assert.match(a.get("notice").textContent, /changed while preparing print/);
  assert.ok(!a.calls.some(([name]) => name === "print_document"));
  assert.ok(!a.rendered.includes(String(16 * MIB)));
  a.edit("second");

  const errors = [];
  a.dialog.message = message => { errors.push(message); };
  a.api.render = () => { throw Error("Renderer unavailable"); };
  await a.menu("export_pdf");
  assert.match(errors.at(-1), /could not be rendered for printing/);
  assert.ok(!a.calls.some(([name]) => name === "print_document"));
  assert.equal(a.text(), "second");
});

test("an update keeps untouched preview blocks without serialising them", async () => {
  const a = await app();
  const preview = a.get("preview"), serialised = [];
  preview.childNodes = [];
  preview.insertBefore = (node, before) => {
    const at = before ? preview.childNodes.indexOf(before) : preview.childNodes.length;
    preview.childNodes.splice(at, 0, node);
  };
  // One block per line: "text@line".
  a.hooks.parse = html => html.split("\n").map(row => {
    const [text, line] = row.split("@");
    return {
      nodeType: 1, text, attrs: {"data-sourcepos": line + ":1-" + line + ":9"},
      get outerHTML() { serialised.push(text); return `<p data-sourcepos="${this.attrs["data-sourcepos"]}">${text}</p>`; },
      isEqualNode(other) { return other.text === text && other.attrs["data-sourcepos"] === this.attrs["data-sourcepos"]; },
      getAttribute(name) { return this.attrs[name] ?? null; }, setAttribute(name, value) { this.attrs[name] = value; },
      querySelectorAll: () => [], matches: () => false,
      remove() { preview.childNodes.splice(preview.childNodes.indexOf(this), 1); },
    };
  });
  a.api.render = ({markdown}) => markdown;
  const show = async html => { a.edit(html); await a.fire(70); return [...preview.childNodes]; };
  const lines = nodes => nodes.map(node => parseInt(node.attrs["data-sourcepos"], 10));

  const first = await show("A@1\nB@3\nC@5\nD@7");
  assert.deepEqual(first.map(node => node.text), ["A", "B", "C", "D"]);
  serialised.length = 0;
  const typed = await show("A@1\nB2@3\nC@5\nD@7");
  assert.deepEqual(serialised, ["B2"], "only the edited block is serialised");
  assert.ok(typed[0] === first[0] && typed[2] === first[2] && typed[3] === first[3] && typed[1] !== first[1]);

  serialised.length = 0;
  const shifted = await show("A@1\nNew@3\nB2@5\nC@7\nD@9");
  assert.ok(shifted[0] === typed[0] && shifted[2] === typed[1] && shifted[4] === typed[3], "moved blocks keep their nodes");
  assert.deepEqual(lines(shifted), [1, 3, 5, 7, 9], "and take over their new source lines");
  assert.deepEqual(serialised.sort(), ["B2", "C", "D", "New"], "blocks above the new line are compared as they stand");
});


test("native preference revisions protect pending local edits and synchronize clean windows", async () => {
  const a = await app({"kladje.theme":'"dark"'});
  assert.equal(a.values.has("kladje.theme"),false);
  const wait = gate(), started = gate();
  a.api.set_preference = async ({key,value}) => {
    started.resolve(); await wait.promise;
    return {revision:8,values:{theme:"light",[key]:value}};
  };
  await a.menu("gutter");
  await started.promise;
  const receive = a.events["preferences-changed"];
  receive({payload:{revision:7,values:{theme:"light",gutter:false}}});
  assert.equal(a.get("pref-gutter").checked,true);
  receive({payload:{revision:6,values:{theme:"dark",gutter:false}}});
  wait.resolve(); await new Promise(setImmediate);
  receive({payload:{revision:9,values:{theme:"light",gutter:false}}});
  assert.equal(a.get("pref-gutter").checked,false);
});

test("an unreadable settings file preserves migration data and allows editing and saving", async () => {
  const a = await app({"kladje.theme":'"light"'}, ({api}) => {
    api.read_preferences = () => {throw Error("damaged settings");};
  });
  assert.equal(a.values.get("kladje.theme"),'"light"');
  await a.menu("gutter");
  a.edit("safe draft"); await a.menu("save");
  assert.equal(a.disk.content,"safe draft");
  assert.ok(!a.calls.some(([cmd]) => cmd === "set_preference"));
});

test("document check discards a result if the source changed while files were inspected", async () => {
  const a = await app(), start = gate(), finish = gate();
  a.api.check_document = async () => {start.resolve(); await finish.promise; return "old result";};
  let messages = 0;
  a.dialog.message = () => {messages++;};
  const checking = a.menu("check_document");
  await start.promise; a.edit("new text"); finish.resolve(); await checking;
  assert.equal(messages,0);
  assert.match(a.get("notice").textContent,/changed/);
});
