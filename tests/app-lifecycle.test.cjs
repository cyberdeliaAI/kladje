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

async function app(initial = {}, configure = () => {}) {
  const ready = gate(), events = {}, calls = [], values = new Map(Object.entries(initial));
  const disk = { path: "/notes/a.md", content: "original", version: { target: "/notes/a.md", digest: "a" } };
  const format = { encoding: "utf8", eol: "lf" };
  disk.format = format;
  let text = "", change;
  const element = () => ({
    scrollTop: 0, scrollHeight: 100, clientHeight: 100, children: [], childNodes: [], dataset: {}, style: { setProperty() {} }, classList: { add() {}, remove() {}, toggle() {} },
    firstElementChild: {}, content: { childNodes: [], querySelectorAll: () => [] }, append() {}, replaceChildren(...nodes) { this.children = nodes; }, show() { this.open = true; }, showModal() { this.open = true; }, close() { this.open = false; },
    attrs: {}, handlers: {}, setSelectionRange(from, to) { this.selection = [from, to]; }, setAttribute(k,v) { this.attrs[k]=v; }, getAttribute(k) { return this.attrs[k]; }, focus() {},
    addEventListener(k,f) { this.handlers[k]=f; }, querySelector: () => null, querySelectorAll: () => [], getBoundingClientRect: () => ({ top: 0 }),
  });
  const rendered = [], comparisons = [];
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
  const api = {
    take_fragment() {}, document_ready() {}, accept_reload() {}, begin_close:()=>true, cancel_close() {},
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
    window_bounds: () => null, set_menu_checks() {},
    setup: () => ({ pendingOpen: disk.path }), take_pending_open: () => null, read_file: () => ({ ...disk }),
    file_version: () => disk.version, render: () => "", log_message: ({ message }) => { if (message === "ready") ready.resolve(); },
    recovery_list: () => [], recovery_clear() {}, recovery_write() {},
    write_file: ({content}) => { disk.content = content; return {version: disk.version, confirmed: true}; }, quit() { return events["prepare-quit"]({payload:{epoch:1,rememberWindow:true}}); },
  };
  const dialog = { message: () => "Cancel", ask: () => false };
  configure({ api, dialog, disk });
  const pendingTimers = new Map();
  let nextTimer = 0;
  const nativeWindow = { setTitle: async () => {}, onCloseRequested: cb => { events.close = cb; }, destroy: async () => { calls.push(["destroy"]); } };
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
    if (tag === "template") Object.defineProperty(node, "innerHTML", {set(html) { rendered.push(html); }});
    return node;
  } },
    FileReader: class { readAsDataURL(file) { this.result = "data:" + file.type + ";base64," + file.encoded; this.onload(); } },
    getComputedStyle: () => ({lineHeight:"18px"}), performance, Intl, crypto: require("node:crypto").webcrypto, console, clearTimeout: id => pendingTimers.delete(id),
    setTimeout(fn, delay) { pendingTimers.set(++nextTimer, {fn, delay}); return nextTimer; },
    localStorage: { getItem: k => values.get(k), setItem: (k,v) => values.set(k,v), removeItem: k => values.delete(k) } });
  vm.runInContext(source("document-session.js"),context);
  vm.runInContext(source("app.js"),context);
  await ready.promise;
  async function fire(delay) {
    const entry = [...pendingTimers].find(([, timer]) => timer.delay === delay);
    assert.ok(entry, `no pending timer at ${delay} ms`);
    pendingTimers.delete(entry[0]);
    return entry[1].fn();
  }
  return { comparisons, children, history:()=>history, disk, api, calls, dialog, events, get, values, fire, rendered, view, menu: id => events.menu({payload: id}), edit: v => view.replaceText(v), text: view.getText };
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
  a.get("preview").querySelectorAll = () => links;
  a.events.beforeprint();
  assert.deepEqual(links.map(link => link.href), ["https://example.com", "mailto:editor@example.org", "#part", null]);
  a.events.afterprint();
  assert.ok(links.every(link => link.href === "#"));
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
  assert.equal(a.values.get("kladje.zoom"),"1");
  assert.equal(a.values.get("kladje.split"),"50");
  await a.menu("gutter"); await a.menu("wrap");
  await new Promise(done => setImmediate(done));
  assert.equal(a.values.get("kladje.gutter"),"true");
  assert.equal(a.values.get("kladje.wrap"),"false");
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
  assert.equal(a.get("heading-list").children[0].value, 101);
  a.get("heading-filter").value = "last";
  a.get("heading-filter").handlers.input();
  assert.equal(a.get("heading-list").children[0].value, 120);
  assert.equal(a.get("heading-pages").hidden, true);
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
  assert.match(a.get("heading-list").children[0].textContent,/Current/);
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

test("paused preview skips reading the full document and resumes below its limit", async () => {
  const a = await app();
  await a.menu("view_editor");
  a.edit("a".repeat(256 * 1024 + 1));
  let reads = 0;
  a.view.getText = () => { reads++; return a.text(); };
  await a.menu("view_split");
  await new Promise(setImmediate);
  assert.match(a.get("preview").textContent, /Live preview is paused/);
  assert.equal(reads, 0);
  a.api.render = ({markdown}) => markdown;
  a.edit("short draft");
  await a.fire(70);
  assert.equal(a.rendered.at(-1), "short draft");
});
