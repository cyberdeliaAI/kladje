// Kladje — application logic. Plain JavaScript, no framework and no build step.
// Rendering, file access, import and export all happen in Rust (see src-tauri).

(() => {
  "use strict";

  const T = window.__TAURI__;
  if (!T) {
    document.body.textContent = "Kladje has to be started as an application.";
    return;
  }
  const { invoke } = T.core;
  const appWindow = T.window.getCurrentWindow();

  const $ = (id) => document.getElementById(id);
  const els = {
    app: $("app"),
    panes: $("panes"),
    editorPane: $("editor-pane"),
    previewPane: $("preview-pane"),
    preview: $("preview"),
    divider: $("divider"),
    docName: $("doc-name"),
    notice: $("notice"),
    stats: $("stats"),
    viewSwitch: $("view-switch"),
  };

  const MARKDOWN_EXT = ["md", "markdown", "mdown", "mkd", "mdx", "txt"];
  const IMPORT_EXT = ["html", "htm", "xhtml", "docx", "txt"];

  // ---------------------------------------------------------------- settings

  let applyingPreference = false;
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem("kladje." + key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      if (applyingPreference) return true;
      try {
        localStorage.setItem("kladje." + key, JSON.stringify(value));
        return true;
      } catch {
        return false;
      }
    },
    remove(key) {
      try {
        localStorage.removeItem("kladje." + key);
      } catch {}
    },
  };

  // ---------------------------------------------------------------- state

  const draftId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)),
    byte => byte.toString(16).padStart(2, "0")).join("");
  const doc = { id: draftId(), hasRecovery: false, recovered: false, path: null, name: "Untitled", version: null, format: null };
  let config = { syntaxCssLight: "", syntaxCssDark: "", idPrefix: "" };
  let viewMode = store.get("view", window.matchMedia("(max-width: 640px)").matches ? "editor" : "split");
  let themeSetting = store.get("theme", "auto");
  function storedFlag(key, fallback) {
    const value = store.get(key, fallback);
    return typeof value === "boolean" ? value : fallback;
  }
  if (!["auto", "light", "dark"].includes(themeSetting)) themeSetting = "auto";
  let syncEnabled = storedFlag("sync", true);
  let gutter = storedFlag("gutter", false), wrap = storedFlag("wrap", true), measure = storedFlag("measure", true);
  const settings = $("settings");
  const writing = {pairing:true, linkPaste:true, htmlPaste:false, confirmImage:true, readingTime:false, focusParagraph:false, typewriter:false};
  for (const [key, fallback] of Object.entries(writing)) {
    writing[key] = storedFlag(key, fallback);
    const control = $(key);
    control.checked = writing[key];
    control.addEventListener("change", () => {
      writing[key] = control.checked;
      store.set(key, control.checked);
      if (key === "focusParagraph" || key === "typewriter") applyWritingModes();
      if (key === "pairing") editor.setPairing(control.checked);
      if (key === "readingTime") updateStats();
    });
  }
  function applyWritingModes() {
    editor.setWritingModes(writing.focusParagraph, writing.typewriter);
    els.editorPane.dataset.focusParagraph = String(writing.focusParagraph);
    els.editorPane.dataset.typewriter = String(writing.typewriter);
  }
  let sidebarOpen = false;
  let checkUpdate = Promise.resolve();
  function syncChecks() {
    const checked = ["view_" + viewMode, "theme_" + themeSetting];
    for (const [id, enabled] of Object.entries({sync_scroll:syncEnabled, gutter, wrap, measure, document_outline:sidebarOpen})) {
      if (enabled) checked.push(id);
    }
    checkUpdate = checkUpdate.then(() => invoke("set_menu_checks", {checked})).catch(report);
  }
  function applyEditorLayout() {
    editor.configureLayout({gutter, wrap});
    els.app.dataset.measure = String(measure);
    els.app.dataset.wrap = String(wrap);
    anchors = null;
    syncChecks();
  }
  let zoom = store.get("zoom", 1);
  let initializing = true;
  let busy = false; // a dialog or file operation is in progress

  // ---------------------------------------------------------------- helpers

  const basename = (p) => p.slice(Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\")) + 1);
  const dirname = (p) => {
    const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
    return i < 0 ? "" : p.slice(0, Math.max(i, 1));
  };
  const extension = (p) => {
    const name = basename(p);
    const i = name.lastIndexOf(".");
    return i > 0 ? name.slice(i + 1).toLowerCase() : "";
  };
  const stem = (p) => {
    const name = basename(p);
    const i = name.lastIndexOf(".");
    return i > 0 ? name.slice(0, i) : name;
  };

  function resolvePath(dir, relative) {
    const sep = dir.includes("\\") && !dir.includes("/") ? "\\" : "/";
    const parts = dir.split(/[\\/]/);
    for (const segment of relative.replace(/\\/g, "/").split("/")) {
      if (segment === "" || segment === ".") continue;
      if (segment === "..") {
        if (parts.length > 1) parts.pop();
      } else {
        parts.push(segment);
      }
    }
    return parts.join(sep);
  }

  let history = {paths:[], places:[]};
  const recentPaths = () => history.paths;
  const savedPlaces = () => history.places;
  async function updateHistory(change) {
    const paths = store.get("recent", []), places = store.get("places", []);
    const lastPath = store.get("lastPath", null);
    const seed = {lastPath:typeof lastPath === "string" ? lastPath : null, paths:Array.isArray(paths) ? paths.filter(p => typeof p === "string") : [],
      places:Array.isArray(places) ? places.filter(p => p && typeof p.path === "string" &&
        typeof p.digest === "string" && Number.isSafeInteger(p.offset) && Number.isFinite(p.top)) : []};
    try {
      history = await invoke("update_history", {change, seed});
      store.remove("recent");
      store.remove("places");
      store.remove("lastPath");
    } catch (error) { notify(`Recent documents: ${error}`, 12000); }
  }
  const rememberPath = (path, resume = true) => updateHistory({kind:"touch", path, resume});
  function rememberPlace() {
    if (!doc.path || !doc.version || session.isDirty()) return;
    return updateHistory({kind:"position", place:{path:doc.path, digest:doc.version.digest, ...editor.location()}});
  }

  function applyPreference(key) {
    applyingPreference = true;
    try {
      if (key in writing) {
        writing[key] = storedFlag(key, writing[key]);
        $(key).checked = writing[key];
        if (key === "pairing") editor.setPairing(writing.pairing);
        if (key === "readingTime") updateStats();
        if (key === "focusParagraph" || key === "typewriter") applyWritingModes();
      } else if (key === "theme") setTheme(store.get(key, "auto"));
      else if (key === "view") setView(store.get(key, "split"));
      else if (key === "zoom") setZoom(store.get(key, 1));
      else if (key === "split") setSplit(store.get(key, 50));
      else if (key === "sync") { syncEnabled = storedFlag(key, true); syncChecks(); }
      else if (["gutter","wrap","measure"].includes(key)) {
        gutter = storedFlag("gutter", false);
        wrap = storedFlag("wrap", true);
        measure = storedFlag("measure", true);
        applyEditorLayout();
      }
    } finally { applyingPreference = false; }
  }

  window.addEventListener("storage", event => {
    if (event.key?.startsWith("kladje.")) applyPreference(event.key.slice(7));
  });

  async function openRecent(path) {
    await updateHistory({kind:"read"});
    if (!recentPaths().includes(path)) return;
    try {
      return await openOrImport(path);
    } catch (error) {
      // A permission or format error should keep the entry available.
      if (await invoke("file_version", {path})) return showError(error);
    }
    const answer = await T.dialog.message(`“${basename(path)}” is unavailable. Choose its new location or remove it from Open Recent.`, {
      title: "Recent Document", buttons: {yes: "Locate…", no: "Remove from Recent", cancel: "Cancel"},
    });
    if (answer === "Cancel") return;
    if (answer === "Locate…" || answer === "Yes") {
      if (!await chooseAndOpen() || recentPaths()[0] === path) return;
    } else if (answer !== "Remove from Recent" && answer !== "No") return;
    await updateHistory({kind:"remove", path});

  }

  let noticeTimer = 0;
  function notify(message, ms = 4500) {
    els.notice.textContent = message;
    els.notice.classList.add("visible");
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => els.notice.classList.remove("visible"), ms);
  }

  async function showError(error) {
    const message = typeof error === "string" ? error : (error && error.message) || String(error);
    try {
      await T.dialog.message(message, { title: "Kladje", kind: "error" });
    } catch {
      notify(message, 8000);
    }
  }

  function report(error) {
    const message = (error && (error.stack || error.message)) || String(error);
    invoke("log_message", { message }).catch(() => {});
  }
  window.addEventListener("error", (e) => report(e.error || e.message));
  window.addEventListener("unhandledrejection", (e) => report(e.reason));

  // ---------------------------------------------------------------- editor

  const editor = window.KladjeEditor.create(els.editorPane, {
    placeholderText: "Start writing…",
    onChange: onDocumentChanged,
    onSelection: () => schedule("stats", updateStats, 60),
  });

  const session = new DocumentSession(() => editor.getText());
  const timers = {};
  function schedule(name, fn, delay) {
    clearTimeout(timers[name]);
    timers[name] = setTimeout(fn, delay);
  }

  function onDocumentChanged() {
    session.changed();
    if (sidebarOpen) schedule("sidebar", refreshSidebar, 500);
    if (els.notice.textContent === "Saved") {
      els.notice.classList.remove("visible");
      els.notice.textContent = "";
    }
    scheduleRender();
    schedule("chrome", refreshChrome, 50);
    schedule("recovery", saveRecovery, 900);
    if (!timers.recoveryDeadline) timers.recoveryDeadline = setTimeout(saveRecovery, 5000);
  }

  // ---------------------------------------------------------------- chrome

  let shownTitle = null;
  function refreshChrome() {
    const dirty = session.isDirty();
    els.docName.classList.toggle("dirty", dirty);
    const label = doc.recovered ? `${doc.name} (recovered)` : doc.name;
    const filename = els.docName.firstElementChild;
    const stateLabel = $("doc-state");
    const stateText = dirty ? " — Unsaved changes" : "";
    if (filename.textContent !== label) filename.textContent = label;
    if (stateLabel.textContent !== stateText) stateLabel.textContent = stateText;
    els.docName.title = (doc.path || "Not saved yet") + (dirty ? " — edited" : "");
    const title = `${dirty ? "• " : ""}${doc.name} — Kladje`;
    if (title !== shownTitle) {
      shownTitle = title;
      document.title = title;
      appWindow.setTitle(title).catch(() => {});
    }
    updateStats();
  }

  const number = new Intl.NumberFormat("en-US");
  function updateStats() {
    const counts = editor.statistics();
    const c = editor.cursor();
    const selection = c.selected === null ? " · large selection" : c.selected ? ` · ${number.format(c.selectedWords)} words / ${number.format(c.selected)} characters selected` : "";
    const column = c.column === null ? "" : `, Col ${c.column}`;
    els.stats.innerHTML = "";
    const position = document.createElement("span");
    position.className = "optional";
    position.textContent = `Ln ${number.format(c.line)}${column}${selection}  ·  `;
    const encoding = {utf8:"UTF-8", utf8bom:"UTF-8 BOM", utf16le:"UTF-16 LE", utf16be:"UTF-16 BE", latin1:"Latin-1"};
    const format = doc.format ? (encoding[doc.format.encoding] || "") + " · " + doc.format.eol.toUpperCase() : "";
    const details = document.createElement("span");
    details.className = "optional";
    const minutes = counts && writing.readingTime && counts.words ? Math.ceil(counts.words / 200) : 0;
    details.textContent = (minutes ? ` · ~${minutes} min read` : "") + (format ? " · " + format : "");
    els.stats.title = position.textContent + (counts ? counts.words + " words" : c.lines + " lines") + details.textContent;
    els.stats.append(
      position,
      counts ? `${number.format(counts.words)} ${counts.words === 1 ? "word" : "words"}  ·  ${number.format(counts.characters)} characters` : `${number.format(c.lines)} lines`, details,
    );
  }

  // ---------------------------------------------------------------- theme, layout, zoom

  window.addEventListener("pointerdown", () => { els.app.dataset.pointerFocus = "true"; }, true);
  window.addEventListener("keydown", event => {
    if (event.key === "Tab" || event.key === "Escape") els.app.dataset.pointerFocus = "false";
  }, true);
  const systemDark = window.matchMedia("(prefers-color-scheme: dark)");
  function applyTheme() {
    const dark = themeSetting === "dark" || (themeSetting === "auto" && systemDark.matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    $("syntax-screen").textContent = dark ? config.syntaxCssDark : config.syntaxCssLight;
    $("syntax-print").textContent = config.syntaxCssLight;
  }
  systemDark.addEventListener("change", applyTheme);

  function setTheme(setting) {
    themeSetting = setting;
    syncChecks();
    store.set("theme", setting);
    applyTheme();
  }

  function setView(mode) {
    viewMode = ["editor", "split", "preview"].includes(mode) ? mode : "split";
    els.app.dataset.view = viewMode;
    syncChecks();
    store.set("view", viewMode);
    for (const button of els.viewSwitch.children) {
      button.setAttribute("aria-pressed", String(button.dataset.view === viewMode));
    }
    anchors = null;
    editor.remeasure();
    if (viewMode !== "editor") renderNow().then(() => activePane === "editor" && syncFromEditor());
    if (!applyingPreference) focusDocument();
  }

  function setZoom(value) {
    zoom = Math.min(1.8, Math.max(0.7, Math.round((Number.isFinite(value) ? value : 1) * 10) / 10));
    store.set("zoom", zoom);
    document.documentElement.style.setProperty("--zoom", zoom);
    anchors = null;
    editor.remeasure();
  }

  function setSplit(percent) {
    const clamped = Math.min(80, Math.max(20, Number.isFinite(percent) ? percent : 50));
    els.panes.style.setProperty("--split", clamped + "%");
    const sourceWidth = Math.round(clamped);
    els.divider.setAttribute("aria-valuenow", String(sourceWidth));
    els.divider.setAttribute("aria-valuetext", `${sourceWidth}% source, ${100 - sourceWidth}% preview`);
    store.set("split", clamped);
    anchors = null;
    editor.remeasure();
  }

  els.viewSwitch.addEventListener("click", (e) => {
    const button = e.target.closest("button[data-view]");
    if (button) setView(button.dataset.view);
  });

  els.divider.addEventListener("keydown", (event) => {
    const current = Number(els.divider.getAttribute("aria-valuenow"));
    const next = {ArrowLeft: current - 5, ArrowRight: current + 5, Home: 20, End: 80, Enter: 50};
    if (event.key === "Escape") { event.preventDefault(); editor.focus(); }
    if (Object.hasOwn(next, event.key)) { event.preventDefault(); setSplit(next[event.key]); }
  });

  els.divider.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    els.divider.setPointerCapture(e.pointerId);
    els.divider.classList.add("dragging");
    els.app.classList.add("resizing");
    const move = (ev) => {
      const rect = els.panes.getBoundingClientRect();
      setSplit(((ev.clientX - rect.left) / rect.width) * 100);
    };
    const stop = () => {
      els.divider.classList.remove("dragging");
      els.app.classList.remove("resizing");
      els.divider.removeEventListener("pointermove", move);
      els.divider.removeEventListener("pointerup", stop);
      els.divider.removeEventListener("pointercancel", stop);
    };
    els.divider.addEventListener("pointermove", move);
    els.divider.addEventListener("pointerup", stop);
    els.divider.addEventListener("pointercancel", stop);
  });
  els.divider.addEventListener("dblclick", () => setSplit(50));

  // ---------------------------------------------------------------- preview rendering

  const SOURCEPOS = / data-sourcepos="[^"]*"/g;
  const nodeKeys = new WeakMap();
  let renderPromise = null;
  let renderAgain = false;
  let renderCost = 0;
  let previewAssets = new Map();

  function scheduleRender() {
    if (viewMode === "editor") return; // rendered on demand when the preview is shown
    // Stay responsive on big documents: wait longer when rendering is slow.
    schedule("render", renderNow, Math.min(700, Math.max(70, renderCost * 1.5)));
  }

  /** Render the current text; resolves once the preview is up to date. */
  function renderNow() {
    clearTimeout(timers.render);
    if (renderPromise) {
      renderAgain = true;
      return renderPromise;
    }
    renderPromise = Promise.resolve().then(async () => {
      let ready = false;
      try {
        do {
          renderAgain = false;
          const started = performance.now();
          if (editor.textLength() > 256 * 1024) {
            previewAssets.clear();
            anchors = null;
            els.preview.textContent = "Live preview is paused for this large document. You can keep editing and saving.";
            return false;
          }
          const snapshot = session.snapshot();
          const source = doc.path, remote = doc.remote;
          let html, failure;
          try {
            html = await invoke("render", { markdown: snapshot.content, source, remote, knownImages: [...previewAssets.keys()] });
          } catch (error) {
            failure = error;
          }
          if (!session.isCurrent(snapshot) || source !== doc.path || remote !== doc.remote) {
            renderAgain = true;
            continue;
          }
          if (html === undefined) throw failure || new Error("Missing preview");
          patchPreview(typeof html === "string" ? html : html.html, html.assets || {});
          bindPreviewTasks(html.tasks || {}, snapshot);
          ready = true;
          renderCost = performance.now() - started;
        } while (renderAgain);
      } catch (error) {
        report(error);
        previewAssets.clear();
        els.preview.textContent = "Preview unavailable. Your source is still open.";
        ready = false;
      } finally {
        renderPromise = null;
      }
      anchors = null;
      if (activePane === "editor") syncFromEditor();
      return ready;
    });
    return renderPromise;
  }

  const keyOf = (node) =>
    node.nodeType === 1 ? node.outerHTML.replace(SOURCEPOS, "") : "#" + node.nodeValue;

  /**
   * Update the preview by replacing only the top-level blocks that changed.
   * Unchanged blocks keep their DOM nodes, so images do not reload and the
   * scroll position stays put while typing.
   */
  function patchPreview(html, assets) {
    const template = document.createElement("template");
    template.innerHTML = html;
    for (const link of template.content.querySelectorAll("a[href]")) {
      link.dataset.destination = link.getAttribute("href");
      link.setAttribute("href", "#");
    }
    for (const img of template.content.querySelectorAll("img")) {
      if (!img.hasAttribute("src")) markMissing(img);
      else img.referrerPolicy = "no-referrer";
    }

    const root = els.preview;
    const oldNodes = Array.from(root.childNodes);
    // Compare short content-addressed references before expanding validated local images.
    const nextAssets = new Map();
    for (const img of template.content.querySelectorAll('img[src^="data:,kladje-"]')) {
      const key = img.getAttribute("src");
      const uri = assets[key] || previewAssets.get(key);
      if (uri) nextAssets.set(key, uri);
      else markMissing(img);
    }
    const newNodes = Array.from(template.content.childNodes);
    const newKeys = newNodes.map(keyOf);
    previewAssets = nextAssets;
    const oldKey = (i) => nodeKeys.get(oldNodes[i]);

    let head = 0;
    const limit = Math.min(oldNodes.length, newNodes.length);
    while (head < limit && oldKey(head) === newKeys[head]) head++;
    let oldEnd = oldNodes.length;
    let newEnd = newNodes.length;
    while (oldEnd > head && newEnd > head && oldKey(oldEnd - 1) === newKeys[newEnd - 1]) {
      oldEnd--;
      newEnd--;
    }

    for (let i = 0; i < head; i++) copyPositions(newNodes[i], oldNodes[i]);
    for (let i = 0; oldEnd + i < oldNodes.length; i++) copyPositions(newNodes[newEnd + i], oldNodes[oldEnd + i]);

    for (let i = head; i < oldEnd; i++) oldNodes[i].remove();
    const before = oldNodes[oldEnd] || null;
    for (let i = head; i < newEnd; i++) {
      nodeKeys.set(newNodes[i], newKeys[i]);
      const node = newNodes[i];
      if (node.nodeType === 1) {
        const images = node.matches('img') ? [node] : node.querySelectorAll('img[src^="data:,kladje-"]');
        for (const img of images) {
          const uri = nextAssets.get(img.getAttribute("src"));
          if (uri) img.src = uri;
        }
      }
      root.insertBefore(node, before);
    }
  }

  let taskBindings = new WeakMap();
  function bindPreviewTasks(tasks, snapshot) {
    taskBindings = new WeakMap();
    const markers = new Map(Object.entries(tasks));
    for (const box of els.preview.querySelectorAll("li.task-list-item > input.task-list-item-checkbox")) {
      const marker = markers.get(box.parentElement.getAttribute("data-sourcepos"));
      box.disabled = !marker;
      if (marker) {
        box.checked = marker.checked;
        const label = box.parentElement.textContent.trim().split("\n")[0].slice(0, 160);
        box.setAttribute("aria-label", label || "Task");
        taskBindings.set(box, {marker, snapshot});
      } else box.removeAttribute("aria-label");
    }
  }
  els.preview.addEventListener("change", event => {
    const binding = taskBindings.get(event.target);
    if (!binding) return;
    const {marker, snapshot} = binding;
    if (closing || !session.isCurrent(snapshot) || !editor.toggleTask(marker.offset, marker.checked)) {
      event.target.checked = marker.checked;
      scheduleRender();
    }
  });

  // The live preview routes links through the native opener. Supply the real
  // destinations to the print engine so PDF annotations work outside Kladje.
  window.addEventListener("beforeprint", () => {
    for (const link of els.preview.querySelectorAll("a[data-destination]")) {
      const href = link.dataset.destination;
      if (/^(?:https?:\/\/|mailto:|tel:|#)/i.test(href)) link.setAttribute("href", href);
      else link.removeAttribute("href");
    }
  });
  window.addEventListener("afterprint", () => {
    for (const link of els.preview.querySelectorAll("a[data-destination]")) link.setAttribute("href", "#");
  });

  /** Lines shift as you type; kept nodes take over the fresh source positions. */
  function copyPositions(from, to) {
    if (from.nodeType !== 1) return;
    const set = (a, b) => {
      const value = a.getAttribute("data-sourcepos");
      if (value !== null && b.getAttribute("data-sourcepos") !== value) b.setAttribute("data-sourcepos", value);
    };
    set(from, to);
    const a = from.querySelectorAll("[data-sourcepos]");
    const b = to.querySelectorAll("[data-sourcepos]");
    if (a.length !== b.length) return;
    for (let i = 0; i < a.length; i++) set(a[i], b[i]);
  }

  function markMissing(img) {
    const message = document.createElement("span");
    message.className = "asset-missing";
    message.textContent = "Image unavailable" + (img.alt ? " · " + img.alt : "");
    message.title = "Check the relative image path or enable HTTPS images in View.";
    img.replaceWith(message);
  }
  els.preview.addEventListener("error", event => {
    if (event.target.tagName === "IMG") markMissing(event.target);
  }, true);

  const outline = $("outline");
  const headingFilter = $("heading-filter");
  const headingList = $("heading-list");
  let headingRows = [], outlineSnapshot, headingPage = 0;
  function filterHeadings() {
    const needle = headingFilter.value.normalize().toLocaleLowerCase().trim();
    const matches = headingRows.filter(h => h.text.normalize().toLocaleLowerCase().includes(needle));
    const start = headingPage * 100;
    const options = matches.slice(start, start + 100).map(h => {
      const option = document.createElement("option");
      option.value = h.line;
      option.textContent = `H${h.level}  ${h.text || "(untitled heading)"} · line ${h.line}`;
      return option;
    });
    headingList.replaceChildren(...options);
    headingList.selectedIndex = options.length ? 0 : -1;
    $("heading-go").disabled = !options.length;
    $("heading-pages").hidden = matches.length <= 100;
    $("heading-prev").disabled = headingPage === 0;
    $("heading-next").disabled = start + 100 >= matches.length;
    $("heading-count").textContent = matches.length > 100 ? `Headings ${start + 1}–${start + options.length} of ${matches.length}` :
      matches.length ? `${matches.length} heading${matches.length === 1 ? "" : "s"}` : "No matching headings";
  }
  async function jumpToHeading() {
    if (sidebarOpen) { headingFilter.focus(); headingFilter.select(); return; }
    if (initializing || outline.open) return;
    const snapshot = session.snapshot();
    const rows = await invoke("document_headings", {markdown: snapshot.content});
    if (!session.isCurrent(snapshot) || outline.open) return;
    headingRows = rows;
    outlineSnapshot = snapshot;
    headingPage = 0;
    headingFilter.value = "";
    filterHeadings();
    outline.showModal();
    headingFilter.focus();
  }
  const narrowOutline = window.matchMedia("(max-width: 800px)");
  let headingRequest = 0, sidebarBusy = false, sidebarAgain = false;
  async function refreshSidebar() {
    if (!sidebarOpen) return;
    if (sidebarBusy) { sidebarAgain = true; return; }
    sidebarBusy = true;
    const request = ++headingRequest;
    const snapshot = session.snapshot();
    try {
      const rows = await invoke("document_headings", {markdown:snapshot.content});
      if (!sidebarOpen || request !== headingRequest || !session.isCurrent(snapshot)) return;
      headingRows = rows;
      outlineSnapshot = snapshot;
      headingPage = 0;
      filterHeadings();
    } catch (error) {
      if (!sidebarOpen || request !== headingRequest || !session.isCurrent(snapshot)) return;
      headingRows = [];
      outlineSnapshot = null;
      filterHeadings();
      $("heading-count").textContent = String(error);
    } finally {
      sidebarBusy = false;
      if (sidebarAgain) { sidebarAgain = false; refreshSidebar(); }
    }
  }
  function hideOutline() {
    if (sidebarOpen) {
      sidebarOpen = false;
      ++headingRequest;
      clearTimeout(timers.sidebar);
      els.app.dataset.outline = "false";
      $("outline-title").textContent = "Jump to Heading";
      $("heading-cancel").textContent = "Cancel";
      syncChecks();
      editor.remeasure();
    }
    outline.close();
  }
  function focusDocument() {
    if (viewMode === "preview") els.previewPane.focus();
    else editor.focus();
  }
  async function toggleSidebar() {
    if (sidebarOpen) { hideOutline(); focusDocument(); return; }
    if (narrowOutline.matches) { syncChecks(); return jumpToHeading(); }
    sidebarOpen = true;
    els.app.dataset.outline = "true";
    $("outline-title").textContent = "Document Outline";
    $("heading-cancel").textContent = "Hide";
    headingFilter.value = "";
    headingRows = [];
    outlineSnapshot = null;
    filterHeadings();
    outline.show();
    headingFilter.focus();
    syncChecks();
    editor.remeasure();
    await refreshSidebar();
  }
  narrowOutline.addEventListener("change", () => { if (narrowOutline.matches && sidebarOpen) hideOutline(); });
  async function chooseHeading() {
    const line = Number(headingList.value);
    if (!line || !outlineSnapshot) return;
    const snapshot = outlineSnapshot;
    if (!sidebarOpen) outline.close();
    if (!session.isCurrent(snapshot)) return;
    if (viewMode === "preview" && await renderNow() && session.isCurrent(snapshot)) {
      const heading = els.preview.querySelector(`:is(h1,h2,h3,h4,h5,h6)[data-sourcepos^="${line}:"]`);
      if (heading) {
        heading.setAttribute("tabindex", "-1");
        heading.focus({preventScroll:true});
        heading.scrollIntoView({block:"start"});
        return;
      }
    }
    if (!session.isCurrent(snapshot)) return;
    if (viewMode === "preview") setView("editor");
    editor.goToLine(line);
    editor.focus();
  }
  headingFilter.addEventListener("input", () => { headingPage = 0; filterHeadings(); });
  for (const [id, step] of [["heading-prev", -1], ["heading-next", 1]]) {
    $(id).addEventListener("click", () => { headingPage += step; filterHeadings(); headingList.focus(); });
  }
  headingFilter.addEventListener("keydown", event => {
    if (event.key === "ArrowDown") { event.preventDefault(); headingList.focus(); }
  });
  headingList.addEventListener("keydown", event => {
    if (event.key === "Enter") {
      event.preventDefault();
      chooseHeading().catch(showError);
    }
  });
  headingList.addEventListener("dblclick", () => chooseHeading().catch(showError));
  $("heading-form").addEventListener("submit", event => { event.preventDefault(); chooseHeading().catch(showError); });
  $("heading-cancel").addEventListener("click", () => {
    const pinned = sidebarOpen;
    hideOutline();
    if (pinned) focusDocument();
  });
  outline.addEventListener("keydown", event => {
    if (sidebarOpen && event.key === "Escape") { event.preventDefault(); hideOutline(); focusDocument(); }
  });
  outline.addEventListener("close", () => { if (!outline.open) { headingRows = []; outlineSnapshot = null; headingList.replaceChildren(); } });

  function jumpFragment(fragment) {
    let id;
    try { id = decodeURIComponent(fragment); } catch { id = fragment; }
    const target = els.preview.querySelector(`[id="${CSS.escape(config.idPrefix + id)}"]`);
    if (!target) { notify("Heading or reference not found", 8000); return; }
    activePane = "preview";
    target.scrollIntoView({ block: "start" });
    target.setAttribute("tabindex", "-1");
    target.focus({preventScroll: true});
  }

  els.preview.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-destination]");
    if (!link || !els.preview.contains(link)) return;
    event.preventDefault();
    const href = link.dataset.destination;
    if (href.startsWith("#")) return jumpFragment(href.slice(1));
    if (/^(https?:\/\/|mailto:|tel:)/i.test(href)) return T.opener.openUrl(href).catch(showError);
    const [file, fragment] = href.split(/#(.*)/s);
    let relative;
    try { relative = decodeURIComponent(file.split("?")[0]); } catch { return notify("Invalid document link"); }
    if (!doc.path || !MARKDOWN_EXT.includes(extension(relative)) || /^(?:[a-z]+:|[/\\])/i.test(relative) || relative.includes("\\")) {
      return notify("Unsupported document link", 8000);
    }
    const path = resolvePath(dirname(doc.path), relative);
    return runFileAction(() => openWindow({kind:"open", path, fragment})).catch(showError);
  });

  // Double-click in the preview jumps to that place in the source.
  els.preview.addEventListener("dblclick", (e) => {
    if (viewMode !== "split") return;
    const block = e.target.closest("[data-sourcepos]");
    if (!block) return;
    const line = parseInt(block.getAttribute("data-sourcepos"), 10);
    if (line > 0) {
      activePane = "editor";
      editor.goToLine(line);
      editor.focus();
    }
  });

  // ---------------------------------------------------------------- scroll sync

  const ANCHOR_SELECTOR =
    ":scope > [data-sourcepos], li[data-sourcepos], tr[data-sourcepos], dt[data-sourcepos], dd[data-sourcepos], blockquote > [data-sourcepos], .markdown-alert > [data-sourcepos]";
  let anchors = null; // [{ line, top }] strictly increasing in both
  let activePane = "editor";

  function buildAnchors() {
    const pane = els.previewPane;
    const origin = pane.getBoundingClientRect().top - pane.scrollTop;
    const list = [{ line: 1, top: 0 }];
    for (const el of els.preview.querySelectorAll(ANCHOR_SELECTOR)) {
      const line = parseInt(el.getAttribute("data-sourcepos"), 10);
      const top = el.getBoundingClientRect().top - origin;
      const last = list[list.length - 1];
      if (line > last.line && top > last.top) list.push({ line, top });
    }
    const last = list[list.length - 1];
    list.push({
      line: Math.max(editor.cursor().lines + 1, last.line + 1),
      top: Math.max(pane.scrollHeight, last.top + 1),
    });
    anchors = list;
  }

  function interpolate(value, from, to) {
    let lo = 0;
    let hi = anchors.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (anchors[mid][from] <= value) lo = mid;
      else hi = mid;
    }
    const a = anchors[lo];
    const b = anchors[hi];
    const span = b[from] - a[from];
    const ratio = span > 0 ? Math.min(1, Math.max(0, (value - a[from]) / span)) : 0;
    return a[to] + ratio * (b[to] - a[to]);
  }

  function syncFromEditor() {
    if (!syncEnabled || viewMode !== "split") return;
    const source = editor.scroller;
    const target = els.previewPane;
    const sourceMax = source.scrollHeight - source.clientHeight;
    if (source.scrollTop <= 0) target.scrollTop = 0;
    else if (source.scrollTop >= sourceMax - 1) target.scrollTop = target.scrollHeight;
    else {
      if (!anchors) buildAnchors();
      target.scrollTop = interpolate(editor.topLine(), "line", "top");
    }
  }

  function syncFromPreview() {
    if (!syncEnabled || viewMode !== "split") return;
    const source = els.previewPane;
    const sourceMax = source.scrollHeight - source.clientHeight;
    if (source.scrollTop <= 0) editor.scroller.scrollTop = 0;
    else if (source.scrollTop >= sourceMax - 1) editor.scroller.scrollTop = editor.scroller.scrollHeight;
    else {
      if (!anchors) buildAnchors();
      editor.scrollToLine(interpolate(source.scrollTop, "top", "line"));
    }
  }

  // Only the pane the user is actually driving moves the other one; that is
  // what keeps the two from chasing each other.
  for (const type of ["wheel", "pointerdown", "keydown", "touchstart"]) {
    els.editorPane.addEventListener(type, () => (activePane = "editor"), { capture: true, passive: true });
    els.previewPane.addEventListener(type, () => (activePane = "preview"), { capture: true, passive: true });
  }
  let syncFrame = 0;
  const onScroll = (pane, sync) => () => {
    if (activePane !== pane) return;
    cancelAnimationFrame(syncFrame);
    syncFrame = requestAnimationFrame(sync);
  };
  editor.scroller.addEventListener("scroll", onScroll("editor", syncFromEditor), { passive: true });
  els.previewPane.addEventListener("scroll", onScroll("preview", syncFromPreview), { passive: true });

  // Anything that changes the preview's layout invalidates the line map.
  const invalidate = () => (anchors = null);
  window.addEventListener("resize", invalidate);
  els.preview.addEventListener("load", invalidate, true);
  els.preview.addEventListener("toggle", invalidate, true);

  // ---------------------------------------------------------------- documents

  function loadDocument({ path = null, name = null, content = "", version = null, dirty = false, id = draftId(), recovered = false, format = null, revision = 0 }) {
    if (outline.open && !sidebarOpen) outline.close();
    if (comparison.open) comparison.close();
    clearRecovery();
    previewAssets.clear();
    doc.id = id;
    doc.remote = false;
    doc.recovered = recovered;
    doc.hasRecovery = recovered;
    doc.format = format || { encoding: "utf8", eol: content.includes("\r\n") ? "crlf" : "lf" };
    doc.path = path;
    doc.name = path ? basename(path) : name || "Untitled";
    doc.version = version;
    doc.ignoredVersion = null;
    editor.setText(content.replace(/\r\n?/g, "\n"));
    session.reset(editor.getText(), dirty, revision);
    if (sidebarOpen) { headingRows = []; outlineSnapshot = null; filterHeadings(); refreshSidebar(); }
    els.preview.replaceChildren();
    els.previewPane.scrollTop = 0;
    anchors = null;
    activePane = "editor";

    if (dirty && !recovered) saveRecovery();
    refreshChrome();
    renderNow();
    if (viewMode !== "preview") editor.focus();
  }

  async function openPath(path, { silent = false } = {}) {
    let file;
    try {
      file = await invoke("read_file", { path, bind:true });
    } catch (error) {
      if (!silent) await showError(error);
      return false;
    }
    await displayFile(file);
    return true;
  }

  async function displayFile(file, routed = false) {
    loadDocument(file);
    if (routed) await updateHistory({kind:"read"});
    else await rememberPath(file.path);
    const place = savedPlaces().find(p => p.path === file.path && p.digest === file.version?.digest);
    if (place) editor.restoreLocation(place);
    if (file.format.encoding === "latin1") notify("Opened as Latin-1 · its encoding will be preserved", 9000);
  }

  async function openWindow(request) {
    await invoke("open_document_window", {request});
    if (request.kind === "open" || request.kind === "import") await rememberPath(request.path, request.kind === "open");
    return true;
  }

  /** Ask what to do with unsaved changes. Resolves true when it is fine to continue. */
  async function confirmDiscard() {
    if (!session.isDirty()) return true;
    const SAVE = "Save";
    const DISCARD = "Don't Save";
    const CANCEL = "Cancel";
    const before = session.snapshot();
    // Two windows can have the same title. Give each vote enough context to identify the draft.
    const detail = doc.path || before.content.match(/^\s{0,160}([^\r\n]{1,72})/u)?.[1].trim();
    const question = `Do you want to save the changes you made to “${doc.name}”?`;
    const answer = await T.dialog.message(detail ? question + "\n\n" + detail : question, {
      title: "Unsaved changes",
      kind: "warning",
      buttons: { yes: SAVE, no: DISCARD, cancel: CANCEL },
    });
    if (!session.isCurrent(before)) return false;
    if (answer === SAVE || answer === "Yes") return save();
    return answer === DISCARD || answer === "No";
  }

  function runFileAction(action) {
    return session.run(() => !closing && action());
  }

  function queuedSave(saveAs) {
    const identity = session.document;
    return runFileAction(() => identity === session.document && save(saveAs));
  }

  async function save(saveAs = false) {
    let path = doc.path;
    if (!path || saveAs) {
      path = await T.dialog.save({
        title: "Save",
        defaultPath: doc.path || `${stem(doc.name) || "Untitled"}.md`,
        filters: [{ name: "Markdown", extensions: ["md", "markdown"] }],
      });
      if (!path) return false;
    }
    let expected = doc.version;
    if (path !== doc.path) {
      const destination = await invoke("file_version", { path });
      if (destination && doc.version && destination.target === doc.version.target) {
        expected = doc.version;
      } else {
        expected = destination;
        if (destination && !await T.dialog.ask(`Replace the existing file “${basename(path)}” with this document?`, {
          title: "Save As", kind: "warning", okLabel: "Replace File", cancelLabel: "Cancel",
        })) return false;
      }
    }
    const snapshot = session.snapshot();
    const content = snapshot.content;
    const format = { ...doc.format };
    if (format.eol === "mixed" && content.split("\n").length - 1 !== format.separators.length) {
      if (!await T.dialog.ask("The number of lines changed in this mixed-ending document. Save using LF throughout?", {
        title: "Line-ending conversion", okLabel: "Use LF", cancelLabel: "Cancel",
      })) return false;
      format.eol = "lf";
      delete format.separators;
    }
    if (format.encoding === "latin1" && /[^\u0000-\u00ff]/u.test(content)) {
      if (!await T.dialog.ask("Some characters cannot be stored in Latin-1. Save this document as UTF-8?", {
        title: "Encoding conversion", okLabel: "Use UTF-8", cancelLabel: "Cancel",
      })) return false;
      format.encoding = "utf8";
    }
    let result, copied = false;
    try {
      session.beginWrite(snapshot);
      notify("Saving…", 60000);
      try {
        result = await invoke("write_file", { path, content, format, expected, bind:true });
      } catch (error) {
        if (String(error) !== "KLADJE_COPY_REQUIRED") throw error;
        await saveRecovery();
        if (!await T.dialog.ask("This volume cannot safely publish this file at the chosen name. Save a complete copy inside a new folder beside it and continue editing the copy? Relative links will resolve from the new folder.", {
          title: "Save a Protected Copy", okLabel: "Save Copy", cancelLabel: "Cancel",
        })) {
          session.endWrite();
          notify("Copy cancelled · document remains open");
          refreshChrome();
          return false;
        }
        result = await invoke("save_protected_copy", { path, content, format });
        path = result.version.target;
        copied = true;
      }
    } catch (error) {
      session.endWrite();
      session.requireSave();
      refreshChrome();
      saveRecovery();
      notify("Save failed · edits remain open", 30000);
      const message = String(error);
      await showError(/save as/i.test(message) ? message : message + "\nUse Save As to save a separate copy.");
      return false;
    }
    session.endWrite();
    const confirmed = result.confirmed;
    const moved = path !== doc.path;
    doc.version = result.version;
    doc.format = format;
    doc.ignoredVersion = null;
    doc.path = path;
    doc.name = basename(path);
    if (confirmed && moved) await rememberPath(path);
    if (confirmed) doc.recovered = false;
    if (!confirmed) session.requireSave();
    const clean = confirmed && session.acknowledge(snapshot);
    if (clean) clearRecovery();
    else saveRecovery();
    if (confirmed) notify(clean ? (copied ? `Saved copy to ${path}` : "Saved") : "Earlier edits saved · newer edits are unsaved");
    else notify("Save unconfirmed · recovery retained · retry Save or use Save As", 60000);
    refreshChrome();
    if (moved) {
      doc.remote = false;
      // Relative image paths now resolve against the new folder.
      els.preview.replaceChildren();
      renderNow();
    }
    if (result.warning) await showError(result.warning);
    return clean;
  }

  async function newFromTemplate() {
    const path = await T.dialog.open({title: "New from Template", multiple: false,
      filters: [{name: "Markdown or plain text", extensions: MARKDOWN_EXT}]});
    if (!path) return;
    return openWindow({kind:"template", path});
  }

  const comparison = $("comparison");
  const comparisonFields = [$("comparison-editor"), $("comparison-disk")];
  comparison.addEventListener("close", () => {
    if (!comparison.open) for (const field of comparisonFields) field.value = "";
  });
  async function compareWithDisk() {
    if (!doc.path) return notify("Save the document before comparing it with disk.");
    if (editor.textLength() > 512 * 1024) return notify("Comparison supports up to 524,288 UTF-16 code units in the editor and 512 KiB on disk.", 12000);
    const before = session.snapshot();
    const disk = (await invoke("comparison_text", {path: doc.path})).replace(/\r\n?/g, "\n");
    if (!session.isCurrent(before)) return notify("The document changed. Open Compare with Disk again.");
    const source = before.content;
    const equal = disk === source;
    let line = 1, start = 0;
    if (!equal) {
      const length = Math.min(disk.length, source.length);
      for (let i = 0; i < length && source.charCodeAt(i) === disk.charCodeAt(i); i++) {
        if (source[i] === "\n") { line++; start = i + 1; }
      }
    }
    $("comparison-summary").textContent = equal ? "Both versions have the same text. Line endings and encoding are ignored." :
      `First text difference at line ${line}. Both versions are read-only snapshots.`;
    comparisonFields[0].value = source;
    comparisonFields[1].value = disk;
    comparison.showModal();
    if (!equal) {
      for (const field of comparisonFields) {
        const end = field.value.indexOf("\n", start);
        field.setSelectionRange(start, end === -1 ? field.value.length : end);
        field.scrollTop = Math.max(0, line - 3) * parseFloat(getComputedStyle(field).lineHeight);
      }
    }
  }

  async function chooseAndOpen() {
    const path = await T.dialog.open({
      title: "Open",
      multiple: false,
      directory: false,
      filters: [
        { name: "Markdown", extensions: MARKDOWN_EXT },
        { name: "All files", extensions: ["*"] },
      ],
    });
    return path ? (await openOrImport(path)) !== false : false;
  }

  async function importPath(path) {
    if (extension(path) === "docx" && !await T.dialog.ask("Import the text, supported styles, lists and tables? Embedded media, page layout and review annotations are omitted. The Word file stays intact.", {
      title: "Word Import", okLabel: "Import Markdown", cancelLabel: "Cancel",
    })) return false;
    return openWindow({kind:"import", path});
  }

  async function chooseAndImport() {
    const path = await T.dialog.open({
      title: "Import",
      multiple: false,
      directory: false,
      filters: [{ name: "HTML, Word or text", extensions: IMPORT_EXT }],
    });
    if (path) await importPath(path);
  }

  const openOrImport = path =>
    ["html", "htm", "xhtml", "docx"].includes(extension(path)) ? importPath(path) : openWindow({kind:"open", path});

  async function tryOpen(path) {
    try {
      return (await openOrImport(path)) !== false;
    } catch (error) {
      await showError(error);
      return false;
    }
  }

  async function openGuide() {
    const response = await fetch("guide.md");
    loadDocument({ name: "Markdown Guide.md", content: await response.text() });
  }

  async function exportHtml() {
    if (busy) return;
    busy = true;
    try {
      const name = `${stem(doc.name) || "Untitled"}.html`;
      const path = await T.dialog.save({
        title: "Export as HTML",
        defaultPath: doc.path ? resolvePath(dirname(doc.path), name) : name,
        filters: [{ name: "HTML", extensions: ["html"] }],
      });
      if (!path) return;
      const expected = await invoke("file_version", { path });
      if (expected && !await T.dialog.ask(`Replace “${basename(path)}” with this HTML export?`, {
        title: "Export HTML", okLabel: "Replace File", cancelLabel: "Cancel",
      })) return;
      const result = await invoke("export_html", { path, markdown: editor.getText(), title: stem(doc.name), source: doc.path, expected });
      if (result.warning) await showError(result.warning);
      if (result.confirmed) notify(`Exported ${basename(path)}`);
    } catch (error) {
      await showError(error);
    } finally {
      busy = false;
    }
  }

  async function printDocument() {
    const snapshot = session.snapshot();
    if (!await renderNow()) return showError("Print needs a current preview.");
    const images = Array.from(els.preview.querySelectorAll("img[src]"));
    let timeout;
    try {
      const decoded = Promise.all(images.map(image => image.decode())).then(() => true, () => false);
      const loaded = await Promise.race([decoded, new Promise(resolve => { timeout = setTimeout(() => resolve(false), 10000); })]);
      if ((!loaded || els.preview.querySelector(".asset-missing")) && !await T.dialog.ask("Some images are unavailable. Print the document with these images omitted?", {
        title: "Print", okLabel: "Print Anyway", cancelLabel: "Cancel",
      })) return;
      await document.fonts.ready;
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!session.isCurrent(snapshot)) return notify("Document changed while preparing print. Print again to use the latest text.", 15000);
      await invoke("print_document");
    } finally { clearTimeout(timeout); }
  }

  async function insertImage(image) {
    if (!doc.path && (!await T.dialog.ask("Save this document to give its image a relative path?", {title: "Insert Local Image", okLabel: "Save Document", cancelLabel: "Cancel"}) || !await save())) return;
    image ||= await T.dialog.open({title: "Insert Local Image", multiple: false, filters: [{name: "Images", extensions: ["png","jpg","jpeg","gif","webp"]}]});
    if (!image) return;
    let relative = await invoke("insert_image", {source: doc.path, image, copy: false});
    if (relative === null) {
      if (!await T.dialog.ask("Copy this image beside the Markdown file so the reference travels with it?", {title: "Insert Local Image", okLabel: "Copy Image", cancelLabel: "Cancel"})) return;
      relative = await invoke("insert_image", {source: doc.path, image, copy: true});
    }
    if (viewMode === "preview") setView("split");
    editor.insertImage(relative);
  }

  function clipboardBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(",") + 1));
      reader.onerror = () => reject(reader.error || Error("Could not read the clipboard image."));
      reader.readAsDataURL(file);
    });
  }

  // The platform's paste-as-plain-text shortcut bypasses writing preferences.
  let literalPasteUntil = 0;
  els.editorPane.addEventListener("keydown", event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "v") {
      literalPasteUntil = event.shiftKey ? performance.now() + 1000 : 0;
    }
  }, true);

  els.editorPane.addEventListener("paste", event => {
    const data = event.clipboardData;
    if (!event.target.closest(".cm-content") || !data || initializing || closing) return;
    if (literalPasteUntil > performance.now()) { literalPasteUntil = 0; return; }
    const plain = data.getData("text/plain");
    if (plain && writing.linkPaste && editor.pasteUrl(plain)) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const html = writing.htmlPaste && data.getData("text/html");
    if (html && html.length <= 1024 * 1024) {
      event.preventDefault();
      event.stopPropagation();
      const before = session.snapshot(), selection = editor.selection();
      return invoke("clipboard_markdown", {html}).then(converted => {
        if (!session.isCurrent(before) || !editor.selection().eq(selection) || closing) {
          return notify("The insertion point changed. Paste again.");
        }
        const text = converted.replace(/\n$/, "") || plain;
        if (text) editor.pasteText(text);
      }).catch(showError);
    }
    if (plain) return;
    const file = Array.from(data.files).find(f => f.type.startsWith("image/"));
    if (!file) return;
    event.preventDefault();
    event.stopPropagation();
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type) || file.size > 4 * 1024 * 1024) {
      return notify("Paste a PNG, JPEG, GIF or WebP image of up to 4 MiB.", 12000);
    }
    const before = session.snapshot(), selection = editor.selection();
    const current = () => session.isCurrent(before) && editor.selection().eq(selection);
    return runFileAction(async () => {
      if (!current()) return notify("The insertion point changed. Paste the image again.");
      const message = doc.path ? "Save this image in the assets folder beside this document and insert a relative link?" :
        "Choose where to save this document, then store the image in the assets folder beside it?";
      if ((!doc.path || writing.confirmImage) && !await T.dialog.ask(message, {title: "Paste Image", okLabel: doc.path ? "Save Image" : "Save Document and Image", cancelLabel: "Cancel"})) return;
      if (!current()) return notify("The insertion point changed. Paste the image again.");
      if (!doc.path && !await save()) return;
      const encoded = await clipboardBase64(file);
      if (!current()) return notify("The insertion point changed. Paste the image again.");
      const relative = await invoke("paste_image", {source: doc.path, encoded});
      if (!current()) return notify(`Saved ${relative}. The insertion point changed, so the link was left out.`, 15000);
      editor.insertImage(relative);
    }).catch(showError);
  }, true);

  // ---------------------------------------------------------------- crash recovery

  // Snapshot publication and retirement must have the same ordering, including
  // when an old document is replaced while its final snapshot is in flight.
  let recoveryIO = Promise.resolve();
  function recoveryOperation(action) {
    const result = recoveryIO.then(action);
    recoveryIO = result.catch(error => notify(`Recovery storage: ${error}. Save your document to keep these edits.`, 60000));
    return result;
  }

  function cancelRecoveryTimers() {
    clearTimeout(timers.recovery);
    clearTimeout(timers.recoveryDeadline);
    timers.recoveryDeadline = 0;
  }

  function saveRecovery() {
    cancelRecoveryTimers();
    if (!session.isDirty()) return clearRecovery();
    const draft = {
      id: doc.id, revision: session.document.revision, path: doc.path, name: doc.name,
      format: doc.format,
      version: doc.version, content: editor.getText(), time: Date.now(),
    };
    doc.hasRecovery = true;
    return recoveryOperation(() => invoke("recovery_write", { draft })).catch(() => {
      if (doc.id === draft.id && session.isDirty() && !timers.recoveryDeadline)
        timers.recoveryDeadline = setTimeout(saveRecovery, 5000);
    });
  }

  function clearRecovery() {
    cancelRecoveryTimers();
    if (!doc.hasRecovery) return recoveryIO;
    const id = doc.id;
    doc.hasRecovery = false;
    return recoveryOperation(() => invoke("recovery_clear", { id })).catch(() => {
      if (doc.id === id) doc.hasRecovery = true;
    });
  }

  // ---------------------------------------------------------------- changes made by other programs

  function sameVersion(a, b) {
    return a && b && a.target === b.target && a.digest === b.digest && a.identity === b.identity;
  }

  async function checkDisk() {
    if (!doc.path || !doc.version || closing) return;
    const before = session.snapshot();
    const version = await invoke("file_version", { path: doc.path });
    if (sameVersion(version, doc.version) || (session.isDirty() && sameVersion(version, doc.ignoredVersion))) return;
    if (!version) {
      session.requireSave();
      saveRecovery();
      refreshChrome();
      notify("File was moved or deleted · use Save As to keep a copy", 30000);
      return;
    }
    const file = await invoke("read_file", { path: doc.path });
    if (!session.isCurrent(before)) {
      notify("File changed on disk while you were editing · your edits are still open", 15000);
      return;
    }
    if (session.isDirty()) {
      const reload = await T.dialog.ask(`“${doc.name}” changed on disk. Reload the disk version and discard the edits in this window? Choose Keep Edits to use File → Compare with Disk or Save As.`, {
        title: "Conflicting changes", kind: "warning", okLabel: "Reload Disk Version", cancelLabel: "Keep Edits",
      });
      if (!session.isCurrent(before)) return;
      if (!reload) {
        doc.ignoredVersion = file.version;
        return;
      }
    }
    await invoke("accept_reload", {path:doc.path, version:file.version});
    if (!session.isCurrent(before)) return;
    const top = editor.scroller.scrollTop;
    editor.replaceText(file.content.replace(/\r\n?/g, "\n"));
    doc.version = file.version;
    doc.ignoredVersion = null;
    doc.format = file.format;
    session.acknowledge(session.snapshot());
    clearRecovery();
    editor.scroller.scrollTop = top;
    refreshChrome();
    notify(`${doc.name} was reloaded from disk.`);
  }

  let checkingDisk = false;
  window.addEventListener("focus", () => {
    syncChecks();
    if (initializing || checkingDisk || busy || closing) return;
    checkingDisk = true;
    return runFileAction(checkDisk).catch(e => notify(String(e), 15000)).finally(() => { checkingDisk = false; });
  });

  async function rememberBounds() {
    try {
      const bounds = await invoke("window_bounds");
      if (bounds) store.set("bounds", bounds);
    } catch (error) { report(error); }
  }

  let closing = false;
  async function finishClose(close) {
    if (closing || !await confirmDiscard()) return;
    closing = true;
    editor.setFrozen(true);
    els.editorPane.inert = true;
    try {
      if (!await invoke("begin_close")) {
        closing = false;
        editor.setFrozen(false);
        els.editorPane.inert = false;
        return;
      }
      await rememberPlace();
      await rememberBounds();
      await clearRecovery();
      await close();
    } catch (error) {
      closing = false;
      editor.setFrozen(false);
      els.editorPane.inert = false;
      if (session.isDirty()) saveRecovery();
      await invoke("cancel_close");
      throw error;
    }
  }

  let quitEpoch = null, cancelledThrough = 0;
  function cancelQuit() {
    if (quitEpoch === null) return;
    quitEpoch = null;
    editor.setFrozen(false);
    closing = false;
    els.app.inert = false;
    els.editorPane.inert = initializing;
  }

  function prepareQuit({epoch, rememberWindow}) {
    return session.run(async () => {
      if (closing || quitEpoch !== null || epoch <= cancelledThrough) return;
      quitEpoch = epoch;
      editor.setFrozen(true);
      closing = true;
      els.app.inert = true;
      els.editorPane.inert = true;
      let allow = false;
      try {
        await saveRecovery();
        allow = await confirmDiscard();
        if (allow) {
          await rememberPlace();
          if (rememberWindow) await rememberBounds();
        }
        await recoveryIO;
      } catch (error) { await showError(error); }
      // Don't Save is provisional until every window has agreed.
      if (quitEpoch !== epoch) return;
      try { await invoke("quit_vote", {epoch, allow, draft:doc.hasRecovery ? doc.id : null}); }
      finally { if (!allow) cancelQuit(); }
    }).catch(error => { cancelQuit(); report(error); });
  }

  // ---------------------------------------------------------------- menu

  const TABLE = "| Column 1 | Column 2 |\n| --- | --- |\n| Cell | Cell |";
  const actions = {
    new: () => runFileAction(() => openWindow({kind:"new"})),
    new_tab: () => runFileAction(() => invoke("open_document_window", {request:{kind:"new"}, tab:true})),
    open: () => runFileAction(chooseAndOpen),
    new_template: () => runFileAction(newFromTemplate),
    compare_disk: () => runFileAction(compareWithDisk),
    clear_recent: () => runFileAction(async () => {
      await updateHistory({kind:"clear"});
    }),
    jump_heading: jumpToHeading,
    document_outline: toggleSidebar,
    settings: () => settings.showModal(),
    close_window: () => runFileAction(() => finishClose(() => appWindow.destroy())),
    reveal: () => doc.path ? invoke("reveal_document", {path:doc.path}) : notify("Save this document first to reveal it."),
    fold: () => editor.fold(),
    find_selection: () => editor.findSelection(),
    copy_formatted: async () => {
      const markdown = editor.selectedText();
      if (!markdown) return notify("Select Markdown to copy as formatted text.");
      const html = await invoke("formatted_selection", {markdown});
      if (html) {
        const copy = event => {
          event.clipboardData.setData("text/plain", markdown);
          event.clipboardData.setData("text/html", html);
          event.preventDefault();
        };
        document.addEventListener("copy", copy, {once:true});
        try {
          if (!document.execCommand("copy")) throw Error("The system could not copy formatted text.");
        } finally { document.removeEventListener("copy", copy); }
      }
    },
    save: () => queuedSave(false),
    save_as: () => queuedSave(true),
    import: () => runFileAction(chooseAndImport),
    export_html: () => runFileAction(exportHtml),
    export_pdf: () => runFileAction(printDocument),
    insert_image: () => runFileAction(() => insertImage()),
    remote_images: () => runFileAction(async () => {
      const allowed = await T.dialog.ask(doc.remote ? "HTTPS images are enabled for this document. Block them again?" : "Loading HTTPS images contacts their hosts and shares your IP address. Allow this for the current document?", {
        title: "Remote Images", okLabel: doc.remote ? "Block Images" : "Allow Images", cancelLabel: "Cancel",
      });
      if (allowed) {doc.remote = !doc.remote; await renderNow();}
    }),
    guide: () => runFileAction(() => openWindow({kind:"guide"})),
    quit: () => invoke("quit"),

    undo: () => editor.undo(),
    redo: () => editor.redo(),
    find: () => {
      if (viewMode === "preview") setView("split");
      editor.find();
    },

    bold: () => editor.toggleWrap("**"),
    italic: () => editor.toggleWrap("*"),
    strike: () => editor.toggleWrap("~~"),
    code: () => editor.toggleWrap("`"),
    link: () => editor.insertLink(),
    h1: () => editor.setHeading(1),
    h2: () => editor.setHeading(2),
    h3: () => editor.setHeading(3),
    h4: () => editor.setHeading(4),
    h5: () => editor.setHeading(5),
    h6: () => editor.setHeading(6),
    h0: () => editor.setHeading(0),
    bullet: () => editor.toggleList("bullet"),
    numbered: () => editor.toggleList("numbered"),
    task: () => editor.toggleList("task"),
    quote: () => editor.toggleList("quote"),
    codeblock: () =>
      editor.insertBlock((selected) => ({ text: "```\n" + selected + "\n```", selectFrom: 3, selectTo: 3 })),
    table_row: () => { if (!editor.insertTableRow()) notify("Place the cursor inside a Markdown table."); },
    table: () => editor.insertBlock(() => ({ text: TABLE, selectFrom: 2, selectTo: 10 })),
    rule: () => editor.insertBlock(() => ({ text: "---", selectFrom: 3, selectTo: 3 })),

    view_editor: () => setView("editor"),
    view_split: () => setView("split"),
    view_preview: () => setView("preview"),
    gutter: () => { gutter = !gutter; store.set("gutter", gutter); applyEditorLayout(); },
    wrap: () => { wrap = !wrap; store.set("wrap", wrap); applyEditorLayout(); },
    measure: () => { measure = !measure; store.set("measure", measure); applyEditorLayout(); },
    sync_scroll: () => {
      syncEnabled = !syncEnabled;
      store.set("sync", syncEnabled);
      syncChecks();
      notify(syncEnabled ? "Scroll sync on" : "Scroll sync off", 2000);
      if (syncEnabled) syncFromEditor();
    },
    zoom_in: () => setZoom(zoom + 0.1),
    zoom_out: () => setZoom(zoom - 0.1),
    zoom_reset: () => setZoom(1),
    theme_auto: () => setTheme("auto"),
    theme_light: () => setTheme("light"),
    theme_dark: () => setTheme("dark"),
  };

  const EDITING = new Set([
    "undo", "redo", "bold", "italic", "strike", "code", "link", "h1", "h2", "h3", "h4", "h5", "h6", "h0",
    "find_selection", "fold", "copy_formatted", "bullet", "numbered", "task", "quote", "codeblock", "table", "table_row", "rule",
  ]);

  async function runAction(id) {
    if (((outline.open && !sidebarOpen) || comparison.open || settings.open) && id !== "quit") {
      // Native check items toggle before the event arrives, even behind a dialog.
      syncChecks();
      return;
    }
    if (!closing && id.startsWith("recent:")) return runFileAction(() => openRecent(id.slice(7))).catch(showError);
    const action = Object.hasOwn(actions, id) && actions[id];
    if (!action || closing) return;
    if (EDITING.has(id)) {
      if (initializing) return;
      if (viewMode === "preview") setView("split");
    }
    try {
      return await action();
    } catch (error) {
      report(error);
      await showError(error);
    }
  }

  // ---------------------------------------------------------------- start

  async function start() {
    els.editorPane.inert = true;
    setView(viewMode);
    applyEditorLayout();
    editor.setPairing(writing.pairing);
    applyWritingModes();
    setZoom(zoom);
    const split = store.get("split", 50);
    if (split !== 50) setSplit(split);
    applyTheme();
    refreshChrome();

    try {
      config = await invoke("setup");
    } catch (error) {
      report(error);
    }
    applyTheme();

    const bounds = !config.launch && store.get("bounds", null);
    if (bounds && typeof bounds === "object") {
      try { await invoke("restore_window_bounds", {bounds}); }
      catch (error) { store.remove("bounds"); report(error); }
    }
    const target = {target:appWindow.label};
    const fragment = async () => {
      const anchor = await invoke("take_fragment");
      if (anchor && await renderNow()) jumpFragment(anchor);
    };
    await T.event.listen("prepare-quit", event => prepareQuit(event.payload), target);
    await T.event.listen("cancel-quit", ({payload}) => {
      cancelledThrough = Math.max(cancelledThrough, payload);
      if (quitEpoch === payload) cancelQuit();
    });
    await T.event.listen("document-fragment", () => {
      if (!initializing) runFileAction(fragment).catch(showError);
    }, target);
    const initialDocument = runFileAction(openInitialDocument).catch(showError);
    await T.event.listen("menu", (event) => runAction(event.payload), {target:appWindow.label});
    const drainOpenRequests = () => runFileAction(async () => {
      let path;
      while ((path = await invoke("take_pending_open"))) await tryOpen(path);
    }).catch(showError);
    await T.event.listen("open-requested", drainOpenRequests);
    // LaunchServices may have delivered a file between setup and registration.
    const pendingDocuments = drainOpenRequests();

    // Closing the window with unsaved work asks first.
    await appWindow.onCloseRequested((event) => {
      event.preventDefault();
      return runFileAction(() => finishClose(() => appWindow.destroy())).catch(showError);
    });

    // Drop a file on the window to open (or import) it.
    try {
      await T.webview.getCurrentWebview().onDragDropEvent((event) => {
        const paths = event.payload.type === "drop" ? event.payload.paths : null;
        if (paths?.length) return runFileAction(async () => {
          for (const path of paths) {
            if (/\.(png|jpe?g|gif|webp)$/i.test(path)) await insertImage(path);
            else await tryOpen(path);
          }
        }).catch(showError);
      });
    } catch (error) {
      report(error);
    }

    await initialDocument;
    await updateHistory({kind:"read"});
    await pendingDocuments;
    initializing = false;
    els.editorPane.inert = closing;
    if (viewMode !== "preview") editor.focus();
    await fragment();
    await invoke("document_ready");
    invoke("log_message", { message: "ready" }).catch(() => {});
  }

  async function restoreDraft(id) {
    const draft = await invoke("recovery_claim", {id, restore:true});
    loadDocument({...draft, dirty:true, recovered:true});
    notify("Recovered edits · save to keep them", 15000);
  }

  async function openInitialDocument() {
    const launch = config.launch;
    delete config.launch;
    if (launch) {
      switch (launch.kind) {
        case "open": return displayFile(launch.file, true);
        case "guide": return openGuide();
        case "new": return loadDocument({});
        case "template": return loadDocument({name:"Untitled.md", content:launch.content, dirty:true});
        case "import": return loadDocument({name:stem(launch.path) + ".md", content:launch.content, dirty:true});
        case "restore": return restoreDraft(launch.id);
      }
    }
    let restored = false;
    try {
      for (const entry of await invoke("recovery_list")) {
        if (entry.problem) {
          await showError(entry.problem);
          continue;
        }
        const choice = await T.dialog.message(`An unsaved draft of “${entry.name}” was recovered from ${new Date(entry.time).toLocaleString()}.`, {
          title: "Recovered edits", kind: "warning", buttons: { yes: "Restore", no: "Discard Draft", cancel: "Later" },
        });
        try {
          if (choice === "Restore" || choice === "Yes") {
            if (restored) await openWindow({kind:"restore", id:entry.id});
            else { await restoreDraft(entry.id); restored = true; }
          }
          if (choice === "Discard Draft" || choice === "No") {
            await invoke("recovery_claim", { id: entry.id });
            await invoke("recovery_clear", { id: entry.id });
          }
        } catch (error) {
          await showError(`Could not finish recovery for “${entry.name}”. ${error}`);
        }
      }
      const legacy = !restored && store.get("recovery", null);
      if (legacy && typeof legacy.content === "string") {
        const choice = await T.dialog.message(`Restore “${legacy.name}” as a separate draft? Its original disk version is unknown.`, {
          title: "Older recovery draft", buttons: { yes: "Restore", no: "Discard Draft", cancel: "Later" },
        });
        if (choice === "Restore" || choice === "Yes") {
          const draft = { id: draftId(), name: legacy.name || "Untitled", path: null, version: null,
            format: { encoding: "utf8", eol: legacy.crlf ? "crlf" : "lf" }, revision: 0,
            content: legacy.content, time: Date.now() };
          await invoke("recovery_write", { draft });
          store.remove("recovery");
          loadDocument({ ...draft, dirty: true, recovered: true });
          if (config.pendingOpen) await tryOpen(config.pendingOpen);
          return;
        }
        if (choice === "Discard Draft" || choice === "No") store.remove("recovery");
      }
    } catch (error) {
      await showError(`Recovery could not finish: ${error}. Existing drafts have been retained.`);
    }
    // Startup fallback may replace a blank editor only. Even a later dialog or
    // claim failure must leave a restored document and its lease intact.
    if (restored) {
      if (config.pendingOpen) await tryOpen(config.pendingOpen);
      return;
    }
    if (config.pendingOpen) {
      if (["html","htm","xhtml","docx"].includes(extension(config.pendingOpen))) {
        if (await tryOpen(config.pendingOpen)) return loadDocument({});
      } else if (await openPath(config.pendingOpen)) return;
    }
    await updateHistory({kind:"read"});
    const last = history.lastPath;
    if (last && (await openPath(last, { silent: true }))) return;
    if (!store.get("welcomed", false)) {
      store.set("welcomed", true);
      try {
        await openGuide();
        return;
      } catch (error) {
        report(error);
      }
    }
    loadDocument({});
  }

  start().catch((error) => {
    report(error);
    initializing = false;
    els.editorPane.inert = false;
    showError(error);
  });
})();
