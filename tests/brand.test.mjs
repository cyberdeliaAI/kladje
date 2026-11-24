import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { darkWordmark, DARK } from "../scripts/wordmarks.mjs";

test("the dark wordmark is the light drawing with its two colours swapped", () => {
  const light = readFileSync(new URL("../ui/brand/kladje-wordmark.svg", import.meta.url), "utf8").trim();
  const dark = readFileSync(new URL("../ui/brand/kladje-wordmark-dark.svg", import.meta.url), "utf8").trim();
  assert.equal(dark, darkWordmark(light), "Run npm run build:brand after changing the wordmark.");
  assert.ok(dark.includes(`fill="${DARK.ink}"`) && dark.includes(`fill="${DARK.dot}"`));
  assert.throws(() => darkWordmark("<svg/>"), /Expected one/);
});
