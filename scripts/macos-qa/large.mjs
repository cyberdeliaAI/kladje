// Large-document measurements in the isolated QA build:
//
//     node scripts/macos-qa/run.mjs --large [--sizes=256,1024,4096,16384] [--print=1024 --keep]
//
// With --print the app then loads a fixture of that many KiB and opens the
// system print dialog for it; --keep leaves the app running so the dialog can
// be used. Check the saved PDF with verify-large-print.swift.
//
// The QA copy of app.js reports each render request and how long patchPreview
// takes. Nothing else about the shipped code changes, and no measurement hook ships.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { mixedMarkdown } from "../large-documents/fixture.mjs";

const option = (name, fallback) =>
  process.argv.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3) ?? fallback;

function replaceOnce(source, from, to, what) {
  if (source.split(from).length !== 2) throw Error("Cannot instrument " + what + " in the QA copy of app.js");
  return source.replace(from, to);
}

export function prepareLarge({ ui, tmp }) {
  const file = path.join(ui, "app.js");
  let source = fs.readFileSync(file, "utf8");
  source = replaceOnce(
    source,
    "function patchPreview(html, assets) {",
    "function patchPreview(html, assets) {\n    const qaStarted = performance.now();\n" +
      "    try { return qaPatchPreview(html, assets); } finally { window.qaPatch?.(performance.now() - qaStarted); }\n" +
      "  }\n  function qaPatchPreview(html, assets) {",
    "patchPreview",
  );
  source = replaceOnce(source, "const { invoke } = T.core;", "const invoke = window.qaInvoke(T.core.invoke);", "invoke");
  if (process.argv.includes("--lift-limit")) {
    source = replaceOnce(source, "editor.textLength() > 256 * 1024", "false", "the fixed preview pause");
  }
  fs.writeFileSync(file, source);
  const fixtures = option("sizes", "256,1024,4096,16384").split(",").map(Number).map((kib) => {
    const target = path.join(tmp, `mixed-${kib}k.md`);
    fs.writeFileSync(target, mixedMarkdown(kib * 1024));
    return { kib, path: target };
  });
  let print = null;
  if (option("print", "")) {
    const kib = Number(option("print", ""));
    print = { kib, path: path.join(tmp, `print-${kib}k.md`) };
    fs.writeFileSync(print.path, mixedMarkdown(kib * 1024));
  }
  return "window.qaFixtures = " + JSON.stringify(fixtures) + ";\nwindow.qaPrint = " + JSON.stringify(print) + ";\n";
}

export async function measureLarge({ app, executable, tmp, id, fixture, result, root }) {
  const child = spawn("/usr/bin/open", ["-n", "-W", "-a", app, "--args", fixture], { stdio: "inherit" });
  const started = Date.now();
  const limit = Number(option("timeout", "1500")) * 1000;
  const peaks = {};
  let hostPid, finished = false;
  const latest = (kind) => {
    const prefix = path.basename(result) + "." + kind + ".";
    const names = fs.readdirSync(tmp).filter((name) => name.startsWith(prefix));
    if (!names.length) return null;
    const number = (name) => Number(name.slice(prefix.length, -4));
    return fs.readFileSync(path.join(tmp, names.sort((a, b) => number(b) - number(a))[0]), "utf8");
  };
  const sample = () => {
    const run = spawnSync("python3", [path.join(root, "scripts/macos-qa/rss.py"), executable], { encoding: "utf8" });
    if (run.status !== 0) throw Error(run.stderr);
    const { pid, sizes } = JSON.parse(run.stdout);
    if (pid) hostPid = pid;
    const phase = (latest("phase") || "start").split(":")[0];
    const peak = (peaks[phase] ||= {});
    for (const [name, kib] of Object.entries(sizes)) peak[name] = Math.max(peak[name] || 0, kib);
  };
  try {
    while (!fs.existsSync(result) && child.exitCode === null && Date.now() - started < limit) {
      sample();
      await delay(500);
    }
    const text = fs.existsSync(result) ? fs.readFileSync(result, "utf8") : latest("partial");
    if (!text) throw Error("No large-document report");
    const report = JSON.parse(text);
    if (!fs.existsSync(result)) report.error = "No final report. Last phase: " + latest("phase");
    report.peakRssMiB = Object.fromEntries(Object.entries(peaks).map(([phase, sizes]) =>
      [phase, Object.fromEntries(Object.entries(sizes).map(([name, kib]) => [name, Math.round(kib / 1024)]))]));
    console.log(JSON.stringify(report, null, 2));
    const out = option("out", "");
    if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
    finished = !report.error;
    if (report.error) process.exitCode = 1;
  } finally {
    if (hostPid && child.exitCode === null && !process.argv.includes("--keep")) {
      try { process.kill(hostPid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
    }
    if (finished && !process.argv.includes("--keep")) {
      fs.rmSync(tmp, { recursive: true, force: true });
      fs.rmSync(path.join(os.homedir(), "Library/Application Support", id), { recursive: true, force: true });
    }
  }
}
