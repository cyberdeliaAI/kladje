//! Markdown → HTML rendering.
//!
//! Pipeline: comrak (CommonMark + GFM + extensions) → syntect for fenced code →
//! ammonia to sanitise raw HTML → pulldown-latex for math (MathML, no JavaScript).
//!
//! Everything the preview shows goes through the sanitiser, so opening an
//! untrusted `.md` file can never run script inside the app.

use std::borrow::Cow;
use std::collections::BTreeMap;
use std::fmt::{self, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};

use comrak::adapters::{SyntaxHighlightMeta, SyntaxHighlighterAdapter};
use comrak::nodes::NodeValue;
use comrak::{format_html_with_plugins, options, parse_document, Arena, Options};
use syntect::html::{css_for_theme_with_class_style, ClassStyle, ClassedHTMLGenerator};
use syntect::parsing::SyntaxSet;
use syntect::util::LinesWithEndings;
use two_face::theme::EmbeddedThemeName;

/// Prefix for syntax-highlighting classes, so they cannot clash with anything else.
const HL_STYLE: ClassStyle = ClassStyle::SpacedPrefixed { prefix: "hl-" };
/// Code blocks larger than this are shown without highlighting to stay fast.
const MAX_HIGHLIGHT_BYTES: usize = 256 * 1024;
/// Private-use characters that bracket a math placeholder while sanitising.
const MATH_OPEN: char = '\u{E000}';
const MATH_CLOSE: char = '\u{E001}';
/// Prefix ammonia puts on every `id` in the preview so document content cannot
/// shadow the app's own element ids.
pub const PREVIEW_ID_PREFIX: &str = "uc-";

pub struct Renderer {
    syntaxes: SyntaxSet,
    preview_sanitizer: ammonia::Builder<'static>,
    export_sanitizer: ammonia::Builder<'static>,
    pub syntax_css_light: String,
    pub syntax_css_dark: String,
}

/// What the rendered HTML is for.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Target {
    /// Live preview: source positions for scroll sync, prefixed ids.
    Preview,
    /// Standalone export: clean markup, ids as written.
    Export,
}

impl Renderer {
    pub fn new() -> Self {
        let themes = two_face::theme::extra();
        let css = |name| {
            css_for_theme_with_class_style(themes.get(name), HL_STYLE).unwrap_or_default()
        };
        Renderer {
            syntaxes: two_face::syntax::extra_newlines(),
            preview_sanitizer: sanitizer(Some(PREVIEW_ID_PREFIX)),
            export_sanitizer: sanitizer(None),
            syntax_css_light: css(EmbeddedThemeName::Github),
            syntax_css_dark: css(EmbeddedThemeName::OneHalfDark),
        }
    }

    /// Render Markdown to sanitised HTML. Never panics: if a library misbehaves
    /// on some input, the error is shown in the preview instead of taking the
    /// editor (and unsaved text) down with it.
    pub fn render(&self, markdown: &str, target: Target) -> String {
        match catch_unwind(AssertUnwindSafe(|| self.render_inner(markdown, target))) {
            Ok(html) => html,
            Err(_) => "<div class=\"markdown-alert markdown-alert-caution\">\
                       <p class=\"markdown-alert-title\">Preview unavailable</p>\
                       <p>This document could not be rendered. Your text is unaffected.</p></div>"
                .to_string(),
        }
    }

