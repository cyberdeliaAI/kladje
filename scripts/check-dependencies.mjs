// Check declared licenses for this desktop target. Send only public package
// names and versions to OSV when the advisory check is explicitly requested.
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const host = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(/^host: (.+)$/m)[1];
const metadata = JSON.parse(
  execFileSync(
    "cargo",
    [
      "metadata",
      "--format-version",
      "1",
      "--locked",
      "--filter-platform",
      host,
      "--manifest-path",
      "src-tauri/Cargo.toml",
    ],
    { maxBuffer: 32 * 1024 * 1024 },
  ),
);
const crates = metadata.packages.filter((pkg) => pkg.source);
const npm = Object.entries(JSON.parse(fs.readFileSync("package-lock.json")).packages).filter(
  ([name]) => name,
);
for (const pkg of crates) {
  if (!pkg.license && !pkg.license_file) throw Error("Missing Rust dependency license for " + pkg.name);
}
for (const [name, pkg] of npm) {
  // Like a crate's license_file: a package may state its terms only in a file.
  const stated = pkg.license || (fs.existsSync(name) && fs.readdirSync(name).some((file) => /^licen[sc]e/i.test(file)));
  if (!stated) throw Error("Missing npm dependency license for " + name);
}
// The notices shipped with the application must describe the locked dependencies.
execFileSync("node", ["scripts/build-notices.mjs", "--check"], { stdio: "inherit" });
execFileSync("node", ["scripts/build-diagrams.mjs", "--check"], { stdio: "inherit" });
console.log(
  "License metadata present for",
  crates.length,
  "Rust dependencies on",
  host,
  "and",
  npm.length,
  "npm lockfile entries.",
);
if (process.argv.includes("--advisories")) {
  if (crates.some((pkg) => pkg.source !== "registry+https://github.com/rust-lang/crates.io-index")) {
    throw Error("Review non-public-registry dependencies locally before running online checks.");
  }
  const queries = crates.map((pkg) => ({
    package: { ecosystem: "crates.io", name: pkg.name },
    version: pkg.version,
  }));
  const response = await fetch("https://api.osv.dev/v1/querybatch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ queries }),
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw Error("OSV lookup failed with HTTP " + response.status);
  const { results } = await response.json();
  if (results.length !== queries.length) throw Error("Incomplete OSV response");
  let notices = 0;
  for (const [i, result] of results.entries()) {
    if (result.next_page_token) throw Error("Review additional OSV results for " + crates[i].name);
    for (const { id } of result.vulns ?? []) {
      const detail = await fetch("https://api.osv.dev/v1/vulns/" + encodeURIComponent(id), {
        signal: AbortSignal.timeout(15000),
      });
      if (!detail.ok) throw Error("OSV record unavailable for " + id);
      const record = await detail.json();
      const entries = record.affected.filter((entry) => entry.package?.name === crates[i].name);
      const maintenance =
        entries.length > 0 &&
        entries.every((entry) => entry.database_specific?.informational === "unmaintained");
      console.log(crates[i].name, crates[i].version, id, maintenance ? "unmaintained" : "requires review");
      if (maintenance) notices++;
      else process.exitCode = 1;
    }
  }
  console.log("Maintenance notices:", notices);
}
