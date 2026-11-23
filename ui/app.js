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
  let checkUpdate = Promise.resolve();
  function syncChecks() {
    const checked = ["view_" + viewMode, "theme_" + themeSetting];
    for (const [id, enabled] of Object.entries({sync_scroll:syncEnabled, gutter, wrap, measure})) {
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

  function recentPaths() {
    const saved = store.get("recent", []);
    if (!Array.isArray(saved)) return [];
    return [...new Set(saved.filter(path => typeof path === "string" && path.length <= 32768 &&
      /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path) && !/[\x00-\x1f]/.test(path)))].slice(0, 10);
  }

  let recentUpdate = Promise.resolve();
  function syncRecentMenu() {
    const paths = recentPaths();
    recentUpdate = recentUpdate.then(() => invoke("set_recent_menu", {paths})).catch(report);
    return recentUpdate;
  }

  function rememberPath(path) {
    if (!path) return;
    const paths = recentPaths();
    if (paths[0] === path) return;
    store.set("recent", [path, ...paths.filter(item => item !== path)].slice(0, 10));
    store.set("places", savedPlaces());
    syncRecentMenu();
  }

  function savedPlaces() {
    const places = store.get("places", []);
    const paths = recentPaths();
    return Array.isArray(places) ? places.filter(p => p && paths.includes(p.path)).slice(0, 10) : [];
  }

  function rememberPlace() {
    if (!doc.path || !doc.version || session.isDirty() || !recentPaths().includes(doc.path)) return;
    const place = {path: doc.path, digest: doc.version.digest, ...editor.location()};
    store.set("places", [place, ...savedPlaces().filter(p => p.path !== doc.path)].slice(0,10));
  }

  window.addEventListener("storage", event => {
    if (event.key === "kladje.recent" || event.key === null) syncRecentMenu();
  });

  async function openRecent(path) {
    if (!recentPaths().includes(path)) return;
    try {
      return await openOrImport(path, {throwOnRead: true});
    } catch (error) {
      // A permission or format error should keep the entry available.
      if (await invoke("file_version", {path})) return showError(error);
    }
    const answer = await T.dialog.message(`“${basename(path)}” is unavailable. Choose its new location or remove it from Open Recent.`, {
      title: "Recent Document", buttons: {yes: "Locate…", no: "Remove from Recent", cancel: "Cancel"},
    });
    if (answer === "Cancel") return;
    if (answer === "Locate…" || answer === "Yes") {
      if (!await chooseAndOpen() || recentPaths()[0] === path && doc.path === path) return;
    } else if (answer !== "Remove from Recent" && answer !== "No") return;
    store.set("recent", recentPaths().filter(item => item !== path));
    store.set("places", savedPlaces());
    if (store.get("lastPath", null) === path) store.remove("lastPath");
    await syncRecentMenu();
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
    const selection = c.selected === null ? " · large selection" : c.selected ? ` · ${number.format(c.selected)} selected` : "";
    const column = c.column === null ? "" : `, Col ${c.column}`;
    els.stats.innerHTML = "";
    const position = document.createElement("span");
    position.className = "optional";
    position.textContent = `Ln ${number.format(c.line)}${column}${selection}  ·  `;
    els.stats.append(
      position,
      counts ? `${number.format(counts.words)} ${counts.words === 1 ? "word" : "words"}  ·  ${number.format(counts.characters)} characters` : `${number.format(c.lines)} lines`,
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
    if (viewMode !== "preview") editor.focus();
    else els.previewPane.focus();
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
    els.divider.setAttribute("aria-valuenow", String(Math.round(clamped)));
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
          const snapshot = session.snapshot();
          const source = doc.path, remote = doc.remote;
          if (snapshot.content.length > 256 * 1024) {
            els.preview.textContent = "Live preview is paused for this large document. You can keep editing and saving.";
            return false;
          }
          let html, failure;
          try {
            html = await invoke("render", { markdown: snapshot.content, source, remote });
          } catch (error) {
            failure = error;
          }
          if (!session.isCurrent(snapshot) || source !== doc.path || remote !== doc.remote) {
            renderAgain = true;
            continue;
          }
          if (html === undefined) throw failure || new Error("Missing preview");
          patchPreview(html);
          ready = true;
          renderCost = performance.now() - started;
        } while (renderAgain);
      } catch (error) {
        report(error);
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
  function patchPreview(html) {
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
  async function chooseHeading() {
    const line = Number(headingList.value);
    if (!line || !outlineSnapshot) return;
    const snapshot = outlineSnapshot;
    outline.close();
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
  $("heading-cancel").addEventListener("click", () => outline.close());
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
    return runFileAction(async () => {
      if (await openPath(path) && fragment && await renderNow()) jumpFragment(fragment);
    }).catch(showError);
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
    rememberPlace();
    if (outline.open) outline.close();
    if (comparison.open) comparison.close();
    clearRecovery();
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
    els.preview.replaceChildren();
    els.previewPane.scrollTop = 0;
    anchors = null;
    activePane = "editor";
    if (path && !recovered) store.set("lastPath", path);
    else if (!path) store.remove("lastPath");
    if (dirty && !recovered) saveRecovery();
    refreshChrome();
    renderNow();
    if (viewMode !== "preview") editor.focus();
  }

  async function openPath(path, { silent = false, throwOnRead = false } = {}) {
    let file;
    try {
      file = await invoke("read_file", { path });
    } catch (error) {
      if (throwOnRead) throw error;
      if (!silent) await showError(error);
      return false;
    }
    if (!await replaceDocument(file)) return false;
    rememberPath(path);
    const place = savedPlaces().find(p => p.path === path && p.digest === file.version?.digest);
    if (place) editor.restoreLocation(place);
    if (file.format.encoding === "latin1") notify("Opened as Latin-1 · its encoding will be preserved", 9000);
    return true;
  }

  /** Ask what to do with unsaved changes. Resolves true when it is fine to continue. */
  async function confirmDiscard() {
    if (!session.isDirty()) return true;
    const SAVE = "Save";
    const DISCARD = "Don't Save";
    const CANCEL = "Cancel";
    const before = session.snapshot();
    const answer = await T.dialog.message(`Do you want to save the changes you made to “${doc.name}”?`, {
      title: "Unsaved changes",
      kind: "warning",
      buttons: { yes: SAVE, no: DISCARD, cancel: CANCEL },
    });
    if (!session.isCurrent(before)) return false;
    if (answer === SAVE || answer === "Yes") return save();
    return answer === DISCARD || answer === "No";
  }

  // Read and validate the candidate before asking to discard the old document.
  async function replaceDocument(next, {template = false} = {}) {
    const previousVersion = doc.version;
    if (!await confirmDiscard()) return false;
    // The discard prompt can itself Save (As) into the file we just read.
    if (next.version && previousVersion !== doc.version && next.version.target === doc.version?.target) {
      const before = session.snapshot();
      next = await invoke("read_file", { path: next.path });
      if (!session.isCurrent(before)) return false;
    }
    loadDocument(template ? {name: "Untitled.md", content: next.content, dirty: true} : next);
    return true;
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
    let result;
    try {
      session.beginWrite(snapshot);
      notify("Saving…", 60000);
      result = await invoke("write_file", { path, content, format, expected });
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
    if (confirmed && moved) rememberPath(path);
    if (recentPaths().includes(path)) store.set("lastPath", path);
    if (confirmed) doc.recovered = false;
    if (!confirmed) session.requireSave();
    const clean = confirmed && session.acknowledge(snapshot);
    if (clean) clearRecovery();
    else saveRecovery();
    if (confirmed) notify(clean ? "Saved" : "Earlier edits saved · newer edits are unsaved");
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
    const file = await invoke("read_file", {path});
    // A template provides text only. Save must choose a new destination and
    // recovery belongs to the new draft, never to the template's path.
    await replaceDocument(file, {template: true});
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
    const markdown = await invoke("import_file", { path });
    if (extension(path) === "docx" && !await T.dialog.ask("Import the text, supported styles, lists and tables? Embedded media, page layout and review annotations are omitted. The Word file stays intact.", {
      title: "Word Import", okLabel: "Import Markdown", cancelLabel: "Cancel",
    })) return false;
    if (!await replaceDocument({ name: `${stem(path)}.md`, content: markdown, dirty: true })) return false;
    rememberPath(path);
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

  const openOrImport = (path, options) =>
    ["html", "htm", "xhtml", "docx"].includes(extension(path)) ? importPath(path) : openPath(path, options);

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
    return replaceDocument({ name: "Markdown Guide.md", content: await response.text() });
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

  els.editorPane.addEventListener("paste", event => {
    // Text and rich text with a plain-text representation use native CodeMirror paste.
    const data = event.clipboardData;
    if (!event.target.closest(".cm-content") || !data || initializing || closing || data.getData("text/plain")) return;
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
      if (!await T.dialog.ask(message, {title: "Paste Image", okLabel: doc.path ? "Save Image" : "Save Document and Image", cancelLabel: "Cancel"})) return;
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
    if (initializing || checkingDisk || busy || closing) return;
    checkingDisk = true;
    return runFileAction(checkDisk).catch(e => notify(String(e), 15000)).finally(() => { checkingDisk = false; });
  });

  let closing = false;
  async function finishClose(close) {
    if (closing || !await confirmDiscard()) return;
    rememberPlace();
    closing = true;
    els.editorPane.inert = true;
    try {
      try {
        const bounds = await invoke("window_bounds");
        if (bounds) store.set("bounds", bounds);
      } catch (error) { report(error); }
      await clearRecovery();
      await close();
    } catch (error) {
      closing = false;
      els.editorPane.inert = false;
      if (session.isDirty()) saveRecovery();
      throw error;
    }
  }

  // ---------------------------------------------------------------- menu

  const TABLE = "| Column 1 | Column 2 |\n| --- | --- |\n| Cell | Cell |";
  const actions = {
    new: () => runFileAction(() => replaceDocument({})),
    open: () => runFileAction(chooseAndOpen),
    new_template: () => runFileAction(newFromTemplate),
    compare_disk: () => runFileAction(compareWithDisk),
    clear_recent: () => runFileAction(async () => {
      store.remove("places");
      store.remove("recent");
      store.remove("lastPath");
      await syncRecentMenu();
    }),
    jump_heading: jumpToHeading,
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
    guide: () => runFileAction(openGuide),
    quit: () => runFileAction(() => finishClose(() => invoke("quit"))),

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
    "bullet", "numbered", "task", "quote", "codeblock", "table", "table_row", "rule",
  ]);

  async function runAction(id) {
    if ((outline.open || comparison.open) && id !== "quit") {
      // Native check items toggle before the event arrives, even behind a dialog.
      syncChecks();
      return;
    }
    if (!closing && id.startsWith("recent:")) return runFileAction(() => openRecent(id.slice(7))).catch(showError);
    const action = Object.hasOwn(actions, id) && actions[id];
    if (!action || closing) return;
    if (EDITING.has(id) && (initializing || viewMode === "preview")) return; // nothing to edit in
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

    const bounds = store.get("bounds", null);
    if (bounds && typeof bounds === "object") {
      try { await invoke("restore_window_bounds", {bounds}); }
      catch (error) { store.remove("bounds"); report(error); }
    }
    const initialDocument = runFileAction(openInitialDocument);
    await T.event.listen("menu", (event) => runAction(event.payload));
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
        if (paths && paths.length) return runFileAction(() => /\.(png|jpe?g|gif|webp)$/i.test(paths[0]) ? insertImage(paths[0]) : openOrImport(paths[0])).catch(showError);
      });
    } catch (error) {
      report(error);
    }

    await initialDocument;
    await syncRecentMenu();
    await pendingDocuments;
    initializing = false;
    els.editorPane.inert = closing;
    if (viewMode !== "preview") editor.focus();
    invoke("log_message", { message: "ready" }).catch(() => {});
  }

  async function openInitialDocument() {
    try {
      for (const entry of await invoke("recovery_list")) {
        if (entry.problem) {
          await showError(entry.problem);
          continue;
        }
        const choice = await T.dialog.message(`An unsaved draft of “${entry.name}” was recovered from ${new Date(entry.time).toLocaleString()}.`, {
          title: "Recovered edits", kind: "warning", buttons: { yes: "Restore", no: "Discard Draft", cancel: "Later" },
        });
        if (choice === "Restore" || choice === "Yes") {
          const draft = await invoke("recovery_claim", { id: entry.id });
          loadDocument({ ...draft, dirty: true, recovered: true });
          notify("Recovered edits · save to keep them", 15000);
          return;
        }
        if (choice === "Discard Draft" || choice === "No") {
          await invoke("recovery_claim", { id: entry.id });
          await invoke("recovery_clear", { id: entry.id });
        }
      }
      const legacy = store.get("recovery", null);
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
          return;
        }
        if (choice === "Discard Draft" || choice === "No") store.remove("recovery");
      }
    } catch (error) {
      await showError(`Recovery could not finish: ${error}. Existing drafts have been retained.`);
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
    initializing = false;
    els.editorPane.inert = false;
    showError(error);
  });
})();
