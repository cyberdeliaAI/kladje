// Build an isolated, instrumented copy of the actual desktop app. No test hook ships.
import fs from "node:fs";
import os from "node:os";
import http from "node:http";
import net from "node:net";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

if (process.platform !== "darwin") throw Error("This workflow requires a logged-in macOS desktop.");
const root = fileURLToPath(new URL("../../", import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "kladje-p1-"));
const id = "app.kladje.qa." + path.basename(tmp).replaceAll("-", "").toLowerCase();
const ui = path.join(tmp, "ui");
const result = path.join(tmp, "result.txt");
const probeWindows = process.argv.includes("--windows");
fs.cpSync(path.join(root, "ui"), ui, { recursive: true });
const html = path.join(ui, "index.html");
fs.writeFileSync(
  html,
  fs
    .readFileSync(html, "utf8")
    .replace('<script src="app.js">', '<script src="qualification.js"></script>\n  <script src="app.js">'),
);
fs.writeFileSync(
  path.join(ui, "qualification.js"),
  "window.qaResultPath=" +
    JSON.stringify(result) +
    ";\nwindow.qaPaste = " + process.argv.includes("--paste") + ";\n" +
    fs.readFileSync(new URL(probeWindows ? "window-probe.js" : "webview.js", import.meta.url), "utf8"),
);
fs.copyFileSync(path.join(root, "src-tauri/icons/32x32.png"), path.join(tmp, "figure.png"));
const fixture = path.join(tmp, "start.md");
let imageConnections = 0;
const imageProbe = net.createServer((socket) => {
  imageConnections++;
  socket.destroy();
});
await new Promise((resolve) => imageProbe.listen(0, "127.0.0.1", resolve));
const imageUrl = "https://127.0.0.1:" + imageProbe.address().port + "/private-image.png";
let linkOpened = false;
const server = http.createServer((req, res) => {
  if (req.url !== "/qa-link") {
    res.writeHead(404).end();
    return;
  }
  linkOpened = true;
  res
    .writeHead(200, { "Content-Type": "text/plain; charset=utf-8" })
    .end("Kladje opened this test link in the default browser. You can close this tab.");
});
let external = "";
if (process.argv.includes("--links")) {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  external = "\n[Native opener check](http://127.0.0.1:" + server.address().port + "/qa-link)\n";
}
fs.writeFileSync(
  fixture,
  "# Start\n\n![Local](figure.png)\n\n![Remote](" +
    imageUrl +
    ")\n\n$\\frac{1}{2}$\n\n[Sibling](sibling%20note.md#caf%C3%A9-1)\n" +
    external,
);
fs.writeFileSync(path.join(tmp, "sibling note.md"), "# Café\n\n# Café\n");
const config = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
config.identifier = id;
config.productName = "Kladje P1 QA";
config.build.frontendDist = ui;
config.app.windows[0].incognito = !probeWindows;
const override = path.join(tmp, "config.json");
fs.writeFileSync(override, JSON.stringify(config));
const build = spawnSync(
  path.join(root, "node_modules/.bin/tauri"),
  ["build", "--ci", "--bundles", "app", "--config", override, "--", "--locked"],
  { cwd: root, stdio: "inherit" },
);
if (build.status !== 0) throw Error("QA bundle failed to build");
const app = path.join(tmp, "Kladje P1 QA.app");
fs.cpSync(path.join(root, "src-tauri/target/release/bundle/macos/Kladje P1 QA.app"), app, {
  recursive: true,
});
const executable = path.join(app, "Contents/MacOS/kladje");
console.log("Isolated native QA folder", tmp);
if (probeWindows) {
  imageProbe.close();
  const {verifyWindows} = await import("./windows.mjs");
  await verifyWindows({app, executable, tmp, id, fixture});
  process.exit(0);
}
const manual = process.argv.includes("--manual");
const started = Date.now();
const child = spawn("/usr/bin/open", ["-n", "-W", "-a", app, "--args", fixture], { stdio: "inherit" });
let hostPid,
  peak = 0,
  idle = {},
  ready = false,
  pasteAccepted = false;
