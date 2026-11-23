// Kladje — application logic. Plain JavaScript, no framework and no build step.
// Rendering, file access, import and export all happen in Rust (see src-tauri).

(() => {
  "use strict";

  const T = window.__TAURI__;
  if (!T) {
    document.body.textContent = "Kladje has to be started as an application.";
    return;
  }
  const { invoke, convertFileSrc } = T.core;
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
  const IMPORT_EXT = ["html", "htm", "docx", "txt"];

  // ---------------------------------------------------------------- settings

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

  const doc = { path: null, name: "Untitled", mtime: null, crlf: false };
  let config = { syntaxCssLight: "", syntaxCssDark: "", idPrefix: "" };
  let viewMode = store.get("view", "split");
  let themeSetting = store.get("theme", "auto");
  let syncEnabled = store.get("sync", true);
  let zoom = store.get("zoom", 1);
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
  const isWindowsPath = (p) => /^[A-Za-z]:[\\/]/.test(p) || p.startsWith("\\\\");

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

  const timers = {};
  function schedule(name, fn, delay) {
    clearTimeout(timers[name]);
    timers[name] = setTimeout(fn, delay);
  }

  function onDocumentChanged() {
    scheduleRender();
    schedule("chrome", refreshChrome, 50);
    schedule("recovery", saveRecovery, 900);
  }

  // ---------------------------------------------------------------- chrome

  let shownTitle = null;
  function refreshChrome() {
    const dirty = !editor.isClean();
    els.docName.classList.toggle("dirty", dirty);
    els.docName.firstElementChild.textContent = doc.name;
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
    const text = editor.getText();
    const words = (text.match(/[^\s]+/g) || []).length;
    const c = editor.cursor();
    const selection = c.selected ? ` · ${number.format(c.selected)} selected` : "";
    els.stats.innerHTML = "";
    const position = document.createElement("span");
    position.className = "optional";
    position.textContent = `Ln ${number.format(c.line)}, Col ${c.column}${selection}  ·  `;
    els.stats.append(
      position,
      `${number.format(words)} ${words === 1 ? "word" : "words"}  ·  ${number.format(text.length)} characters`,
    );
  }

  // ---------------------------------------------------------------- theme, layout, zoom

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
    store.set("theme", setting);
    applyTheme();
  }

  function setView(mode) {
    viewMode = ["editor", "split", "preview"].includes(mode) ? mode : "split";
    els.app.dataset.view = viewMode;
    store.set("view", viewMode);
    for (const button of els.viewSwitch.children) {
      button.setAttribute("aria-pressed", String(button.dataset.view === viewMode));
    }
    anchors = null;
    editor.remeasure();
    if (viewMode !== "editor") renderNow().then(() => activePane === "editor" && syncFromEditor());
    if (viewMode !== "preview") editor.focus();
  }

  function setZoom(value) {
    zoom = Math.min(1.8, Math.max(0.7, Math.round(value * 10) / 10));
    store.set("zoom", zoom);
    document.documentElement.style.setProperty("--zoom", zoom);
    anchors = null;
    editor.remeasure();
  }

  function setSplit(percent) {
    const clamped = Math.min(80, Math.max(20, percent));
    els.panes.style.setProperty("--split", clamped + "%");
    store.set("split", clamped);
    anchors = null;
    editor.remeasure();
  }

  els.viewSwitch.addEventListener("click", (e) => {
    const button = e.target.closest("button[data-view]");
    if (button) setView(button.dataset.view);
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
    renderPromise = (async () => {
      try {
        do {
          renderAgain = false;
          const started = performance.now();
          const html = await invoke("render", { markdown: editor.getText() });
          patchPreview(html);
          renderCost = performance.now() - started;
        } while (renderAgain);
      } catch (error) {
        report(error);
      } finally {
        renderPromise = null;
      }
      anchors = null;
      if (activePane === "editor") syncFromEditor();
    })();
    return renderPromise;
  }

  const keyOf = (node) =>
    node.nodeType === 1 ? node.outerHTML.replace(SOURCEPOS, "") : "#" + node.nodeValue;

  /**
   * Update the preview by replacing only the top-level blocks that changed.
   * Unchanged blocks keep their DOM nodes, so images do not reload and the
   * scroll position stays put while typing.
   */
  function patchPreview(html) {
    const template = document.createElement("template");
    template.innerHTML = html;
    resolveImages(template.content);

    const root = els.preview;
    const oldNodes = Array.from(root.childNodes);
    const newNodes = Array.from(template.content.childNodes);
    const newKeys = newNodes.map(keyOf);
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
      root.insertBefore(newNodes[i], before);
    }
  }

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

  /** Point relative and file: image paths at the real files next to the document. */
  function resolveImages(fragment) {
    for (const img of fragment.querySelectorAll("img[src]")) {
      const path = localImagePath(img.getAttribute("src"));
      if (path) img.setAttribute("src", convertFileSrc(path));
      img.setAttribute("loading", "lazy");
    }
  }

  function localImagePath(src) {
    if (/^(https?:|data:|blob:|asset:|\/\/)/i.test(src)) return null;
    if (/^file:/i.test(src)) {
      try {
        const path = decodeURIComponent(new URL(src).pathname);
        return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
      } catch {
        return null;
      }
    }
    let relative = src.split(/[?#]/)[0];
    try {
      relative = decodeURIComponent(relative);
    } catch {}
    if (relative.startsWith("/") || isWindowsPath(relative)) return relative;
    return doc.path ? resolvePath(dirname(doc.path), relative) : null;
  }

  // Links never navigate the app itself.
  els.preview.addEventListener("click", (e) => {
    const link = e.target.closest("a[href]");
    if (!link || !els.preview.contains(link)) return;
    e.preventDefault();
    const href = link.getAttribute("href");
    if (href.startsWith("#")) {
      let id = href.slice(1);
      try {
        id = decodeURIComponent(id);
      } catch {}
      const target = els.preview.querySelector(`[id="${CSS.escape(config.idPrefix + id)}"]`);
      if (target) {
        activePane = "preview";
        target.scrollIntoView({ block: "start" });
      }
    } else if (/^(https?:|mailto:|tel:)/i.test(href)) {
      T.opener.openUrl(href).catch(showError);
    } else if (doc.path && MARKDOWN_EXT.includes(extension(href.split(/[?#]/)[0]))) {
      let relative = href.split(/[?#]/)[0];
      try {
        relative = decodeURIComponent(relative);
      } catch {}
      const path = relative.startsWith("/") || isWindowsPath(relative) ? relative : resolvePath(dirname(doc.path), relative);
      guarded(() => openPath(path));
    }
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
    if (!anchors) buildAnchors();
    const source = editor.scroller;
    const target = els.previewPane;
    const sourceMax = source.scrollHeight - source.clientHeight;
    if (source.scrollTop <= 0) target.scrollTop = 0;
    else if (source.scrollTop >= sourceMax - 1) target.scrollTop = target.scrollHeight;
    else target.scrollTop = interpolate(editor.topLine(), "line", "top");
  }

  function syncFromPreview() {
    if (!syncEnabled || viewMode !== "split") return;
    if (!anchors) buildAnchors();
    const source = els.previewPane;
    const sourceMax = source.scrollHeight - source.clientHeight;
    if (source.scrollTop <= 0) editor.scroller.scrollTop = 0;
    else if (source.scrollTop >= sourceMax - 1) editor.scroller.scrollTop = editor.scroller.scrollHeight;
    else editor.scrollToLine(interpolate(source.scrollTop, "top", "line"));
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

  function loadDocument({ path = null, name = null, content = "", mtime = null, dirty = false }) {
    doc.crlf = content.includes("\r\n");
    doc.path = path;
    doc.name = path ? basename(path) : name || "Untitled";
    doc.mtime = mtime;
    editor.setText(content.replace(/\r\n?/g, "\n"));
    if (dirty) editor.markDirty();
    els.preview.replaceChildren();
    els.previewPane.scrollTop = 0;
    anchors = null;
    activePane = "editor";
    if (path) store.set("lastPath", path);
    else store.remove("lastPath");
    if (dirty) saveRecovery();
    else clearRecovery();
    refreshChrome();
    renderNow();
    if (viewMode !== "preview") editor.focus();
  }

  async function openPath(path, { silent = false } = {}) {
    let file;
    try {
      file = await invoke("read_file", { path });
    } catch (error) {
      if (!silent) await showError(error);
      return false;
    }
    loadDocument({ path: file.path, content: file.content, mtime: file.mtime });
    if (file.converted) notify("This file was not UTF-8. It has been converted and will be saved as UTF-8.", 9000);
    return true;
  }

  /** Ask what to do with unsaved changes. Resolves true when it is fine to continue. */
  async function confirmDiscard() {
    if (editor.isClean()) return true;
    const SAVE = "Save";
    const DISCARD = "Don't Save";
    const CANCEL = "Cancel";
    const answer = await T.dialog.message(`Do you want to save the changes you made to “${doc.name}”?`, {
      title: "Unsaved changes",
      kind: "warning",
      buttons: { yes: SAVE, no: DISCARD, cancel: CANCEL },
    });
    if (answer === SAVE || answer === "Yes") return save();
    return answer === DISCARD || answer === "No";
  }

  /** Run an action that replaces the document, after dealing with unsaved changes. */
  async function guarded(action) {
    if (busy) return;
    busy = true;
    try {
      if (await confirmDiscard()) await action();
    } catch (error) {
      await showError(error);
    } finally {
      busy = false;
    }
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
    let content = editor.getText();
    if (doc.crlf) content = content.replace(/\n/g, "\r\n");
    try {
      doc.mtime = await invoke("write_file", { path, content });
    } catch (error) {
      await showError(error);
      return false;
    }
    const moved = path !== doc.path;
    doc.path = path;
    doc.name = basename(path);
    store.set("lastPath", path);
    editor.markClean();
    clearRecovery();
    refreshChrome();
    if (moved) {
      // Relative image paths now resolve against the new folder.
      els.preview.replaceChildren();
      renderNow();
    }
    return true;
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
    if (path) await openPath(path);
  }

  async function importPath(path) {
    const markdown = await invoke("import_file", { path });
    loadDocument({ name: `${stem(path)}.md`, content: markdown, dirty: true });
    notify(`Imported ${basename(path)} — save it to keep the Markdown version.`);
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

  const openOrImport = (path) =>
    ["html", "htm", "xhtml", "docx"].includes(extension(path)) ? importPath(path) : openPath(path);

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
      await invoke("export_html", { path, markdown: editor.getText(), title: stem(doc.name) });
      notify(`Exported ${basename(path)}`);
    } catch (error) {
      await showError(error);
    } finally {
      busy = false;
    }
  }

  async function printDocument() {
    try {
      await renderNow(); // also when the preview is hidden
      await new Promise((resolve) => setTimeout(resolve, 60)); // let layout settle
      await invoke("print_document");
    } catch (error) {
      await showError(error);
    }
  }

  // ---------------------------------------------------------------- crash recovery

  function saveRecovery() {
    if (editor.isClean()) return clearRecovery();
    const ok = store.set("recovery", {
      path: doc.path,
      name: doc.name,
      crlf: doc.crlf,
      content: editor.getText(),
      time: Date.now(),
    });
    if (!ok) store.remove("recovery"); // too large for local storage
  }
  const clearRecovery = () => {
    clearTimeout(timers.recovery);
    store.remove("recovery");
  };

  // ---------------------------------------------------------------- changes made by other programs

  let checkingDisk = false;
  async function checkDisk() {
    if (!doc.path || checkingDisk || busy) return;
    checkingDisk = true;
    try {
      const path = doc.path;
      const mtime = await invoke("file_mtime", { path });
      if (path !== doc.path || mtime == null || doc.mtime == null || mtime === doc.mtime) return;
      doc.mtime = mtime; // ask only once per change
      if (editor.isClean()) {
        const file = await invoke("read_file", { path });
        const top = editor.scroller.scrollTop;
        const text = file.content.replace(/\r\n?/g, "\n");
        if (text !== editor.getText()) {
          doc.crlf = file.content.includes("\r\n");
          editor.replaceText(text);
          editor.markClean();
          editor.scroller.scrollTop = top;
          refreshChrome();
          notify(`${doc.name} changed on disk and was reloaded.`);
        }
      } else {
        const reload = await T.dialog.ask(
          `“${doc.name}” was changed by another program. Reload it and lose your unsaved changes?`,
          { title: "File changed on disk", kind: "warning", okLabel: "Reload", cancelLabel: "Keep My Changes" },
        );
        if (reload) await openPath(path);
      }
    } catch (error) {
      report(error);
    } finally {
      checkingDisk = false;
    }
  }
  window.addEventListener("focus", checkDisk);

  // ---------------------------------------------------------------- menu

  const TABLE = "| Column 1 | Column 2 |\n| --- | --- |\n| Cell | Cell |";
  const actions = {
    new: () => guarded(() => loadDocument({})),
    open: () => guarded(chooseAndOpen),
    save: () => save(false),
    save_as: () => save(true),
    import: () => guarded(chooseAndImport),
    export_html: exportHtml,
    export_pdf: printDocument,
    guide: () => guarded(openGuide),
    quit: async () => {
      if (busy) return;
      busy = true;
      try {
        if (await confirmDiscard()) {
          clearRecovery();
          await invoke("quit");
        }
      } finally {
        busy = false;
      }
    },

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
    h0: () => editor.setHeading(0),
    bullet: () => editor.toggleList("bullet"),
    numbered: () => editor.toggleList("numbered"),
    task: () => editor.toggleList("task"),
    quote: () => editor.toggleList("quote"),
    codeblock: () =>
      editor.insertBlock((selected) => ({ text: "```\n" + selected + "\n```", selectFrom: 3, selectTo: 3 })),
    table: () => editor.insertBlock(() => ({ text: TABLE, selectFrom: 2, selectTo: 10 })),
    rule: () => editor.insertBlock(() => ({ text: "---", selectFrom: 3, selectTo: 3 })),

    view_editor: () => setView("editor"),
    view_split: () => setView("split"),
    view_preview: () => setView("preview"),
    sync_scroll: () => {
      syncEnabled = !syncEnabled;
      store.set("sync", syncEnabled);
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
    "undo", "redo", "bold", "italic", "strike", "code", "link", "h1", "h2", "h3", "h4", "h0",
    "bullet", "numbered", "task", "quote", "codeblock", "table", "rule",
  ]);

  function runAction(id) {
    const action = actions[id];
    if (!action) return;
    if (EDITING.has(id) && viewMode === "preview") return; // nothing to edit in
    Promise.resolve()
      .then(action)
      .catch((error) => {
        report(error);
        showError(error);
      });
  }

  // ---------------------------------------------------------------- start

  async function start() {
    setView(viewMode);
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

    await T.event.listen("menu", (event) => runAction(event.payload));
    await T.event.listen("open-requested", async () => {
      const path = await invoke("take_pending_open");
      if (path) guarded(() => openOrImport(path));
    });

    // Closing the window with unsaved work asks first.
    await appWindow.onCloseRequested(async (event) => {
      if (busy) return event.preventDefault();
      busy = true;
      try {
        if (await confirmDiscard()) clearRecovery();
        else event.preventDefault();
      } finally {
        busy = false;
      }
    });

    // Drop a file on the window to open (or import) it.
    try {
      await T.webview.getCurrentWebview().onDragDropEvent((event) => {
        const paths = event.payload.type === "drop" ? event.payload.paths : null;
        if (paths && paths.length) guarded(() => openOrImport(paths[0]));
      });
    } catch (error) {
      report(error);
    }

    await openInitialDocument();
    invoke("log_message", { message: "ready" }).catch(() => {});
  }

  async function openInitialDocument() {
    const recovery = store.get("recovery", null);
    if (recovery && typeof recovery.content === "string") {
      let restore = false;
      try {
        restore = await T.dialog.ask(
          `Kladje closed with unsaved changes to “${recovery.name}”. Restore them?`,
          { title: "Restore unsaved changes", kind: "warning", okLabel: "Restore", cancelLabel: "Discard" },
        );
      } catch (error) {
        report(error);
      }
      if (restore) {
        const mtime = recovery.path ? await invoke("file_mtime", { path: recovery.path }).catch(() => null) : null;
        loadDocument({
          path: recovery.path,
          name: recovery.name,
          content: recovery.crlf ? recovery.content.replace(/\n/g, "\r\n") : recovery.content,
          mtime,
          dirty: true,
        });
        return;
      }
      clearRecovery();
    }
    if (config.pendingOpen && (await tryOpen(config.pendingOpen))) return;
    const last = store.get("lastPath", null);
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
    showError(error);
  });
})();