    fn render_inner(&self, markdown: &str, target: Target) -> String {
        // The placeholder characters must not occur in the source itself.
        let source: Cow<str> = if markdown.contains([MATH_OPEN, MATH_CLOSE]) {
            Cow::Owned(markdown.replace([MATH_OPEN, MATH_CLOSE], ""))
        } else {
            Cow::Borrowed(markdown)
        };

        let opts = comrak_options(target);
        let arena = Arena::new();
        let root = parse_document(&arena, &source, &opts);

        // Swap math nodes for placeholders; the MathML is inserted after sanitising.
        let mut math: Vec<String> = Vec::new();
        for node in root.descendants() {
            let mut ast = node.data_mut();
            let pos = if target == Target::Preview {
                format!(" data-sourcepos=\"{}\"", ast.sourcepos)
            } else {
                String::new()
            };
            let replacement = match &ast.value {
                NodeValue::Math(m) => {
                    math.push(latex_to_mathml(&m.literal, m.display_math));
                    Some(format!("{MATH_OPEN}{}{MATH_CLOSE}", math.len() - 1))
                }
                NodeValue::MathBlock(b) => {
                    math.push(latex_to_mathml(&b.literal, true));
                    Some(format!(
                        "<div class=\"math-block\"{pos}>{MATH_OPEN}{}{MATH_CLOSE}</div>\n",
                        math.len() - 1
                    ))
                }
                NodeValue::CodeBlock(cb) if is_math_fence(&cb.info) => {
                    math.push(latex_to_mathml(&cb.literal, true));
                    Some(format!(
                        "<div class=\"math-block\"{pos}>{MATH_OPEN}{}{MATH_CLOSE}</div>\n",
                        math.len() - 1
                    ))
                }
                _ => None,
            };
            if let Some(raw) = replacement {
                ast.value = NodeValue::Raw(raw);
            }
        }

        let highlighter = Highlighter { syntaxes: &self.syntaxes };
        let mut plugins = options::Plugins::default();
        plugins.render.codefence_syntax_highlighter = Some(&highlighter);

        let mut html = String::with_capacity(source.len() * 2);
        if format_html_with_plugins(root, &opts, &mut html, &plugins).is_err() {
            return String::new();
        }

        let sanitizer = match target {
            Target::Preview => &self.preview_sanitizer,
            Target::Export => &self.export_sanitizer,
        };
        let clean = sanitizer.clean(&html).to_string();
        insert_math(&clean, &math)
    }

    /// First level-1 heading of the document, used as the title of an export.
    pub fn title_of(&self, markdown: &str) -> Option<String> {
        let opts = comrak_options(Target::Export);
        let arena = Arena::new();
        let root = parse_document(&arena, markdown, &opts);
        let heading = root.children().find(|n| {
            matches!(&n.data().value, NodeValue::Heading(h) if h.level == 1)
        })?;
        let text = heading.collect_text();
        let text = text.trim();
        (!text.is_empty()).then(|| text.to_string())
    }
}

fn comrak_options(target: Target) -> Options<'static> {
    let mut o = Options::default();

    // GitHub Flavored Markdown
    o.extension.strikethrough = true;
    o.extension.table = true;
    o.extension.autolink = true;
    o.extension.tasklist = true;
    o.extension.footnotes = true;
    o.extension.alerts = true;
    o.extension.shortcodes = true;
    o.extension.header_id_prefix = Some(String::new());
    // Common extras
    o.extension.superscript = true;
    o.extension.subscript = true;
    o.extension.highlight = true;
    o.extension.description_lists = true;
    o.extension.front_matter_delimiter = Some("---".to_string());
    o.extension.math_dollars = true;
    o.extension.math_dollars_block = true;
    o.extension.math_code = true;

    o.parse.relaxed_tasklist_matching = true;
    o.parse.tasklist_in_table = true;

    // Raw HTML is allowed through here and cleaned by ammonia afterwards.
    o.render.r#unsafe = true;
    o.render.tasklist_classes = true;
    o.render.sourcepos = target == Target::Preview;
    o
}

fn is_math_fence(info: &str) -> bool {
    info.split_whitespace().next() == Some("math")
}

// ---------------------------------------------------------------------------
// Syntax highlighting

struct Highlighter<'a> {
    syntaxes: &'a SyntaxSet,
}

