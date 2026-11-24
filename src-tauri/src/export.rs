//! Export to a standalone HTML file.

use crate::markdown::{escaped, Renderer, Target};

const DOCUMENT_CSS: &str = include_str!("../../ui/preview.css");
const MATH_CSS: &str = include_str!("../../ui/vendor/mathml.css");

/// Read flat, single-line metadata only. Unknown or compound YAML never runs
/// a resolver or expands aliases. Ambiguous fields fall back independently.
pub(crate) fn document_metadata(root: comrak::nodes::Node<'_>) -> (Option<String>, Option<String>) {
    use comrak::nodes::NodeValue;
    let heading = || {
        root.children()
            .find(|node| matches!(&node.data().value, NodeValue::Heading(h) if h.level == 1))
            .map(|node| node.collect_text().trim().to_owned())
            .filter(|s| !s.is_empty())
    };
    let Some(first) = root.first_child() else {
        return (None, None);
    };
    let ast = first.data();
    let NodeValue::FrontMatter(metadata) = &ast.value else {
        return (heading(), None);
    };
    if metadata.len() > 16 * 1024 {
        return (heading(), None);
    }
    let field = |key: &str| -> Option<String> {
        let mut rows = metadata
            .lines()
            .filter(|line| !line.trim().is_empty())
            .peekable();
        let mut result = None;
        while let Some(line) = rows.next() {
            let Some((name, value)) = line.split_once(':') else {
                continue;
            };
            if name != key {
                continue;
            }
            if result.is_some()
                || !value.starts_with(' ')
                || rows
                    .peek()
                    .is_some_and(|next| next.starts_with([' ', '\t']))
            {
                return None;
            }
            let value = value.trim();
            let simple = if let Some(inner) =
                value.strip_prefix('"').and_then(|s| s.strip_suffix('"'))
            {
                if inner.contains(['"', '\\']) {
                    return None;
                }
                inner
            } else if let Some(inner) = value.strip_prefix('\'').and_then(|s| s.strip_suffix('\''))
            {
                if inner.contains('\'') {
                    return None;
                }
                inner
            } else {
                if value.starts_with([
                    '!', '&', '*', '[', '{', '|', '>', '\'', '"', '#', '%', '@', '`',
                ]) || value.contains(" #")
                    || value.contains(": ")
                {
                    return None;
                }
                value
            };
            if simple.is_empty() || simple.len() > 512 || simple.chars().any(char::is_control) {
                return None;
            }
            result = Some(simple.to_owned());
        }
        result
    };
    let language = field("lang").filter(|tag| {
        let mut parts = tag.split('-');
        let first = parts.next().unwrap_or_default();
        (2..=8).contains(&first.len())
            && first.bytes().all(|c| c.is_ascii_alphabetic())
            && tag.len() <= 63
            && parts
                .all(|p| (1..=8).contains(&p.len()) && p.bytes().all(|c| c.is_ascii_alphanumeric()))
    });
    (field("title").or_else(heading), language)
}

/// One Mermaid diagram as the webview drew it: an SVG image for a source text.
#[derive(serde::Deserialize)]
pub struct Diagram {
    source: String,
    src: String,
    width: u32,
    height: u32,
}

const DIAGRAM_BYTES: usize = 2 * 1024 * 1024;
const DIAGRAM_ENTRIES: usize = 64;
const DIAGRAM_MARKUP: &str = "<pre><code class=\"language-mermaid\">";

/// Images of Mermaid diagrams, keyed by their source text. The diagram engine
/// is JavaScript, so the webview draws them and export looks them up here. The
/// same source always yields the same image, so windows can share the store.
/// An SVG shown through `img` cannot run script or load other resources.
#[derive(Default)]
pub struct DiagramStore {
    figures: std::collections::VecDeque<(String, String)>,
}

