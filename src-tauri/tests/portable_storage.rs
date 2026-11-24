use kladje::{fileio, storage};
use std::fs;
use std::path::Path;

// Run through scripts/test-exfat.sh, which creates and verifies a real exFAT mount.
#[test]
#[ignore = "requires the disposable mounted exFAT fixture"]
fn documents_on_exfat() {
    let mount = std::env::var_os("KLADJE_EXFAT_FIXTURE").unwrap();
    let dir = tempfile::tempdir_in(&mount).unwrap();
    let source = dir.path().join("draft.md");
    fs::write(&source, b"\xef\xbb\xbforiginal\r\n").unwrap();
    let mut baseline = storage::version(&source).unwrap().unwrap();
    let format = fileio::read_text(&source).unwrap().format;

    // Without an atomic exchange the document itself is replaced, save after save.
    for text in ["new\n", "newer\n"] {
        let result = fileio::write_document(&source, text, &format, Some(&baseline)).unwrap();
        assert!(result.confirmed && result.basic, "{:?}", result.warning);
        assert_eq!(result.version.target(), storage::target(&source).unwrap());
        assert_eq!(
            fs::read(&source).unwrap(),
            format!("\u{feff}{}", text.replace('\n', "\r\n")).as_bytes()
        );
        assert_eq!(storage::version(&source).unwrap().unwrap(), result.version);
        baseline = result.version;
    }

    // A stale baseline is still refused and the other writer's bytes remain.
    fs::write(&source, b"external").unwrap();
    assert!(fileio::write_document(&source, "mine\n", &format, Some(&baseline)).is_err());
    assert_eq!(fs::read(&source).unwrap(), b"external");

    // A new name is published once and never replaced without a baseline.
    let fresh = dir.path().join("new.md");
    let result = fileio::write_document(&fresh, "new\n", &format, None).unwrap();
    assert!(result.confirmed && result.basic, "{:?}", result.warning);
    assert_eq!(fs::read(&fresh).unwrap(), b"\xef\xbb\xbfnew\r\n");
    assert!(fileio::write_document(&fresh, "again\n", &format, None).is_err());
    assert_eq!(fs::read(&fresh).unwrap(), b"\xef\xbb\xbfnew\r\n");

    let html = dir.path().join("draft.html");
    let result = kladje::export::write_html(&html, "<p>offline</p>", Some(&source), None).unwrap();
    assert!(result.confirmed && result.warning.is_none());
    assert_eq!(fs::read_to_string(&html).unwrap(), "<p>offline</p>");

    // Pasted and copied images keep their ordinary numbered names.
    for n in 1..=2 {
        let image = kladje::images::paste(&source, "R0lGODlh").unwrap();
        assert_eq!(image, format!("assets/screenshot-{n}.gif"));
        assert_eq!(fs::read(dir.path().join(image)).unwrap(), b"GIF89a");
    }
    let elsewhere = tempfile::tempdir_in(&mount).unwrap();
    let outside = elsewhere.path().join("picture.gif");
    fs::write(&outside, b"GIF89a").unwrap();
    let copied = kladje::images::insert_path(&source, &outside, true).unwrap();
    assert_eq!(copied.as_deref(), Some("image-1.gif"));
    assert_eq!(fs::read(dir.path().join("image-1.gif")).unwrap(), b"GIF89a");

    let names = |folder: &Path| {
        let mut names: Vec<_> = fs::read_dir(folder)
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    };
    assert_eq!(
        names(dir.path()),
        ["assets", "draft.html", "draft.md", "image-1.gif", "new.md"]
    );
    assert_eq!(
        names(&dir.path().join("assets")),
        ["screenshot-1.gif", "screenshot-2.gif"]
    );

    // The dedicated disk image is 64 MiB before filesystem overhead. A full
    // 64 MiB write deterministically runs out of space during staging.
    let before = names(dir.path());
    let baseline = storage::version(&source).unwrap();
    let full = vec![0x5a; 64 * 1024 * 1024];
    let error = storage::replace(&source, &full, baseline.as_ref())
        .err()
        .unwrap();
    assert!(
        error.contains("os error 28"),
        "expected ENOSPC, received {error}"
    );
    let error = storage::protected_copy(&source, &full).err().unwrap();
    assert!(
        error.contains("os error 28"),
        "expected ENOSPC, received {error}"
    );
    assert_eq!(names(dir.path()), before, "a partial file was left behind");
    assert_eq!(fs::read(source).unwrap(), b"external");
}

#[test]
fn protected_copies_preserve_existing_names_versions_and_encoded_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let original = dir.path().join("note.md");
    fs::write(&original, b"external").unwrap();
    let make_copy = |data| {
        let r = storage::protected_copy(&original, data).unwrap();
        assert!(r.confirmed);
        assert_eq!(
            storage::version(r.version.target()).unwrap().unwrap(),
            r.version
        );
        r.version.target().to_owned()
    };
    let a = make_copy(b"a");
    let b = make_copy(b"b");
    assert_ne!(a, b);
    assert_eq!(fs::read(a).unwrap(), b"a");
    assert_eq!(fs::read(b).unwrap(), b"b");
    assert_eq!(fs::read(original).unwrap(), b"external");
    assert!(storage::protected_copy(Path::new("/"), b"invalid").is_err());
}
