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
    read_raster_ref(&file, limit)
}

fn read_raster_ref(file: &File, limit: usize) -> io::Result<Vec<u8>> {
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

/// Inspect a local link without loading its contents or following a symlink.
/// None covers paths outside the document and targets we lack permission to inspect.
pub(crate) fn link_exists(root: &Path, url: &str) -> Option<bool> {
    let path = relative(url)?;
    let result = link_metadata(root, &path);
    match result {
        Ok(ordinary) => ordinary.then_some(true),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::NotADirectory
            ) =>
        {
            Some(false)
        }
        Err(_) => None,
    }
}

#[cfg(unix)]
fn link_metadata(root: &Path, path: &Path) -> io::Result<bool> {
    use std::ffi::CString;
    use std::os::fd::AsRawFd;
    use std::os::unix::ffi::OsStrExt;
    let parent = open_relative(root, path.parent().ok_or(io::ErrorKind::InvalidInput)?)?;
    let name = CString::new(
        path.file_name()
            .ok_or(io::ErrorKind::InvalidInput)?
            .as_bytes(),
    )?;
    let mut stat = std::mem::MaybeUninit::uninit();
    // The directory is held open while the leaf's metadata is inspected.
    if unsafe {
        libc::fstatat(
            parent.as_raw_fd(),
            name.as_ptr(),
            stat.as_mut_ptr(),
            libc::AT_SYMLINK_NOFOLLOW,
        )
    } != 0
    {
        return Err(io::Error::last_os_error());
    }
    let kind = unsafe { stat.assume_init() }.st_mode & libc::S_IFMT;
    Ok(kind == libc::S_IFREG || kind == libc::S_IFDIR)
}

#[cfg(windows)]
fn link_metadata(root: &Path, path: &Path) -> io::Result<bool> {
    let meta = open_relative(root, path)?.metadata()?;
    Ok(meta.is_file() || meta.is_dir())
}

/// Cached payloads contain only bytes from a currently accessible, confined
/// raster file. Export always performs its own fresh read.
pub(crate) struct PreviewRaster {
    pub token: String,
    pub uri: String,
    pub size: usize,
}

#[derive(Default)]
pub(crate) struct RasterCache {
    #[cfg(unix)]
    entries: std::collections::VecDeque<(PathBuf, FileStamp, std::sync::Arc<PreviewRaster>)>,
}

#[cfg(unix)]
#[derive(PartialEq)]
struct FileStamp(u64, u64, u64, i64, i64, i64, i64);
#[cfg(unix)]
fn file_stamp(m: &std::fs::Metadata) -> FileStamp {
    use std::os::unix::fs::MetadataExt;
    FileStamp(
        m.dev(),
        m.ino(),
        m.len(),
        m.mtime(),
        m.mtime_nsec(),
        m.ctime(),
        m.ctime_nsec(),
    )
}

impl RasterCache {
    pub fn local(
        &mut self,
        src: &str,
        document: &Path,
        remaining: &mut usize,
    ) -> Option<std::sync::Arc<PreviewRaster>> {
        use sha2::{Digest, Sha256};
        let rel = relative(src)?;
        let root = document.parent()?;
        let file = open_relative(root, &rel).ok()?;
        let meta = file.metadata().ok()?;
        let limit = IMAGE_LIMIT.min(*remaining);
        if !meta.is_file() || meta.len() > limit as u64 {
            return None;
        }
        #[cfg(unix)]
        let (path, stamp) = (root.join(rel), file_stamp(&meta));
        #[cfg(unix)]
        if let Some(index) = self.entries.iter().position(|(p, _, _)| *p == path) {
            let entry = self.entries.remove(index)?;
            if entry.1 == stamp {
                *remaining -= entry.2.size;
                let hit = entry.2.clone();
                self.entries.push_back(entry);
                return Some(hit);
            }
        }
        let bytes = read_raster_ref(&file, limit).ok()?;
        let asset = std::sync::Arc::new(PreviewRaster {
            token: format!("data:,kladje-{:x}", Sha256::digest(&bytes)),
            uri: format!(
                "data:{};base64,{}",
                raster_type(&bytes)?,
                STANDARD.encode(&bytes)
            ),
            size: bytes.len(),
        });
        #[cfg(unix)]
        if stamp.6 != 0 && file_stamp(&file.metadata().ok()?) == stamp {
            while self.entries.len() >= 128
                || self.entries.iter().map(|e| e.2.size).sum::<usize>() + asset.size
                    > DOCUMENT_IMAGE_LIMIT
            {
                self.entries.pop_front()?;
            }
            self.entries.push_back((path, stamp, asset.clone()));
        }
        *remaining -= asset.size;
        Some(asset)
    }
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
    let ext = raster_type(&bytes).unwrap().trim_start_matches("image/");
    let tmp = stage(&root, &bytes)?;
    publish(tmp, &root, "image", ext, &bytes).map(Some)
}