impl DiagramStore {
    fn insert(&mut self, diagram: Diagram) -> Result<(), String> {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let encoded = diagram
            .src
            .strip_prefix("data:image/svg+xml;base64,")
            .ok_or("A diagram must be an SVG image.")?;
        if encoded.len() > DIAGRAM_BYTES.div_ceil(3) * 4 {
            return Err("A diagram exceeds the 2 MiB export limit.".into());
        }
        let bytes = STANDARD
            .decode(encoded)
            .map_err(|_| "Invalid diagram image.")?;
        let svg = std::str::from_utf8(&bytes).map_err(|_| "Invalid diagram image.")?;
        let sized = |n: u32| (1..=20_000).contains(&n);
        if !svg.trim_start().starts_with("<svg") || !sized(diagram.width) || !sized(diagram.height)
        {
            return Err("Invalid diagram image.".into());
        }
        // Only validated base64 and two numbers reach this markup.
        let figure = format!(
            "<figure class=\"diagram\"><img class=\"diagram-image\" alt=\"Diagram\" \
             src=\"data:image/svg+xml;base64,{encoded}\" width=\"{}\" height=\"{}\"></figure>",
            diagram.width, diagram.height
        );
        self.figures.retain(|(source, _)| *source != diagram.source);
        while self.figures.len() >= DIAGRAM_ENTRIES {
            self.figures.pop_front();
        }
        self.figures.push_back((diagram.source, figure));
        Ok(())
    }
}

impl Renderer {
    /// Remember drawn diagrams for the exports that follow.
    pub fn store_diagrams(&self, diagrams: Vec<Diagram>) -> Result<(), String> {
        let mut store = self.diagrams.lock().map_err(|e| e.to_string())?;
        for diagram in diagrams.into_iter().take(DIAGRAM_ENTRIES) {
            store.insert(diagram)?;
        }
        Ok(())
    }
}

/// Replace each Mermaid code block whose diagram is known with its image. A
/// block without one stays as readable source.
fn embed_diagrams(renderer: &Renderer, mut body: String) -> String {
    if !body.contains(DIAGRAM_MARKUP) {
        return body;
    }
    let Ok(store) = renderer.diagrams.lock() else {
        return body;
    };
    for (source, figure) in &store.figures {
        // Render the block on its own to get exactly the markup it has in the
        // document. The fence is longer than any run of tildes inside it.
        let mut run = 0;
        let longest = source.chars().fold(0, |longest, c| {
            run = if c == '~' { run + 1 } else { 0 };
            longest.max(run)
        });
        let fence = "~".repeat(longest.max(2) + 1);
        let end = if source.ends_with('\n') { "" } else { "\n" };
        let block = renderer.render(
            &format!("{fence}mermaid\n{source}{end}{fence}\n"),
            Target::Export,
        );
        let block = block.trim_end();
        if block.starts_with(DIAGRAM_MARKUP) && block.ends_with("</code></pre>") {
            body = body.replace(block, figure);
        }
    }
    body
}

/// Build an offline HTML file with its checked raster assets embedded.
pub fn standalone_html(
    renderer: &Renderer,
    markdown: &str,
    fallback_title: &str,
    source: Option<&std::path::Path>,
) -> Result<(String, usize), String> {
    let rendered = renderer.render_document(markdown, Target::Export, source, false)?;
    let title = rendered.title.as_deref().unwrap_or(fallback_title);
    let lang = rendered.language.as_deref().unwrap_or("en");
    let body = embed_diagrams(renderer, rendered.html);

    let html = format!(
        "<!DOCTYPE html>\n<html lang=\"{lang}\">\n<head>\n<meta charset=\"utf-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\">\n\
         <meta name=\"generator\" content=\"Kladje\">\n<title>{title}</title>\n<style>\n\
         html {{ background: #fff; }}\n\
         body {{ margin: 0; }}\n\
         .markdown-body {{ max-width: 46rem; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }}\n\
         {DOCUMENT_CSS}\n{MATH_CSS}\n{syntax}\n</style>\n</head>\n<body>\n\
         <article class=\"markdown-body\">\n{body}</article>\n</body>\n</html>\n",
        title = escaped(title),
        syntax = renderer.syntax_css_light,
    );
    Ok((html, rendered.omitted))
}

