const test = require("node:test");
const assert = require("node:assert/strict");
const { create } = require("../ui/diagrams.js");

function engine(log = []) {
  let config;
  return {
    log,
    initialize(next) { config = next; },
    async render(id, source) {
      log.push([id, config.theme, source]);
      await new Promise(setImmediate);
      if (source.includes("broken")) throw Error("Parse error on line 2:\n...stack and detail");
      return { svg: `<svg data-theme="${config.theme}">${source}</svg>` };
    },
    get config() { return config; },
  };
}
const toImage = svg => ({ src: svg, width: 10, height: 20 });

test("diagrams are drawn one at a time, per theme, with the strict security level", async () => {
  const mermaid = engine();
  let loads = 0;
  const diagrams = create(async () => { loads++; return mermaid; }, toImage);
  const [light, dark, again] = await Promise.all([
    diagrams.image("graph TD", false), diagrams.image("graph TD", true), diagrams.image("graph TD", false),
  ]);
  assert.equal(loads, 1);
  assert.deepEqual(mermaid.log.map(([, theme]) => theme), ["default", "dark"]);
  assert.equal(light.src, '<svg data-theme="default">graph TD</svg>');
  assert.equal(dark.src, '<svg data-theme="dark">graph TD</svg>');
  assert.equal(again, light);
  assert.equal(mermaid.config.securityLevel, "strict");
  assert.equal(mermaid.config.htmlLabels, false);
  assert.equal(mermaid.config.startOnLoad, false);
  // Element ids never repeat, so one drawing cannot pick up another's nodes.
  assert.equal(new Set(mermaid.log.map(([id]) => id)).size, 2);
});

test("a diagram that cannot be drawn reports one short line and never rejects", async () => {
  const mermaid = engine();
  const diagrams = create(async () => mermaid, toImage);
  assert.deepEqual(await diagrams.image("broken", false), { error: "Parse error on line 2:" });
  assert.deepEqual(await diagrams.image("x".repeat(50001), false), { error: "This diagram is too large to draw." });
  assert.equal(mermaid.log.length, 1);
  const unsized = create(async () => mermaid, () => { throw Error("The diagram could not be drawn."); });
  assert.deepEqual(await unsized.image("pie", false), { error: "The diagram could not be drawn." });
});

test("a missing engine is reported and tried again later, and the cache stays bounded", async () => {
  let available = false, loads = 0;
  const mermaid = engine();
  const diagrams = create(async () => {
    loads++;
    if (!available) throw Error("Diagram support is not part of this build.");
    return mermaid;
  }, toImage);
  const missing = await diagrams.image("pie", false);
  assert.equal(missing.error, "Diagram support is not part of this build.");
  available = true;
  assert.equal((await diagrams.image("pie", false)).width, 10);
  assert.equal(loads, 2);
  for (let n = 0; n < 70; n++) await diagrams.image("pie " + n, false);
  const drawn = mermaid.log.length;
  await diagrams.image("pie 69", false);
  assert.equal(mermaid.log.length, drawn);
  await diagrams.image("pie", false);
  assert.equal(mermaid.log.length, drawn + 1);
});
