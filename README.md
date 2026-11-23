# Kladje

A light, fast Markdown editor with a live preview, for macOS, Windows and Linux.
Built with Rust and Tauri 2: the system webview draws the window, everything
else (rendering, files, import, export) is Rust.

## Features

- Source editor on the left, live preview on the right, with scroll sync.
  Switch between editor only, both, or preview only.
- CommonMark and GitHub Flavored Markdown: tables, task lists, footnotes,
  strikethrough, autolinks, callouts (`> [!NOTE]`), plus definition lists,
  highlight, sub/superscript, emoji shortcodes and front matter.
- Syntax highlighting for code blocks and math (`$…$`, `$$…$$`) without any
  JavaScript: both are rendered in Rust.
- Import: HTML, Word (`.docx`) and plain text.
- Export: standalone HTML, and PDF through the print dialog.
- Safe by default: raw HTML in a document is sanitised, so opening an untrusted
  file never runs script.
- Careful with your text: atomic saves, recovery of unsaved work after a crash,
  a warning when another program changes the file, original line endings kept.
- Light and dark theme, following the system or set by hand.

## Build

Requirements: [Rust](https://rustup.rs) and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform.

```bash
cd src-tauri
cargo run              # development build
cargo test             # unit tests
```

For an installable bundle (`.app`/`.dmg`, `.msi`, `.deb`/`.AppImage`) Node.js is
needed for the Tauri CLI:

```bash
npm install
npm run build
```

## Layout

| Path | What |
| :-- | :-- |
| `src-tauri/src/markdown.rs` | Markdown → sanitised HTML |
| `src-tauri/src/import.rs` | HTML and `.docx` → Markdown |
| `src-tauri/src/export.rs` | Standalone HTML export |
| `src-tauri/src/fileio.rs` | Decoding and atomic writes |
| `src-tauri/src/main.rs` | Window, menu and commands |
| `ui/` | Interface: plain HTML, CSS and JavaScript, no build step |
| `editor-src/` | Source of the editor bundle (`ui/vendor/editor.js`) |

The editor bundle is checked in, so Node.js is only needed when you change
`editor-src/editor.entry.js` (`npm run build:editor`) or build an installer.

`cargo run --example devserver` serves the interface in a normal browser with
the real Rust core behind it, which is handy for working on the UI.
