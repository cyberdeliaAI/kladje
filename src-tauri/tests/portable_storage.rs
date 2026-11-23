use kladje::{fileio, storage};
use std::fs;
use std::path::Path;

// Run through scripts/test-exfat.sh, which creates and verifies a real exFAT mount.
#[test]
#[ignore = "requires the disposable mounted exFAT fixture"]
fn documents_on_exfat() {
    let mount = std::env::var_os("KLADJE_EXFAT_FIXTURE").unwrap();
    let dir = tempfile::tempdir_in(mount).unwrap();
    let source = dir.path().join("draft.md");
    let original = b"\xef\xbb\xbforiginal\r\n";
    fs::write(&source, original).unwrap();
    let expected = storage::version(&source).unwrap().unwrap();
    let format = fileio::read_text(&source).unwrap().format;
    let fresh = dir.path().join("new.md");
    for (path, baseline) in [(&source, Some(&expected)), (&fresh, None)] {
        let error = fileio::write_document(path, "new\n", &format, baseline)
            .err()
            .unwrap();
        assert_eq!(error, storage::COPY_REQUIRED);
        let result = fileio::copy_document(path, "new\n", &format).unwrap();
        assert!(result.confirmed, "{:?}", result.warning);
        assert_eq!(
            fs::read(result.version.target()).unwrap(),
            b"\xef\xbb\xbfnew\r\n"
        );
        assert_eq!(result.version.target().file_name(), path.file_name());
    }
    let html = dir.path().join("draft.html");
    let result = kladje::export::write_html(&html, "<p>offline</p>", Some(&source), None).unwrap();
    assert!(result.confirmed);
    assert_eq!(
        fs::read_to_string(result.version.target()).unwrap(),
        "<p>offline</p>"
    );
    let image = kladje::images::paste(&source, "R0lGODlh").unwrap();
    assert!(image.starts_with("assets/"));
    assert_eq!(fs::read(dir.path().join(image)).unwrap(), b"GIF89a");
    assert_eq!(fs::read(source).unwrap(), original);
    assert!(!fresh.exists());
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
