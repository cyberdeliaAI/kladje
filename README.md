# Kladje

Kladje is a single-document Markdown editor with a live preview. Write in the source pane, read in the preview, or keep both in view with synchronized scrolling. It uses CodeMirror for editing, Rust for rendering and file operations, and Tauri 2 for the native window and menus.

The P0 document-safety baseline has been tested on Apple silicon macOS. Windows and Linux native validation is pending.

## What you can do

- Edit Markdown with native menu shortcuts, heading and list commands, undo and redo, and Find and Replace. Open **Help → Markdown Guide** for an editable guide.
- Preview tables, task lists, footnotes, strikethrough, fenced code with syntax highlighting, and math. Switch between editor, preview and split views in light or dark mode.
- Open Markdown and plain text, import HTML or Word documents as editable Markdown, export HTML, and print or save a PDF through the system print dialog.
- Save explicitly with **⌘S**. If you keep typing during a save, newer edits stay marked as unsaved. When another program changes the file, you can keep your edits, reload from disk, or save a separate copy.
- Restore private drafts after an unexpected exit. Kladje keeps up to three recovery generations per document. On macOS, saving through a symlink preserves the link.

## Build the macOS app

Install the Xcode Command Line Tools, Rust with Cargo, and Node.js with npm. The verified environment used macOS 27.2.1 on Apple silicon, Rust 1.100.0 and Node.js 26.13.1. The minimum Rust version for the locked dependencies still needs qualification. [Tauri prerequisites for macOS](https://v2.tauri.app/start/prerequisites/#macos)

From the repository root, run

```sh
npm ci
npm run build -- --ci --bundles app
```

The application bundle is written to `src-tauri/target/release/bundle/macos/Kladje.app`.

## Development

With dependencies installed, start the desktop app in development mode with `npm run dev`. The UI uses plain HTML, CSS and JavaScript. Its CodeMirror bundle is checked in. After changing `editor-src/editor.entry.js`, regenerate the bundle with `npm run build:editor`.

Run the Rust and JavaScript regression suites from the repository root

```sh
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm test
```

The Rust suite exercises rendering, import, export, file formats, atomic saves and recovery. The JavaScript tests control the timing of disk reads and writes while driving document, menu and window events.

## Known limitations

- Preview resource isolation remains a release blocker. Documents can load remote images, and the local image scope is broad. Use trusted documents while these controls are under review.
- Files are limited to 64 MiB. Supported encodings include UTF-8, BOM-marked UTF-16 and printable Latin-1. Format changes such as converting edited Latin-1 text to UTF-8 require confirmation.
- Recovery is periodic. Edits made since the last completed snapshot can be lost on a crash. Network shares, removable media and physical power-loss behavior still need testing.
- HTML exports retain image paths. Moving the exported file can break relative images. Word import supports a subset of document formatting.
- Open Recent, a heading outline and dedicated image insertion are planned features.

## Planning documents

The [development roadmap](docs/planning/DEVELOPMENT_ROADMAP.md) records the verified P0 behavior and remaining release gates. The original audit and feature matrix describe the earlier baseline.

- [Project audit](docs/planning/PROJECT_AUDIT.md)
- [Feature matrix](docs/planning/FEATURE_MATRIX.md)
- [UX review](docs/planning/UX_REVIEW.md)
- [Product vision](docs/planning/PRODUCT_VISION.md)

## Licensing

The project license for Kladje's own code is pending. The bundled editor and MathML stylesheet carry their upstream licenses. [Third-party frontend notices](ui/vendor/THIRD-PARTY-NOTICES.txt)
