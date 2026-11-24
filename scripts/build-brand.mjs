import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { darkWordmark } from "./wordmarks.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const icons = path.join(root, "src-tauri/icons");
const temp = mkdtempSync(path.join(tmpdir(), "kladje-icons-"));
try {
  execFileSync(process.execPath, [
    path.join(root, "node_modules/@tauri-apps/cli/tauri.js"), "icon",
    path.join(icons, "kladje-icon-b-potlood.svg"), "--output", temp,
  ], { stdio: "inherit" });
  // Only the desktop targets ship with Kladje.
  for (const name of ["32x32.png", "64x64.png", "128x128.png", "128x128@2x.png", "icon.png", "icon.ico", "icon.icns"]) {
    copyFileSync(path.join(temp, name), path.join(icons, name));
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}

// The README can appear on dark backgrounds. Mount the original on its
// cream brand color, retaining the SVG's intrinsic aspect ratio.
const wordmark = readFileSync(path.join(root, "ui/brand/kladje-wordmark.svg"), "utf8").trim();
writeFileSync(path.join(root, "docs/kladje-wordmark-panel.svg"),
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 800 300">\n' +
  '  <rect width="800" height="300" rx="20" fill="#FFFCF7"/>\n' +
  '  <svg x="43" y="30" width="714" height="240">' + wordmark + '</svg>\n</svg>\n');
// The dark theme shows the same drawing in light colours, without a panel.
writeFileSync(path.join(root, "ui/brand/kladje-wordmark-dark.svg"), darkWordmark(wordmark) + "\n");
