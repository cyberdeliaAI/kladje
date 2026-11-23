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
    let first = r.preview_update(md, Some(&source), false, vec![]).unwrap();
    let key = first.assets.keys().next().unwrap().clone();
    assert!(first.html.contains(&key));
    let next = r
        .preview_update(md, Some(&source), false, vec![key.clone()])
        .unwrap();
    assert!(next.assets.is_empty());
    assert!(next.html.contains(&key));
    let exported = r
        .render_document(md, Target::Export, Some(&source), false)
        .unwrap();
    assert!(exported.html.contains(&first.assets[&key]));
    fs::write(&img, b"GIF89a456").unwrap();
    assert_eq!(
        r.preview_update(md, Some(&source), false, vec![key.clone()])
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
        .preview_update(md, Some(&source), false, vec![key.clone()])
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
    let first = r.preview_update(md, Some(&source), false, vec![]).unwrap();
    let warm = r
        .preview_update(
            &format!("{md}\n\nEdited."),
            Some(&source),
            false,
            first.assets.into_keys().collect(),
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
    let md = "🌱 notes\n\n> - [X] first\n> - [ ] second\n\n```\n- [x] code\n```";
    let preview = r.preview_update(md, None, false, vec![]).unwrap();
    let source: Vec<_> = md.encode_utf16().collect();
    assert_eq!(preview.tasks.len(), 2);
    for (pos, task) in preview.tasks {
        assert!(preview.html.contains(&format!("data-sourcepos=\"{pos}\"")));
        assert_eq!(
            source[task.offset],
            if task.checked { b'X' } else { b' ' } as u16
        );
    }
    assert!(r
        .preview_update(&format!("{md}\n\n<input>"), None, false, vec![])
        .unwrap()
        .tasks
        .is_empty());
    assert!(r
        .render_document(md, Target::Export, None, false)
        .unwrap()
        .tasks
        .is_empty());
}
