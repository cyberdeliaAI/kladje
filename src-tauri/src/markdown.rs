//! Markdown → HTML rendering.
//!
//! Pipeline: comrak (CommonMark + GFM + extensions) → syntect for fenced code →
//! pulldown-latex for MathML → final HTML/MathML sanitation and image policy.
//!
use std::borrow::Cow;
use std::collections::BTreeMap;
use std::fmt::{self, Write};
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

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
/// Prefix ammonia puts on every `id` in the preview so document content cannot
/// shadow the app's own element ids.
pub const PREVIEW_ID_PREFIX: &str = "uc-";

pub struct Renderer {
    syntaxes: SyntaxSet,
    image_cache: Arc<Mutex<crate::images::RasterCache>>,
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

#[derive(serde::Serialize)]
pub struct TaskMarker {
    pub offset: usize,
    pub checked: bool,
}

#[derive(serde::Serialize)]
pub struct Rendered {
    #[serde(skip)]
    pub title: Option<String>,
    #[serde(skip)]
    pub language: Option<String>,
    #[serde(skip_serializing_if = "std::collections::HashMap::is_empty")]
    pub tasks: std::collections::HashMap<String, TaskMarker>,
    pub assets: std::collections::HashMap<String, String>,
    pub html: String,
    pub omitted: usize,
}

struct ImageUsage {
    assets: std::collections::HashMap<String, String>,
    remaining: usize,
    images: usize,
    attempts: usize,
    accepted: usize,
}

fn luminance([r, g, b]: [u8; 3]) -> f64 {
    let channel = |v: u8| {
        let s = f64::from(v) / 255.0;
        if s <= 0.04045 {
            s / 12.92
        } else {
            ((s + 0.055) / 1.055).powf(2.4)
        }
    };
    0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
}

// Syntax scopes share the code block surface in the preview, export and print.
fn syntax_styles(theme: &syntect::highlighting::Theme, background: [u8; 3], ink: u8) -> String {
    let surface = luminance(background);
    let mut theme = theme.clone();
    for scope in &mut theme.scopes {
        scope.style.background = None;
        if let Some(c) = &mut scope.style.foreground {
            loop {
                let fg = luminance([c.r, c.g, c.b]);
                if (surface.max(fg) + 0.05) / (surface.min(fg) + 0.05) >= 4.5 {
                    break;
                }
                let blend = |v| ((3 * u16::from(v) + u16::from(ink)) / 4) as u8;
                (c.r, c.g, c.b) = (blend(c.r), blend(c.g), blend(c.b));
            }
        }
    }
    css_for_theme_with_class_style(&theme, HL_STYLE).unwrap_or_default()
}

impl Renderer {
    pub fn new() -> Self {
        let themes = two_face::theme::extra();
        Renderer {
            image_cache: Default::default(),
            syntaxes: two_face::syntax::extra_newlines(),
            syntax_css_light: syntax_styles(
                themes.get(EmbeddedThemeName::Github),
                [246, 248, 250],
                0,
            ),
            syntax_css_dark: syntax_styles(
                themes.get(EmbeddedThemeName::OneHalfDark),
                [32, 36, 43],
                255,
            ),
        }
    }

    /// Render Markdown to sanitised HTML. Never panics: if a library misbehaves
    /// on some input, the error is shown in the preview instead of taking the
    /// editor (and unsaved text) down with it.
    pub fn render(&self, markdown: &str, target: Target) -> String {
        self.render_document(markdown, target, None, false)
            .map(|r| r.html)
            .unwrap_or_else(|e| format!("<p>{}</p>", escaped(&e)))
    }

    pub fn render_document(
        &self,
        markdown: &str,
        target: Target,
        source: Option<&Path>,
        remote: bool,
    ) -> Result<Rendered, String> {
        catch_unwind(AssertUnwindSafe(|| {
            self.render_inner(markdown, target, source, remote, None)
        }))
        .map_err(|_| "Preview unavailable. Your source is still open.".to_owned())?
    }

    pub fn preview_update(
        &self,
        markdown: &str,
        source: Option<&Path>,
        remote: bool,
        known: Vec<String>,
    ) -> Result<Rendered, String> {
        let known = known.into_iter().take(128).collect();
        catch_unwind(AssertUnwindSafe(|| {
            self.render_inner(markdown, Target::Preview, source, remote, Some(known))
        }))
        .map_err(|_| "Preview unavailable. Your source is still open.".to_owned())?
    }

