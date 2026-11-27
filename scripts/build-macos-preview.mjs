// Build a signed host DMG, or package a prebuilt universal binary in CI.
// Notarization is a separate step performed on the verified disk image.
import {execFileSync, spawnSync} from "node:child_process";
import {mkdtempSync, mkdirSync, readFileSync, readlinkSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const identity = process.env.APPLE_SIGNING_IDENTITY;
if (process.platform !== "darwin" || !identity?.startsWith("Developer ID Application: ")) {
  throw Error("On macOS, set APPLE_SIGNING_IDENTITY to the full name of a Developer ID Application certificate.");
}
const env = {...process.env};
for (const key of ["APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID", "APPLE_API_KEY", "APPLE_API_ISSUER", "APPLE_API_KEY_PATH"]) {
  delete env[key];
}
const run = (command, args) => execFileSync(command, args, {cwd:root, env, stdio:"inherit"});
const config = JSON.parse(readFileSync(path.join(root, "src-tauri/tauri.conf.json")));
const bundleUniversal = process.argv.includes("--bundle-universal");
const universalTarget = "universal-apple-darwin";
const output = path.join(root, "src-tauri/target", bundleUniversal ? universalTarget : "", "release/bundle");
const appName = config.productName + ".app";
const app = path.join(output, "macos", appName);
const arch = bundleUniversal ? "universal" : {arm64:"aarch64", x64:"x64"}[process.arch];
if (!arch) throw Error("Expected an Apple silicon or Intel macOS build host.");
const dmg = path.join(output, "dmg", config.productName + "_" + config.version + "_" + arch + ".dmg");
const distribution = "=anchor apple generic and certificate leaf[field.1.2.840.113635.100.6.1.13] exists";
function verifySignature(artifact, isApp) {
  run("codesign", ["--verify", ...(isApp ? ["--deep", "--all-architectures"] : []), "--strict", "-R", distribution, artifact]);
  if (isApp && bundleUniversal) {
    const slices = execFileSync("lipo", ["-archs", path.join(artifact, "Contents/MacOS/kladje")], {encoding:"utf8"});
    if (slices.trim().split(/\s+/).sort().join(" ") !== "arm64 x86_64") throw Error("Expected an Intel and an Apple silicon binary in " + artifact);
  }
  const signature = spawnSync("codesign", ["--display", "--verbose=4", artifact], {encoding:"utf8"});
  if (signature.status !== 0 || !/^Timestamp=/m.test(signature.stderr)) throw Error("Missing secure timestamp: " + artifact);
  if (isApp && !/flags=.*\bruntime\b/.test(signature.stderr)) throw Error("Missing hardened runtime: " + artifact);
}
const packaging = ["--ci", "--bundles", "app,dmg", "--config", JSON.stringify({bundle:{macOS:{signingIdentity:identity}}})];
if (bundleUniversal) run("npm", ["run", "tauri", "--", "bundle", "--target", universalTarget, ...packaging]);
else run("npm", ["run", "build", "--", ...packaging, "--", "--locked"]);
verifySignature(app, true);
verifySignature(dmg, false);
run("hdiutil", ["verify", dmg]);
const tmp = mkdtempSync(path.join(tmpdir(), "kladje-install-"));
const mount = path.join(tmp, "volume");
mkdirSync(mount);
let mounted = false;
try {
  // The disk image displays the project's bundled MIT license on attach.
  execFileSync("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, dmg],
    {cwd:root, env, input:"Y\n", stdio:["pipe", "inherit", "inherit"]});
  mounted = true;
  try {
    if (readlinkSync(path.join(mount, "Applications")) !== "/Applications") throw Error("Missing Applications shortcut");
    const copy = path.join(tmp, appName);
    run("ditto", [path.join(mount, appName), copy]);
    verifySignature(copy, true);
    // Reject an older correctly signed bundle or a disk image missing resources.
    run("diff", ["-qr", app, copy]);
  } finally {
    run("hdiutil", ["detach", mount]);
    mounted = false;
  }
} finally {
  // A failed detach can leave a live read-only mount; keep its containing directory for inspection.
  if (!mounted) rmSync(tmp, {recursive:true, force:true});
}
console.log("Verified signed disk image:", dmg);
