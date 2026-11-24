// Deterministic mixed Markdown for size measurements: mostly prose, with the
// lists, tables, fenced code, quotes and math a long working document carries.
//
//     node scripts/large-documents/fixture.mjs <directory> [KiB ...]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const WORDS = ("kladje schrijft snel een lange notitie over water licht tijd ruimte werk en rust " +
  "the quick editor keeps every paragraph local and readable while the preview follows along").split(" ");

function sentence(seed, length) {
  const words = [];
  for (let i = 0; i < length; i++) words.push(WORDS[(seed * 7 + i * 13 + (i * i) % 5) % WORDS.length]);
  words[0] = words[0][0].toUpperCase() + words[0].slice(1);
  return words.join(" ") + ".";
}

function paragraph(seed, sentences) {
  const lines = [];
  for (let i = 0; i < sentences; i++) lines.push(sentence(seed + i, 9 + ((seed + i) % 9)));
  // Sentences share a line in pairs, so single Returns appear as they do in real notes.
  const out = [];
  for (let i = 0; i < lines.length; i += 2) out.push(lines.slice(i, i + 2).join(" "));
  return out.join("\n");
}

function section(n) {
  const parts = [
    `## Section ${n}: ${sentence(n, 4).slice(0, -1)}`,
    paragraph(n, 6),
    `A sentence with **bold ${n}**, *emphasis*, ~~struck~~ text, a [link](#section-${n}), \`inline code\` and $a_${n}^2 + b^2$.`,
    paragraph(n + 3, 8),
    Array.from({ length: 5 }, (_, i) => `- Item ${n}.${i + 1}: ${sentence(n + i, 7)}`).join("\n"),
    paragraph(n + 5, 6),
  ];
  if (n % 2 === 0) parts.push(`> ${sentence(n, 12)}\n> ${sentence(n + 1, 10)}`);
  if (n % 3 === 0) {
    parts.push("| Measure | Value | Note |\n| --- | ---: | --- |\n" +
      Array.from({ length: 4 }, (_, i) => `| Row ${n}.${i} | ${n * 17 + i} | ${sentence(n + i, 5)} |`).join("\n"));
  }
  if (n % 4 === 0) {
    parts.push("```rust\n" +
      `fn section_${n}(input: &str) -> usize {\n    let mut total = ${n};\n    for line in input.lines() {\n` +
      "        if line.trim().is_empty() { continue; }\n        total += line.len();\n    }\n    total\n}\n```");
  }
  if (n % 5 === 0) parts.push(`- [ ] Open task ${n}\n- [x] Finished task ${n}`);
  if (n % 7 === 0) parts.push(`$$\n\\frac{${n}}{2} = \\sum_{i=1}^{${n}} x_i\n$$`);
  parts.push(paragraph(n + 9, 4));
  return parts.join("\n\n") + "\n\n";
}

/** Markdown of at least `bytes` UTF-8 bytes, ending in a complete section. */
export function mixedMarkdown(bytes) {
  const chunks = ["# Large document fixture\n\n"];
  let size = chunks[0].length;
  for (let n = 1; size < bytes; n++) {
    const text = section(n);
    chunks.push(text);
    size += Buffer.byteLength(text);
  }
  return chunks.join("");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [directory, ...sizes] = process.argv.slice(2);
  if (!directory) throw Error("Usage: fixture.mjs <directory> [KiB ...]");
  fs.mkdirSync(directory, { recursive: true });
  for (const kib of sizes.length ? sizes.map(Number) : [256, 1024, 4096, 16384]) {
    const file = path.join(directory, `mixed-${kib}k.md`);
    fs.writeFileSync(file, mixedMarkdown(kib * 1024));
    console.log(file, fs.statSync(file).size);
  }
}
