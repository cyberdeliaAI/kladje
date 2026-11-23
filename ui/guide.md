# Markdown Guide

Write on the left, read on the right. This page shows everything Kladje understands — edit it freely, it is only a copy. You can always get it back from **Help → Markdown Guide**.

## Text

Plain paragraphs are separated by a blank line. Inside a paragraph you can use *italic*, **bold**, ***both***, ~~strikethrough~~, ==highlight==, `inline code`, H~2~O and x^2^.

A line ending in a backslash\
breaks without starting a new paragraph.

## Links and images

[A link](https://commonmark.org "with a title"), a bare address like https://example.com, and a [reference link][ref].

Use **Format → Insert Local Image** or drop a PNG, JPEG, GIF or WebP. Save an untitled document first so Kladje can use a relative path. When a picture is outside the document folder, you can copy it beside the Markdown file. Replace the selected description with meaningful alt text. The result looks like `![A map of the route](map.png)`.

HTTPS images require permission in **View → Remote Images for This Document**. An unavailable image shows its description. Standalone HTML embeds supported local images so the exported file can move. PDF uses the current rendered document, including when only the editor is visible.

Relative Markdown links can include a section, as in `[Notes](meeting%20notes.md#decisions)`. A second heading with the same name gets the suffix `-1`. External links open with the system handler.

Use **⌘1–⌘6** on macOS for heading levels and **⌘0** for a paragraph. Tab to the splitter, resize with the arrow keys, press Enter to center it or Escape to return to the source. In the editor, Escape followed by Tab moves keyboard focus out of the writing area.

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
