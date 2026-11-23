const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

function luminance(hex) {
  const linear = hex.match(/../g).map((pair) => {
    const value = parseInt(pair, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

test("source text and Markdown tokens meet 4.5 to 1 contrast in both editor themes", () => {
  const css = fs.readFileSync(path.join(__dirname, "../ui/app.css"), "utf8");
  for (const selector of [":root {", ':root[data-theme="dark"] {']) {
    assert.ok(css.includes(selector));
    const theme = css.split(selector)[1].split("}")[0];
    const colors = Object.fromEntries(
      [...theme.matchAll(/--([\w-]+): #([a-f\d]{6});/gi)].map(([, name, hex]) => [name, luminance(hex)]),
    );
    for (const name of [
      "text",
      "text-muted",
      "text-faint",
      "ed-heading",
      "ed-mark",
      "ed-link",
      "ed-code",
      "ed-quote",
      "ed-meta",
      "ed-html",
    ]) {
      const [light, dark] = [colors[name], colors["bg-editor"]].sort((a, b) => b - a);
      assert.ok((light + 0.05) / (dark + 0.05) >= 4.5, selector + " " + name);
    }
  }
});