pub fn export_document(
    renderer: &Renderer,
    path: &std::path::Path,
    markdown: &str,
    title: &str,
    source: Option<&std::path::Path>,
    expected: Option<&crate::storage::Version>,
) -> Result<crate::storage::Written, String> {
    let (html, omitted) = standalone_html(renderer, markdown, title, source)?;
    let mut result = write_html(path, &html, source, expected)?;
    if omitted > 0 {
        let message = format!("{omitted} image reference(s) omitted from the offline export. Check for remote, missing or oversized images.");
        result.warning = Some(match result.warning {
            Some(w) => format!("{w} {message}"),
            None => message,
        });
    }
    Ok(result)
}

pub fn write_html(
    path: &std::path::Path,
    html: &str,
    source: Option<&std::path::Path>,
    expected: Option<&crate::storage::Version>,
) -> Result<crate::storage::Written, String> {
    if html.len() as u64 > crate::fileio::MAX_FILE_BYTES {
        return Err("The exported HTML exceeds the 64 MiB file limit.".into());
    }
    let is_html = |p: &std::path::Path| {
        let ext = p.extension().unwrap_or_default().to_string_lossy();
        ext.eq_ignore_ascii_case("html") || ext.eq_ignore_ascii_case("htm")
    };
    if !is_html(path) {
        return Err("Choose an HTML output file.".into());
    }
    if let Ok(output) = path.canonicalize() {
        if source.and_then(|p| p.canonicalize().ok()).as_ref() == Some(&output) {
            return Err("Choose a different file. This destination is the open document.".into());
        }
        if !is_html(&output) {
            return Err(
                "The destination points to a different file format. Choose an HTML output file."
                    .into(),
            );
        }
        crate::fileio::read_text(path)?;
    }
    match crate::storage::replace(path, html.as_bytes(), expected) {
        Err(e) if e == crate::storage::COPY_REQUIRED => {
            let mut result = crate::storage::protected_copy(path, html.as_bytes())?;
            if result.confirmed {
                result.warning = Some(format!(
                    "This volume required a separate export. Saved to {}.",
                    result.version.target().display()
                ));
            }
            Ok(result)
        }
        result => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exported_images_survive_a_move_and_report_omissions() {
        use std::fs;
        let assets = tempfile::tempdir().unwrap();
        let moved = tempfile::tempdir().unwrap();
        let image = include_bytes!("../icons/32x32.png");
        fs::write(assets.path().join("a b.png"), image).unwrap();
        let source = assets.path().join("note.md");
        let md = "![Here](a%20b.png) ![Remote](https://example.org/x) ![Missing](absent.jpg) <img alt='Empty'>";
        fs::write(&source, md).unwrap();
        let out = assets.path().join("page.html");
        let result =
            export_document(&Renderer::new(), &out, md, "Note", Some(&source), None).unwrap();
        assert!(result.confirmed);
        assert!(result.warning.unwrap().starts_with("3 image reference"));
        let dest = moved.path().join("moved.html");
        fs::rename(out, &dest).unwrap();
        drop(assets);
        let html = fs::read_to_string(dest).unwrap();
        use base64::Engine;
        assert!(html.contains(&base64::engine::general_purpose::STANDARD.encode(image)));
        assert!(!html.contains("a%20b.png") && !html.contains("https://example.org"));
        assert!(html.contains("img-src data:") && html.contains("alt=\"Missing\""));
    }

    #[cfg(unix)]
    #[test]
    fn export_rejects_alias_of_open_document() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("note.md");
        let destination = dir.path().join("export.html");
        std::fs::write(&source, "source").unwrap();
        std::os::unix::fs::symlink(&source, &destination).unwrap();
        let baseline = crate::storage::version(&destination).unwrap();
        assert!(write_html(&destination, "output", Some(&source), baseline.as_ref()).is_err());
        assert_eq!(std::fs::read(&source).unwrap(), b"source");
        assert!(destination.is_symlink());
    }

    fn drawn(source: &str, svg: &str) -> Diagram {
        use base64::Engine;
        Diagram {
            source: source.into(),
            src: format!(
                "data:image/svg+xml;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(svg)
            ),
            width: 120,
            height: 80,
        }
    }

    #[test]
    fn known_diagrams_replace_their_code_blocks_and_others_stay_readable() {
        let r = Renderer::new();
        let flow = "graph TD\n  A[\"x < y & z\"] --> B\n";
        let tildes = "pie\n~~~~\n  \"a\" : 1\n";
        let md = format!(
            "Intro\n\n```mermaid\n{flow}```\n\n- item\n\n  ~~~~~~mermaid\n  pie\n  ~~~~\n    \"a\" : 1\n  ~~~~~~\n\n```mermaid\nsequenceDiagram\n```\n\n```text\n{flow}```\n"
        );
        assert_eq!(
            crate::markdown::diagram_sources(&md).unwrap(),
            [flow, tildes, "sequenceDiagram\n"]
        );
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 120 80\"></svg>";
        r.store_diagrams(vec![drawn(flow, svg), drawn(tildes, svg)])
            .unwrap();
        let (html, omitted) = standalone_html(&r, &md, "t", None).unwrap();
        assert_eq!(omitted, 0);
        assert_eq!(
            html.matches("<figure class=\"diagram\">").count(),
            2,
            "{html}"
        );
        assert_eq!(html.matches("src=\"data:image/svg+xml;base64,").count(), 2);
        assert!(html.contains("width=\"120\" height=\"80\""));
        // An undrawn diagram and an ordinary code block keep their text.
        assert!(html.contains("<code class=\"language-mermaid\">sequenceDiagram"));
        assert!(html.contains("<code class=\"language-text\">graph TD"));
        // A document cannot smuggle in an SVG image of its own.
        let own = standalone_html(
            &Renderer::new(),
            "![x](data:image/svg+xml;base64,PHN2Zy8+)\n\n<figure class=\"diagram\"><img src=\"data:image/svg+xml;base64,PHN2Zy8+\"></figure>\n",
            "t",
            None,
        )
        .unwrap();
        assert!(!own.0.contains("image/svg+xml"), "{}", own.0);
        assert_eq!(own.1, 2);
    }

    #[test]
    fn the_diagram_store_accepts_only_bounded_svg_images() {
        let r = Renderer::new();
        let svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>";
        let mut png = drawn("a", svg);
        png.src = "data:image/png;base64,iVBORw0KGgo=".into();
        let html = drawn("a", "<html><script>1</script></html>");
        let mut sized = drawn("a", svg);
        sized.width = 0;
        let mut broken = drawn("a", svg);
        broken.src.push('"');
        let large = drawn("a", &format!("<svg>{}</svg>", "x".repeat(DIAGRAM_BYTES)));
        for bad in [png, html, sized, broken, large] {
            assert!(r.store_diagrams(vec![bad]).is_err());
        }
        assert!(r.diagrams.lock().unwrap().figures.is_empty());
        // The newest sixty-four sources are kept and a source is stored once.
        for n in 0..70 {
            r.store_diagrams(vec![drawn(&format!("pie\n\"{n}\" : 1\n"), svg)])
                .unwrap();
        }
        r.store_diagrams(vec![drawn("pie\n\"69\" : 1\n", svg)])
            .unwrap();
        let store = r.diagrams.lock().unwrap();
        assert_eq!(store.figures.len(), DIAGRAM_ENTRIES);
        assert_eq!(store.figures.back().unwrap().0, "pie\n\"69\" : 1\n");
        assert!(store
            .figures
            .iter()
            .all(|(source, _)| source != "pie\n\"5\" : 1\n"));
    }

    #[test]
    fn export_is_a_complete_document() {
        let r = Renderer::new();
        let html = standalone_html(
            &r,
            "# My Doc & Co\n\n```rust\nlet a = 1;\n```\n",
            "untitled",
            None,
        )
        .unwrap()
        .0;
        assert!(html.starts_with("<!DOCTYPE html>"));
        assert!(html.contains("<title>My Doc &amp; Co</title>"));
        assert!(html.contains(".markdown-body"));
        assert!(html.contains(".hl-"));
        assert!(!html.contains("data-sourcepos"));
        assert!(html.trim_end().ends_with("</html>"));

        let html = standalone_html(&r, "no heading", "notes", None).unwrap().0;
        assert!(html.contains("<title>notes</title>"));
    }
}
