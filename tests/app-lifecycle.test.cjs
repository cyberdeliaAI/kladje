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
    firstElementChild: {}, content: { childNodes: [], querySelectorAll: () => [] }, append() {}, replaceChildren(...nodes) { this.children = nodes; }, showModal() { this.open = true; }, close() { this.open = false; },
    attrs: {}, handlers: {}, setSelectionRange(from, to) { this.selection = [from, to]; }, setAttribute(k,v) { this.attrs[k]=v; }, getAttribute(k) { return this.attrs[k]; }, focus() {},
    addEventListener(k,f) { this.handlers[k]=f; }, querySelector: () => null, querySelectorAll: () => [], getBoundingClientRect: () => ({ top: 0 }),
  });
  const rendered = [];
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const view = {
    selection: () => EditorSelection.single(0), textLength: () => text.length, location: () => ({offset:0,top:1}), restoreLocation() {}, configureLayout() {}, statistics: () => ({words: 1, characters: text.length}),
    getText: () => text, setText(v) { text = v; }, replaceText(v) { text = v; change(); },
    insertImage(relative) { text += " IMAGE " + relative; change(); },
    cursor: () => ({ line: 1, column: 1, lines: 1 }), scroller: element(), remeasure() {}, focus() {},
  };
  const api = {
    window_bounds: () => null, set_recent_menu() {}, set_menu_checks() {},
    setup: () => ({ pendingOpen: disk.path }), take_pending_open: () => null, read_file: () => ({ ...disk }),
    file_version: () => disk.version, render: () => "", log_message: ({ message }) => { if (message === "ready") ready.resolve(); },
    recovery_list: () => [], recovery_clear() {}, recovery_write() {},
    write_file: ({content}) => { disk.content = content; return {version: disk.version, confirmed: true}; }, quit() {},
  };
  const dialog = { message: () => "Cancel", ask: () => false };
  configure({ api, dialog, disk });
  const pendingTimers = new Map();
  let nextTimer = 0;
  const nativeWindow = { setTitle: async () => {}, onCloseRequested: cb => { events.close = cb; }, destroy: async () => { calls.push(["destroy"]); } };
  const win = {
    KladjeEditor: { create(_, options) { change = options.onChange; return view; } },
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
  return { disk, api, calls, dialog, events, get, values, fire, rendered, view, menu: id => events.menu({payload: id}), edit: v => view.replaceText(v), text: view.getText };
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
  assert.ok(!a.calls.some(([name]) => name === "quit"));
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
  assert.ok(!a.calls.some(([name]) => name === "quit"));
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
  assert.equal(a.values.get("kladje.lastPath"), JSON.stringify(a.disk.path));
  a.dialog.ask = (_, {title}) => title === "Encoding conversion";
  await a.menu("save_as");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].format.encoding, "utf8");
  assert.equal(saved[0].expected, null);
  assert.equal(a.disk.content, "original");
  assert.equal(a.values.get("kladje.lastPath"), JSON.stringify(copy));
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
  const latest = a.calls.filter(([name]) => name === "render").at(-1)[1];
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
  const a = await app();
  await a.menu("new");
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
  assert.deepEqual(a.calls.filter(([name]) => name === "read_file").map(([,args]) => args.path),
    [a.disk.path, "/notes/two.md", "/notes/three.md"]);
  assert.equal(a.text(), "/notes/three.md");
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
  const paths = JSON.parse(a.values.get("kladje.recent"));
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
  assert.ok(JSON.parse(a.values.get("kladje.recent")).includes(path));
  a.dialog.message = () => "Remove from Recent";
  await a.menu("recent:"+path);
  assert.ok(!JSON.parse(a.values.get("kladje.recent")).includes(path));
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
  assert.equal(JSON.parse(a.values.get("kladje.recent"))[0],"/notes/c.md");
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

test("remembered positions restore only for matching disk content", async () => {
  const a = await app();
  const restored=[];
  a.view.location=()=>({offset:4,top:2});
  a.view.restoreLocation=p=>restored.push(p.offset);
  a.dialog.open=()=>"/notes/b.md";
  a.api.read_file=({path})=>({...a.disk,path});
  await a.menu("open");
  await a.menu("recent:"+a.disk.path);
  assert.deepEqual(restored,[4]);
  await a.menu("open");
  a.disk.version={...a.disk.version,digest:"replacement"};
  await a.menu("recent:"+a.disk.path);
  assert.equal(restored.length,2); // B was restored before changing A on disk.
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
  a.edit("new draft");
  a.dialog.save = () => null;
  await imagePaste(a).done;
  assert.equal(a.text(), "new draft");
  assert.equal(a.calls.filter(([cmd]) => cmd === "paste_image").length, 1);
});

test("comparison displays two read-only text snapshots and retains the original save baseline", async () => {
  const a = await app();
  const diskVersion = a.disk.version;
  a.edit("shared\nlocal 😀\nend");
  a.api.comparison_text = () => "shared\r\n<svg>disk</svg>\r\nend";
  await a.menu("compare_disk");
  assert.equal(a.get("comparison").open, true);
  assert.match(a.get("comparison-summary").textContent, /line 2/);
  assert.deepEqual(a.get("comparison-editor").selection, [7,15]);
  assert.equal(a.get("comparison-disk").value, "shared\n<svg>disk</svg>\nend");
  a.get("comparison").close();
  a.get("comparison").handlers.close();
  assert.equal(a.get("comparison-disk").value, "");
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
  a.dialog.message = () => "Don't Save";
  await a.menu("new_template");
  assert.equal(a.text(), "# Template\n");
  assert.match(a.get("doc-name").title, /Not saved yet.*edited/);
  const recovery = a.calls.filter(([cmd]) => cmd === "recovery_write").at(-1);
  assert.equal(recovery[1].draft.path, null);
  assert.ok(!JSON.parse(a.values.get("kladje.recent")).includes("/notes/template.md"));
  let defaultPath;
  a.dialog.save = options => { defaultPath = options.defaultPath; return null; };
  await a.menu("save");
  assert.equal(defaultPath, "Untitled.md");
  assert.equal(a.disk.content, "original");
});

test("template rereads the saved source when the discard dialog saves back to the chosen file", async () => {
  const a = await app();
  a.dialog.open = () => a.disk.path;
  a.dialog.message = () => "Save";
  a.api.write_file = ({content}) => {
    a.disk.content = content;
    a.disk.version = {...a.disk.version, digest:"saved"};
    return {version:a.disk.version, confirmed:true};
  };
  a.edit("new template text");
  await a.menu("new_template");
  assert.equal(a.text(), "new template text");
  assert.match(a.get("doc-name").title, /Not saved yet.*edited/);
});

test("comparison treats CRLF as the same text and a missing disk version leaves edits intact", async () => {
  const a = await app();
  a.edit("one\ntwo");
  a.api.comparison_text = () => "one\r\ntwo";
  await a.menu("compare_disk");
  assert.match(a.get("comparison-summary").textContent, /same text/);
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