fn stage(folder: &Path, bytes: &[u8]) -> Result<tempfile::NamedTempFile, String> {
    let mut tmp = tempfile::Builder::new()
        .prefix(".kladje-stage-")
        .tempfile_in(folder)
        .map_err(|e| e.to_string())?;
    tmp.write_all(bytes)
        .and_then(|_| tmp.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    Ok(tmp)
}

fn publish(
    mut tmp: tempfile::NamedTempFile,
    folder: &Path,
    prefix: &str,
    ext: &str,
    bytes: &[u8],
) -> Result<String, String> {
    for n in 1..=10000 {
        let name = format!("{prefix}-{n}.{ext}");
        match tmp.persist_noclobber(folder.join(&name)) {
            Ok(_) => {
                crate::storage::sync_directory(folder).map_err(|e| e.to_string())?;
                return Ok(name);
            }
            Err(e) if e.error.kind() == io::ErrorKind::AlreadyExists => tmp = e.file,
            Err(e) if crate::storage::unsupported(&e.error) => {
                // No exclusive rename here. Claim the numbered name, then install.
                let dest = folder.join(&name);
                match crate::storage::claim(e.file.path(), &dest) {
                    Ok(()) => {
                        crate::storage::sync_directory(folder).map_err(|e| e.to_string())?;
                        if std::fs::read(&dest).ok().as_deref() != Some(bytes) {
                            return Err("Could not confirm the copied image.".into());
                        }
                        return Ok(name);
                    }
                    Err(error) if error.kind() == io::ErrorKind::AlreadyExists => tmp = e.file,
                    Err(error) => return Err(error.to_string()),
                }
            }
            Err(e) => return Err(e.to_string()),
        }
    }
    Err("No free image filename.".into())
}

/// Accept only a bounded raster. The webview supplies neither a destination filename
/// nor a directory name. Opening the asset directory must never follow a link.
pub fn paste(document: &Path, encoded: &str) -> Result<String, String> {
    if encoded.len() > IMAGE_LIMIT.div_ceil(3) * 4 {
        return Err("Clipboard image exceeds 4 MiB.".into());
    }
    let bytes = STANDARD
        .decode(encoded)
        .map_err(|_| "Invalid clipboard image.")?;
    let mime = raster_type(&bytes)
        .filter(|_| bytes.len() <= IMAGE_LIMIT)
        .ok_or("Paste a PNG, JPEG, GIF or WebP of up to 4 MiB.")?;
    crate::fileio::markdown_path(document)?;
    if !document.is_file() {
        return Err("Save the document before pasting an image.".into());
    }
    let root = document
        .parent()
        .ok_or("No document folder.")?
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let name = paste_in_assets(&root, &bytes, mime.trim_start_matches("image/"))?;
    Ok(format!("assets/{name}"))
}

#[cfg(unix)]
fn paste_in_assets(root: &Path, bytes: &[u8], ext: &str) -> Result<String, String> {
    use std::ffi::CString;
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;
    let dir = File::open(root).map_err(|e| e.to_string())?;
    let root_fd = dir.as_raw_fd();
    if unsafe { libc::mkdirat(root_fd, c"assets".as_ptr(), 0o755) } != 0 {
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::AlreadyExists {
            return Err(error.to_string());
        }
    }
    let fd = unsafe {
        libc::openat(
            root_fd,
            c"assets".as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err(format!(
            "Cannot open the document's assets folder: {}",
            io::Error::last_os_error()
        ));
    }
    let assets = unsafe { File::from_raw_fd(fd) };
    let tmp = stage(root, bytes)?;
    let staged =
        CString::new(tmp.path().file_name().unwrap().as_bytes()).map_err(|e| e.to_string())?;
    for n in 1..=10000 {
        let name = format!("screenshot-{n}.{ext}");
        let target = CString::new(name.as_bytes()).unwrap();
        // Publish all bytes together. linkat refuses existing names and resolves
        // against the held directory even if somebody replaces the assets path.
        if unsafe {
            libc::linkat(
                root_fd,
                staged.as_ptr(),
                assets.as_raw_fd(),
                target.as_ptr(),
                0,
            )
        } == 0
        {
            assets
                .sync_all()
                .and_then(|_| dir.sync_all())
                .map_err(|e| {
                    format!("Created assets/{name}, but could not confirm the directory write: {e}")
                })?;
            return Ok(name);
        }
        let error = io::Error::last_os_error();
        if crate::storage::unsupported(&error) {
            // No hard links here. Claim the numbered name inside the pinned assets
            // handle, which refuses an existing entry, then move the staged file over it.
            let claim = unsafe {
                libc::openat(
                    assets.as_raw_fd(),
                    target.as_ptr(),
                    libc::O_WRONLY
                        | libc::O_CREAT
                        | libc::O_EXCL
                        | libc::O_NOFOLLOW
                        | libc::O_CLOEXEC,
                    0o644,
                )
            };
            if claim < 0 {
                let error = io::Error::last_os_error();
                if error.kind() == io::ErrorKind::AlreadyExists {
                    continue;
                }
                return Err(format!(
                    "Could not publish the screenshot in assets: {error}"
                ));
            }
            drop(unsafe { File::from_raw_fd(claim) });
            if unsafe {
                libc::renameat(
                    root_fd,
                    staged.as_ptr(),
                    assets.as_raw_fd(),
                    target.as_ptr(),
                )
            } != 0
            {
                let error = io::Error::last_os_error();
                unsafe { libc::unlinkat(assets.as_raw_fd(), target.as_ptr(), 0) };
                return Err(format!(
                    "Could not publish the screenshot in assets: {error}"
                ));
            }
            // The staged name now belongs to the published image.
            tmp.into_temp_path().disable_cleanup(true);
            assets
                .sync_all()
                .and_then(|_| dir.sync_all())
                .map_err(|e| e.to_string())?;
            let installed = open_relative(root, &Path::new("assets").join(&name))
                .and_then(|f| read_raster(f, IMAGE_LIMIT))
                .map_err(|e| e.to_string())?;
            if installed != bytes {
                return Err("Could not confirm the pasted image.".into());
            }
            return Ok(name);
        }
        if error.kind() != io::ErrorKind::AlreadyExists {
            return Err(format!(
                "Could not publish the screenshot in assets: {error}"
            ));
        }
    }
    Err("No free screenshot filename.".into())
}

#[cfg(windows)]
fn paste_in_assets(root: &Path, bytes: &[u8], ext: &str) -> Result<String, String> {
    let folder = root.join("assets");
    match std::fs::create_dir(&folder) {
        Ok(()) => (),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => (),
        Err(e) => return Err(e.to_string()),
    }
    // open_relative rejects reparse points and denies delete sharing. Keep the
    // handle alive through publication so the directory cannot be replaced.
    let handle = open_relative(root, Path::new("assets")).map_err(|e| e.to_string())?;
    if !handle.metadata().map_err(|e| e.to_string())?.is_dir() {
        return Err("assets must be a directory.".into());
    }
    publish(stage(&folder, bytes)?, &folder, "screenshot", ext, bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    #[test]
    fn pasted_rasters_publish_complete_distinct_files_and_travel_with_document() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("notes");
        fs::create_dir(&root).unwrap();
        let doc = root.join("draft.md");
        fs::write(&doc, "draft").unwrap();
        let encoded = STANDARD.encode(b"GIF89a fixture");
        let first = paste(&doc, &encoded).unwrap();
        let second = paste(&doc, &encoded).unwrap();
        assert_eq!(first, "assets/screenshot-1.gif");
        assert_eq!(second, "assets/screenshot-2.gif");
        assert_eq!(fs::read(root.join(&first)).unwrap(), b"GIF89a fixture");
        let moved = tmp.path().join("moved");
        fs::rename(&root, &moved).unwrap();
        let mut remaining = DOCUMENT_IMAGE_LIMIT;
        assert_eq!(
            source_url(&first, Some(&moved.join("draft.md")), false, &mut remaining).unwrap(),
            format!("data:image/gif;base64,{encoded}")
        );
        assert_eq!(fs::read(moved.join("draft.md")).unwrap(), b"draft");
    }

    #[test]
    fn invalid_and_oversized_clipboard_images_create_no_assets() {
        let tmp = tempfile::tempdir().unwrap();
        let doc = tmp.path().join("draft.md");
        fs::write(&doc, "draft").unwrap();
        for invalid in [
            "!".to_owned(),
            STANDARD.encode(b"<svg/>"),
            "A".repeat(IMAGE_LIMIT.div_ceil(3) * 4 + 1),
        ] {
            assert!(paste(&doc, &invalid).is_err());
        }
        assert!(!tmp.path().join("assets").exists());
    }

    #[cfg(unix)]
    #[test]
    fn clipboard_folder_symlinks_are_refused_and_existing_names_survive() {
        use std::os::unix::fs::symlink;
        let tmp = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let doc = tmp.path().join("note.md");
        fs::write(&doc, "draft").unwrap();
        let assets = tmp.path().join("assets");
        symlink(outside.path(), &assets).unwrap();
        let encoded = STANDARD.encode(b"GIF89a fixture");
        assert!(paste(&doc, &encoded).is_err());
        assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
        fs::remove_file(&assets).unwrap();
        fs::create_dir(&assets).unwrap();
        let victim = outside.path().join("original");
        fs::write(&victim, "untouched").unwrap();
        symlink(&victim, assets.join("screenshot-1.gif")).unwrap();
        assert_eq!(paste(&doc, &encoded).unwrap(), "assets/screenshot-2.gif");
        assert_eq!(fs::read_to_string(victim).unwrap(), "untouched");
    }

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
