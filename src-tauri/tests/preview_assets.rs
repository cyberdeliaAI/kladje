use kladje::markdown::{Renderer, Target};
use std::fs;

#[test]
fn preview_reuses_only_currently_authorized_image_bytes_and_export_is_standalone() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("note.md");
    let img = dir.path().join("a.gif");
    fs::write(&img, b"GIF89a123").unwrap();
    let r = Renderer::new();
    let md = "![diagram](a.gif)";
    let first = r
        .preview_update(md, Some(&source), false, vec![], false)
        .unwrap();
    let key = first.assets.keys().next().unwrap().clone();
    assert!(first.html.contains(&key));
    let next = r
        .preview_update(md, Some(&source), false, vec![key.clone()], false)
        .unwrap();
    assert!(next.assets.is_empty());
    assert!(next.html.contains(&key));
    let exported = r
        .render_document(md, Target::Export, Some(&source), false)
        .unwrap();
    assert!(exported.html.contains(&first.assets[&key]));
    fs::write(&img, b"GIF89a456").unwrap();
    assert_eq!(
        r.preview_update(md, Some(&source), false, vec![key.clone()], false)
            .unwrap()
            .assets
            .len(),
        1
    );
    fs::remove_file(&img).unwrap();
    #[cfg(unix)]
    {
        let outside = tempfile::NamedTempFile::new().unwrap();
        std::os::unix::fs::symlink(outside.path(), &img).unwrap();
    }
    let denied = r
        .preview_update(md, Some(&source), false, vec![key.clone()], false)
        .unwrap();
    assert!(!denied.html.contains(&key));
    assert_eq!(denied.omitted, 1);
}

#[test]
fn warm_illustrated_edits_have_bounded_ipc_payloads() {
    let dir = tempfile::tempdir().unwrap();
    let source = dir.path().join("draft.md");
    let mut bytes = vec![0u8; 1024 * 1024];
    bytes[..6].copy_from_slice(b"GIF89a");
    fs::write(dir.path().join("chart.gif"), bytes).unwrap();
    let r = Renderer::new();
    let md = "# Chart\n\n![Chart](chart.gif)";
    let full = r
        .render_document(md, Target::Preview, Some(&source), false)
        .unwrap();
    let first = r
        .preview_update(md, Some(&source), false, vec![], false)
        .unwrap();
    let warm = r
        .preview_update(
            &format!("{md}\n\nEdited."),
            Some(&source),
            false,
            first.assets.into_keys().collect(),
            false,
        )
        .unwrap();
    let payload = serde_json::to_vec(&warm).unwrap().len();
    println!(
        "Embedded HTML {} bytes; edited preview response {} bytes",
        full.html.len(),
        payload
    );
    assert!(full.html.len() > 1_390_000 && payload < 1024);
}

#[test]
fn only_renderer_owned_list_markers_receive_edit_coordinates() {
    let r = Renderer::new();
    let md = "🌱 <kbd>notes</kbd>\n\n> - [X] first\n> - [ ] second\n\n```\n- [x] code\n```";
    let preview = r.preview_update(md, None, false, vec![], false).unwrap();
    let source: Vec<_> = md.encode_utf16().collect();
    assert_eq!(preview.tasks.len(), 2);
    for (pos, task) in preview.tasks {
        assert!(preview
            .html
            .contains(&format!("data-kladje-task=\"{pos}\"")));
        assert_eq!(
            source[task.offset],
            if task.checked { b'X' } else { b' ' } as u16
        );
    }
}

#[test]
fn html_and_table_controls_stay_read_only_beside_a_real_task() {
    let r = Renderer::new();
    let md = "- [ ] one\n\n<ul><li class=\"task-list-item\" data-sourcepos=\"1:1-1:9\"><input class=\"task-list-item-checkbox\" data-kladje-task=\"1:1-1:9\"></li></ul>\n\n| Status |\n| --- |\n| [x] |";
    let render = || r.preview_update(md, None, false, vec![], false).unwrap();
    let result = render();
    assert_eq!(result.tasks.len(), 1);
    assert_eq!(result.tasks["1:1-1:9"].offset, 3);
    assert_eq!(
        result.html.matches("data-kladje-task=\"1:1-1:9\"").count(),
        1
    );
    assert_eq!(result.html.matches("disabled=\"\"").count(), 3);
    assert_eq!(render().html, result.html, "unchanged blocks can be reused");

    let export = r.render_document(md, Target::Export, None, false).unwrap();
    assert!(export.tasks.is_empty());
    assert!(!export.html.contains("data-kladje-task"));
    assert_eq!(export.html.matches("disabled=\"\"").count(), 3);
}

#[test]
fn export_uses_bounded_frontmatter_fields_and_prints_explicit_page_breaks() {
    let renderer = Renderer::new();
    let doc =
        "---\ntitle: 'Café & More'\nlang: nl-BE\n---\n# fallback\n\n<!-- pagebreak -->\n\nLast";
    let export = |text: &str| {
        kladje::export::standalone_html(&renderer, text, "untitled", None, false)
            .unwrap()
            .0
    };
    let html = export(doc);
    assert!(html.contains("<title>Café &amp; More</title>"));
    assert!(html.contains("<html lang=\"nl-BE\">"));
    assert!(html.contains("<div class=\"page-break\""));
    assert!(!export("```\n<!-- pagebreak -->\n```").contains("<div class=\"page-break\""));
    for field in [
        "title: |\n  longer",
        "title: A\ntitle: B",
        "title: *alias",
        "title: A\n  continuation",
        "title: A\n\n  continuation",
    ] {
        let html = export(&format!("---\n{field}\nlang: 'en bad'\n---\n# Fallback"));
        assert!(html.contains("<title>Fallback</title>"), "{field}");
        assert!(html.contains("<html lang=\"en\">"));
    }
}
