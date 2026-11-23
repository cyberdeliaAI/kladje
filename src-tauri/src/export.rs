//! Export to a standalone HTML file.

use crate::markdown::{escaped, Renderer, Target};

const DOCUMENT_CSS: &str = include_str!("../../ui/preview.css");
const MATH_CSS: &str = include_str!("../../ui/vendor/mathml.css");

/// A complete, self-contained HTML document: styles are embedded, nothing is
/// loaded from the network. Images keep the paths written in the Markdown.
pub fn standalone_html(renderer: &Renderer, markdown: &str, fallback_title: &str) -> String {
    let title = renderer
        .title_of(markdown)
        .unwrap_or_else(|| fallback_title.to_string());
    let body = renderer.render(markdown, Target::Export);

    format!(
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <meta name=\"generator\" content=\"Kladje\">\n<title>{title}</title>\n<style>\n\
         html {{ background: #fff; }}\n\
         body {{ margin: 0; }}\n\
         .markdown-body {{ max-width: 46rem; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }}\n\
         {DOCUMENT_CSS}\n{MATH_CSS}\n{syntax}\n</style>\n</head>\n<body>\n\
         <article class=\"markdown-body\">\n{body}</article>\n</body>\n</html>\n",
        title = escaped(&title),
        syntax = renderer.syntax_css_light,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn export_is_a_complete_document() {
        let r = Renderer::new();
        let html = standalone_html(&r, "# My Doc & Co\n\n```rust\nlet a = 1;\n```\n", "untitled");
        assert!(html.starts_with("<!DOCTYPE html>"));
        assert!(html.contains("<title>My Doc &amp; Co</title>"));
        assert!(html.contains(".markdown-body"));
        assert!(html.contains(".hl-"));
        assert!(!html.contains("data-sourcepos"));
        assert!(html.trim_end().ends_with("</html>"));

        let html = standalone_html(&r, "no heading", "notes");
        assert!(html.contains("<title>notes</title>"));
    }
}
