<h1><img src="docs/kladje-wordmark-panel.svg" alt="Kladje" width="240"></h1>

Kladje is a single-document Markdown editor with a live preview. Write in the source pane, read in the preview, or keep both in view with synchronized scrolling. It uses CodeMirror for editing, Rust for rendering and file operations, and Tauri 2 for the native window and menus.

The P0 document-safety baseline and P1 single-document workflows have been exercised on Apple silicon macOS. Windows and Linux native validation is pending.

## What you can do

- Pair brackets and quotes, paste a URL over selected text, and use **Writing Settings** to enable rich-text paste or estimated reading time. Copy selected Markdown as formatted text from **Edit**.
- Edit Markdown with native menu shortcuts, heading and list commands, undo and redo, and Find and Replace. Open **Help → Markdown Guide** for an editable guide.
- Reopen any of the last ten files from **File → Open Recent**. Search headings with **⌘⇧J** on macOS, including in editor-only view.
- Toggle line numbers, wrapping and writing width in **View**. Use **Format → Insert Table Row Below** to extend an existing Markdown table.
- Preview tables, task lists, footnotes, strikethrough, fenced code with syntax highlighting, and math. Switch between editor, preview and split views in light or dark mode.
- Open Markdown and plain text, import HTML or Word documents as editable Markdown, export HTML, and print or save a PDF through the system print dialog.
- Use **Format → Insert Local Image** or drop a PNG, JPEG, GIF or WebP into the document. Edit the selected description to supply alt text.
- Save explicitly with **⌘S**. If you keep typing during a save, newer edits stay marked as unsaved. When another program changes the file, you can keep your edits, reload from disk, or save a separate copy.
- Paste a clipboard PNG, JPEG, GIF or WebP into the source editor. On confirmation, Kladje saves a new numbered file in `assets/` beside the document. Undo removes the link and keeps the image file.
- Use **File → Compare with Disk** to inspect the current text alongside the saved version. **File → New from Template** opens a local Markdown or text file as a fresh, unsaved draft.
- Restore private drafts after an unexpected exit. Kladje keeps up to three recovery generations per document. On macOS, saving through a symlink preserves the link.

## Build the macOS app

Install the Xcode Command Line Tools, Rust with Cargo, and Node.js with npm. The verified environment used macOS 27.2.1 on Apple silicon, Rust 1.100.0 and Node.js 26.13.1. The locked macOS targets also compile with Rust 1.90.0. [Tauri prerequisites for macOS](https://v2.tauri.app/start/prerequisites/#macos)

From the repository root, run

```sh
npm ci
npm run build -- --ci --bundles app -- --locked
```

The application bundle is written to `src-tauri/target/release/bundle/macos/Kladje.app`. For local use, quit Kladje and copy that bundle into Applications, replacing your previous copy, then open Kladje from Applications. Finder’s Get Info shows the new cream, navy and teal icon. The local build uses an ad-hoc signature. You can check its integrity with `codesign --verify --deep --strict /Applications/Kladje.app`. Distribution signing and notarization remain release gates.

## Development

With dependencies installed, start the desktop app in development mode with `npm run dev`. The UI uses plain HTML, CSS and JavaScript. Its CodeMirror bundle is checked in. After changing `editor-src/editor.entry.js`, regenerate the bundle with `npm run build:editor`.

The [application icon](src-tauri/icons/kladje-icon-b-potlood.svg) and [wordmark](ui/brand/kladje-wordmark.svg) are the original artwork. Run `npm run build:brand` to regenerate the desktop PNG, ICO and macOS ICNS files and the cream-backed README wordmark. The ICNS includes 1× and 2× representations from 16 to 512 points. The empty preview shows the wordmark on screen.

Run the Rust and JavaScript regression suites from the repository root

```sh
cargo test --locked --all-targets --manifest-path src-tauri/Cargo.toml
npm test
```

The Rust suite exercises rendering, import, export, file formats, atomic saves and recovery. The JavaScript tests control the timing of disk reads and writes while driving document, menu and window events.

## Known limitations

- Preview reads supported local rasters within the saved document folder. HTTPS images stay blocked until you allow them in **View → Remote Images for This Document**. Opening another document resets permission. Local and embedded images are limited to 4 MiB each, 12 MiB total and 128 source references per render.
- Files are limited to 64 MiB. Supported encodings include UTF-8, BOM-marked UTF-16 and printable Latin-1. Format changes such as converting edited Latin-1 text to UTF-8 require confirmation.
- Recovery is periodic. Edits made since the last completed snapshot can be lost on a crash. Network shares, removable media and physical power-loss behavior still need testing.
- Standalone HTML embeds permitted local raster images and reports omissions. Word import preserves supported text, headings, lists and tables. Embedded media, page layout and review annotations are omitted.
- Native PDF printing on macOS requires macOS 11 or later.
- Live preview and printing pause above 262,144 UTF-16 code units. Editing, explicit saving and recovery remain available. Heading search supports source files up to 4 MiB. Live word totals use the same size limit as preview.

## Planning documents

The [development roadmap](docs/planning/DEVELOPMENT_ROADMAP.md) records the verified P0 behavior and remaining release gates. The [P1 acceptance review](docs/planning/P1_ACCEPTANCE.md) records native and automated results and the remaining manual checks. The original audit records the earlier baseline.

- [Project audit](docs/planning/PROJECT_AUDIT.md)
- [Feature matrix](docs/planning/FEATURE_MATRIX.md)
- [UX review](docs/planning/UX_REVIEW.md)
- [Product vision](docs/planning/PRODUCT_VISION.md)

## Licensing

The project license for Kladje's own code is pending. The bundled editor and MathML stylesheet carry their upstream licenses. [Third-party frontend notices](ui/vendor/THIRD-PARTY-NOTICES.txt)
