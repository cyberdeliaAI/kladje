# Markdown Guide

Write on the left, read on the right. This page shows everything Kladje understands — edit it freely, it is only a copy. You can always get it back from **Help → Markdown Guide**.

## Text

Plain paragraphs are separated by a blank line. Inside a paragraph you can use *italic*, **bold**, ***both***, ~~strikethrough~~, ==highlight==, `inline code`, H~2~O and x^2^.

A line ending in a backslash\
breaks without starting a new paragraph.

## Links and images

[A link](https://commonmark.org "with a title"), a bare address like https://example.com, and a [reference link][ref].

Images use the same idea with an exclamation mark in front: `![Description](picture.png)`. Paths are relative to the saved document.

[ref]: https://github.github.com/gfm/

## Lists

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