function sample() {
  const result = spawnSync("python3", [path.join(root, "scripts/macos-qa/rss.py"), executable], {
    encoding: "utf8",
  });
  if (result.status !== 0) throw Error(result.stderr);
  const { pid, sizes } = JSON.parse(result.stdout);
  if (pid) hostPid = pid;
  peak = Math.max(
    peak,
    Object.values(sizes).reduce((sum, n) => sum + n, 0),
  );
  return sizes;
}
try {
  while (!fs.existsSync(result) && child.exitCode === null && Date.now() - started < 180000) {
    sample();
    if (!pasteAccepted && hostPid && fs.existsSync(result + ".paste.txt")) {
      // Act only on Save Image in the isolated QA process. No keystrokes,
      // clipboard changes or interaction with the installed application.
      const accept = spawnSync("osascript", ["-e", `on run argv
        tell application "System Events"
          set proc to first application process whose unix id is (item 1 of argv as integer)
          tell proc
            repeat with win in windows
              if exists button "Save Image" of win then
                click button "Save Image" of win
                return "accepted"
              end if
              if exists sheet 1 of win then
                if exists button "Save Image" of sheet 1 of win then
                  click button "Save Image" of sheet 1 of win
                  return "accepted"
                end if
              end if
            end repeat
          end tell
        end tell
      end run`, String(hostPid)], {encoding: "utf8", timeout: 5000});
      if (accept.status !== 0) throw Error("Native paste confirmation: " + accept.stderr);
      pasteAccepted = accept.stdout.trim() === "accepted";
    }
    await delay(250);
  }
  if (!fs.existsSync(result)) throw Error("No native workflow report");
  const report = JSON.parse(fs.readFileSync(result, "utf8"));
  if (report.error) throw Error(JSON.stringify({error: report.error, notice: report.notice, focus: report.focus, pasteAccepted}));
  if (process.argv.includes("--paste")) {
    const image = fs.readFileSync(path.join(tmp, "figure.png"));
    const pasted = fs.readFileSync(path.join(tmp, "assets/screenshot-1.png"));
    const exported = fs.readFileSync(result + ".html", "utf8");
    if (!pasteAccepted || !pasted.equals(image) || !exported.includes("data:image/png;base64," + image.toString("base64"))) {
      throw Error("The confirmed image must survive Undo on disk and be embedded byte-for-byte in standalone HTML.");
    }
    report.checks.push("verified pasted file after Undo and identical embedded export bytes");
  }
  if (!probeWindows) {
    const proof = spawnSync("swift", [path.join(root,"scripts/macos-qa/verify-pagebreak.swift"), result+".paged.html"],
      {encoding:"utf8",timeout:60000});
    if (proof.status !== 0) throw Error("Native PDF page break: "+(proof.stderr || proof.error || proof.status));
    report.checks.push("Both headings appeared on separate pages in a native WebKit PDF");
  }
  if (imageConnections) throw Error("A blocked document image initiated a network connection");
  report.unapprovedImageConnections = imageConnections;
  if (external && !linkOpened) {
    for (let i = 0; i < 40 && !linkOpened; i++) await delay(250);
    if (!linkOpened) throw Error("The default browser did not open the local test URL");
  }
  await delay(1500);
  idle = sample();
  if (report.readyEpochMs) report.launchToEditableMs = report.readyEpochMs - started;
  report.peakSampledRssKiB = peak;
  report.settledRssKiB = idle;
  if (!idle.host || !idle["com.apple.WebKit.WebContent"]) throw Error("Missing app or WebKit memory sample");
  if (external) report.externalLinkOpened = linkOpened;
  console.log(JSON.stringify(report, null, 2));
  ready = true;
  if (manual) {
    console.log("Print the current editor-only document, then quit the QA app.");
    await new Promise((resolve) => child.once("exit", resolve));
  }
} finally {
  imageProbe.close();
  if (server.listening) server.close();
  if (hostPid && child.exitCode === null) {
    try {
      process.kill(hostPid, "SIGTERM");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  }
  if (ready && !manual) {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(path.join(os.homedir(), "Library/Application Support", id), { recursive: true, force: true });
  }
}
