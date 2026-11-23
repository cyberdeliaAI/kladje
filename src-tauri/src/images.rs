//! Raster resources are read relative to the document, never via a webview file protocol.
use base64::{engine::general_purpose::STANDARD, Engine};
use percent_encoding::percent_decode_str;
use std::fs::File;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};

const IMAGE_LIMIT: usize = 4 * 1024 * 1024;
pub const DOCUMENT_IMAGE_LIMIT: usize = 12 * 1024 * 1024;

fn raster_type(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        Some("image/png")
    } else if bytes.starts_with(&[0xff, 0xd8, 0xff]) {
        Some("image/jpeg")
    } else if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        Some("image/gif")
    } else if bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP") {
        Some("image/webp")
    } else {
        None
    }
}

fn read_raster(file: File, limit: usize) -> io::Result<Vec<u8>> {
    let meta = file.metadata()?;
    if !meta.is_file() || meta.len() > limit as u64 {
        return Err(io::Error::other(
            "Image exceeds the size limit or is not a regular file.",
        ));
    }
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    if bytes.len() > limit || raster_type(&bytes).is_none() {
        return Err(io::Error::other(
            "Choose a PNG, JPEG, GIF or WebP image within 4 MiB.",
        ));
    }
    Ok(bytes)
}

fn relative(src: &str) -> Option<PathBuf> {
    let raw = src.split(['?', '#']).next()?;
    let decoded = percent_decode_str(raw).decode_utf8().ok()?;
    if decoded.is_empty()
        || decoded.starts_with('/')
        || decoded.contains(['\\', ':'])
        || decoded.chars().any(char::is_control)
    {
        return None;
    }
    let p = Path::new(decoded.as_ref());
    if p.components()
        .any(|c| !matches!(c, Component::CurDir | Component::Normal(_)))
    {
        return None;
    }
    Some(p.to_path_buf())
}

// Pin each directory while opening the next component. A symlink in a supplied
// image path cannot redirect a read outside the document folder.
#[cfg(unix)]
fn open_relative(root: &Path, relative: &Path) -> io::Result<File> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    let mut current = File::open(root)?;
    for part in relative.components() {
        let Component::Normal(name) = part else {
            continue;
        };
        let name = CString::new(name.as_bytes())?;
        let fd = unsafe {
            libc::openat(
                current.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_NONBLOCK | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        current = unsafe { File::from_raw_fd(fd) };
    }
    Ok(current)
}

#[cfg(windows)]
fn open_relative(root: &Path, relative: &Path) -> io::Result<File> {
    use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
    let root = root.canonicalize()?;
    use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_ATTRIBUTE_REPARSE_POINT, FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT,
        FILE_SHARE_READ, FILE_SHARE_WRITE,
    };
    let mut path = root.clone();
    let mut held = Vec::new();
    for part in relative.components() {
        let Component::Normal(name) = part else {
            continue;
        };
        path.push(name);
        let handle = File::options()
            .read(true)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(&path)?;
        if handle.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        held.push(handle);
    }
    let file = held.pop().ok_or(io::ErrorKind::InvalidInput)?;
    let mut buffer = vec![0u16; 32768];
    let n = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle().cast(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    } as usize;
    if n == 0 || n >= buffer.len() {
        return Err(io::Error::last_os_error());
    }
    let final_path = PathBuf::from(std::ffi::OsString::from_wide(&buffer[..n]));
    if !final_path.starts_with(root) {
        return Err(io::ErrorKind::PermissionDenied.into());
    }
    Ok(file)
}

pub fn source_url(
    src: &str,
    document: Option<&Path>,
    remote: bool,
    remaining: &mut usize,
) -> Option<String> {
    if let Ok(url) = url::Url::parse(src) {
        if remote
            && url.scheme() == "https"
            && url.host().is_some()
            && url.username().is_empty()
            && url.password().is_none()
        {
            return Some(url.into());
        }
    }
    let limit = IMAGE_LIMIT.min(*remaining);
    let bytes = if let Some(data) = src.strip_prefix("data:image/") {
        let (mime, encoded) = data.split_once(";base64,")?;
        if encoded.len() > limit.div_ceil(3) * 4 {
            return None;
        }
        let bytes = STANDARD.decode(encoded).ok()?;
        if bytes.len() > limit || raster_type(&bytes)?.strip_prefix("image/")? != mime {
            return None;
        }
        bytes
    } else {
        let path = relative(src)?;
        read_raster(open_relative(document?.parent()?, &path).ok()?, limit).ok()?
    };
    *remaining = remaining.checked_sub(bytes.len())?;
    Some(format!(
        "data:{};base64,{}",
        raster_type(&bytes)?,
        STANDARD.encode(bytes)
    ))
}

