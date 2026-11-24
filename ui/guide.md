# Markdown Guide

Write on the left, read on the right. This page shows everything Kladje understands — edit it freely, it is only a copy. You can always get it back from **Help → Markdown Guide**.

## Text

Press Enter once for a new line in the live preview, or twice for a new paragraph. Inside a paragraph you can use *italic*, **bold**, ***both***, ~~strikethrough~~, ==highlight==, `inline code`, H~2~O and x^2^.

A line ending in a backslash\
keeps its line break in exported HTML and other Markdown readers too.

## Links and images

[A link](https://commonmark.org "with a title"), a bare address like https://example.com, and a [reference link][ref].

Use **Format → Insert Local Image** or drop a PNG, JPEG, GIF or WebP. Save an untitled document first so Kladje can use a relative path. When a picture is outside the document folder, you can copy it beside the Markdown file. Replace the selected description with meaningful alt text. The result looks like `![A map of the route](map.png)`.

HTTPS images require permission in **View → Remote Images for This Document**. An unavailable image shows its description. Standalone HTML embeds supported local images so the exported file can move. PDF uses the current rendered document, including when only the editor is visible.

Relative Markdown links can include a section, as in `[Notes](meeting%20notes.md#decisions)`. A second heading with the same name gets the suffix `-1`. External links open with the system handler.

Use **⌘1–⌘6** on macOS for heading levels and **⌘⌥0** for a paragraph. **⌘0** restores default text size. Tab to the splitter, resize with the arrow keys, press Enter to center it or Escape to return to the source. In the editor, Escape followed by Tab moves keyboard focus out of the writing area. In Find and Replace, use Tab or Shift-Tab to move between fields, options and buttons. Space activates a focused button.

[ref]: https://github.github.com/gfm/

## Lists

Press Enter to continue a list. Press Enter on an empty item to leave the list.

- Bullets start with a dash
- Indent to nest
    - like this
    - and this
- Back at the first level

1. Numbered lists
2. Count for you
3. In the preview

- [x] Task lists
- [ ] Show checkboxes

Term
: Definition lists pair a term with its explanation.

## Quotes and callouts

> A quote starts with a greater-than sign.
> It can span several lines.

> [!NOTE]
> Callouts are quotes with a label: NOTE, TIP, IMPORTANT, WARNING or CAUTION.

> [!WARNING]
> Use them sparingly.

## Code

```rust
fn main() {
    let name = "Kladje";
    println!("Hello from {name}!");
}
```

```json
{ "light": true, "fast": true, "bells": 0 }
```

## Tables

| Shortcut | Action | Notes |
| :-- | :-- | --: |
| Ctrl/Cmd + B | Bold | toggles |
| Ctrl/Cmd + K | Link | selection becomes the text |
| Ctrl/Cmd + Alt + 1 / 2 / 3 | Editor, both, preview | or the buttons bottom right |

## Math

Inline math sits between dollar signs: $e^{i\pi} + 1 = 0$. Display math gets its own block:

$$
\int_{-\infty}^{\infty} e^{-x^2}\,dx = \sqrt{\pi}
$$

## Footnotes and more

Footnotes keep the text clean.[^1] Emoji shortcodes work too :sparkles:, and so does a little HTML such as <kbd>Ctrl</kbd> + <kbd>S</kbd>.

<details>
<summary>Collapsible section</summary>

Hidden until opened.

</details>

[^1]: The note itself can live anywhere in the document.

## Returning to your writing

**File → New** and **File → Open** each open a separate document window. Opening a file that is already open brings its window forward. On macOS, **File → New Tab** (⌘T) opens a document in the current native tab group. **Window → Move Tab to New Window** detaches it.

**Close Window** (⌘W on macOS) asks about changes in that window. **Quit** asks about each unsaved document. Cancel keeps all windows and their edits available. A Save you already approved stays on disk. After an unexpected exit, choose **Restore** for each draft you want to reopen.

**File → Open Recent** remembers ten documents on this device. Choose **Clear Recent Documents** to forget their paths and saved places. If a file moved, choose **Locate…** when you reopen it. An unchanged document restores its last saved editing position.

Press **⌘⇧J** on macOS (Ctrl+Shift+J elsewhere) to search headings. Type part of a heading, press the down arrow to select a match, and press Enter to jump. Escape returns to the document.

Use **View** to toggle line numbers, wrapping or a narrower writing width. The footer counts Unicode code points and word-like segments of Markdown source. **Format → Insert Table Row Below** adds an empty row with the same number of columns.

## Saving automatically

Kladje saves when you press **⌘S**. To have it save for you, turn on **Save automatically** in **Settings**. A document that already has a file is then saved two seconds after you stop typing, when you switch to another window, and when you close it. A new document still needs a first Save to give it a name.

Autosave never asks a question. If the file changed on disk, or a save would need a decision about encoding or line endings, it pauses and says so at the bottom of the window. Use **Save**, **Save As** or **File → Compare with Disk** to settle it, and autosave resumes after the next successful save.

## Reusing writing and images

**File → New from Template** copies the text of a local Markdown or plain-text file into a new, unsaved draft. Save it where you want the new document. Relative image links resolve beside the saved draft.

Paste a clipboard image into the source editor and confirm **Save Image**. For an untitled draft, first choose where to save the document. Kladje stores a new PNG, JPEG, GIF or WebP of up to 4 MiB in the adjacent `assets/` folder and selects the image description. Undo removes the link. The image remains in the folder, so other documents can still use it. Move that folder with the document.

Choose **File → Compare with Disk** to see both text snapshots and the first differing line. You can select and copy from either pane. Closing the comparison returns to your edits. Save As keeps a separate copy if you want to keep both versions. Comparison ignores line-ending and encoding differences and supports up to 512 KiB on disk and 524,288 UTF-16 code units in the editor.


## Writing shortcuts

Use **Kladje → Settings…** (⌘,) on macOS or **File → Settings…** on other desktops to change automatic pairing, URL paste, rich-text conversion, reading time or image confirmation. Normal paste keeps plain text by default. With URL paste enabled, select a label and paste an HTTP or HTTPS address. With rich-text conversion enabled, paste formatted content to insert Markdown. Shift with the platform’s plain-paste shortcut bypasses these conversions. **Edit → Copy as Formatted Text** puts both Markdown source and formatted HTML on the clipboard.

Use Tab and Shift-Tab to select adjacent GFM table cells. Choose **View → Fold or Unfold at Cursor** on a heading. **⌘E** opens Find with the current selection; **⌘⇧C** toggles inline code. Fenced JavaScript, TypeScript, HTML and CSS have editor syntax colors. A closed initial frontmatter block stays in the file and is excluded from the prose word total.

Click a standard list checkbox in the preview or focus it and press Space to change its Markdown marker. Undo restores it. Checkboxes stay read-only in exports, tables and documents containing raw HTML. The status bar shows the encoding and line endings of the current document. Optional reading time uses 200 words per minute.

Choose **View → Document Outline** to keep headings beside your document. Filter or select a heading and press Enter to jump. Hide or Escape returns the space to the document. Windows 800 pixels wide or smaller use the compact heading picker. Tab in the final table cell adds a blank row.

Writing Settings can emphasize the current paragraph or keep the caret centered while you type. Both options start off. You can still scroll through the document and use Find.

Standalone HTML exports recognize a simple, single-line `title` and `lang` at the top level of initial frontmatter. For example, `lang: nl-BE` sets the document language. An omitted or unsupported title uses the first level-one heading, then the filename. Put `<!-- pagebreak -->` on a line between paragraphs to start a new printed page.
