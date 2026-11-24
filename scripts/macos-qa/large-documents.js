// Loaded only by the isolated QA build started with --large. Measures what one
// preview update costs the webview's main thread on large fixtures, and whether
// typing stays smooth while a render is in flight.
const originalCreate = window.KladjeEditor.create;
let qaEditor;
window.KladjeEditor.create = (...args) => (qaEditor = originalCreate(...args));

const qa = { renders: [], resolved: null, patchedLength: -1 };
const now = () => performance.now();
const nativeInvoke = window.__TAURI__.core.invoke;
// The API object is frozen, so the runner routes the QA copy of app.js through here.
window.qaInvoke = (invoke) => function (name, args, options) {
  if (name === "print_document") qa.printed = now();
  if (name !== "render") return invoke(name, args, options);
  const entry = { length: args.markdown.length, start: now() };
  const pending = invoke(name, args, options);
  entry.sendMs = now() - entry.start;
  qa.renders.push(entry);
  const settle = () => {
    entry.roundTripMs = now() - entry.start;
    qa.resolved = entry;
    // The app continues in microtasks; the next task marks the end of that work.
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      entry.blockMs = now() - entry.start - entry.roundTripMs;
      const blocked = now();
      requestAnimationFrame(() => requestAnimationFrame(() => {
        entry.framesMs = now() - blocked;
        entry.done = true;
      }));
    };
    channel.port2.postMessage(0);
  };
  return pending.then(value => {
    entry.htmlLength = (typeof value === "string" ? value : value.html).length;
    settle();
    return value;
  }, error => {
    entry.failed = String(error);
    settle();
    throw error;
  });
};
// The runner wraps patchPreview in the QA copy of app.js so it reports here.
window.qaPatch = (ms) => {
  if (!qa.resolved) return;
  qa.resolved.patchMs = ms;
  qa.patchedLength = qa.resolved.length;
};