/// Return a portable relative path. Copying an explicitly selected outside
/// file requires separate consent and never replaces an existing sibling.
pub fn insert_path(document: &Path, image: &Path, copy: bool) -> Result<Option<String>, String> {
    let root = document
        .parent()
        .ok_or("Save the document first.")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let selected = image.canonicalize().map_err(|e| e.to_string())?;
    let mut open = File::options();
    open.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        open.custom_flags(libc::O_NONBLOCK | libc::O_NOFOLLOW);
    }
    let file = open.open(&selected).map_err(|e| e.to_string())?;
    let bytes = read_raster(file, IMAGE_LIMIT).map_err(|e| e.to_string())?;
    if let Ok(path) = selected.strip_prefix(&root) {
        let name = path
            .to_str()
            .ok_or("The filename is not Unicode.")?
            .replace(std::path::MAIN_SEPARATOR, "/");
        if !name.contains([':', '\\']) && !name.chars().any(char::is_control) {
            return Ok(Some(name));
        }
    }
    if !copy {
        return Ok(None);
    }
    let ext = raster_type(&bytes).unwrap().strip_prefix("image/").unwrap();
    let mut tmp = tempfile::Builder::new()
        .prefix(".kladje-stage-")
        .tempfile_in(&root)
        .map_err(|e| e.to_string())?;
    tmp.write_all(&bytes)
        .and_then(|_| tmp.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    for n in 1..=10000 {
        let name = format!("image-{n}.{ext}");
        match tmp.persist_noclobber(root.join(&name)) {
            Ok(_) => {
                crate::storage::sync_directory(&root).map_err(|e| e.to_string())?;
                return Ok(Some(name));
            }
            Err(e) if e.error.kind() == io::ErrorKind::AlreadyExists => tmp = e.file,
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("No free image filename.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn raster_policy_and_budget() {
        let temp = tempfile::tempdir().unwrap();
        let doc = temp.path().join("note.md");
        fs::write(temp.path().join("a b.png"), b"\x89PNG\r\n\x1a\n").unwrap();
        let mut budget = 8;
        assert!(source_url("a%20b.png", Some(&doc), false, &mut budget)
            .unwrap()
            .starts_with("data:image/png;"));
        assert!(source_url("a%20b.png", Some(&doc), false, &mut budget).is_none());
        for denied in [
            "../a.png",
            "%2e%2e/a.png",
            "//example.org/a",
            "https://example.org/a",
            "data:image/svg+xml;base64,AAAA",
        ] {
            assert!(source_url(denied, Some(&doc), false, &mut budget).is_none());
        }
        assert!(source_url("https://example.org/a", None, true, &mut budget).is_some());
    }
    #[cfg(unix)]
    #[test]
    fn linked_directory_and_copy_collisions() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        std::os::unix::fs::symlink(outside.path(), root.path().join("alias")).unwrap();
        let img = outside.path().join("file.png");
        fs::write(&img, b"\x89PNG\r\n\x1a\n").unwrap();
        let doc = root.path().join("note.md");
        let mut budget = 1024;
        assert!(source_url("alias/file.png", Some(&doc), false, &mut budget).is_none());
        assert_eq!(insert_path(&doc, &img, false).unwrap(), None);
        fs::write(root.path().join("image-1.png"), b"original").unwrap();
        assert_eq!(
            insert_path(&doc, &img, true).unwrap().as_deref(),
            Some("image-2.png")
        );
        assert_eq!(
            fs::read(root.path().join("image-1.png")).unwrap(),
            b"original"
        );
    }
}
