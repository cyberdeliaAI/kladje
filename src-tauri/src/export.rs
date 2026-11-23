//! Export to a standalone HTML file.

use crate::markdown::{escaped, Renderer, Target};

const DOCUMENT_CSS: &str = include_str!("../../ui/preview.css");
const MATH_CSS: &str = include_str!("../../ui/vendor/mathml.css");

/// Build an offline HTML file with its checked raster assets embedded.
pub fn standalone_html(
    renderer: &Renderer,
    markdown: &str,
    fallback_title: &str,
    source: Option<&std::path::Path>,
) -> Result<(String, usize), String> {
    let title = renderer
        .title_of(markdown)
        .unwrap_or_else(|| fallback_title.to_string());
    let rendered = renderer.render_document(markdown, Target::Export, source, false)?;
    let body = rendered.html;

    let html = format!(
        "<!DOCTYPE html>\n<html lang=\"en\">\n<head>\n<meta charset=\"utf-8\">\n\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">\n\
         <meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'\">\n\
         <meta name=\"generator\" content=\"Kladje\">\n<title>{title}</title>\n<style>\n\
         html {{ background: #fff; }}\n\
         body {{ margin: 0; }}\n\
         .markdown-body {{ max-width: 46rem; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }}\n\
         {DOCUMENT_CSS}\n{MATH_CSS}\n{syntax}\n</style>\n</head>\n<body>\n\
         <article class=\"markdown-body\">\n{body}</article>\n</body>\n</html>\n",
        title = escaped(&title),
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