    fn render_inner(
        &self,
        markdown: &str,
        target: Target,
        source: Option<&Path>,
        remote: bool,
        known: Option<std::collections::HashSet<String>>,
    ) -> Result<Rendered, String> {
        let opts = comrak_options(target);
        let arena = Arena::new();
        let root = parse_document(&arena, markdown, &opts);

        let (title, language) = if target == Target::Export {
            crate::export::document_metadata(root)
        } else {
            (None, None)
        };

        // Only bind a source editing command when every list control was produced
        // by our Markdown renderer. Raw HTML may supply its own classes/positions.
        let mut tasks = std::collections::HashMap::new();
        if known.is_some()
            && ["[ ]", "[x]", "[X]"]
                .iter()
                .any(|mark| markdown.contains(mark))
            && !root.descendants().any(|n| match &n.data().value {
                NodeValue::HtmlBlock(block) => block.literal.trim() != "<!-- pagebreak -->",
                NodeValue::HtmlInline(_) => true,
                _ => false,
            })
        {
            let mut offset = 0;
            let lines: Vec<_> = markdown
                .split('\n')
                .map(|line| {
                    let start = offset;
                    offset += line.encode_utf16().count() + 1;
                    (start, line)
                })
                .collect();
            for node in root.descendants() {
                let ast = node.data();
                if let NodeValue::TaskItem(task) = &ast.value {
                    if !node
                        .parent()
                        .is_some_and(|p| matches!(p.data().value, NodeValue::List(_)))
                    {
                        continue;
                    }
                    let pos = task.symbol_sourcepos.start;
                    let Some(&(start, line)) = lines.get(pos.line.saturating_sub(1)) else {
                        continue;
                    };
                    let column = pos.column.saturating_sub(1);
                    let Some(marker) = line.as_bytes().get(column.saturating_sub(1)..column + 2)
                    else {
                        continue;
                    };
                    if !matches!(marker, b"[ ]" | b"[x]" | b"[X]") {
                        continue;
                    }
                    tasks.insert(
                        ast.sourcepos.to_string(),
                        TaskMarker {
                            offset: start + line[..column].encode_utf16().count(),
                            checked: task.symbol.is_some(),
                        },
                    );
                }
            }
        }

        for node in root.descendants() {
            let mut ast = node.data_mut();
            if let NodeValue::HtmlBlock(block) = &ast.value {
                if block.literal.trim() == "<!-- pagebreak -->" {
                    ast.value = NodeValue::Raw(
                        "<div class=\"page-break\" aria-hidden=\"true\"></div>\n".into(),
                    );
                }
            }
            if !matches!(
                ast.value,
                NodeValue::Math(_) | NodeValue::MathBlock(_) | NodeValue::CodeBlock(_)
            ) {
                continue;
            }
            let pos = if target == Target::Preview {
                format!(" data-sourcepos=\"{}\"", ast.sourcepos)
            } else {
                String::new()
            };
            let replacement = match &ast.value {
                NodeValue::Math(m) => Some(latex_to_mathml(&m.literal, m.display_math)),
                NodeValue::MathBlock(m) => Some(format!(
                    "<div class=\"math-block\"{pos}>{}</div>\n",
                    latex_to_mathml(&m.literal, true)
                )),
                NodeValue::CodeBlock(cb) if is_math_fence(&cb.info) => Some(format!(
                    "<div class=\"math-block\"{pos}>{}</div>\n",
                    latex_to_mathml(&cb.literal, true)
                )),
                _ => None,
            };
            if let Some(raw) = replacement {
                ast.value = NodeValue::Raw(raw);
            }
        }

        let highlighter = Highlighter {
            syntaxes: &self.syntaxes,
        };
        let mut plugins = options::Plugins::default();
        plugins.render.codefence_syntax_highlighter = Some(&highlighter);

        let mut html = String::with_capacity(markdown.len() * 2);
        format_html_with_plugins(root, &opts, &mut html, &plugins)
            .map_err(|_| "Could not format Markdown.")?;
        let usage = Arc::new(Mutex::new(ImageUsage {
            assets: Default::default(),
            remaining: crate::images::DOCUMENT_IMAGE_LIMIT,
            images: 0,
            attempts: 0,
            accepted: 0,
        }));
        let prefix = (target == Target::Preview).then_some(PREVIEW_ID_PREFIX);
        let clean = sanitizer(
            prefix,
            source.map(Path::to_owned),
            remote && target == Target::Preview,
            usage.clone(),
            known,
            self.image_cache.clone(),
        )
        .clean(&html)
        .to_string();
        let mut counts = usage.lock().unwrap();
        let omitted = counts.images.saturating_sub(counts.accepted);
        Ok(Rendered {
            title,
            language,
            tasks,
            assets: std::mem::take(&mut counts.assets),
            html: clean,
            omitted,
        })
    }
}

#[derive(serde::Serialize)]
pub struct Heading {
    pub level: u8,
    pub line: usize,
    pub text: String,
}

/// Navigation uses the preview parser without rendering HTML or reading images.
pub fn headings(markdown: &str) -> Result<Vec<Heading>, String> {
    if markdown.len() > 4 * 1024 * 1024 {
        return Err(
            "Jump to Heading supports documents up to 4 MiB. Use Find in this document.".into(),
        );
    }
    catch_unwind(AssertUnwindSafe(|| {
        let arena = Arena::new();
        let root = parse_document(&arena, markdown, &comrak_options(Target::Preview));
        root.descendants()
            .filter_map(|node| {
                let ast = node.data();
                if let NodeValue::Heading(h) = &ast.value {
                    Some(Heading {
                        level: h.level,
                        line: ast.sourcepos.start.line,
                        text: node.collect_text(),
                    })
                } else {
                    None
                }
            })
            .collect()
    }))
    .map_err(|_| "Could not read document headings.".into())
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
    o.render.hardbreaks = target == Target::Preview;
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
            if generator
                .parse_html_for_line_which_includes_newline(line)
                .is_err()
            {
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
        display_mode: if display {
            DisplayMode::Block
        } else {
            DisplayMode::Inline
        },
        ..RenderConfig::default()
    };
    let mut out = String::new();
    match pulldown_latex::push_mathml(&mut out, parser, config) {
        Ok(()) => out,
        Err(_) => format!("<code class=\"math-error\">{}</code>", escaped(latex)),
    }
}

fn sanitizer(
    id_prefix: Option<&'static str>,
    source: Option<PathBuf>,
    remote: bool,
    usage: Arc<Mutex<ImageUsage>>,
    known: Option<std::collections::HashSet<String>>,
    cache: Arc<Mutex<crate::images::RasterCache>>,
) -> ammonia::Builder<'static> {
    let mut b = ammonia::Builder::default();
    b.add_tags([
        "details",
        "summary",
        "mark",
        "kbd",
        "input",
        "section",
        "figure",
        "figcaption",
        "u",
        "ins",
        "center",
    ]);
    b.add_generic_attributes([
        "class",
        "id",
        "title",
        "lang",
        "dir",
        "data-sourcepos",
        "aria-hidden",
    ]);
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
    b.add_tags([
        "math",
        "mrow",
        "mi",
        "mn",
        "mo",
        "mtext",
        "ms",
        "mspace",
        "mfrac",
        "msqrt",
        "mroot",
        "msub",
        "msup",
        "msubsup",
        "mover",
        "munder",
        "munderover",
        "mtable",
        "mtr",
        "mtd",
        "mstyle",
        "mpadded",
        "mphantom",
        "merror",
        "menclose",
        "mmultiscripts",
        "mprescripts",
        "none",
    ]);
    b.add_tag_attributes("math", ["display"]);
    b.add_tag_attributes(
        "mo",
        [
            "stretchy",
            "fence",
            "separator",
            "largeop",
            "movablelimits",
            "lspace",
            "rspace",
        ],
    );
    b.add_tag_attributes("mi", ["mathvariant"]);
    b.add_tag_attributes("mfrac", ["linethickness"]);
    b.add_tag_attributes("mspace", ["width", "height", "depth"]);
    b.url_schemes(
        ["https", "http", "mailto", "tel", "data"]
            .into_iter()
            .collect(),
    );
    b.id_prefix(id_prefix);
    b.set_tag_attribute_value("img", "referrerpolicy", "no-referrer");
    b.attribute_filter(move |element, attribute, value| {
        if element == "img" && attribute == "referrerpolicy" {
            usage.lock().unwrap().images += 1;
        }
        if element == "img" && attribute == "src" {
            let mut totals = usage.lock().unwrap();
            totals.attempts += 1;
            if totals.attempts > 128 {
                return None;
            }
            if let (Some(known), Some(source)) = (&known, &source) {
                if !value.starts_with("data:") && url::Url::parse(value).is_err() {
                    let asset = cache
                        .lock()
                        .ok()?
                        .local(value, source, &mut totals.remaining)?;
                    totals.accepted += 1;
                    if !known.contains(&asset.token) {
                        totals
                            .assets
                            .entry(asset.token.clone())
                            .or_insert_with(|| asset.uri.clone());
                    }
                    return Some(Cow::Owned(asset.token.clone()));
                }
            }
            let url =
                crate::images::source_url(value, source.as_deref(), remote, &mut totals.remaining);
            if url.is_some() {
                totals.accepted += 1;
            }
            return url.map(Cow::Owned);
        }
        if attribute == "href"
            && (value.starts_with("//")
                || value.contains('\\')
                || value.chars().any(char::is_control)
                || value.to_ascii_lowercase().starts_with("data:"))
        {
            return None;
        }
        Some(value.into())
    });
    b
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
    fn single_returns_are_visible_in_preview_and_keep_markdown_export_semantics() {
        let source = "Dit\nis\neen\ntest\n\nVolgende alinea";
        let html = preview(source);
        assert_eq!(html.matches("<p ").count(), 2, "{html}");
        assert_eq!(html.matches("<br").count(), 3, "{html}");
        assert_eq!(
            export(source).trim(),
            "<p>Dit\nis\neen\ntest</p>\n<p>Volgende alinea</p>"
        );
    }

