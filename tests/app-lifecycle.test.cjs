// Drive the shipped app through its menu/focus/close entry points. Only the
// native bridge, CodeMirror view and DOM are doubled; I/O gates are explicit.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
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
    firstElementChild: {}, content: { childNodes: [], querySelectorAll: () => [] }, append() {}, replaceChildren() {},
    addEventListener() {}, querySelectorAll: () => [], getBoundingClientRect: () => ({ top: 0 }),
  });
  const elements = new Map();
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const view = {
    getText: () => text, setText(v) { text = v; }, replaceText(v) { text = v; change(); },
    cursor: () => ({ line: 1, column: 1, lines: 1 }), scroller: element(), remeasure() {}, focus() {},
  };
  const api = {
    setup: () => ({ pendingOpen: disk.path }), read_file: () => ({ ...disk }),
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
  const context = vm.createContext({ window: win, document: { getElementById: get, documentElement: element(), createElement: element },
    performance, Intl, crypto: require("node:crypto").webcrypto, console, clearTimeout: id => pendingTimers.delete(id),
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
  return { disk, api, calls, dialog, events, get, values, fire, menu: id => events.menu({payload: id}), edit: v => view.replaceText(v), text: view.getText };
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
  a.api.read_file = () => { throw Error("Unsupported image"); };
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
