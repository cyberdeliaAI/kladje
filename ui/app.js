// Kladje — application logic. Plain JavaScript, no framework and no build step.
// Rendering, file access, import and export all happen in Rust (see src-tauri).

(async () => {
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
    previewStatus: $("preview-status"),
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
  const legacyStore = {
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

  const preferences = await openPreferences(T, legacyStore);
  const store = {
    get(key, fallback) { return (preferences.keys.has(key) ? preferences : legacyStore).get(key, fallback); },
    set(key, value) {
      if (!applyingPreference) return (preferences.keys.has(key) ? preferences : legacyStore).set(key, value);
    },
    remove(key) { legacyStore.remove(key); },
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
  const writing = {pairing:true, linkPaste:true, htmlPaste:false, tablePaste:false, confirmImage:true, readingTime:false, focusParagraph:false, typewriter:false, lineBreaks:true, darkExport:false, pageNumbers:false, formatBar:true};
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
      if (key === "lineBreaks" && viewMode !== "editor") renderNow();
      if (key === "formatBar") { applyFormatBar(); syncChecks(); }
    });
  }
  let editorFont = store.get("editorFont", "mono") === "sans" ? "sans" : "mono";
  function setEditorFont(value) {
    editorFont = value === "sans" ? "sans" : "mono";
    store.set("editorFont", editorFont);
    els.app.dataset.editorFont = editorFont;
    editor.remeasure();
    syncSettings();
  }
  function applyWritingModes() {
    editor.setWritingModes(writing.focusParagraph, writing.typewriter);
    els.editorPane.dataset.focusParagraph = String(writing.focusParagraph);
    els.editorPane.dataset.typewriter = String(writing.typewriter);
  }
  let sidebarOpen = false;
  // Writing to the original file without being asked is opt-in. A save that
  // fails or needs a decision pauses it until an explicit Save settles things.
  const AUTOSAVE_IDLE = 2000;
  let autosave = storedFlag("autosave", false), autosavePaused = false;
  $("autosave").checked = autosave;
  $("autosave").addEventListener("change", () => {
    autosave = $("autosave").checked;
    store.set("autosave", autosave);
    autosavePaused = false;
    return requestAutosave();
  });
  let checkUpdate = Promise.resolve();
  function syncChecks() {
    const checked = ["view_" + viewMode, "theme_" + themeSetting];
    for (const [id, enabled] of Object.entries({sync_scroll:syncEnabled, gutter, wrap, measure, document_outline:sidebarOpen, format_bar:writing.formatBar})) {
      if (enabled) checked.push(id);
    }
    $("outline-toggle").setAttribute("aria-pressed", String(sidebarOpen));
    syncSettings();
    checkUpdate = checkUpdate.then(() => invoke("set_menu_checks", {checked})).catch(report);
  }
  // The settings window shows preferences that also live in the View menu.
  function syncSettings() {
    for (const [id, on] of Object.entries({"pref-gutter": gutter, "pref-wrap": wrap, "pref-measure": measure, "pref-sync": syncEnabled, formatBar: writing.formatBar})) {
      $(id).checked = on;
    }
    for (const radio of settings.querySelectorAll('input[name="theme"]')) radio.checked = radio.value === themeSetting;
    for (const radio of settings.querySelectorAll('input[name="editorFont"]')) radio.checked = radio.value === editorFont;
    $("zoom-value").textContent = Math.round(zoom * 100) + "%";
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
      renderStart();
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
        if (key === "lineBreaks" && viewMode !== "editor") renderNow();
        if (key === "focusParagraph" || key === "typewriter") applyWritingModes();
        if (key === "formatBar") { applyFormatBar(); syncChecks(); }
      } else if (key === "editorFont") setEditorFont(store.get(key, "mono"));
      else if (key === "theme") setTheme(store.get(key, "auto"));
      else if (key === "view") setView(store.get(key, "split"));
      else if (key === "zoom") setZoom(store.get(key, 1));
      else if (key === "split") setSplit(store.get(key, 50));
      else if (key === "sync") { syncEnabled = storedFlag(key, true); syncChecks(); }
      else if (["gutter","wrap","measure"].includes(key)) {
        gutter = storedFlag("gutter", false);
        wrap = storedFlag("wrap", true);
        measure = storedFlag("measure", true);
        applyEditorLayout();
      } else if (key === "autosave") {
        autosave = storedFlag(key, false);
        $(key).checked = autosave;
      }
    } finally { applyingPreference = false; }
  }

  preferences.subscribe(applyPreference, message => notify(message, 12000));

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
    onSelection: () => {
      schedule("stats", updateStats, 60);
      if (sidebarOpen) schedule("outlineFollow", followOutline, 120);
    },
    onStatistics: () => schedule("stats", updateStats, 60),
  });

  const session = new DocumentSession(() => editor.getText(), () => editor.textLength());
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
    if (autosave) schedule("autosave", requestAutosave, AUTOSAVE_IDLE);
  }

  // ---------------------------------------------------------------- chrome

  // ---------------------------------------------------------------- formatting bar

  const onMac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform || "");

  if (!onMac) $("page-numbers-option").hidden = true;

  // A row of formatting buttons along the bottom of the source pane. Every
  // button runs a menu action, so the bar adds no behaviour of its own.
  const glyphs = onMac => text => onMac ? text :
    text.replace(/⌃/g, "Ctrl+").replace(/⌥/g, "Alt+").replace(/⇧/g, "Shift+").replace(/⌘/g, "Ctrl+").replace(/Ctrl\+Ctrl\+/, "Ctrl+");
  const FORMAT_ICONS = {
    heading: '<path d="M3.5 3v10M10.5 3v10M3.5 8h7"/>',
    task: '<rect x="2.5" y="2.5" width="11" height="11" rx="2.5"/><path d="M5.3 8.2l1.9 1.9 3.6-4"/>',
    list: '<path d="M6 4h7.5M6 8h7.5M6 12h7.5"/><circle cx="3" cy="4" r=".9" fill="currentColor" stroke="none"/><circle cx="3" cy="8" r=".9" fill="currentColor" stroke="none"/><circle cx="3" cy="12" r=".9" fill="currentColor" stroke="none"/>',
    bold: '<path d="M4.5 2.8h4.2a2.6 2.6 0 0 1 0 5.2H4.5zM4.5 8h4.9a2.6 2.6 0 0 1 0 5.2H4.5z"/>',
    italic: '<path d="M7 2.8h5M4 13.2h5M9.8 2.8L6.2 13.2"/>',
    highlight: '<path d="M9.8 2.6l3.6 3.6-6 6H3.8V8.6z"/><path d="M2.5 14h11"/>',
    link: '<path d="M6.8 9.2a2.8 2.8 0 0 0 4 0l2-2a2.8 2.8 0 0 0-4-4l-.9.9"/><path d="M9.2 6.8a2.8 2.8 0 0 0-4 0l-2 2a2.8 2.8 0 0 0 4 4l.9-.9"/>',
    table: '<rect x="2" y="3" width="12" height="10" rx="1.6"/><path d="M2 6.5h12M2 10h12M6.5 3v10"/>',
    image: '<rect x="2" y="3" width="12" height="10" rx="1.6"/><circle cx="5.8" cy="6.5" r="1.1"/><path d="M2.5 12l3.6-3.4 2.4 2.2 2.2-2 3 3"/>',
    more: '<circle cx="8" cy="3.5" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1" fill="currentColor" stroke="none"/><circle cx="8" cy="12.5" r="1" fill="currentColor" stroke="none"/>',
  };
  const sep = "-";
  const FORMAT_MENUS = {
    heading: [["h1", "Heading 1", "⌘1"], ["h2", "Heading 2", "⌘2"], ["h3", "Heading 3", "⌘3"], ["h4", "Heading 4", "⌘4"],
      ["h5", "Heading 5", "⌘5"], ["h6", "Heading 6", "⌘6"], sep, ["h0", "Paragraph", "⌥⌘0"]],
    list: [["bullet", "Bullet List", "⇧⌘8"], ["numbered", "Numbered List", "⇧⌘7"], ["quote", "Quote", "⇧⌘."], sep,
      ["callout_note", "Note"], ["callout_tip", "Tip"], ["callout_important", "Important"], ["callout_warning", "Warning"], ["callout_caution", "Caution"]],
    table: [["table", "Insert Table", "⌥⌘T"], sep, ["table_row_above", "Add Row Above"], ["table_row", "Add Row Below"],
      ["table_column_before", "Add Column Before"], ["table_column_after", "Add Column After"], sep,
      ["table_row_up", "Move Row Up"], ["table_row_down", "Move Row Down"], ["table_format", "Tidy Table"], sep,
      ["table_delete_row", "Delete Row"], ["table_delete_column", "Delete Column"]],
    more: [["strike", "Strikethrough", "⇧⌘X"], ["code", "Inline Code", "⇧⌘C"], ["codeblock", "Code Block", "⌥⌘C"],
      ["math", "Inline Math", "⇧⌘M"], ["math_block", "Math Block"], ["footnote", "Footnote", "⌥⌘F"],
      ["rule", "Horizontal Rule"], ["date_iso", "Insert Date"], sep, ["format_bar", "Hide Formatting Bar", "⌥⌘B"]],
  };
  const FORMAT_BUTTONS = [
    ["heading", "Heading", "menu"], ["task", "Task List", "task"], ["list", "Lists and Callouts", "menu"], sep,
    ["bold", "Bold", "bold", "⌘B"], ["italic", "Italic", "italic", "⌘I"], ["highlight", "Highlight", "highlight", "⇧⌘H"],
    ["link", "Link", "link", "⌘K"], sep,
    ["table", "Table", "menu"], ["image", "Insert Local Image", "insert_image"], ["more", "More Formatting", "menu"],
  ];
  const keyLabel = glyphs(onMac);
  const formatBar = $("format-bar"), formatMenu = $("format-menu");
  function svgIcon(markup) {
    const icon = document.createElementNS ? document.createElementNS("http://www.w3.org/2000/svg", "svg") : document.createElement("svg");
    icon.setAttribute("viewBox", "0 0 16 16");
    icon.setAttribute("aria-hidden", "true");
    icon.innerHTML = markup;
    return icon;
  }
  formatBar.replaceChildren(...FORMAT_BUTTONS.map(entry => {
    if (entry === sep) {
      const line = document.createElement("span");
      line.className = "format-separator";
      line.setAttribute("role", "separator");
      return line;
    }
    const [name, label, action, keys] = entry;
    const button = document.createElement("button");
    button.type = "button";
    button.tabIndex = -1;
    button.dataset.format = name;
    button.setAttribute("aria-label", label);
    button.title = keys ? `${label} (${keyLabel(keys)})` : label;
    if (action === "menu") {
      button.setAttribute("aria-haspopup", "menu");
      button.setAttribute("aria-expanded", "false");
      button.dataset.menu = name;
    } else button.dataset.action = action;
    button.append(svgIcon(FORMAT_ICONS[name]));
    if (action === "menu" && name !== "more") button.classList.add("has-menu");
    return button;
  }));
  // One button at a time takes part in Tab order (roving tabindex).
  const barButtons = () => Array.from(formatBar.querySelectorAll("button"));
  if (formatBar.firstElementChild) formatBar.firstElementChild.tabIndex = 0;

  let menuOpener = null;
  function closeFormatMenu(refocus = false) {
    if (!menuOpener) return;
    menuOpener.setAttribute("aria-expanded", "false");
    formatMenu.hidden = true;
    formatMenu.replaceChildren();
    if (refocus) menuOpener.focus();
    menuOpener = null;
  }
  function openFormatMenu(opener, focusFirst = false) {
    const same = menuOpener === opener;
    closeFormatMenu();
    if (same) return;
    menuOpener = opener;
    opener.setAttribute("aria-expanded", "true");
    formatMenu.setAttribute("aria-label", opener.getAttribute("aria-label"));
    formatMenu.replaceChildren(...FORMAT_MENUS[opener.dataset.menu].map(entry => {
      if (entry === sep) {
        const line = document.createElement("div");
        line.className = "format-menu-separator";
        line.setAttribute("role", "separator");
        return line;
      }
      const [action, label, keys] = entry;
      const item = document.createElement("button");
      item.type = "button";
      item.tabIndex = -1;
      item.setAttribute("role", "menuitem");
      item.dataset.action = action;
      const name = document.createElement("span");
      name.textContent = action === "format_bar" ? label : label;
      item.append(name);
      if (keys) {
        const hint = document.createElement("kbd");
        hint.textContent = keyLabel(keys);
        item.append(hint);
      }
      return item;
    }));
    formatMenu.hidden = false;
    // Open above the button, kept inside the pane.
    const pane = els.editorPane.getBoundingClientRect?.() || {left: 0, width: 0};
    const at = opener.getBoundingClientRect?.() || {left: 0};
    const width = formatMenu.offsetWidth || 0;
    formatMenu.style.left = Math.max(8, Math.min(at.left - pane.left, pane.width - width - 8)) + "px";
    if (focusFirst) formatMenu.querySelector("[role=menuitem]")?.focus();
  }
  const keepEditorFocus = event => { if (event.target.closest?.("button")) event.preventDefault(); };
  formatBar.addEventListener("mousedown", keepEditorFocus);
  formatMenu.addEventListener("mousedown", keepEditorFocus);
  formatBar.addEventListener("click", event => {
    const button = event.target.closest?.("button");
    if (!button) return;
    if (button.dataset.menu) return openFormatMenu(button, event.detail === 0);
    closeFormatMenu();
    return runAction(button.dataset.action);
  });
  formatBar.addEventListener("keydown", event => {
    const buttons = barButtons();
    const index = buttons.indexOf(document.activeElement);
    const step = {ArrowRight: 1, ArrowLeft: -1}[event.key];
    if (step && index >= 0) {
      event.preventDefault();
      const next = buttons[(index + step + buttons.length) % buttons.length];
      buttons.forEach(b => { b.tabIndex = -1; });
      next.tabIndex = 0;
      next.focus();
    } else if (event.key === "ArrowUp" && document.activeElement?.dataset?.menu) {
      event.preventDefault();
      openFormatMenu(document.activeElement, true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeFormatMenu();
      editor.focus();
    }
  });
  formatMenu.addEventListener("click", event => {
    const item = event.target.closest?.("[role=menuitem]");
    if (!item) return;
    closeFormatMenu();
    return runAction(item.dataset.action);
  });
  formatMenu.addEventListener("keydown", event => {
    const items = Array.from(formatMenu.querySelectorAll("[role=menuitem]"));
    const index = items.indexOf(document.activeElement);
    const move = {ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1}[event.key];
    if (move !== undefined) {
      event.preventDefault();
      items[(move + items.length) % items.length]?.focus();
    } else if (event.key === "Escape" || event.key === "Tab") {
      event.preventDefault();
      closeFormatMenu(true);
    }
  });
  els.app.addEventListener("pointerdown", event => {
    if (menuOpener && !event.target.closest?.("#format-menu, #format-bar")) closeFormatMenu();
  }, true);
  function applyFormatBar() {
    els.app.dataset.formatBar = String(writing.formatBar);
    if (!writing.formatBar) closeFormatMenu();
  }

  // ---------------------------------------------------------------- start screen

  // An empty document shows the wordmark, the ways to begin and recent files
  // where its preview would be.
  const shortcut = (key, shift = false) => onMac ? (shift ? "⇧⌘" : "⌘") + key : "Ctrl+" + (shift ? "Shift+" : "") + key;
  const START_ICONS = {
    open: '<path d="M4.5 3.5h6v6M10.5 3.5l-7 7"/>',
    new_template: '<path d="M3.5 1.5h5l3 3v8h-8z"/><path d="M8.5 1.5v3h3M7.5 7v4M5.5 9h4"/>',
    import: '<path d="M7 1.5v7M4 5.5l3 3 3-3M2.5 9.5v3h9v-3"/>',
    guide: '<path d="M2.5 2.5h3.5a1.5 1.5 0 0 1 1 .5 1.5 1.5 0 0 1 1-.5h3.5v9H8a1 1 0 0 0-1 1 1 1 0 0 0-1-1H2.5zM7 3v9"/>',
    recent: '<path d="M3.5 1.5h5l3 3v8h-8z"/><path d="M8.5 1.5v3h3"/>',
  };
  function startButton(action, label, detail, icon) {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = action;
    const mark = document.createElementNS ? document.createElementNS("http://www.w3.org/2000/svg", "svg") : document.createElement("svg");
    mark.setAttribute("viewBox", "0 0 14 14");
    mark.setAttribute("aria-hidden", "true");
    mark.innerHTML = START_ICONS[icon];
    const name = document.createElement("span");
    name.className = "start-label";
    name.textContent = label;
    button.append(mark, name);
    if (detail) {
      const side = document.createElement("span");
      side.className = "start-detail";
      side.textContent = detail;
      button.append(side);
    }
    item.append(button);
    return item;
  }
  $("start-actions").replaceChildren(
    startButton("open", "Open…", shortcut("O"), "open"),
    startButton("new_template", "New from Template…", "", "new_template"),
    startButton("import", "Import…", shortcut("I", true), "import"),
    startButton("guide", "Markdown Guide", "", "guide"),
  );
  let shownRecent = null;
  function renderStart() {
    const empty = editor.textLength() === 0;
    els.app.dataset.empty = String(empty);
    $("start").hidden = !empty;
    if (!empty) return;
    const recent = recentPaths().filter(path => path !== doc.path).slice(0, 5);
    const key = recent.join("\n");
    if (key === shownRecent) return;
    shownRecent = key;
    $("start-recent").replaceChildren(...recent.map(path => {
      // The folder name tells same-named files apart. The tooltip has the full path.
      const item = startButton("recent:" + path, basename(path), basename(dirname(path)), "recent");
      item.firstElementChild.title = path;
      return item;
    }));
    $("start-recent-group").hidden = !recent.length;
  }
  $("start").addEventListener("click", event => {
    const button = event.target.closest?.("button[data-action]");
    if (button) return runAction(button.dataset.action);
  });

  let shownTitle = null;
  let representedPath;
  function refreshChrome() {
    renderStart();
    const dirty = session.isDirty();
    els.docName.classList.toggle("dirty", dirty);
    const label = doc.recovered ? `${doc.name} (recovered)` : doc.name;
    const filename = els.docName.firstElementChild;
    const stateLabel = $("doc-state");
    const stateText = dirty ? " — Unsaved changes" : "";
    if (filename.textContent !== label) filename.textContent = label;
    if (stateLabel.textContent !== stateText) stateLabel.textContent = stateText;
    els.docName.title = (doc.path || "Not saved yet") + (dirty ? " — edited" : "");
    if (representedPath !== doc.path) {
      representedPath = doc.path;
      invoke("sync_document_icon").catch(report);
    }
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
  function updateExportAppearance() {
    const media = [];
    if (document.documentElement.dataset.theme === "dark") media.push("screen");
    if (writing.darkExport) media.push("print");
    $("dark-document").media = media.join(", ") || "not all";
    document.documentElement.dataset.printTheme = writing.darkExport ? "dark" : "light";
    $("syntax-print").textContent = writing.darkExport ? config.syntaxCssDark : config.syntaxCssLight;
  }

  function applyTheme() {
    const dark = themeSetting === "dark" || (themeSetting === "auto" && systemDark.matches);
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    $("syntax-screen").textContent = dark ? config.syntaxCssDark : config.syntaxCssLight;
    updateExportAppearance();
    drawDiagrams();
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
    else showPreviewStatus();
    if (!applyingPreference) focusDocument();
  }

  function setZoom(value) {
    zoom = Math.min(1.8, Math.max(0.7, Math.round((Number.isFinite(value) ? value : 1) * 10) / 10));
    store.set("zoom", zoom);
    document.documentElement.style.setProperty("--zoom", zoom);
    $("zoom-value").textContent = Math.round(zoom * 100) + "%";
    anchors = null;
    editor.remeasure();
  }

  function setSplit(percent, persist = true) {
    const clamped = Math.min(80, Math.max(20, Number.isFinite(percent) ? percent : 50));
    els.panes.style.setProperty("--split", clamped + "%");
    const sourceWidth = Math.round(clamped);
    els.divider.setAttribute("aria-valuenow", String(sourceWidth));
    els.divider.setAttribute("aria-valuetext", `${sourceWidth}% source, ${100 - sourceWidth}% preview`);
    if (persist) store.set("split", clamped);
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
      setSplit(((ev.clientX - rect.left) / rect.width) * 100, false);
    };
    const stop = () => {
      store.set("split", Number(els.divider.getAttribute("aria-valuenow")));
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
  let renderForced = false;
  let refreshWanted = false; // typing overtook a requested render: repeat it at the next pause
  let renderCost = 0;
  let previewAssets = new Map();
  let shown = null; // what the preview displays: { snapshot, source, remote, lineBreaks }

  // How live the preview stays depends on how long one update keeps the
  // webview's main thread busy, because typing waits behind that work. Sending
  // the text and patching the result took about 22 ms per MiB of mixed Markdown
  // in a release build on an Apple M4 (`node scripts/macos-qa/run.mjs --large`).
  // A window assumes twice that until it has timed a large update of its own.
  const MIB = 1024 * 1024;
  const LIVE_STALL_MS = 50; // the usual long-task threshold: not felt while typing
  const PAUSE_STALL_MS = 250; // a hitch this long is acceptable once typing has stopped
  const PAUSE_MS = 1500;
  const MIN_RENDER_DELAY = 70;
  const STALL_SAMPLE = 128 * 1024; // smaller updates are mostly fixed overhead
  const DEFAULT_STALL_RATE = 45 / MIB; // ms per UTF-16 code unit
  const clampRate = rate => Math.min(DEFAULT_STALL_RATE * 8, Math.max(DEFAULT_STALL_RATE / 8, rate));
  // Each document has its own window, so the timing is remembered for the next one.
  const knownRate = store.get("previewRate", null);
  // A remembered timing only ever makes a new window less cautious than the default.
  let stallRate = typeof knownRate === "number" && knownRate > 0 ? Math.min(DEFAULT_STALL_RATE, clampRate(knownRate)) : DEFAULT_STALL_RATE;
  let stallSamples = [];

  /** "live" while typing, "pause" once typing stops, or "request" from Refresh Preview only. */
  function previewTier() {
    const stall = editor.textLength() * stallRate;
    return stall <= LIVE_STALL_MS ? "live" : stall <= PAUSE_STALL_MS ? "pause" : "request";
  }

  const previewCurrent = () =>
    !!shown && session.isCurrent(shown.snapshot) && shown.source === doc.path && shown.remote === doc.remote &&
    shown.lineBreaks === writing.lineBreaks;

  let statusShown = null;
  function showPreviewStatus(rendering = false) {
    const tier = previewTier();
    let text = "";
    if (viewMode === "editor") text = "";
    else if (rendering) text = "Rendering preview…";
    else if (previewCurrent() || tier === "live") text = "";
    else if (tier === "pause") text = "Preview updates when you pause typing";
    else text = shown ? "Preview is out of date" : "Preview is not rendered automatically for a document this large";
    if (text === statusShown) return;
    statusShown = text;
    els.previewStatus.hidden = !text;
    $("preview-status-text").textContent = text;
    $("preview-refresh").hidden = rendering;
  }

  let announcedTier = "live";
  function announceTier() {
    const tier = previewTier();
    if (tier === announcedTier) return;
    announcedTier = tier;
    if (viewMode === "editor") return;
    if (tier === "pause") notify("Large document · the preview updates when you pause typing", 9000);
    if (tier === "request") notify("Large document · use View → Refresh Preview to update the preview", 12000);
  }

  function scheduleRender() {
    if (viewMode === "editor") return; // rendered on demand when the preview is shown
    const tier = previewTier();
    announceTier();
    clearTimeout(timers.render);
    // Stay responsive on big documents: wait longer when rendering is slow, and
    // above the live budget wait until typing has stopped or the user asks.
    if (tier === "live") schedule("render", renderNow, Math.min(700, Math.max(MIN_RENDER_DELAY, renderCost * 1.5)));
    else if (tier === "pause" || refreshWanted) schedule("render", () => renderNow({ force: refreshWanted }), PAUSE_MS);
    if (!renderPromise) showPreviewStatus();
  }

  /**
   * Render the current text; resolves true once the preview is up to date.
   * `force` renders even when the document is too large to follow automatically.
   */
  function renderNow({ force = false } = {}) {
    clearTimeout(timers.render);
    if (force) renderForced = true;
    if (renderPromise) {
      renderAgain = true;
      return renderPromise;
    }
    renderPromise = Promise.resolve().then(async () => {
      let ready = false;
      try {
        do {
          renderAgain = false;
          const forced = renderForced;
          renderForced = false;
          announceTier();
          if (!forced && previewTier() === "request") {
            ready = previewCurrent();
            continue;
          }
          const started = performance.now();
          const snapshot = session.snapshot();
          const source = doc.path, remote = doc.remote, lineBreaks = writing.lineBreaks;
          if (forced || previewTier() !== "live") showPreviewStatus(true);
          let html, failure;
          const request = invoke("render", { markdown: snapshot.content, source, remote, knownImages: [...previewAssets.keys()], lineBreaks });
          const sent = performance.now() - started;
          try {
            html = await request;
          } catch (error) {
            failure = error;
          }
          const arrived = performance.now();
          if (!session.isCurrent(snapshot) || source !== doc.path || remote !== doc.remote || lineBreaks !== writing.lineBreaks) {
            // Never show an obsolete result. A render quick enough to keep pace
            // with typing runs again at once. A slower one waits for the delay
            // the overtaking edit started, and a requested one for the next pause:
            // repeating a large render back to back would make typing stutter.
            const tier = previewTier();
            if (tier === "live" && (arrived - started) * 1.5 <= MIN_RENDER_DELAY) renderAgain = true;
            else if (forced && tier === "request") {
              refreshWanted = true;
              if (!renderAgain) schedule("render", () => renderNow({ force: true }), PAUSE_MS);
            }
            ready = false;
            continue;
          }
          if (html === undefined) throw failure || new Error("Missing preview");
          patchPreview(typeof html === "string" ? html : html.html, html.assets || {});
          bindPreviewTasks(html.tasks || {}, snapshot);
          drawDiagrams();
          shown = { snapshot: { document: snapshot.document, revision: snapshot.revision }, source, remote, lineBreaks };
          refreshWanted = false;
          ready = true;
          const finished = performance.now();
          renderCost = finished - started;
          if (snapshot.content.length >= STALL_SAMPLE) {
            // The lowest of the last three timings: a collection pause is not the renderer's cost.
            stallSamples = [...stallSamples.slice(-2), (sent + finished - arrived) / snapshot.content.length];
            const rate = clampRate(Math.min(...stallSamples));
            if (Math.abs(rate - stallRate) > stallRate / 10) store.set("previewRate", rate);
            stallRate = rate;
          }
        } while (renderAgain);
      } catch (error) {
        report(error);
        previewAssets.clear();
        shown = null;
        els.preview.textContent = "Preview unavailable. Your source is still open.";
        ready = false;
      } finally {
        renderPromise = null;
      }
      showPreviewStatus();
      anchors = null;
      if (activePane === "editor") syncFromEditor();
      return ready;
    });
    return renderPromise;
  }

  function refreshPreview() {
    if (viewMode === "editor") return notify("Show the preview to refresh it.");
    return renderNow({ force: true });
  }
  $("preview-refresh").addEventListener("click", () => { refreshPreview(); });

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
    const newKeys = new Array(newNodes.length);
    const newKey = (i) => (newKeys[i] ??= keyOf(newNodes[i]));
    previewAssets = nextAssets;
    // Most blocks are untouched by an edit and compare equal as they stand,
    // source positions included. Only the others are serialised: a block whose
    // lines moved, or one the page changed after it was inserted.
    const moved = [];
    const same = (o, n) => {
      if (oldNodes[o].isEqualNode(newNodes[n])) return true;
      if (nodeKeys.get(oldNodes[o]) !== newKey(n)) return false;
      moved.push(o, n);
      return true;
    };

    let head = 0;
    const limit = Math.min(oldNodes.length, newNodes.length);
    while (head < limit && same(head, head)) head++;
    let oldEnd = oldNodes.length;
    let newEnd = newNodes.length;
    while (oldEnd > head && newEnd > head && same(oldEnd - 1, newEnd - 1)) {
      oldEnd--;
      newEnd--;
    }

    for (let i = 0; i < moved.length; i += 2) copyPositions(newNodes[moved[i + 1]], oldNodes[moved[i]]);

    for (let i = head; i < oldEnd; i++) oldNodes[i].remove();
    const before = oldNodes[oldEnd] || null;
    for (let i = head; i < newEnd; i++) {
      nodeKeys.set(newNodes[i], newKey(i));
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
  let tasksBound = false;
  function bindPreviewTasks(tasks, snapshot) {
    taskBindings = new WeakMap();
    const markers = new Map(Object.entries(tasks));
    // Rendered checkboxes start out disabled, so without markers now or before nothing needs a visit.
    if (!markers.size && !tasksBound) return;
    tasksBound = markers.size > 0;
    for (const box of els.preview.querySelectorAll("input[data-kladje-task]")) {
      const marker = markers.get(box.getAttribute("data-kladje-task"));
      box.disabled = !marker;
      if (marker) {
        box.checked = marker.checked;
        const label = box.closest("li")?.textContent.trim().split("\n")[0].slice(0, 160);
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
    // Someone ticking boxes is working in the preview: keep it current even
    // when the document is too large to follow while typing.
    if (!closing && previewTier() !== "live") renderNow({ force: true });
  });

  // ---------------------------------------------------------------- diagrams

  const diagrams = KladjeDiagrams.create(() => new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "vendor/mermaid.min.js";
    script.onload = () => window.mermaid ? resolve(window.mermaid) : reject(Error("Diagram support did not start."));
    script.onerror = () => reject(Error("Diagram support is not part of this build."));
    document.head.append(script);
  }));
  // The last image of each diagram, by its first source line. It stays visible,
  // dimmed, while an edited diagram is drawn again.
  const drawnDiagrams = new Map();

  /** Draw every Mermaid block in the preview for the screen theme, or light for paper. */
  function drawDiagrams(dark = document.documentElement.dataset.theme === "dark") {
    const blocks = Array.from(els.preview.querySelectorAll("pre > code.language-mermaid"));
    return Promise.all(blocks.map(code => drawDiagram(code.parentElement, code, dark)));
  }

  async function drawDiagram(block, code, dark) {
    const theme = dark ? "dark" : "light";
    if (block.dataset.diagram === theme) return;
    block.dataset.diagram = theme;
    const source = code.textContent;
    const line = parseInt(block.getAttribute("data-sourcepos"), 10) || 0;
    let image = block.querySelector("img.diagram-image:not(.diagram-paper)");
    const earlier = drawnDiagrams.get(line);
    if (!image && earlier) {
      image = showDiagram(block, null, earlier);
      image.classList.add("stale");
    }
    const result = await diagrams.image(source, dark);
    if (!block.isConnected || block.dataset.diagram !== theme || code.textContent !== source) return;
    block.querySelector(".diagram-error")?.remove();
    if (result.error) {
      image?.remove();
      block.classList.remove("diagram-drawn");
      drawnDiagrams.delete(line);
      const note = document.createElement("span");
      note.className = "diagram-error";
      note.textContent = "Diagram: " + result.error;
      block.append(note);
    } else {
      showDiagram(block, image, result).classList.remove("stale");
      if (drawnDiagrams.size > 256) drawnDiagrams.clear();
      drawnDiagrams.set(line, result);
    }
    anchors = null;
  }

  // The native print panel paginates more than once. Keep its image separate
  // from the live preview so screen-theme redraws cannot change a printed page.
  async function preparePrintDiagrams(dark) {
    const blocks = Array.from(els.preview.querySelectorAll("pre > code.language-mermaid"));
    for (const code of blocks) {
      const block = code.parentElement;
      const drawn = await diagrams.image(code.textContent, dark);
      let paper = block.querySelector(".diagram-paper");
      if (drawn.error) {
        paper?.remove();
        block.classList.remove("has-paper-diagram");
        continue;
      }
      if (!paper) {
        paper = document.createElement("img");
        paper.className = "diagram-image diagram-paper";
        block.append(paper);
      }
      paper.alt = "Diagram: " + code.textContent.trim().split(/\s/)[0];
      paper.width = drawn.width;
      paper.height = drawn.height;
      paper.src = drawn.src;
      block.classList.add("has-paper-diagram");
    }
  }

  function showDiagram(block, image, drawn) {
    if (!image) {
      image = document.createElement("img");
      image.className = "diagram-image";
      block.append(image);
    }
    const kind = block.firstElementChild.textContent.trim().split(/\s/)[0];
    image.alt = kind ? `Diagram: ${kind}` : "Diagram";
    image.width = drawn.width;
    image.height = drawn.height;
    image.src = drawn.src;
    block.classList.add("diagram-drawn");
    return image;
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
  // The rows drawn in the list, the row the keyboard is on, and the section
  // that holds the cursor. Collapsed headings are keyed by level, text and
  // occurrence, so the state survives edits elsewhere in the document.
  let headingShown = [], headingActive = -1, headingCurrent = -1;
  const collapsedHeadings = new Set();
  const headingKey = (h, occurrence) => `${h.level}\u0000${h.text}\u0000${occurrence}`;

  function headingTree() {
    const occurrences = new Map();
    return headingRows.map((h, index) => {
      const seen = occurrences.get(h.text) || 0;
      occurrences.set(h.text, seen + 1);
      const next = headingRows[index + 1];
      return {...h, key: headingKey(h, seen), parent: !!next && next.level > h.level};
    });
  }

  function filterHeadings() {
    const needle = headingFilter.value.normalize().toLocaleLowerCase().trim();
    const tree = headingTree();
    let matches;
    if (needle) {
      matches = tree.filter(h => h.text.normalize().toLocaleLowerCase().includes(needle));
    } else {
      // Leave out everything below a collapsed heading.
      matches = [];
      let hiddenBelow = 7;
      for (const h of tree) {
        if (h.level > hiddenBelow) continue;
        hiddenBelow = 7;
        matches.push(h);
        if (h.parent && collapsedHeadings.has(h.key)) hiddenBelow = h.level;
      }
    }
    const start = headingPage * 100;
    // Indent by level from the shallowest heading. A line number is only
    // needed to tell headings with the same text apart.
    const top = headingRows.reduce((least, h) => Math.min(least, h.level), 6);
    const repeated = new Map();
    for (const h of headingRows) repeated.set(h.text, (repeated.get(h.text) || 0) + 1);
    headingShown = matches.slice(start, start + 100).map((h, index) => {
      const option = document.createElement("div");
      const name = h.text || "(untitled heading)";
      const numbered = repeated.get(h.text) > 1;
      option.id = "heading-row-" + index;
      option.className = "heading-row";
      option.dataset.line = String(h.line);
      option.style.setProperty("--depth", String(h.level - top));
      option.setAttribute("role", "treeitem");
      option.setAttribute("aria-level", String(h.level - top + 1));
      option.setAttribute("aria-selected", "false");
      option.setAttribute("aria-label", numbered ? `${name}, line ${h.line}` : name);
      option.title = `Heading level ${h.level} · line ${h.line}`;
      const toggle = document.createElement("span");
      toggle.className = "heading-toggle";
      toggle.setAttribute("aria-hidden", "true");
      if (h.parent && !needle) {
        const open = !collapsedHeadings.has(h.key);
        option.setAttribute("aria-expanded", String(open));
        toggle.dataset.open = String(open);
      }
      const label = document.createElement("span");
      label.className = "heading-text";
      label.textContent = name;
      option.append(toggle, label);
      if (numbered) {
        const where = document.createElement("span");
        where.className = "heading-line";
        where.textContent = String(h.line);
        option.append(where);
      }
      return {...h, option};
    });
    headingList.replaceChildren(...headingShown.map(row => row.option));
    headingCurrent = -1;
    setActiveHeading(headingShown.length ? 0 : -1, false);
    if (!needle) followOutline(true);
    $("heading-go").disabled = !headingShown.length;
    $("heading-pages").hidden = matches.length <= 100;
    $("heading-prev").disabled = headingPage === 0;
    $("heading-next").disabled = start + 100 >= matches.length;
    $("heading-count").textContent = matches.length > 100 ? `Headings ${start + 1}–${start + headingShown.length} of ${matches.length}` :
      matches.length ? `${matches.length} heading${matches.length === 1 ? "" : "s"}` : "No matching headings";
  }

  function setActiveHeading(index, reveal = true) {
    headingShown[headingActive]?.option.classList.remove("active");
    headingShown[headingActive]?.option.setAttribute("aria-selected", "false");
    headingActive = index;
    const row = headingShown[index];
    if (!row) { headingList.removeAttribute?.("aria-activedescendant"); return; }
    row.option.classList.add("active");
    row.option.setAttribute("aria-selected", "true");
    headingList.setAttribute("aria-activedescendant", row.option.id);
    if (reveal) row.option.scrollIntoView?.({block: "nearest"});
  }

  // The side panel marks the section that holds the cursor. While the list is
  // being browsed, or shows filtered or outdated headings, it stays put.
  function followOutline(force = false) {
    if (!sidebarOpen || headingFilter.value.trim() || !outlineSnapshot || !session.isCurrent(outlineSnapshot)) return;
    const line = editor.cursor().line;
    let current = -1;
    headingShown.forEach((row, index) => { if (row.line <= line) current = index; });
    if (current !== headingCurrent) {
      headingShown[headingCurrent]?.option.classList.remove("current");
      headingShown[current]?.option.classList.add("current");
      headingCurrent = current;
    }
    if (force || document.activeElement !== headingList) setActiveHeading(current, !force);
  }

  function toggleHeading(index, open) {
    const row = headingShown[index];
    if (!row?.parent || headingFilter.value.trim()) return false;
    const isOpen = !collapsedHeadings.has(row.key);
    if (open === isOpen) return false;
    if (isOpen) collapsedHeadings.add(row.key); else collapsedHeadings.delete(row.key);
    const line = row.line;
    filterHeadings();
    setActiveHeading(headingShown.findIndex(r => r.line === line));
    return true;
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
    $("outline-title").textContent = "Outline";
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
  $("outline-toggle").addEventListener("click", () => runAction("document_outline"));
  narrowOutline.addEventListener("change", () => { if (narrowOutline.matches && sidebarOpen) hideOutline(); });
  async function chooseHeading() {
    const line = headingShown[headingActive]?.line;
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
    if (event.key === "ArrowDown" && headingShown.length) {
      event.preventDefault();
      headingList.focus();
      setActiveHeading(Math.max(headingActive, 0));
    }
  });
  headingList.addEventListener("keydown", event => {
    const last = headingShown.length - 1;
    const row = headingShown[headingActive];
    const move = {ArrowDown: headingActive + 1, ArrowUp: headingActive - 1, Home: 0, End: last,
      PageDown: headingActive + 10, PageUp: headingActive - 10}[event.key];
    if (move !== undefined) {
      event.preventDefault();
      if (last >= 0) setActiveHeading(Math.min(last, Math.max(0, move)));
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      chooseHeading().catch(showError);
    } else if (event.key === "ArrowRight" && row) {
      event.preventDefault();
      // Open a collapsed heading, or step to its first subheading.
      if (!toggleHeading(headingActive, true) && row.parent && headingShown[headingActive + 1]) setActiveHeading(headingActive + 1);
    } else if (event.key === "ArrowLeft" && row) {
      event.preventDefault();
      // Close an open heading, or step to the heading it belongs to.
      if (!toggleHeading(headingActive, false)) {
        for (let i = headingActive - 1; i >= 0; i--) if (headingShown[i].level < row.level) { setActiveHeading(i); break; }
      }
    }
  });
  const headingRowAt = event => event.target?.closest?.(".heading-row");
  headingList.addEventListener("click", event => {
    const option = headingRowAt(event);
    const index = headingShown.findIndex(row => row.option === option);
    if (index < 0) return;
    if (event.target.closest?.(".heading-toggle") && headingShown[index].parent) {
      toggleHeading(index, collapsedHeadings.has(headingShown[index].key));
      return;
    }
    setActiveHeading(index, false);
    // In the side panel one click on a heading goes there. The modal picker
    // selects first and jumps on a double click or Enter.
    if (sidebarOpen) chooseHeading().catch(showError);
  });
  headingList.addEventListener("dblclick", event => {
    if (!sidebarOpen && headingRowAt(event)) chooseHeading().catch(showError);
  });
  $("heading-form").addEventListener("submit", event => { event.preventDefault(); chooseHeading().catch(showError); });
  $("heading-cancel").addEventListener("click", () => hideOutline());
  outline.addEventListener("keydown", event => {
    if (sidebarOpen && event.key === "Escape") { event.preventDefault(); hideOutline(); focusDocument(); }
  });
  $("outline-close").addEventListener("click", () => { hideOutline(); focusDocument(); });
  outline.addEventListener("close", () => {
    if (!outline.open) { headingRows = []; headingShown = []; headingActive = headingCurrent = -1; outlineSnapshot = null; headingList.replaceChildren(); }
  });

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
    pendingConflict = null;
    observed = null;
    lastDiskError = null;
    retryDiskAfter = 0;
    autosavePaused = false;
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
    shown = null;
    refreshWanted = false;
    announcedTier = "live";
    drawnDiagrams.clear();
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
    // With autosave on, leaving a saved document needs no question.
    if (autosaveReady() && await saveUnattended()) return true;
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

  // Only a document that already has a file, an accepted disk baseline and no
  // open question is saved unasked. Everything else waits for an explicit Save.
  function autosaveReady() {
    if (!autosave || autosavePaused || initializing || busy || comparison.open) return false;
    if (!doc.path || !doc.version || doc.recovered || doc.ignoredVersion || pendingConflict?.path === doc.path || !session.isDirty()) return false;
    const { eol, encoding, separators } = doc.format;
    const content = editor.getText();
    if (eol === "mixed" && content.split("\n").length - 1 !== separators.length) return false;
    return !(encoding === "latin1" && /[^\u0000-\u00ff]/u.test(content));
  }
  function requestAutosave() {
    clearTimeout(timers.autosave);
    if (closing || !autosaveReady()) return;
    const identity = session.document;
    return runFileAction(() => identity === session.document && autosaveReady() && saveUnattended()).catch(report);
  }
  window.addEventListener("blur", requestAutosave);
  // An autosave never asks a question or opens a dialog. File actions run one
  // at a time, so the flag covers exactly the save it wraps.
  let unattended = false;
  async function saveUnattended() {
    unattended = true;
    try { return await save(); } finally { unattended = false; }
  }

  function queuedSave(saveAs) {
    const identity = session.document;
    return runFileAction(() => identity === session.document && save(saveAs));
  }

  async function formatForWrite(content) {
    const format = { ...doc.format };
    if (format.eol === "mixed" && content.split("\n").length - 1 !== format.separators.length) {
      if (!await T.dialog.ask("The number of lines changed in this mixed-ending document. Save using LF throughout?", {
        title: "Line-ending conversion", okLabel: "Use LF", cancelLabel: "Cancel",
      })) return null;
      format.eol = "lf";
      delete format.separators;
    }
    if (format.encoding === "latin1" && /[^\u0000-\u00ff]/u.test(content)) {
      if (!await T.dialog.ask("Some characters cannot be stored in Latin-1. Save this document as UTF-8?", {
        title: "Encoding conversion", okLabel: "Use UTF-8", cancelLabel: "Cancel",
      })) return null;
      format.encoding = "utf8";
    }
    return format;
  }

  const basicVolumes = new Set();
  let pendingConflict = null;
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
    let snapshot = session.snapshot();
    let format = await formatForWrite(snapshot.content);
    if (!format) return false;
    let result, copied = false;
    try {
      session.beginWrite(snapshot);
      notify("Saving…", 60000);
      let conflict = pendingConflict?.path === path ? pendingConflict : null;
      if (!conflict) {
        try {
          result = await invoke("write_file", {path, content:snapshot.content, format, expected, bind:true});
          if (result.conflict) conflict = {path, warning:result.warning};
        } catch (error) {
          if (String(error) !== "KLADJE_COPY_REQUIRED" || unattended) throw error;
        }
      }
      if (conflict || !result) {
        session.endWrite();
        session.requireSave();
        if (conflict) {
          autosavePaused = true;
          if (path === doc.path && pendingConflict !== conflict) {
            pendingConflict = conflict;
            // Dismissing a native Save alert refocuses the window. Recognise this
            // disk revision without accepting it as the baseline for a write.
            doc.ignoredVersion = await invoke("file_version", {path}).catch(() => null);
          }
        }
        await saveRecovery();
        refreshChrome();
        if (unattended) {
          notify("Autosave paused · the file changed on disk · use Save to keep your version separately", 60000);
          return false;
        }
        const explanation = conflict
          ? (conflict.warning || "Another program changed the file during the save.") +
            "\n\nSave your current text in a new folder beside the file and continue editing that copy? Relative links will resolve from the new folder."
          : "This volume cannot safely publish this file at the chosen name. Save a complete copy inside a new folder beside it and continue editing the copy? Relative links will resolve from the new folder.";
        if (!await T.dialog.ask(explanation, conflict
          ? {title:"Conflicting save", kind:"warning", okLabel:"Save My Version Separately…", cancelLabel:"Keep Editing"}
          : {title:"Save a Protected Copy", okLabel:"Save Copy", cancelLabel:"Cancel"})) {
          notify(conflict ? "Your edits are still open · recovery retained" : "Copy cancelled · document remains open");
          return false;
        }
        // The user may have edited while the first write or the question was pending.
        if (!session.isCurrent(snapshot)) {
          snapshot = session.snapshot();
          format = await formatForWrite(snapshot.content);
          if (!format) return false;
        }
        session.beginWrite(snapshot);
        result = await invoke("save_protected_copy", {path, content:snapshot.content, format});
        path = result.version.target;
        copied = true;
      }
    } catch (error) {
      session.endWrite();
      session.requireSave();
      refreshChrome();
      saveRecovery();
      const message = String(error);
      if (unattended) {
        autosavePaused = true;
        const reason = /changed on disk/i.test(message) ? "the file changed on disk" :
          message === "KLADJE_COPY_REQUIRED" ? "this volume needs an explicit Save" : "the file could not be written";
        notify(`Autosave paused · ${reason} · use Save or Save As`, 60000);
        return false;
      }
      notify("Save failed · edits remain open", 30000);
      await showError(/save as/i.test(message) ? message : message + "\nUse Save As to save a separate copy.");
      return false;
    }
    session.endWrite();
    autosavePaused = !result.confirmed;
    if (result.confirmed) pendingConflict = null;
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
    // Mention a volume without atomic replacement once per folder, then save quietly.
    const plain = result.basic && !basicVolumes.has(dirname(path));
    if (result.basic) basicVolumes.add(dirname(path));
    const saved = copied ? `Saved copy to ${path}` : plain ? "Saved · this volume does not support protected replacement" : "Saved";
    if (confirmed) notify(clean ? saved : "Earlier edits saved · newer edits are unsaved", plain ? 12000 : undefined);
    else notify("Save unconfirmed · recovery retained · retry Save or use Save As", 60000);
    refreshChrome();
    if (moved) {
      doc.remote = false;
      // Relative image paths now resolve against the new folder.
      els.preview.replaceChildren();
      shown = null;
      renderNow();
    }
    if (result.warning && !unattended) await showError(result.warning);
    return clean;
  }

  async function newFromTemplate() {
    const path = await T.dialog.open({title: "New from Template", multiple: false,
      filters: [{name: "Markdown or plain text", extensions: MARKDOWN_EXT}]});
    if (!path) return;
    return openWindow({kind:"template", path});
  }

  const comparison = $("comparison");
  let comparisonView = null;
  function discardComparison() {
    comparisonView?.destroy();
    comparisonView = null;
  }
  comparison.addEventListener("close", () => { if (!comparison.open) discardComparison(); });
  $("comparison-previous").addEventListener("click", () => comparisonView?.previous());
  $("comparison-next").addEventListener("click", () => comparisonView?.next());
  async function compareWithDisk() {
    if (!doc.path) return notify("Save the document before comparing it with disk.");
    if (editor.textLength() > 512 * 1024) return notify("Comparison supports up to 524,288 UTF-16 code units in the editor and 512 KiB on disk.", 12000);
    const before = session.snapshot();
    const disk = (await invoke("comparison_text", {path: doc.path})).replace(/\r\n?/g, "\n");
    if (!session.isCurrent(before)) return notify("The document changed. Open Compare with Disk again.");
    const source = before.content;
    const sections = window.KladjeEditor.changedSections(source, disk);
    $("comparison-summary").textContent = sections === 0 ? "Both versions have the same text. Line endings and encoding are ignored." :
      `${sections} changed section${sections === 1 ? "" : "s"}. Both versions are read-only snapshots.`;
    for (const id of ["comparison-previous", "comparison-next"]) $(id).disabled = sections === 0;
    // The view measures its lines, so it is built after the dialog is on screen.
    comparison.showModal();
    discardComparison();
    comparisonView = window.KladjeEditor.compare($("comparison-view"), source, disk);
  }

  // ---------------------------------------------------------------- rename, move and duplicate

  async function moveDocument(target, verb) {
    const before = doc.path;
    const version = await invoke("move_document", {from: before, to: target, expected: doc.version});
    doc.path = target;
    doc.name = basename(target);
    doc.version = version;
    doc.ignoredVersion = null;
    await updateHistory({kind: "remove", path: before});
    await rememberPath(target);
    if (session.isDirty()) saveRecovery();
    refreshChrome();
    if (dirname(before) !== dirname(target)) {
      // Relative links and images now resolve from the new folder.
      doc.remote = false;
      els.preview.replaceChildren();
      renderNow();
    }
    notify(`${verb} ${doc.name}`);
    return true;
  }

  const rename = $("rename");
  const renameName = $("rename-name");
  let renameDone = null;
  function renameDocument() {
    if (!doc.path) return notify("Save this document first to give it a name.");
    renameName.value = doc.name;
    $("rename-error").textContent = "";
    rename.showModal();
    renameName.focus();
    // Select the name without its extension, as Finder does.
    const dot = doc.name.lastIndexOf(".");
    renameName.setSelectionRange(0, dot > 0 ? dot : doc.name.length);
    return new Promise(resolve => { renameDone = resolve; });
  }
  async function submitRename() {
    if (!doc.path) { rename.close(); return false; }
    const name = renameName.value.trim();
    const show = text => { $("rename-error").textContent = text; return false; };
    if (!name || name === "." || name === "..") return show("Enter a file name.");
    if (/[\\/:\u0000-\u001f]/.test(name)) return show("A file name cannot contain / \\ or :.");
    // Keep the document a Markdown or text file.
    const finalName = MARKDOWN_EXT.includes(extension(name)) ? name : `${name}.${extension(doc.name) || "md"}`;
    if (finalName === doc.name) { rename.close(); return true; }
    try {
      await moveDocument(resolvePath(dirname(doc.path), finalName), "Renamed to");
      rename.close();
      return true;
    } catch (error) { return show(String(error)); }
  }
  $("rename-form").addEventListener("submit", event => { event.preventDefault(); return submitRename(); });
  $("rename-cancel").addEventListener("click", () => rename.close());
  rename.addEventListener("close", () => { renameDone?.(); renameDone = null; });

  async function moveDocumentTo() {
    if (!doc.path) return notify("Save this document first to give it a place.");
    const target = await T.dialog.save({title: "Move To", defaultPath: doc.path,
      filters: [{name: "Markdown", extensions: ["md", "markdown"]}]});
    if (!target || target === doc.path) return false;
    return moveDocument(target, "Moved to");
  }

  async function duplicateDocument() {
    if (!doc.path) return notify("Save this document first to duplicate it.");
    const content = editor.getText();
    const format = await formatForWrite(content);
    if (!format) return false;
    const ext = extension(doc.name) || "md", base = stem(doc.name);
    for (let n = 1; n <= 99; n++) {
      const path = resolvePath(dirname(doc.path), `${base} copy${n > 1 ? " " + n : ""}.${ext}`);
      if (await invoke("file_version", {path})) continue;
      // The copy holds the text as it is in this window, including unsaved edits.
      const copy = await invoke("write_file", {path, content, format, expected: null});
      if (!copy.confirmed) {
        await showError(copy.warning || "The copy could not be confirmed. Check the destination before continuing.");
        return false;
      }
      return openWindow({kind: "open", path});
    }
    notify("There are already 99 copies of this document here.");
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
      const snapshot = session.snapshot();
      const dark = writing.darkExport;
      const lineBreaks = writing.lineBreaks;
      // The exported page shows diagrams as images. A diagram that cannot be
      // drawn stays in the page as its source text.
      const drawn = [];
      for (const source of (await invoke("diagram_sources", { markdown: snapshot.content })).slice(0, 64)) {
        const diagram = await diagrams.image(source, dark);
        if (!diagram.error) drawn.push({ source, dark, ...diagram });
      }
      if (drawn.length) await invoke("store_diagrams", { diagrams: drawn });
      const expected = await invoke("file_version", { path });
      if (expected && !await T.dialog.ask(`Replace “${basename(path)}” with this HTML export?`, {
        title: "Export HTML", okLabel: "Replace File", cancelLabel: "Cancel",
      })) return;
      const result = await invoke("export_html", { path, markdown: snapshot.content, title: stem(doc.name), source: doc.path, expected, lineBreaks, dark });
      if (result.warning) await showError(result.warning);
      if (result.confirmed) notify(`Exported ${basename(path)}`);
    } catch (error) {
      await showError(error);
    } finally {
      busy = false;
    }
  }

  const PREPARING_PRINT = "Preparing the document for printing…";
  const PRINT_OVERTAKEN = "Document changed while preparing print. Print again to use the latest text.";
  const donePreparing = () => { if (els.notice.textContent === PREPARING_PRINT) els.notice.classList.remove("visible"); };
  async function printDocument() {
    const snapshot = { document: session.document, revision: session.document.revision };
    let timeout;
    try {
      // Print uses the rendered document, so render it now whatever the live preview is doing.
      notify(PREPARING_PRINT, 600000);
      if (!await renderNow({ force: true })) {
        if (!session.isCurrent(snapshot)) return notify(PRINT_OVERTAKEN, 15000);
        return showError("The document could not be rendered for printing.");
      }
      updateExportAppearance();
      await preparePrintDiagrams(writing.darkExport);
      const images = Array.from(els.preview.querySelectorAll("img[src]"));
      const decoded = Promise.all(images.map(image => image.decode())).then(() => true, () => false);
      const loaded = await Promise.race([decoded, new Promise(resolve => { timeout = setTimeout(() => resolve(false), 10000); })]);
      if ((!loaded || els.preview.querySelector(".asset-missing")) && !await T.dialog.ask("Some images are unavailable. Print the document with these images omitted?", {
        title: "Print", okLabel: "Print Anyway", cancelLabel: "Cancel",
      })) return;
      await document.fonts.ready;
      // The page stands still while the print dialog is open: take the note down first.
      donePreparing();
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      if (!session.isCurrent(snapshot)) return notify(PRINT_OVERTAKEN, 15000);
      await invoke("print_document", {pageNumbers:writing.pageNumbers});
    } finally {
      clearTimeout(timeout);
      donePreparing();
    }
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
    if (writing.tablePaste && editor.pasteTable(plain)) {
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

  // Probe only the foreground document. An unchanged stamp avoids reading any
  // document bytes. Focus and Save still compare the authoritative disk revision.
  const DISK_INTERVAL = 1500;
  let observed = null, checkingDisk = false, lastDiskError = null, retryDiskAfter = 0, forceDiskCheck = false;

  async function checkDisk(force) {
    const path = doc.path;
    if (!path || !doc.version || closing || quitEpoch !== null) return;
    const before = {document: session.document, revision: session.document.revision};
    const stamp = await invoke("file_stamp", {path});
    const previous = observed?.document === before.document && observed.path === path ? observed : null;
    if (!force && previous && stamp?.target === previous.stamp?.target && stamp?.change === previous.stamp?.change) return;
    const record = () => { observed = {document:before.document, path, stamp}; };
    const version = await invoke("file_version", {path});
    if (sameVersion(version, doc.version) || (session.isDirty() && sameVersion(version, doc.ignoredVersion))) {
      record();
      return;
    }
    autosavePaused = true;
    if (!version) {
      if (previous && !previous.stamp && !stamp) return;
      session.requireSave();
      saveRecovery();
      refreshChrome();
      notify("File was moved or deleted · use Save As to keep a copy", 30000);
      record();
      return;
    }
    observed = null; // A forced digest check can detect changes even with identical metadata.
    const file = await invoke("read_file", {path});
    if (!session.isCurrent(before)) {
      notify("File changed on disk while you were editing · your edits are still open", 15000);
      return; // Retry after typing settles, even when the metadata stays the same.
    }
    if (session.isDirty()) {
      const reload = await T.dialog.ask(`“${doc.name}” changed on disk. Reload the disk version and discard the edits in this window? Choose Keep Edits to use File → Compare with Disk or Save As.`, {
        title: "Conflicting changes", kind: "warning", okLabel: "Reload Disk Version", cancelLabel: "Keep Edits",
      });
      if (!session.isCurrent(before)) return;
      if (!reload) {
        doc.ignoredVersion = file.version;
        record();
        notify("Kept your edits · use Compare with Disk or Save As", 15000);
        return;
      }
    }
    await invoke("accept_reload", {path, version:file.version});
    if (!session.isCurrent(before)) return;
    const top = editor.scroller.scrollTop;
    editor.replaceText(file.content.replace(/\r\n?/g, "\n"), true);
    doc.version = file.version;
    doc.ignoredVersion = null;
    pendingConflict = null;
    autosavePaused = false;
    doc.format = file.format;
    session.acknowledge(session.snapshot());
    clearRecovery();
    editor.scroller.scrollTop = top;
    refreshChrome();
    record();
    notify(`${doc.name} was reloaded from disk.`);
  }

  function requestDiskCheck(force = false) {
    forceDiskCheck ||= force;
    if (checkingDisk || initializing || busy || closing || quitEpoch !== null || !doc.path || !doc.version) return;
    checkingDisk = true;
    return runFileAction(async () => {
      if (busy || quitEpoch !== null || comparison.open || document.querySelector?.("dialog[open]")) return;
      if (!force && (document.hidden || document.hasFocus?.() === false || Date.now() < retryDiskAfter)) return;
      const full = forceDiskCheck;
      forceDiskCheck = false;
      await checkDisk(full);
      lastDiskError = null;
      retryDiskAfter = 0;
    }).catch(error => {
      retryDiskAfter = Date.now() + 30000;
      if (lastDiskError !== String(error)) notify(String(error), 15000);
      lastDiskError = String(error);
    }).finally(() => { checkingDisk = false; });
  }

  async function pollDisk() {
    try { await requestDiskCheck(); }
    finally { if (!closing) setTimeout(pollDisk, DISK_INTERVAL); }
  }

  window.addEventListener("focus", () => {
    syncChecks();
    return requestDiskCheck(true);
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
      await preferences.flush();
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
          await preferences.flush();
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

  // ---------------------------------------------------------------- settings window

  const settingTabs = ["general", "editor", "preview", "appearance"];
  let settingsTab = "general";
  function showSettingsTab(name, focus = false) {
    settingsTab = name;
    for (const tab of settingTabs) {
      const selected = tab === name;
      $("tab-" + tab).setAttribute("aria-selected", String(selected));
      $("tab-" + tab).tabIndex = selected ? 0 : -1;
      $("pane-" + tab).hidden = !selected;
    }
    if (focus) $("tab-" + name).focus();
  }
  for (const tab of settingTabs) {
    $("tab-" + tab).addEventListener("click", () => showSettingsTab(tab));
    $("tab-" + tab).addEventListener("keydown", event => {
      const step = {ArrowRight: 1, ArrowLeft: -1}[event.key];
      if (!step) return;
      event.preventDefault();
      showSettingsTab(settingTabs[(settingTabs.indexOf(tab) + step + settingTabs.length) % settingTabs.length], true);
    });
  }
  // These mirror View menu items; each runs the menu's own toggle when it differs.
  for (const [id, action, current] of [["pref-gutter", "gutter", () => gutter], ["pref-wrap", "wrap", () => wrap],
    ["pref-measure", "measure", () => measure], ["pref-sync", "sync_scroll", () => syncEnabled]]) {
    $(id).addEventListener("change", () => { if ($(id).checked !== current()) actions[action](); });
  }
  settings.addEventListener("change", event => {
    const input = event.target;
    if (input?.name === "theme") setTheme(input.value);
    if (input?.name === "editorFont") setEditorFont(input.value);
  });
  $("zoom-smaller").addEventListener("click", () => setZoom(zoom - 0.1));
  $("zoom-larger").addEventListener("click", () => setZoom(zoom + 0.1));
  $("zoom-default").addEventListener("click", () => setZoom(1));

  const TABLE = "| Column 1 | Column 2 |\n| --- | --- |\n| Cell | Cell |";
  // Menu id → table-edit.mjs operation.
  const TABLE_EDITS = {
    table_row: ["rowBelow"], table_row_above: ["rowAbove"],
    table_column_before: ["columnBefore"], table_column_after: ["columnAfter"],
    table_row_up: ["moveUp"], table_row_down: ["moveDown"],
    table_delete_row: ["deleteRow"], table_delete_column: ["deleteColumn"],
    table_align_left: ["align", "left"], table_align_center: ["align", "center"],
    table_align_right: ["align", "right"], table_align_none: ["align", "none"],
    table_format: ["format"],
  };
  function readTableHint(op) {
    if (!editor.inTable()) return "Place the cursor inside a Markdown table.";
    return {rowAbove: "The header row stays at the top of the table.", deleteRow: "The header row cannot be deleted.",
      moveUp: "This row is already directly below the header.", moveDown: "This is already the last row.",
      deleteColumn: "A table keeps at least one column."}[op] || "This change does not apply here.";
  }
  const isoDate = date => [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")].join("-");
  const actions = {
    new: () => runFileAction(() => openWindow({kind:"new"})),
    new_tab: () => runFileAction(() => invoke("open_document_window", {request:{kind:"new"}, tab:true})),
    open: () => runFileAction(chooseAndOpen),
    new_template: () => runFileAction(newFromTemplate),
    compare_disk: () => runFileAction(compareWithDisk),
    rename: () => runFileAction(renameDocument),
    move_to: () => runFileAction(moveDocumentTo),
    duplicate: () => runFileAction(duplicateDocument),
    clear_recent: () => runFileAction(async () => {
      await updateHistory({kind:"clear"});
    }),
    refresh_preview: refreshPreview,
    jump_heading: jumpToHeading,
    check_document: () => runFileAction(async () => {
      const snapshot = session.snapshot();
      const message = await invoke("check_document", {markdown:editor.getText(), source:doc.path});
      if (!session.isCurrent(snapshot)) return notify("The document changed. Run Check Document again.");
      await T.dialog.message(message, {title:"Check Document"});
    }),
    document_outline: toggleSidebar,
    // The window reopens on the section that was open last.
    settings: () => { syncSettings(); showSettingsTab(settingsTab); settings.showModal(); },
    format_bar: () => {
      writing.formatBar = !writing.formatBar;
      store.set("formatBar", writing.formatBar);
      applyFormatBar();
      syncChecks();
      if (!writing.formatBar) editor.focus();
    },
    close_window: () => runFileAction(() => finishClose(() => appWindow.destroy())),
    reveal: () => doc.path ? invoke("reveal_document", {path:doc.path}) : notify("Save this document first to reveal it."),
    fold: () => editor.fold(),
    find_selection: () => editor.findSelection(),
    copy_formatted: async () => {
      const markdown = editor.selectedText();
      if (!markdown) return notify("Select Markdown to copy as formatted text.");
      const html = await invoke("formatted_selection", {markdown, lineBreaks: writing.lineBreaks});
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
    table: () => editor.insertBlock(() => ({ text: TABLE, selectFrom: 2, selectTo: 10 })),
    ...Object.fromEntries(Object.entries(TABLE_EDITS).map(([id, [op, arg]]) => [id, () => {
      if (!editor.editTable(op, arg)) {
        notify(readTableHint(op));
      }
    }])),
    rule: () => editor.insertBlock(() => ({ text: "---", selectFrom: 3, selectTo: 3 })),
    highlight: () => editor.toggleWrap("=="),
    math: () => editor.toggleWrap("$"),
    math_block: () => editor.insertBlock((selected) => ({ text: "$$\n" + selected + "\n$$", selectFrom: 3, selectTo: 3 + selected.length })),
    footnote: () => editor.insertFootnote(),
    ...Object.fromEntries(["note", "tip", "important", "warning", "caution"].map(kind => ["callout_" + kind, () =>
      editor.insertBlock((selected) => {
        const head = `> [!${kind.toUpperCase()}]\n`;
        const lines = (selected || "").split("\n").map(line => line ? "> " + line : ">");
        const text = head + (selected ? lines.join("\n") : "> ");
        return { text, selectFrom: text.length, selectTo: text.length };
      })])),
    date_iso: () => editor.insertText(isoDate(new Date())),
    date_long: () => editor.insertText(new Date().toLocaleDateString(undefined, { dateStyle: "long" })),
    fold_all: () => editor.foldAll(),
    unfold_all: () => editor.unfoldAll(),

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
    "find_selection", "fold", "copy_formatted", "bullet", "numbered", "task", "quote", "codeblock", "table", "rule",
    "highlight", "math", "math_block", "footnote", "date_iso", "date_long", "fold_all", "unfold_all",
    ...Object.keys(TABLE_EDITS), ...["note", "tip", "important", "warning", "caution"].map(kind => "callout_" + kind),
  ]);

  async function runAction(id) {
    if (((outline.open && !sidebarOpen) || comparison.open || settings.open || rename.open) && id !== "quit") {
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
    if (preferences.warning) notify(preferences.warning, 15000);
    setView(viewMode);
    applyEditorLayout();
    editor.setPairing(writing.pairing);
    applyWritingModes();
    applyFormatBar();
    els.app.dataset.editorFont = editorFont;
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
    setTimeout(pollDisk, DISK_INTERVAL);
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