    #[test]
    fn preview_line_breaks_respect_lists_code_and_explicit_markdown_breaks() {
        let source = "- first\n- second\n\n```\none\ntwo\n```\n\na  \nb\\\nc";
        for html in [preview(source), export(source)] {
            assert_eq!(html.matches("<li").count(), 2, "{html}");
            assert!(html.contains("one\ntwo\n"), "{html}");
            assert_eq!(html.matches("<br").count(), 2, "{html}");
        }
    }

    #[test]
    fn generated_syntax_foregrounds_remain_legible_in_both_previews() {
        let renderer = Renderer::new();
        for (css, bg) in [
            (&renderer.syntax_css_light, [246, 248, 250]),
            (&renderer.syntax_css_dark, [32, 36, 43]),
        ] {
            let mut count = 0;
            for line in css.lines() {
                if let Some(hex) = line
                    .trim()
                    .strip_prefix("color: #")
                    .and_then(|s| s.strip_suffix(';'))
                {
                    let value = u32::from_str_radix(hex, 16).unwrap().to_be_bytes();
                    let fg = luminance([value[1], value[2], value[3]]);
                    let bg = luminance(bg);
                    assert!((fg.max(bg) + 0.05) / (fg.min(bg) + 0.05) >= 4.5, "{hex}");
                    count += 1;
                }
            }
            assert!(count > 10);
        }
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
        let html =
            export("Inline $a^2 + b^2$ and\n\n$$\n\\frac{1}{2}\n$$\n\n```math\nx = y\n```\n");
        assert_eq!(html.matches("<math").count(), 3, "{html}");
        assert!(html.contains("<mfrac>"), "{html}");
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
        assert!(
            html.contains("<details>") && html.contains("<summary>"),
            "{html}"
        );
        assert!(html.contains("<kbd>Ctrl</kbd>"), "{html}");
        assert!(html.contains("width=\"40\""), "{html}");
        assert!(!html.contains("data:image/png;base64,AAAA"), "{html}");
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
    fn compatibility_and_privacy_across_output_targets() {
        let md = "# Café\n\n# Café\n\n- parent\n  - **child**  \n    next\n\n$x^2$ \u{e000}漢字\u{e001}\n\n![X](https://example.org/x.png)\n";
        let r = Renderer::new();
        for target in [Target::Preview, Target::Export] {
            let result = r.render_document(md, target, None, true).unwrap();
            let html = result.html;
            for token in [
                "café-1",
                "<strong",
                "child",
                "<br",
                "<msup>",
                "\u{e000}漢字\u{e001}",
            ] {
                assert!(html.contains(token), "{token} in {html}");
            }
            assert_eq!(
                html.contains("https://example.org"),
                target == Target::Preview
            );
            assert_eq!(result.omitted, usize::from(target == Target::Export));
        }
    }

    #[test]
    fn title_comes_from_first_heading() {
        let r = Renderer::new();
        assert_eq!(
            r.render_document("intro\n\n# The *Title*\n", Target::Export, None, false)
                .unwrap()
                .title
                .as_deref(),
            Some("The Title")
        );
        assert_eq!(
            r.render_document("no heading", Target::Export, None, false)
                .unwrap()
                .title,
            None
        );
    }

    #[test]
    fn hostile_input_does_not_panic() {
        let r = Renderer::new();
        for md in [
            "$\\frac{$",
            "$$\n\\begin{matrix}\n$$",
            "\u{E000}0\u{E001}",
            "[[[[[[[[[[",
            "```\n",
            "$\\undefinedcommand{x}$",
            "|||\n|-|\n",
            "<math><mtext><script>x</script></mtext></math>",
        ] {
            let _ = r.render(md, Target::Preview);
        }
        let html = r.render("\u{E000}0\u{E001} plain", Target::Preview);
        assert!(html.contains("plain"));
    }
}

#[cfg(test)]
mod outline_tests {
    #[test]
    fn uses_markdown_source_lines_and_ignores_non_headings() {
        let src =
            "---\n# metadata\n---\n# **Café**\n\n```md\n# example\n```\n> ## Café\n\n東京\n====\n";
        let list = super::headings(src).unwrap();
        let rows: Vec<_> = list
            .iter()
            .map(|h| (h.level, h.line, h.text.as_str()))
            .collect();
        assert_eq!(rows, [(1, 4, "Café"), (2, 9, "Café"), (1, 11, "東京")]);
    }
}
