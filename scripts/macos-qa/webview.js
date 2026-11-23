// Loaded only by the isolated QA build. Exercise the shipped editor and bridge.
const originalCreate = window.KladjeEditor.create;
let qaEditor;
window.KladjeEditor.create = (...args) => (qaEditor = originalCreate(...args));

window.addEventListener("load", async () => {
  const { core, event } = window.__TAURI__;
  const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
  async function wait(check, name) {
    const start = performance.now();
    while (!check()) {
      if (performance.now() - start > 20000) throw Error("Timed out waiting for " + name);
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
  }
  const menu = (id) => event.emit("menu", id);
  const report = { checks: [], sizes: [] };
  const preview = document.getElementById("preview");
  const check = (value, name) => {
    if (!value) throw Error(name);
    report.checks.push(name);
  };
  const text = () => qaEditor.getText();
  const edit = (value) => qaEditor.replaceText(value);
  const percentile = (values) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1];
  const write = (path, content) =>
    core.invoke("write_file", { path, content, format: { encoding: "utf8", eol: "lf" }, expected: null });
  let step = 0;
  const checkpoint = (message) => write(window.qaResultPath + "." + ++step + ".txt", message);
  try {
    await wait(
      () => preview.querySelector("#uc-start") && !document.getElementById("editor-pane").inert,
      "native file open",
    );
    report.readyEpochMs = Date.now();
    check(
      document.querySelector('[contenteditable="true"]').getAttribute("aria-label") ===
        "Markdown source editor",
      "named editing field",
    );
    check(preview.querySelector("img").src.startsWith("data:image/png;base64,"), "document-relative raster");
    check(
      !!preview.querySelector(".asset-missing") && !preview.querySelector('img[src^="https:"]'),
      "remote image blocked before attachment",
    );
    check(!!preview.querySelector("math mfrac"), "MathML rendered in WebKit");
    const sep = document.getElementById("divider");
    sep.focus();
    sep.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    check(sep.getAttribute("aria-valuenow") === "55", "keyboard splitter");
    sep.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    check(document.activeElement.classList.contains("cm-content"), "splitter returns focus to source");

    if (window.qaPaste) {
      const before = text();
      const png = preview.querySelector("img").src.split(",")[1];
      const bytes = Uint8Array.from(atob(png), c => c.charCodeAt(0));
      const clipboard = new DataTransfer();
      clipboard.items.add(new File([bytes], "test.png", {type:"image/png"}));
      qaEditor.goToLine(1);
      qaEditor.focus();
      await write(window.qaResultPath + ".paste.txt", "Await Save Image");
      document.querySelector(".cm-content").dispatchEvent(new ClipboardEvent("paste",
        {clipboardData: clipboard, bubbles:true, cancelable:true}));
      await wait(() => text().includes("assets/screenshot-1.png"), "native paste confirmation and relative link");
      await wait(() => preview.querySelector('img[alt="Image description"]')?.src.startsWith("data:image/png;"), "pasted image preview");
      check(true, "paste event through native confirmation, asset storage and offline preview");
      const exported = await core.invoke("export_html", {
        path: window.qaResultPath + ".html", markdown: "![Pasted](assets/screenshot-1.png)",
        title: "Offline image", source: window.qaResultPath.replace(/result\.txt$/, "start.md"), expected:null,
      });
      check(exported.confirmed && !exported.warning, "standalone export accepts pasted raster");
      await menu("compare_disk");
      const dialog = document.getElementById("comparison");
      await wait(() => dialog.open, "read-only disk comparison");
      check(document.getElementById("comparison-editor").value === text() &&
        document.getElementById("comparison-disk").value === before, "compare current edits with intact disk source");
      dialog.querySelector("button").click();
      await wait(() => !dialog.open, "close comparison");
      await menu("undo");
      await wait(() => text() === before, "undo pasted link");
      check(true, "undo restores source after image paste");
    }
    const external = preview.querySelector('a[data-destination$="/qa-link"]')?.dataset.destination;
    preview.querySelector('a[data-destination*="sibling"]').click();
    await wait(() => document.activeElement.id === "uc-café-1", "cross-file fragment");
    check(text().includes("# Café"), "sibling link with encoded filename and Unicode duplicate fragment");
    const outline = document.getElementById("outline");
    const filter = document.getElementById("heading-filter");
    const list = document.getElementById("heading-list");
    for (const mode of ["editor", "preview"]) {
      await menu("view_" + mode);
      await menu("jump_heading");
      await wait(() => outline.open && document.activeElement === filter, "heading search in " + mode);
      filter.value = "café";
      filter.dispatchEvent(new Event("input"));
      check(Array.from(list.options, o => o.value).join(",") === "1,3", "duplicate Unicode headings in " + mode);
      list.selectedIndex = 1;
      list.dispatchEvent(new KeyboardEvent("keydown", {key: "Enter", cancelable: true}));
      await wait(() => !outline.open && (mode === "editor" ? qaEditor.cursor().line === 3 :
        document.activeElement.id === "uc-café-1"), "jump to second heading in " + mode);
      check(document.getElementById("app").dataset.view === mode, "heading jump preserves " + mode + " view");
    }
    await menu("view_split");
    await menu("gutter");
    await wait(() => document.querySelector(".cm-lineNumbers"), "line-number preference");
    await menu("gutter");
    await wait(() => !document.querySelector(".cm-lineNumbers"), "hide line numbers");
    check(true, "toggle CodeMirror line numbers");
    qaEditor.goToLine(1);
    for (let n = 1; n <= 6; n++) {
      await menu("h" + n);
      await wait(() => text().startsWith("#".repeat(n) + " "), "heading " + n);
    }
    await menu("undo");
    await wait(() => text().startsWith("##### "), "undo");
    await menu("redo");
    await wait(() => text().startsWith("###### "), "redo");
    check(true, "native H1–H6, undo and redo");
    await menu("view_preview");
    await wait(() => document.getElementById("app").dataset.view === "preview", "preview-only");
    await menu("find");
    await wait(() => document.activeElement.matches(".cm-search input"), "find from preview");
    check(true, "find from preview-only focuses search field");
    document.activeElement.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }),
    );
    qaEditor.focus();
    edit("First line\nSecond line");
    qaEditor.goToLine(1);
    qaEditor.insertImage("figures/diagram (2).png");
    check(
      text().startsWith("![Image description](figures/diagram%20%282%29.png)"),
      "encoded image path and editable description",
    );
    await frame();
    if (!document.execCommand("insertText", false, "Résumé 漢字"))
      throw Error("Cannot edit the selected image description");
    await wait(() => text().startsWith("![Résumé 漢字]"), "committed alt text");
    check(true, "Unicode alt text replaces selected placeholder");
    edit("");
    qaEditor.focus();
    document.execCommand("insertText", false, "- item");
    await wait(() => text() === "- item", "committed list text");
    const field = document.querySelector(".cm-content");
    const key = (key, keyCode) =>
      field.dispatchEvent(new KeyboardEvent("keydown", { key, keyCode, bubbles: true, cancelable: true }));
    key("Enter", 13);
    check(text() === "- item\n- ", "Continue a Markdown list");
    key("Enter", 13);
    check(!text().endsWith("- "), "Leave an empty Markdown list item");
    edit("word");
    qaEditor.goToLine(1);
    key("Tab", 9);
    check(text() === "    word", "Tab indents the current line");
    field.dispatchEvent(new KeyboardEvent("keydown", {key: "Tab", keyCode: 9, shiftKey: true, bubbles: true, cancelable: true}));
    check(text() === "word", "Shift-Tab removes an indentation level");
    qaEditor.goToLine(1);
    await menu("bold");
    await wait(() => text() === "****word", "insert bold markers");
    document.execCommand("insertText", false, "new");
    await wait(() => text() === "**new**word", "type between bold markers");
    check(true, "inline formatting keeps the insertion point inside the markers");
    await checkpoint("native workflow passed");
    const sample =
      "# Section\n\nA sentence with **bold**, *emphasis*, a [link](#section) and `code`.\n\n- First\n- Second\n\n";
    await menu("view_split");
    for (const size of [10, 100, 1024]) {
      const body = sample.repeat(Math.ceil((size * 1024) / sample.length)).slice(0, size * 1024);
      const data = { kib: size, sourceBytes: body.length };
      await checkpoint("starting " + size + " KiB");
      edit(body + "\n\nSeed");
      qaEditor.goToLine(body.split("\n").length);
      await wait(() => qaEditor.scroller.scrollTop > 0, "scroll to end of " + size + " KiB");
      qaEditor.goToLine(1);
      await wait(() => qaEditor.scroller.scrollTop < 50, "return to start of " + size + " KiB");
      if (size === 1024) {
        await wait(() => preview.textContent.includes("Live preview is paused"), "source-only size limit");
        qaEditor.goToLine(1);
        qaEditor.focus();
        const start = performance.now();
        document.execCommand("insertText", false, "Large edit");
        await frame();
        await frame();
        data.inputToSecondFrameMs = Math.round(performance.now() - start);
        await wait(() => text().startsWith("Large edit"), "large document text insertion");
        check(text().startsWith("Large edit") && text().includes("Seed"), "large source remains editable");
        data.sourceOnly = true;
        report.sizes.push(data);
        continue;
      }
      await wait(() => preview.lastElementChild?.textContent === "Seed", "size " + size);
      await checkpoint("first preview at " + size + " KiB");
      const paint = [],
        settled = [];
      for (let n = 0; n < (size === 100 ? 20 : 3); n++) {
        const mark = "Z" + n;
        // Type at the start of the viewport and measure presentation at the next frames.
        qaEditor.goToLine(1);
        qaEditor.focus();
        const started = performance.now();
        if (!document.execCommand("insertText", false, mark)) throw Error("WKWebView text insertion failed");
        await frame();
        await frame();
        paint.push(performance.now() - started);
        await wait(() => preview.firstElementChild?.textContent.includes(mark), "painted preview");
        settled.push(performance.now() - started);
      }
      data.samples = paint.length;
      data.inputToSecondFrameP95Ms = Math.round(percentile(paint));
      data.previewP95Ms = Math.round(percentile(settled));
      report.sizes.push(data);
    }
    edit(
      "# Native print check\n\n![Figure](figure.png)\n\n[Project website](https://example.com)\n\n" +
        "```text\n" + "long-code-token ".repeat(14) + "CODE_END\n```\n\n" +
        "| " + Array.from({length: 8}, (_, i) => "Column " + (i + 1)).join(" | ") + " |\n" +
        "| " + Array(8).fill("---").join(" | ") + " |\n" +
        "| " + Array.from({length: 8}, (_, i) => "Data " + (i + 1)).join(" | ") + " |\n\n" +
        Array.from(
          { length: 70 },
          (_, i) => "Paragraph " + (i + 1) + ". The image, text and final line should travel together.",
        ).join("\n\n") +
        "\n\nEnd of document.",
    );
    await wait(
      () =>
        preview.lastElementChild?.textContent === "End of document." &&
        preview.querySelector("img")?.complete,
      "print fixture ready",
    );
    if (external) {
      edit(text() + "\n\n[Opener check](" + external + ")");
      await wait(() => preview.querySelector('a[data-destination$="/qa-link"]'), "native link");
      preview.querySelector('a[data-destination$="/qa-link"]').click();
    }
    await menu("view_editor");
    await wait(() => document.getElementById("app").dataset.view === "editor", "editor-only print setup");
  } catch (error) {
    report.error = String(error);
  }
  await core.invoke("write_file", {
    path: window.qaResultPath,
    content: JSON.stringify(report, null, 2),
    format: { encoding: "utf8", eol: "lf" },
    expected: null,
  });
});