window.addEventListener("load", async () => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  const round = (value) => (value === undefined ? null : Math.round(value * 10) / 10);
  const sorted = (values) => [...values].sort((a, b) => a - b);
  const median = (values) => sorted(values)[Math.floor(values.length / 2)];
  const p95 = (values) => sorted(values)[Math.ceil(values.length * 0.95) - 1];
  async function wait(check, name, limit = 240000) {
    const start = now();
    while (!check()) {
      if (now() - start > limit) throw Error("Timed out waiting for " + name);
      await sleep(16);
    }
    return now() - start;
  }
  const write = (path, content) =>
    nativeInvoke("write_file", { path, content, format: { encoding: "utf8", eol: "lf" }, expected: null });
  // An existing file is never replaced without its version, so each note gets a new name.
  let notes = 0;
  const phase = (name) => write(window.qaResultPath + ".phase." + ++notes + ".txt", name);
  const partial = () => write(window.qaResultPath + ".partial." + ++notes + ".txt", JSON.stringify(report, null, 2));
  const report = { userAgent: navigator.userAgent, viewport: [innerWidth, innerHeight], sizes: [] };
  const preview = document.getElementById("preview");
  const current = () => qa.patchedLength === qaEditor.textLength() && qa.resolved?.done;
  const statusText = () => {
    const status = document.getElementById("preview-status");
    return status && !status.hidden ? document.getElementById("preview-status-text").textContent : "";
  };
  /** Wait for a current preview, asking for one where the app renders on request only. */
  async function settle(name, also = () => true) {
    let requested = false;
    await wait(() => {
      const ready = also();
      if (current() && ready) return true;
      if (/out of date|not rendered/.test(statusText())) {
        document.getElementById("preview-refresh").click();
        requested = true;
      }
      return false;
    }, name);
    return requested;
  }
  const summary = (entry) => ({
    sendMs: round(entry.sendMs), roundTripMs: round(entry.roundTripMs), patchMs: round(entry.patchMs),
    blockMs: round(entry.blockMs), framesMs: round(entry.framesMs),
  });
  const SOURCEPOS = / data-sourcepos="[^"]*"/g;
  /** Longest time the main thread went without running a timer, in milliseconds. */
  function stallWatch() {
    let longest = 0, last = now();
    const timer = setInterval(() => {
      const t = now();
      longest = Math.max(longest, t - last);
      last = t;
    }, 4);
    return () => {
      clearInterval(timer);
      return Math.max(longest, now() - last);
    };
  }

  /** The same steps the app takes, timed apart on a detached template. */
  async function pipeline(markdown) {
    const started = now();
    const result = await nativeInvoke("render", { markdown, source: null, remote: false, knownImages: [] });
    const roundTripMs = now() - started;
    const template = document.createElement("template");
    let t = now();
    template.innerHTML = result.html;
    const parseMs = now() - t;
    t = now();
    for (const link of template.content.querySelectorAll("a[href]")) {
      link.dataset.destination = link.getAttribute("href");
      link.setAttribute("href", "#");
    }
    template.content.querySelectorAll("img");
    const linksMs = now() - t;
    const nodes = Array.from(template.content.childNodes);
    t = now();
    const keys = nodes.map((node) => (node.nodeType === 1 ? node.outerHTML.replace(SOURCEPOS, "") : "#" + node.nodeValue));
    const keysMs = now() - t;
    const twin = document.createElement("template");
    twin.innerHTML = result.html;
    const others = twin.content.childNodes;
    t = now();
    let same = 0;
    for (let i = 0; i < nodes.length; i++) if (nodes[i].isEqualNode(others[i])) same++;
    const equalMs = now() - t;
    return { roundTripMs, htmlKiB: Math.round(result.html.length / 1024), blocks: keys.length, parseMs, linksMs, keysMs, equalMs };
  }

  async function typed(samples, line) {
    qaEditor.goToLine(line);
    qaEditor.focus();
    await frame();
    await frame();
    const updates = [], settled = [], stalls = [];
    let status = "", requested = false;
    for (let n = 0; n < samples; n++) {
      const before = qa.renders.length, started = now(), stalled = stallWatch();
      if (!document.execCommand("insertText", false, "Z")) throw Error("WKWebView text insertion failed");
      // The editor reads the insertion from a mutation record, one microtask later.
      await Promise.resolve();
      await Promise.resolve();
      status = statusText();
      requested = await settle("preview after an edit at line " + line, () => qa.renders.length > before);
      settled.push(now() - started);
      stalls.push(stalled());
      updates.push(qa.resolved);
      await sleep(50);
    }
    const pick = (key) => round(median(updates.map((entry) => entry[key] ?? 0)));
    return { samples, status, requested, settledMs: round(median(settled)), sendMs: pick("sendMs"), roundTripMs: pick("roundTripMs"),
      patchMs: pick("patchMs"), blockMs: pick("blockMs"), framesMs: pick("framesMs"),
      longestStallMs: round(median(stalls)), longestStallMaxMs: round(Math.max(...stalls)) };
  }

  /** Keep typing at a steady pace from the moment a render request leaves. */
  async function typingDuringRender(line, keystrokes, interval) {
    qaEditor.goToLine(line);
    qaEditor.focus();
    await frame();
    let gap = 0, last = 0, watching = true;
    const watch = () => {
      const t = now();
      gap = Math.max(gap, t - last);
      last = t;
      if (watching) requestAnimationFrame(watch);
    };
    const before = qa.renders.length;
    document.execCommand("insertText", false, "Y");
    await wait(() => {
      if (qa.renders.length > before) return true;
      if (/out of date|not rendered/.test(statusText())) document.getElementById("preview-refresh").click();
      return false;
    }, "a render request during typing");
    last = now();
    requestAnimationFrame(watch);
    const stalled = stallWatch();
    const insert = [], frames = [];
    const first = qa.renders.length;
    for (let n = 0; n < keystrokes; n++) {
      const started = now();
      document.execCommand("insertText", false, "y");
      insert.push(now() - started);
      await frame();
      await frame();
      frames.push(now() - started);
      const rest = interval - (now() - started);
      if (rest > 0) await sleep(rest);
    }
    watching = false;
    const stall = stalled();
    const requests = qa.renders.length - first + 1;
    const status = statusText();
    await settle("preview after typing");
    return { keystrokes, status, intervalMs: interval, insertMedianMs: round(median(insert)), insertMaxMs: round(Math.max(...insert)),
      inputToSecondFrameMedianMs: round(median(frames)), inputToSecondFrameP95Ms: round(p95(frames)),
      inputToSecondFrameMaxMs: round(Math.max(...frames)), longestFrameGapMs: round(gap), longestStallMs: round(stall),
      renderRequests: requests };
  }

  try {
    await wait(() => preview.querySelector("#uc-start") && !document.getElementById("editor-pane").inert, "native file open");
    if (!qa.renders.length) throw Error("The render bridge is not observed");
    for (const fixture of window.qaFixtures) {
      const data = { kib: fixture.kib };
      report.sizes.push(data);
      await phase(fixture.kib + " KiB: read");
      const content = (await nativeInvoke("read_file", { path: fixture.path })).content;
      data.sourceKiB = Math.round(content.length / 1024);
      await phase(fixture.kib + " KiB: first preview");
      qa.patchedLength = -1;
      const opened = now();
      qaEditor.replaceText(content);
      data.replaceTextMs = round(now() - opened);
      await frame();
      data.statusAfterOpen = statusText();
      const counted = () => {
        if (data.statisticsMs === undefined && qaEditor.statistics()) data.statisticsMs = round(now() - opened);
        return true;
      };
      data.firstPreviewRequested = await settle("first preview of " + fixture.kib + " KiB", counted);
      data.firstPreview = { settledMs: round(now() - opened), ...summary(qa.resolved) };
      data.previewBlocks = preview.childNodes.length;
      for (let n = 0; n < 600 && data.statisticsMs === undefined; n++) {
        await sleep(25);
        counted();
      }
      data.statistics = qaEditor.statistics();
      await partial();

      await phase(fixture.kib + " KiB: edits");
      const lines = qaEditor.cursor().lines;
      data.editAtStart = await typed(5, 3);
      data.editInMiddle = await typed(5, Math.floor(lines / 2));
      await partial();

      await phase(fixture.kib + " KiB: typing during render");
      data.typing = await typingDuringRender(Math.floor(lines / 2) + 2, 60, 110);
      await partial();

      await phase(fixture.kib + " KiB: detached pipeline");
      const runs = [];
      for (let n = 0; n < (fixture.kib > 4096 ? 1 : 3); n++) runs.push(await pipeline(content));
      const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
      const counting = now();
      let words = 0;
      for (const line of content.split("\n")) for (const part of segmenter.segment(line)) if (part.isWordLike) words++;
      data.wordCountMs = round(now() - counting);
      data.words = words;
      data.detached = Object.fromEntries(Object.keys(runs[0]).map((key) => [key, round(median(runs.map((run) => run[key])))]));
      await partial();
    }
    if (window.qaPrint) {
      // Print straight after loading: the app has to render on demand, whatever the preview was doing.
      await phase(window.qaPrint.kib + " KiB: print");
      const content = (await nativeInvoke("read_file", { path: window.qaPrint.path })).content;
      qa.patchedLength = -1;
      qa.printed = 0;
      qaEditor.replaceText(content);
      await frame();
      const status = statusText(), asked = now();
      const label = window.__TAURI__.window.getCurrentWindow().label;
      await window.__TAURI__.event.emitTo(label, "menu", "export_pdf");
      let preparing = "";
      await wait(() => {
        preparing ||= document.getElementById("notice").textContent;
        return qa.printed;
      }, "the native print request", 900000);
      report.print = { kib: window.qaPrint.kib, statusBeforePrint: status, noticeWhilePreparing: preparing,
        preparedMs: round(qa.printed - asked), previewBlocks: preview.childNodes.length, current: qa.patchedLength === qaEditor.textLength() };
    }
    await phase("done");
  } catch (error) {
    report.error = String(error);
    report.notice = document.getElementById("notice").textContent;
  }
  await write(window.qaResultPath, JSON.stringify(report, null, 2));
});