impl SyntaxHighlighterAdapter for Highlighter<'_> {
    fn write_highlighted(
        &self,
        output: &mut dyn Write,
        highlight: &SyntaxHighlightMeta<'_>,
    ) -> fmt::Result {
        let code = highlight.code;
        let lang = highlight
            .lang
            .split(|c: char| c == ',' || c.is_whitespace())
            .next()
            .unwrap_or("");

        let syntax = (!lang.is_empty() && code.len() <= MAX_HIGHLIGHT_BYTES)
            .then(|| self.syntaxes.find_syntax_by_token(lang))
            .flatten();
        let Some(syntax) = syntax else {
            return escape_html(output, code);
        };

        let mut generator =
            ClassedHTMLGenerator::new_with_class_style(syntax, self.syntaxes, HL_STYLE);
        for line in LinesWithEndings::from(code) {
            if generator.parse_html_for_line_which_includes_newline(line).is_err() {
                return escape_html(output, code);
            }
        }
        output.write_str(&generator.finalize())
    }

    fn write_pre_tag(
        &self,
        output: &mut dyn Write,
        _highlight: &SyntaxHighlightMeta<'_>,
        attributes: BTreeMap<&str, Cow<'_, str>>,
    ) -> fmt::Result {
        write_tag(output, "pre", &attributes)
    }

    fn write_code_tag(
        &self,
        output: &mut dyn Write,
        _highlight: &SyntaxHighlightMeta<'_>,
        attributes: BTreeMap<&str, Cow<'_, str>>,
    ) -> fmt::Result {
        write_tag(output, "code", &attributes)
    }
}

fn write_tag(
    output: &mut dyn Write,
    tag: &str,
    attributes: &BTreeMap<&str, Cow<'_, str>>,
) -> fmt::Result {
    write!(output, "<{tag}")?;
    for (name, value) in attributes {
        write!(output, " {name}=\"")?;
        escape_html(output, value)?;
        output.write_char('"')?;
    }
    output.write_char('>')
}

pub fn escape_html(output: &mut dyn Write, text: &str) -> fmt::Result {
    let mut last = 0;
    for (i, b) in text.bytes().enumerate() {
        let replacement = match b {
            b'&' => "&amp;",
            b'<' => "&lt;",
            b'>' => "&gt;",
            b'"' => "&quot;",
            _ => continue,
        };
        output.write_str(&text[last..i])?;
        output.write_str(replacement)?;
        last = i + 1;
    }
    output.write_str(&text[last..])
}

pub fn escaped(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    let _ = escape_html(&mut out, text);
    out
}

// ---------------------------------------------------------------------------
// Math

fn latex_to_mathml(latex: &str, display: bool) -> String {
    use pulldown_latex::config::{DisplayMode, RenderConfig};

    let storage = pulldown_latex::Storage::new();
    let parser = pulldown_latex::Parser::new(latex, &storage);
    let config = RenderConfig {
        display_mode: if display { DisplayMode::Block } else { DisplayMode::Inline },
        ..RenderConfig::default()
    };
    let mut out = String::new();
    match pulldown_latex::push_mathml(&mut out, parser, config) {
        Ok(()) => out,
        Err(_) => format!("<code class=\"math-error\">{}</code>", escaped(latex)),
    }
}

/// Replace `MATH_OPEN n MATH_CLOSE` placeholders with the rendered MathML.
fn insert_math(html: &str, math: &[String]) -> String {
    if math.is_empty() {
        return html.to_string();
    }
    let mut out = String::with_capacity(html.len() + math.iter().map(String::len).sum::<usize>());
    let mut rest = html;
    while let Some(start) = rest.find(MATH_OPEN) {
        out.push_str(&rest[..start]);
        let after = &rest[start + MATH_OPEN.len_utf8()..];
        match after.find(MATH_CLOSE) {
            Some(end) => {
                if let Some(m) = after[..end].parse::<usize>().ok().and_then(|i| math.get(i)) {
                    out.push_str(m);
                }
                rest = &after[end + MATH_CLOSE.len_utf8()..];
            }
            None => {
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

// ---------------------------------------------------------------------------
// Sanitising

fn sanitizer(id_prefix: Option<&'static str>) -> ammonia::Builder<'static> {
    let mut b = ammonia::Builder::default();
    b.add_tags([
        "details", "summary", "mark", "kbd", "input", "section", "figure", "figcaption", "u",
        "ins", "center",
    ]);
    b.add_generic_attributes(["class", "id", "title", "lang", "dir", "data-sourcepos", "aria-hidden"]);
    b.add_tag_attributes("input", ["type", "checked", "disabled"]);
    b.add_tag_attributes("details", ["open"]);
    b.add_tag_attributes("a", ["name"]);
    b.add_tag_attributes("div", ["align"]);
    b.add_tag_attributes("p", ["align"]);
    for h in ["h1", "h2", "h3", "h4", "h5", "h6"] {
        b.add_tag_attributes(h, ["align"]);
    }
    // The only form control Markdown produces is a read-only task checkbox.
    b.set_tag_attribute_value("input", "type", "checkbox");
    b.set_tag_attribute_value("input", "disabled", "");
    b.add_url_schemes(["data", "file"]);
    b.id_prefix(id_prefix);
    b.attribute_filter(|element, attribute, value| {
        let is_image_src = element == "img" && attribute == "src";
        // Windows drive paths would otherwise be read as a URL scheme ("c:").
        if is_image_src && is_windows_path(value) {
            return Some(format!("file:///{}", value.replace('\\', "/")).into());
        }
        let lower = value.trim_start().to_ascii_lowercase();
        if lower.starts_with("data:") && !(is_image_src && lower.starts_with("data:image/")) {
            return None;
        }
        if lower.starts_with("file:") && !is_image_src {
            return None;
        }
        Some(value.into())
    });
    b
}

fn is_windows_path(value: &str) -> bool {
    let b = value.as_bytes();
    b.len() > 2 && b[0].is_ascii_alphabetic() && b[1] == b':' && (b[2] == b'\\' || b[2] == b'/')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn preview(md: &str) -> String {
        Renderer::new().render(md, Target::Preview)
    }
    fn export(md: &str) -> String {
        Renderer::new().render(md, Target::Export)
    }

    #[test]
    fn commonmark_basics() {
        let html = export("# Title\n\nSome *emphasis*, **strong** and `code`.\n\n> quote\n\n---\n");
        assert!(html.contains("<h1 id=\"title\">Title"), "{html}");
        assert!(html.contains("<em>emphasis</em>"));
        assert!(html.contains("<strong>strong</strong>"));
        assert!(html.contains("<code>code</code>"));
        assert!(html.contains("<blockquote>"));
        assert!(html.contains("<hr"));
    }

    #[test]
    fn gfm_extensions() {
        let html = export(
            "| a | b |\n|---|:-:|\n| 1 | 2 |\n\n- [x] done\n- [ ] todo\n\n~~gone~~ www.example.com\n\nNote[^1]\n\n[^1]: The note.\n",
        );
        assert!(html.contains("<table>"), "{html}");
        assert!(html.contains("align=\"center\""), "{html}");
        assert!(html.contains("type=\"checkbox\""), "{html}");
        assert!(html.contains("checked"), "{html}");
        assert!(html.contains("<del>gone</del>"), "{html}");
        assert!(html.contains("href=\"http://www.example.com\""), "{html}");
        assert!(html.contains("footnotes"), "{html}");
    }

    #[test]
    fn extras() {
        let html = export(
            "> [!WARNING]\n> Careful\n\nH~2~O, x^2^, ==marked== :tada:\n\nTerm\n\n: Definition\n",
        );
        assert!(html.contains("markdown-alert-warning"), "{html}");
        assert!(html.contains("<sub>2</sub>"), "{html}");
        assert!(html.contains("<sup>2</sup>"), "{html}");
        assert!(html.contains("<mark>marked</mark>"), "{html}");
        assert!(html.contains('🎉'), "{html}");
        assert!(html.contains("<dl>") && html.contains("<dd>"), "{html}");
    }

    #[test]
    fn front_matter_is_hidden() {
        let html = export("---\ntitle: Hidden\n---\n\nBody\n");
        assert!(!html.contains("Hidden"), "{html}");
        assert!(html.contains("Body"));
    }

    #[test]
    fn code_is_highlighted_with_classes() {
        let html = export("```rust\nfn main() { let x = 1; }\n```\n\n```toml\na = 1\n```\n");
        assert!(html.contains("language-rust"), "{html}");
        assert!(html.contains("class=\"hl-"), "{html}");
        assert!(!html.contains("style="), "{html}");
    }

    #[test]
    fn unknown_language_is_escaped() {
        let html = export("```nonsense-lang\n<b>&</b>\n```\n");
        assert!(html.contains("&lt;b&gt;&amp;&lt;/b&gt;"), "{html}");
    }

    #[test]
    fn math_becomes_mathml() {
        let html = export("Inline $a^2 + b^2$ and\n\n$$\n\\frac{1}{2}\n$$\n\n```math\nx = y\n```\n");
        assert_eq!(html.matches("<math").count(), 3, "{html}");
        assert!(html.contains("<mfrac>"), "{html}");
        assert!(!html.contains(MATH_OPEN), "{html}");
    }

    #[test]
    fn dollar_amounts_are_not_math() {
        let html = export("It costs $5 and then $10 more.\n");
        assert!(!html.contains("<math"), "{html}");
    }

    #[test]
    fn scripts_and_handlers_are_removed() {
        let html = preview(
            "<script>alert(1)</script>\n\n<img src=x onerror=\"alert(1)\">\n\n[x](javascript:alert(1))\n\n<a href=\"data:text/html,<script>1</script>\">d</a>\n\n<iframe src=\"https://example.com\"></iframe>\n\n<div style=\"position:fixed\">s</div>\n",
        );
        assert!(!html.contains("<script"), "{html}");
        assert!(!html.contains("onerror"), "{html}");
        assert!(!html.contains("javascript:"), "{html}");
        assert!(!html.contains("data:text/html"), "{html}");
        assert!(!html.contains("<iframe"), "{html}");
        assert!(!html.contains("style="), "{html}");
    }

    #[test]
    fn safe_raw_html_is_kept() {
        let html = export(
            "<details><summary>More</summary>\n\nHidden\n\n</details>\n\n<kbd>Ctrl</kbd> <img src=\"a.png\" width=\"40\">\n\n![d](data:image/png;base64,AAAA)\n",
        );
        assert!(html.contains("<details>") && html.contains("<summary>"), "{html}");
        assert!(html.contains("<kbd>Ctrl</kbd>"), "{html}");
        assert!(html.contains("width=\"40\""), "{html}");
        assert!(html.contains("src=\"data:image/png;base64,AAAA\""), "{html}");
    }

    #[test]
    fn preview_has_source_positions_and_prefixed_ids() {
        let html = preview("# Hello\n\nText\n");
        assert!(html.contains("data-sourcepos=\"1:1-1:7\""), "{html}");
        assert!(html.contains("id=\"uc-hello\""), "{html}");
        let html = export("# Hello\n");
        assert!(!html.contains("data-sourcepos"), "{html}");
        assert!(html.contains("id=\"hello\""), "{html}");
    }

    #[test]
    fn title_comes_from_first_heading() {
        let r = Renderer::new();
        assert_eq!(r.title_of("intro\n\n# The *Title*\n").as_deref(), Some("The Title"));
        assert_eq!(r.title_of("no heading"), None);
    }

    #[test]
    fn hostile_input_does_not_panic() {
        let r = Renderer::new();
        for md in [
            "$\\frac{$", "$$\n\\begin{matrix}\n$$", "\u{E000}0\u{E001}", "[[[[[[[[[[", "```\n",
            "$\\undefinedcommand{x}$", "|||\n|-|\n", "<math><mtext><script>x</script></mtext></math>",
        ] {
            let _ = r.render(md, Target::Preview);
        }
        let html = r.render("\u{E000}0\u{E001} plain", Target::Preview);
        assert!(html.contains("plain"));
    }
}
