//! Stage and flush beside the resolved target. Existing files are exchanged so
//! even an uncooperative writer racing the final version check has a recoverable copy.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};

use crate::fileio::MAX_FILE_BYTES;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Version {
    target: PathBuf,
    identity: String,
    digest: String,
}

impl Version {
    pub fn target(&self) -> &Path {
        &self.target
    }
}

#[derive(Serialize)]
pub struct Written {
    pub version: Version,
    pub confirmed: bool,
    /// Keep the original document binding and offer a separate copy.
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub conflict: bool,
    pub warning: Option<String>,
    /// The volume has no atomic exchange. The file was replaced in place by
    /// moving the previous version aside first.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub basic: bool,
}

type Swapped = Result<tempfile::TempPath, (io::Error, tempfile::TempPath)>;

/// A marker used only for a missing publication primitive, never for permission,
/// conflict, quota or I/O failures.
pub const COPY_REQUIRED: &str = "KLADJE_COPY_REQUIRED";

pub(crate) fn unsupported(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::Unsupported || {
        #[cfg(unix)]
        {
            matches!(error.raw_os_error(), Some(libc::ENOTSUP | libc::ENOSYS))
        }
        #[cfg(not(unix))]
        {
            false
        }
    }
}

/// Publish a complete regular file as a new directory entry on a filesystem
/// lacking safe regular-file replacement. Renaming a nonempty directory cannot
/// overwrite a file, symlink, or another nonempty directory.
pub fn protected_copy(requested: &Path, bytes: &[u8]) -> Result<Written, String> {
    let name = requested
        .file_name()
        .ok_or("Choose a filename for the copy.")?;
    let parent = requested
        .parent()
        .ok_or("Choose a folder for the copy.")?
        .canonicalize()
        .map_err(|e| file_error("copy", requested, e))?;
    let (dir, file, folder_name) =
        stage_folder(&parent, name, bytes).map_err(|e| file_error("copy", requested, e))?;
    let folder = parent.join(folder_name);
    if folder
        .try_exists()
        .map_err(|e| file_error("copy", requested, e))?
    {
        return Err("Copy folder already exists. Try saving the copy again.".into());
    }
    let path = folder.join(name);
    let expected = stamp(
        &path,
        &file
            .metadata()
            .map_err(|e| file_error("copy", requested, e))?,
        bytes,
    );
    fs::rename(dir.path(), &folder).map_err(|e| file_error("copy", requested, e))?;
    // The staging directory no longer exists under its old name.
    let _ = dir.keep();
    let confirmed = sync_directory(&parent).is_ok()
        && version(&path).ok().flatten().as_ref() == Some(&expected);
    Ok(Written {
        basic: false,
        conflict: false,
        version: expected,
        confirmed,
        warning: (!confirmed).then(|| {
            format!(
                "Could not confirm the copy at {}. Keep your edits open.",
                path.display()
            )
        }),
    })
}

pub(crate) fn stage_folder(
    parent: &Path,
    name: &std::ffi::OsStr,
    bytes: &[u8],
) -> io::Result<(tempfile::TempDir, File, String)> {
    let dir = tempfile::Builder::new()
        .prefix(".kladje-copy-")
        .tempdir_in(parent)?;
    let mut file = File::create_new(dir.path().join(name))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    sync_directory(dir.path())?;
    let token = dir.path().file_name().unwrap().to_string_lossy();
    let folder = format!("Kladje Copy {}", token.trim_start_matches(".kladje-copy-"));
    Ok((dir, file, folder))
}

/// Publish a new name on a filesystem lacking an exclusive rename, such as
/// exFAT and FAT on macOS. The name is created exclusively and filled through
/// an append-only descriptor, and nothing is ever renamed onto it. Bytes that
/// another program writes to that name in the meantime are therefore never
/// overwritten or removed; they stay in place before or instead of Kladje's,
/// and the caller's read-back reports the difference. If filling the file
/// fails, the name is left as it is.
pub(crate) fn claim(staged: &Path, target: &Path) -> io::Result<()> {
    let bytes = fs::read(staged)?;
    let mut file = File::options().append(true).create_new(true).open(target)?;
    #[cfg(test)]
    conflicts::after_claim(target);
    // The check catches a writer that arrived first. Keep O_APPEND for a
    // writer arriving between this observation and write_all.
    let meta = file.metadata()?;
    if meta.len() != 0 {
        return Err(io::ErrorKind::AlreadyExists.into());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let named = fs::symlink_metadata(target)?;
        if (meta.dev(), meta.ino()) != (named.dev(), named.ino()) {
            return Err(io::ErrorKind::AlreadyExists.into());
        }
    }
    #[cfg(test)]
    conflicts::after_empty_check(target);
    file.write_all(&bytes)
        .and_then(|()| copy_attributes(staged, &file))
        .and_then(|()| file.sync_all())
        .map_err(|e| io::Error::other(format!("{e}. {} may be incomplete", target.display())))
}

/// Give `to` the permissions, ACL and extended attributes of `from`, never its data.
fn copy_attributes(from: &Path, to: &File) -> io::Result<()> {
    let source = File::open(from)?;
    let permissions = source.metadata()?.permissions();
    // FAT volumes report fixed permissions and may refuse to change them.
    if to.metadata()?.permissions() != permissions {
        to.set_permissions(permissions)?;
    }
    #[cfg(target_os = "macos")]
    {
        use std::os::fd::AsRawFd;
        // Both descriptors are live for this call.
        let rc = unsafe {
            libc::fcopyfile(
                source.as_raw_fd(),
                to.as_raw_fd(),
                std::ptr::null_mut(),
                libc::COPYFILE_ACL | libc::COPYFILE_XATTR,
            )
        };
        if rc != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    Ok(())
}

#[derive(PartialEq, Eq)]
enum Publication {
    Written,
    Occupied,
}

// The occupied name belongs to another writer. Do not roll back onto it.
fn publish_document(staged: &Path, target: &Path) -> io::Result<Publication> {
    match claim(staged, target) {
        Ok(()) => Ok(Publication::Written),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => Ok(Publication::Occupied),
        Err(e) => Err(e),
    }
}

/// Replace an existing file on a filesystem lacking an atomic exchange. Whatever
/// is at the target is moved aside first, so a competing writer's file is
/// captured and returned for validation, never overwritten. The new file is then
/// published with `claim`. The target name is absent for a moment, and the
/// previous and the staged file both stay on disk if the process stops in
/// between. When publishing fails, the previous file goes back the same way, so
/// a file another program put there meanwhile is never replaced either.
fn displace(staged: &Path, target: &Path) -> io::Result<(tempfile::TempPath, Publication)> {
    let parent = target.parent().unwrap_or(Path::new("."));
    let mut previous = tempfile::Builder::new()
        .prefix(".kladje-previous-")
        .tempfile_in(parent)?
        .into_temp_path();
    fs::rename(target, &previous)?;
    match publish_document(staged, target) {
        Ok(publication) => Ok((previous, publication)),
        Err(error) => {
            // Rollback is also a publication. A concurrent write after its
            // empty check must not retire the only intact previous copy.
            if claim(&previous, target).is_ok() {
                if let (Ok((_, before)), Ok((_, after))) = (read(&previous), read(target)) {
                    if before.digest == after.digest {
                        return Err(error);
                    }
                }
            }
            previous.disable_cleanup(true);
            Err(io::Error::other(format!(
                "{error}. The previous version was kept at {}",
                previous.display()
            )))
        }
    }
}

/// Resolve an existing file or the canonical parent and filename of a new file.
pub fn target(path: &Path) -> io::Result<PathBuf> {
    match fs::symlink_metadata(path) {
        Ok(_) => fs::canonicalize(path), // A dangling link is an error.
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            let parent = path
                .parent()
                .filter(|p| !p.as_os_str().is_empty())
                .unwrap_or(Path::new("."));
            let name = path.file_name().ok_or(io::ErrorKind::InvalidInput)?;
            Ok(fs::canonicalize(parent)?.join(name))
        }
        Err(e) => Err(e),
    }
}

fn identity(meta: &fs::Metadata) -> String {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        format!("{}-{}", meta.dev(), meta.ino())
    }
    #[cfg(not(unix))]
    {
        // ReplaceFileW can retain the destination creation time. Use the canonical
        // destination and byte digest as the portable Windows baseline.
        let _ = meta;
        String::new()
    }
}

fn stamp(target: &Path, meta: &fs::Metadata, bytes: &[u8]) -> Version {
    Version {
        target: target.into(),
        identity: identity(meta),
        digest: format!("{:x}", Sha256::digest(bytes)),
    }
}

pub(crate) fn document_name(path: &Path) -> String {
    path.file_name()
        .unwrap_or(path.as_os_str())
        .to_string_lossy()
        .into_owned()
}

// Keep recovery paths and detailed conflict warnings intact. Translate ordinary
// filesystem failures at the boundary where we still know the operation and file.
fn file_error(action: &str, path: &Path, error: io::Error) -> String {
    use io::ErrorKind::*;
    let reason = match error.kind() {
        NotFound => "The file or folder has moved or is unavailable. Check its location and try again.",
        PermissionDenied => "Access was denied. Check the file and folder permissions or choose another folder.",
        StorageFull | QuotaExceeded => "The disk is full or its storage quota was reached. Free some space or choose another disk.",
        ReadOnlyFilesystem => "The volume is read-only. Choose a writable folder.",
        AlreadyExists => "That name is already in use. Choose another name.",
        WouldBlock | ResourceBusy => "The file is busy. Try again after the other operation finishes.",
        _ => return format!("Could not {action} “{}”. {error}", document_name(path)),
    };
    format!("Could not {action} “{}”. {reason}", document_name(path))
}

pub fn read(path: &Path) -> Result<(Vec<u8>, Version), String> {
    read_bounded(path, MAX_FILE_BYTES)
}

pub(crate) fn read_bounded(path: &Path, limit: u64) -> Result<(Vec<u8>, Version), String> {
    let resolved = target(path).map_err(|e| file_error("read", path, e))?;
    let mut options = File::options();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let mut file = options
        .open(&resolved)
        .map_err(|e| file_error("read", path, e))?;
    let meta = file.metadata().map_err(|e| file_error("read", path, e))?;
    if !meta.is_file() || meta.len() > limit {
        return Err(format!(
            "{} is not a regular file within the {} KiB limit.",
            document_name(path),
            limit / 1024
        ));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| file_error("read", path, e))?;
    if bytes.len() as u64 > limit {
        return Err(format!("File exceeds the {} KiB limit.", limit / 1024));
    }
    let version = stamp(&resolved, &meta, &bytes);
    Ok((bytes, version))
}

/// An inexpensive wake-up hint. The content digest remains authoritative on
/// focus, before saving, and before accepting an external revision.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct DiskStamp {
    target: PathBuf,
    change: String,
}

pub fn disk_stamp(path: &Path) -> Result<Option<DiskStamp>, String> {
    let probe = || -> io::Result<DiskStamp> {
        let target = fs::canonicalize(path)?;
        let meta = fs::metadata(&target)?;
        #[cfg(unix)]
        let change = {
            use std::os::unix::fs::MetadataExt;
            format!(
                "{}:{}:{}:{}:{}:{}:{}",
                meta.dev(),
                meta.ino(),
                meta.len(),
                meta.mtime(),
                meta.mtime_nsec(),
                meta.ctime(),
                meta.ctime_nsec()
            )
        };
        #[cfg(windows)]
        let change = {
            use std::os::windows::fs::MetadataExt;
            format!(
                "{}:{}:{}",
                meta.file_size(),
                meta.creation_time(),
                meta.last_write_time()
            )
        };
        Ok(DiskStamp { target, change })
    };
    match probe() {
        Ok(stamp) => Ok(Some(stamp)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(file_error("check", path, e)),
    }
}

pub fn version(path: &Path) -> Result<Option<Version>, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => read(path).map(|(_, stamp)| Some(stamp)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(file_error("check", path, e)),
    }
}

pub fn replace(path: &Path, bytes: &[u8], expected: Option<&Version>) -> Result<Written, String> {
    replace_using(
        path,
        bytes,
        expected,
        |f, bytes| f.write_all(bytes),
        exchange,
        sync_directory,
    )
}

#[cfg(test)]
fn replace_with(
    path: &Path,
    bytes: &[u8],
    expected: Option<&Version>,
    write: impl FnOnce(&mut File, &[u8]) -> io::Result<()>,
) -> Result<Written, String> {
    replace_using(path, bytes, expected, write, exchange, sync_directory)
}

fn replace_using(
    path: &Path,
    bytes: &[u8],
    expected: Option<&Version>,
    write: impl FnOnce(&mut File, &[u8]) -> io::Result<()>,
    swap: impl FnOnce(tempfile::TempPath, &Path) -> Swapped,
    flush: impl FnOnce(&Path) -> io::Result<()>,
) -> Result<Written, String> {
    let result = (|| -> io::Result<Written> {
        let resolved = target(path)?;
        let parent = resolved.parent().ok_or(io::ErrorKind::InvalidInput)?;
        let mut staged = tempfile::Builder::new()
            .prefix(".kladje-stage-")
            .tempfile_in(parent)?;
        write(staged.as_file_mut(), bytes)?;
        let original = if expected.is_some() {
            let file = File::options().read(true).write(true).open(&resolved)?;
            let meta = file.metadata()?;
            if meta.permissions().readonly() {
                return Err(io::ErrorKind::PermissionDenied.into());
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                if meta.nlink() != 1 {
                    return Err(io::Error::other(
                        "This file has multiple hard links. Use Save As to create a copy.",
                    ));
                }
                file.try_lock().map_err(io::Error::from)?;
                let new_meta = staged.as_file().metadata()?;
                if (meta.uid(), meta.gid()) != (new_meta.uid(), new_meta.gid()) {
                    use std::os::fd::AsRawFd;
                    if unsafe { libc::fchown(staged.as_file().as_raw_fd(), meta.uid(), meta.gid()) }
                        != 0
                    {
                        return Err(io::Error::last_os_error());
                    }
                }
            }
            staged.as_file().set_permissions(meta.permissions())?;
            #[cfg(target_os = "macos")]
            {
                use std::os::fd::AsRawFd;
                // Both descriptors are live for this call. Copy ACLs and Finder attributes, never file data.
                let rc = unsafe {
                    libc::fcopyfile(
                        file.as_raw_fd(),
                        staged.as_file().as_raw_fd(),
                        std::ptr::null_mut(),
                        libc::COPYFILE_ACL | libc::COPYFILE_XATTR,
                    )
                };
                if rc != 0 {
                    return Err(io::Error::last_os_error());
                }
            }
            #[cfg(target_os = "linux")]
            {
                use std::os::fd::AsRawFd;
                for fd in [file.as_raw_fd(), staged.as_file().as_raw_fd()] {
                    // Refuse to discard attributes (including POSIX ACLs) on replacement.
                    let size = unsafe { libc::flistxattr(fd, std::ptr::null_mut(), 0) };
                    if size < 0 && io::Error::last_os_error().raw_os_error() != Some(libc::ENOTSUP)
                    {
                        return Err(io::Error::last_os_error());
                    }
                    if size > 0 {
                        return Err(io::Error::other("This file uses extended attributes. Use Save As to preserve the original."));
                    }
                }
            }
            Some(file)
        } else {
            None
        };
        staged.as_file().sync_all()?;
        let installed = stamp(&resolved, &staged.as_file().metadata()?, bytes);
        if target(path)? != resolved
            || version(path).map_err(io::Error::other)?.as_ref() != expected
        {
            return Err(io::Error::other("The file changed on disk. Your edits are still open. Use Save As to keep a separate copy."));
        }
        let mut warnings = Vec::new();
        let mut basic = false;
        let mut publication = Publication::Written;
        let mut conflict = false;
        // Only a filesystem that also lacks plain replacement needs a separate copy.
        let portable = |e: io::Error| {
            if unsupported(&e) {
                io::Error::other(COPY_REQUIRED)
            } else {
                e
            }
        };
        let mut installed = installed;
        let displaced = if let Some(expected) = expected {
            let old = match swap(staged.into_temp_path(), &resolved) {
                Ok(old) => old,
                Err((e, staged)) if unsupported(&e) => {
                    basic = true;
                    let (previous, outcome) = displace(&staged, &resolved).map_err(portable)?;
                    publication = outcome;
                    previous
                }
                Err((e, _)) => return Err(e),
            };
            // Validate the actual displaced object, including replacements in the
            // interval between the last comparison and the atomic exchange.
            if !read(&old)
                .is_ok_and(|(_, v)| v.digest == expected.digest && v.identity == expected.identity)
            {
                conflict = basic;
                warnings.push("Another version changed during replacement.".to_owned());
            }
            Some(old)
        } else {
            if let Err(e) = staged.persist_noclobber(&resolved) {
                if !unsupported(&e.error) {
                    return Err(e.error);
                }
                basic = true;
                publication = publish_document(e.file.path(), &resolved).map_err(portable)?;
            }
            None
        };
        if basic && publication == Publication::Written {
            // Such a filesystem may assign the published name a new identity.
            if let Ok((_, current)) = read(&resolved) {
                if current.digest == installed.digest {
                    installed = current;
                }
            }
        }
        if let Err(e) = flush(parent) {
            warnings.push(format!("Could not flush the destination directory: {e}."));
        }
        if publication == Publication::Occupied {
            conflict = true;
            warnings.push("Another program wrote to the destination first. Kladje left its contents untouched.".into());
        } else {
            match version(path) {
                Ok(v) if v.as_ref() != Some(&installed) => {
                    conflict |= basic;
                    warnings.push(if basic {
                        "Another program changed the file during the save. It may contain both versions."
                    } else {
                        "The destination changed during the save. Use Save As to keep these edits."
                    }.into());
                }
                Err(e) => warnings.push(format!("Could not verify the saved file: {e}")),
                _ => {}
            }
        }
        if let Some(mut old) = displaced {
            if !warnings.is_empty() {
                old.disable_cleanup(true);
                warnings.push(format!("The previous file was kept at {}.", old.display()));
            }
        }
        drop(original);
        Ok(Written {
            basic,
            conflict,
            version: installed,
            confirmed: warnings.is_empty(),
            warning: if warnings.is_empty() {
                None
            } else {
                Some(warnings.join(" "))
            },
        })
    })();
    result.map_err(|e| {
        if e.to_string() == COPY_REQUIRED {
            COPY_REQUIRED.into()
        } else {
            file_error("save", path, e)
        }
    })
}

#[cfg(unix)]
fn exchange(staged: tempfile::TempPath, target: &Path) -> Swapped {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let names = CString::new(staged.as_os_str().as_bytes())
        .and_then(|a| Ok((a, CString::new(target.as_os_str().as_bytes())?)));
    let (a, b) = match names {
        Ok(names) => names,
        Err(e) => return Err((e.into(), staged)),
    };
    // Atomically swap both names. A filesystem lacking exchange must fail safely.
    #[cfg(target_os = "macos")]
    let rc = unsafe { libc::renamex_np(a.as_ptr(), b.as_ptr(), libc::RENAME_SWAP) };
    #[cfg(target_os = "linux")]
    let rc = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            a.as_ptr(),
            libc::AT_FDCWD,
            b.as_ptr(),
            libc::RENAME_EXCHANGE,
        )
    };
    if rc != 0 {
        return Err((io::Error::last_os_error(), staged));
    }
    Ok(staged)
}

#[cfg(windows)]
fn exchange(mut staged: tempfile::TempPath, target: &Path) -> Swapped {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
    let wide = |p: &Path| {
        p.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    let mut backup = match tempfile::NamedTempFile::new_in(target.parent().unwrap()) {
        Ok(file) => file.into_temp_path(),
        Err(e) => return Err((e, staged)),
    };
    let (dst, src, old) = (wide(target), wide(&staged), wide(&backup));
    // Preserve the backup on partial Windows replacement errors.
    backup.disable_cleanup(true);
    if unsafe {
        ReplaceFileW(
            dst.as_ptr(),
            src.as_ptr(),
            old.as_ptr(),
            0,
            std::ptr::null(),
            std::ptr::null(),
        )
    } == 0
    {
        let error = io::Error::other(format!(
            "{} (check backup at {})",
            io::Error::last_os_error(),
            backup.display()
        ));
        return Err((error, staged));
    }
    backup.disable_cleanup(false);
    // The staged name now belongs to the replaced file.
    staged.disable_cleanup(true);
    Ok(backup)
}

/// Move on one volume only if the destination is available at publication.
#[cfg(unix)]
fn rename_exclusive(from: &Path, to: &Path) -> io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let from = CString::new(from.as_os_str().as_bytes())?;
    let to = CString::new(to.as_os_str().as_bytes())?;
    #[cfg(target_os = "macos")]
    let rc = unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_EXCL) };
    #[cfg(target_os = "linux")]
    let rc = unsafe {
        libc::syscall(
            libc::SYS_renameat2,
            libc::AT_FDCWD,
            from.as_ptr(),
            libc::AT_FDCWD,
            to.as_ptr(),
            libc::RENAME_NOREPLACE,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn rename_exclusive(from: &Path, to: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;
    let wide = |p: &Path| {
        p.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    let (from, to) = (wide(from), wide(to));
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 0) } != 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// Give a document a new name, here or in another folder on the same volume.
/// An existing file at `to` is never replaced, and the file keeps its identity.
/// `expected` is the version the editor last read, so a file that changed on
/// disk is not carried along unseen.
pub fn move_noclobber(
    from: &Path,
    to: &Path,
    expected: Option<&Version>,
) -> Result<Version, String> {
    let shown = |p: &Path| {
        p.file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    };
    let meta = fs::symlink_metadata(from).map_err(|e| file_error("move", from, e))?;
    if meta.file_type().is_symlink() {
        return Err(
            "This document is opened through a link. Use Save As to keep a copy elsewhere.".into(),
        );
    }
    if !meta.is_file() {
        return Err("Only a regular file can be moved.".into());
    }
    if to.file_name().is_none() || to.parent().is_none_or(|p| !p.is_dir()) {
        return Err("Choose a name in an existing folder.".into());
    }
    let expected = expected.ok_or("Reload the document before moving it.")?;
    if version(from)?.as_ref() != Some(expected) {
        return Err("The file changed on disk. Save it or reload it before moving.".into());
    }
    let new_target = to
        .parent()
        .unwrap()
        .canonicalize()
        .map_err(|e| e.to_string())?
        .join(to.file_name().unwrap());
    rename_exclusive(from, to).map_err(|e| {
        if e.kind() == io::ErrorKind::AlreadyExists {
            format!("“{}” already exists. Choose another name.", shown(to))
        } else if e.kind() == io::ErrorKind::CrossesDevices {
            "Move To works within one volume. Use Save As to put a copy on another volume.".into()
        } else if unsupported(&e) {
            "This volume cannot safely rename or move this document. The original remains in place."
                .into()
        } else {
            file_error("move", from, e)
        }
    })?;
    for dir in [to.parent(), from.parent()].into_iter().flatten() {
        let _ = sync_directory(dir);
    }
    // Keep the revision the user saw. An edit racing the rename must still
    // conflict on the next save, even if the new name now contains other bytes.
    Ok(Version {
        target: new_target,
        ..expected.clone()
    })
}

pub fn sync_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        let dir = File::open(path)?;
        if unsafe { libc::fsync(dir.as_raw_fd()) } != 0 {
            return Err(io::Error::last_os_error());
        }
    }
    #[cfg(not(unix))]
    let _ = path; // std has no portable directory flush on Windows.
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn interrupted_stage_preserves_target_and_cleans_up() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("note.md");
        fs::write(&path, b"original").unwrap();
        let v = version(&path).unwrap();
        assert!(replace_with(&path, b"new", v.as_ref(), |f, _| {
            f.write_all(b"partial")?;
            Err(io::Error::other("injected storage failure"))
        })
        .is_err());
        assert_eq!(fs::read(&path).unwrap(), b"original");
        assert_eq!(dir.path().read_dir().unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn read_only_target_remains_intact() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("read-only.md");
        fs::write(&path, b"original").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o444)).unwrap();
        let expected = version(&path).unwrap();
        assert!(replace(&path, b"other", expected.as_ref()).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"original");
        assert_eq!(dir.path().read_dir().unwrap().count(), 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_replacement_preserves_extended_attributes() {
        use std::os::fd::AsRawFd;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("metadata.md");
        fs::write(&path, b"original").unwrap();
        let fd = File::open(&path).unwrap();
        let name = c"app.kladje.test";
        let data = b"metadata";
        // macOS f[sg]etxattr take a live descriptor and the buffer length.
        let set = unsafe {
            libc::fsetxattr(
                fd.as_raw_fd(),
                name.as_ptr(),
                data.as_ptr().cast(),
                data.len(),
                0,
                0,
            )
        };
        assert_eq!(set, 0);
        let expected = version(&path).unwrap();
        assert!(
            replace(&path, b"edited", expected.as_ref())
                .unwrap()
                .confirmed
        );
        let saved = File::open(&path).unwrap();
        let mut value = [0; 8];
        let size = unsafe {
            libc::fgetxattr(
                saved.as_raw_fd(),
                name.as_ptr(),
                value.as_mut_ptr().cast(),
                value.len(),
                0,
                0,
            )
        };
        assert_eq!(size, data.len() as isize);
        assert_eq!(&value, data);
    }

    #[cfg(unix)]
    #[test]
    fn symlink_survives_success_and_failure() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("original");
        let link = dir.path().join("link.md");
        fs::write(&path, b"old").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        symlink(&path, &link).unwrap();
        let v = version(&link).unwrap();
        assert!(
            replace_with(&link, b"x", v.as_ref(), |_, _| Err(io::Error::other(
                "full"
            )))
            .is_err()
        );
        assert!(link.is_symlink());
        assert_eq!(fs::read(&path).unwrap(), b"old");
        replace(&link, b"new", v.as_ref()).unwrap();
        assert!(link.is_symlink());
        assert_eq!(fs::read(&path).unwrap(), b"new");
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o640
        );
    }
}

#[cfg(test)]
mod moving {
    use super::*;

    #[test]
    fn disk_probe_tracks_missing_files_and_replacements_without_reading_contents() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("draft.md");
        assert_eq!(disk_stamp(&path).unwrap(), None);
        fs::write(&path, b"one").unwrap();
        let first = disk_stamp(&path).unwrap();
        assert_eq!(disk_stamp(&path).unwrap(), first);
        let new = dir.path().join("incoming.md");
        fs::write(&new, b"two").unwrap();
        #[cfg(unix)]
        File::open(&new)
            .unwrap()
            .set_modified(fs::metadata(&path).unwrap().modified().unwrap())
            .unwrap();
        fs::rename(&new, &path).unwrap();
        #[cfg(unix)]
        assert_ne!(disk_stamp(&path).unwrap(), first);
        fs::remove_file(&path).unwrap();
        assert_eq!(disk_stamp(&path).unwrap(), None);
    }

    #[test]
    fn a_move_keeps_the_file_and_never_replaces_another() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("draft.md");
        fs::write(&from, b"text").unwrap();
        let before = version(&from).unwrap();
        fs::create_dir(dir.path().join("sub")).unwrap();
        let to = dir.path().join("sub").join("final.md");
        let moved = move_noclobber(&from, &to, before.as_ref()).unwrap();
        assert!(!from.exists());
        assert_eq!(fs::read(&to).unwrap(), b"text");
        assert_eq!(moved.digest, before.as_ref().unwrap().digest);
        assert_eq!(moved.identity, before.as_ref().unwrap().identity);

        let other = dir.path().join("other.md");
        fs::write(&other, b"other").unwrap();
        let error = move_noclobber(&to, &other, Some(&moved)).unwrap_err();
        assert!(error.contains("already exists"), "{error}");
        assert_eq!(fs::read(&other).unwrap(), b"other");
        assert_eq!(fs::read(&to).unwrap(), b"text");
    }

    #[test]
    fn a_destination_created_after_lookup_is_preserved_by_the_rename_itself() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("draft.md");
        let to = dir.path().join("renamed.md");
        fs::write(&from, b"editor").unwrap();
        assert!(!to.exists());
        fs::write(&to, b"external").unwrap();
        assert_eq!(
            rename_exclusive(&from, &to).unwrap_err().kind(),
            io::ErrorKind::AlreadyExists
        );
        assert_eq!(fs::read(&to).unwrap(), b"external");
        assert_eq!(fs::read(&from).unwrap(), b"editor");
    }

    #[test]
    fn only_the_capitals_of_a_name_can_change() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("notes.md");
        fs::write(&from, b"text").unwrap();
        let before = version(&from).unwrap();
        let to = dir.path().join("Notes.md");
        // Whether or not the volume ignores case, only the new name remains.
        move_noclobber(&from, &to, before.as_ref()).unwrap();
        let names: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name().into_string().unwrap())
            .collect();
        assert_eq!(names, ["Notes.md"]);
        assert_eq!(fs::read(&to).unwrap(), b"text");
    }

    #[test]
    fn a_changed_file_a_link_or_a_missing_folder_is_not_moved() {
        let dir = tempfile::tempdir().unwrap();
        let from = dir.path().join("note.md");
        fs::write(&from, b"one").unwrap();
        let seen = version(&from).unwrap();
        fs::write(&from, b"two").unwrap();
        let to = dir.path().join("renamed.md");
        assert!(move_noclobber(&from, &to, seen.as_ref())
            .unwrap_err()
            .contains("changed on disk"));
        assert!(from.exists() && !to.exists());
        let current = version(&from).unwrap();
        let nowhere = dir.path().join("missing").join("x.md");
        assert!(move_noclobber(&from, &nowhere, current.as_ref()).is_err());
        #[cfg(unix)]
        {
            let link = dir.path().join("link.md");
            std::os::unix::fs::symlink(&from, &link).unwrap();
            let linked = version(&link).unwrap();
            assert!(move_noclobber(&link, &to, linked.as_ref())
                .unwrap_err()
                .contains("link"));
            assert!(link.is_symlink() && !to.exists());
        }
    }
}

#[cfg(test)]
mod conflicts {
    use super::*;

    #[test]
    fn file_errors_name_the_document_and_an_action_without_exposing_its_parent() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("journal.md");
        let missing = read(&path).unwrap_err();
        assert!(missing.contains("journal.md") && missing.contains("location"));
        for kind in [
            io::ErrorKind::PermissionDenied,
            io::ErrorKind::StorageFull,
            io::ErrorKind::ReadOnlyFilesystem,
        ] {
            let message = file_error("save", &path, kind.into());
            assert!(
                message.contains("journal.md")
                    && (message.contains("folder") || message.contains("another disk"))
            );
            assert!(
                !message.contains(dir.path().to_str().unwrap()) && !message.contains("os error")
            );
        }
        let diagnostic = "The previous version was kept at /backup/previous.md";
        assert!(file_error("save", &path, io::Error::other(diagnostic)).contains(diagnostic));
    }

    #[test]
    fn replacement_failure_preserves_original_and_cleans_stage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.md");
        fs::write(&path, b"old").unwrap();
        let original = version(&path).unwrap();
        let result = replace_using(
            &path,
            b"local",
            original.as_ref(),
            |file, bytes| file.write_all(bytes),
            |staged, _| Err((io::ErrorKind::PermissionDenied.into(), staged)),
            sync_directory,
        );
        assert!(result.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"old");
        assert_eq!(dir.path().read_dir().unwrap().count(), 1);
    }

    /// Another program acting on the claimed name.
    type Writer = Box<dyn FnOnce(&Path)>;

    thread_local! {
        static CLAIMED: std::cell::RefCell<Option<Writer>> = const { std::cell::RefCell::new(None) };
        static CHECKED: std::cell::RefCell<Option<Writer>> = const { std::cell::RefCell::new(None) };
    }

    /// Run `writer` once, right after the next name claim on this thread.
    fn on_claim(writer: impl FnOnce(&Path) + 'static) {
        CLAIMED.with(|hook| *hook.borrow_mut() = Some(Box::new(writer)));
    }

    pub(super) fn after_claim(target: &Path) {
        if let Some(writer) = CLAIMED.with(|hook| hook.borrow_mut().take()) {
            writer(target);
        }
    }

    pub(super) fn after_empty_check(target: &Path) {
        if let Some(writer) = CHECKED.with(|hook| hook.borrow_mut().take()) {
            writer(target);
        }
    }

    /// A writer's name, its text and how it saves that text under a name.
    type Case = (&'static str, &'static [u8], fn(&Path, &[u8]));

    fn check_claim_races(folder: &Path, swap: fn(tempfile::TempPath, &Path) -> Swapped) {
        let writers: [Case; 3] = [
            ("shorter", b"theirs", |target, text| {
                fs::write(target, text).unwrap()
            }),
            ("longer", b"their much longer text", |target, text| {
                fs::write(target, text).unwrap()
            }),
            ("rename", b"theirs", |target, text| {
                let other = target.with_file_name("other-app.tmp");
                fs::write(&other, text).unwrap();
                fs::rename(&other, target).unwrap();
            }),
        ];
        for (name, theirs, writer) in writers {
            let dir = tempfile::tempdir_in(folder).unwrap();
            let path = dir.path().join("doc.md");
            fs::write(&path, b"old").unwrap();
            let baseline = version(&path).unwrap();
            on_claim(move |target| writer(target, theirs));
            let result = replace_using(
                &path,
                b"local edits",
                baseline.as_ref(),
                |file, bytes| file.write_all(bytes),
                swap,
                sync_directory,
            )
            .unwrap();
            assert!(
                result.basic && result.conflict && !result.confirmed,
                "{name}"
            );
            assert_eq!(fs::read(&path).unwrap(), theirs, "{name}");
            let previous = dir
                .path()
                .read_dir()
                .unwrap()
                .flatten()
                .find(|e| {
                    e.file_name()
                        .to_string_lossy()
                        .starts_with(".kladje-previous-")
                })
                .unwrap();
            assert_eq!(fs::read(previous.path()).unwrap(), b"old");
            assert!(result
                .warning
                .unwrap()
                .contains(previous.path().canonicalize().unwrap().to_str().unwrap()));
        }

        let dir = tempfile::tempdir_in(folder).unwrap();
        let path = dir.path().join("late.md");
        fs::write(&path, b"old").unwrap();
        let baseline = version(&path).unwrap();
        CHECKED
            .with(|hook| *hook.borrow_mut() = Some(Box::new(|p| fs::write(p, b"theirs").unwrap())));
        let result = replace_using(
            &path,
            b"mine",
            baseline.as_ref(),
            |f, b| f.write_all(b),
            swap,
            sync_directory,
        )
        .unwrap();
        assert!(result.basic && result.conflict && !result.confirmed);
        assert_eq!(fs::read(&path).unwrap(), b"theirsmine");
        let copy = protected_copy(&path, b"mine").unwrap();
        assert!(copy.confirmed);
        assert_eq!(fs::read(copy.version.target()).unwrap(), b"mine");
        assert_eq!(fs::read(&path).unwrap(), b"theirsmine");
    }

    #[test]
    fn a_writer_inside_the_claim_interval_is_never_erased() {
        let dir = tempfile::tempdir().unwrap();
        check_claim_races(dir.path(), no_exchange);
    }

    #[test]
    #[ignore = "requires the disposable mounted exFAT fixture"]
    fn a_writer_inside_the_claim_interval_on_exfat() {
        let mount = std::env::var_os("KLADJE_EXFAT_FIXTURE").unwrap();
        check_claim_races(Path::new(&mount), exchange);

        let dir = tempfile::tempdir_in(mount).unwrap();
        let path = dir.path().join("new.md");
        on_claim(|p| fs::write(p, b"theirs").unwrap());
        let result = replace(&path, b"mine", None).unwrap();
        assert!(result.conflict && !result.confirmed);
        assert_eq!(fs::read(path).unwrap(), b"theirs");
    }

    #[test]
    fn a_late_writer_during_rollback_does_not_retire_the_previous_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("old.md");
        fs::write(&path, b"old").unwrap();
        CHECKED.with(|hook| {
            *hook.borrow_mut() = Some(Box::new(|p| fs::write(p, b"external").unwrap()))
        });
        assert!(displace(&dir.path().join("missing-stage"), &path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"externalold");
        let backup = dir
            .path()
            .read_dir()
            .unwrap()
            .flatten()
            .find(|e| e.path() != path)
            .unwrap();
        assert_eq!(fs::read(backup.path()).unwrap(), b"old");
    }

    fn no_exchange(staged: tempfile::TempPath, _: &Path) -> Swapped {
        Err((io::ErrorKind::Unsupported.into(), staged))
    }

    #[test]
    fn missing_exchange_replaces_in_place_and_leaves_one_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.md");
        fs::write(&path, b"old").unwrap();
        let mut baseline = version(&path).unwrap();
        for text in [b"one".as_slice(), b"two"] {
            let result = replace_using(
                &path,
                text,
                baseline.as_ref(),
                |file, bytes| file.write_all(bytes),
                no_exchange,
                sync_directory,
            )
            .unwrap();
            assert!(result.confirmed && result.basic, "{:?}", result.warning);
            assert_eq!(fs::read(&path).unwrap(), text);
            assert_eq!(version(&path).unwrap().as_ref(), Some(&result.version));
            assert_eq!(dir.path().read_dir().unwrap().count(), 1);
            baseline = Some(result.version);
        }
    }

    #[test]
    fn missing_exchange_still_refuses_a_stale_baseline_and_keeps_a_racing_version() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.md");
        fs::write(&path, b"old").unwrap();
        let original = version(&path).unwrap();
        fs::write(&path, b"external").unwrap();
        let stale = replace_using(
            &path,
            b"local",
            original.as_ref(),
            |file, bytes| file.write_all(bytes),
            no_exchange,
            sync_directory,
        );
        assert!(stale.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"external");
        assert_eq!(dir.path().read_dir().unwrap().count(), 1);

        // A writer that wins the interval after the last comparison is moved aside, never erased.
        let current = version(&path).unwrap();
        let result = replace_using(
            &path,
            b"local",
            current.as_ref(),
            |file, bytes| file.write_all(bytes),
            |staged, target| {
                fs::write(target, b"racing").unwrap();
                no_exchange(staged, target)
            },
            sync_directory,
        )
        .unwrap();
        assert!(!result.confirmed);
        assert_eq!(fs::read(&path).unwrap(), b"local");
        let kept = dir
            .path()
            .read_dir()
            .unwrap()
            .flatten()
            .map(|e| e.path())
            .find(|p| *p != path)
            .unwrap();
        assert_eq!(fs::read(&kept).unwrap(), b"racing");
        assert!(result.warning.unwrap().contains(kept.to_str().unwrap()));
    }

    #[test]
    fn claim_refuses_an_existing_name_and_displace_restores_after_a_failed_install() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.md");
        fs::write(&path, b"existing").unwrap();
        let stage = |text: &[u8]| {
            let mut file = tempfile::NamedTempFile::new_in(dir.path()).unwrap();
            file.write_all(text).unwrap();
            file.into_temp_path()
        };
        let error = claim(&stage(b"new"), &path).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(fs::read(&path).unwrap(), b"existing");

        // The staged file vanished, so installing fails after the original moved aside.
        let staged = stage(b"lost");
        fs::remove_file(&staged).unwrap();
        assert!(displace(&staged, &path).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"existing");
        assert_eq!(dir.path().read_dir().unwrap().count(), 1);

        let fresh = dir.path().join("fresh.md");
        claim(&stage(b"fresh"), &fresh).unwrap();
        assert_eq!(fs::read(&fresh).unwrap(), b"fresh");
        assert_eq!(dir.path().read_dir().unwrap().count(), 2);
    }

    #[test]
    fn commit_race_and_directory_flush_failure_keep_both_versions() {
        for race in [true, false] {
            let dir = tempfile::tempdir().unwrap();
            let path = dir.path().join("doc.md");
            fs::write(&path, b"old").unwrap();
            let original = version(&path).unwrap();
            let result = replace_using(
                &path,
                b"local",
                original.as_ref(),
                |file, bytes| file.write_all(bytes),
                |staged, target| {
                    if race {
                        fs::write(target, b"external").unwrap();
                    }
                    exchange(staged, target)
                },
                |dir| {
                    if race {
                        sync_directory(dir)
                    } else {
                        Err(io::Error::other("flush failed"))
                    }
                },
            )
            .unwrap();
            assert!(!result.confirmed);
            let previous = dir
                .path()
                .read_dir()
                .unwrap()
                .flatten()
                .map(|e| e.path())
                .find(|p| *p != path)
                .unwrap();
            assert!(result.warning.unwrap().contains(previous.to_str().unwrap()));
            assert_eq!(
                fs::read(previous).unwrap(),
                if race { b"external".as_slice() } else { b"old" }
            );
            assert_eq!(fs::read(path).unwrap(), b"local");
        }
    }

    #[test]
    fn external_writer_during_staging_keeps_its_bytes() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("doc.md");
        fs::write(&path, b"old").unwrap();
        let original = version(&path).unwrap();
        let result = replace_with(&path, b"local", original.as_ref(), |f, bytes| {
            f.write_all(bytes)?;
            fs::write(&path, b"external")
        });
        assert!(result.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"external");
        assert_eq!(dir.path().read_dir().unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn dangling_symlinks_and_hard_links_require_a_separate_destination() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("original");
        let alias = dir.path().join("alias.md");
        std::os::unix::fs::symlink(&path, &alias).unwrap();
        assert!(replace(&alias, b"new", None).is_err());
        assert!(alias.is_symlink());
        assert!(!path.exists());
        fs::write(&path, b"original").unwrap();
        fs::hard_link(&path, dir.path().join("other")).unwrap();
        let original = version(&alias).unwrap();
        assert!(replace(&alias, b"new", original.as_ref()).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"original");
    }

    #[test]
    fn refuses_external_edit_even_at_the_same_size_and_mtime() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("doc.md");
        fs::write(&p, b"AAA").unwrap();
        let stamp = version(&p).unwrap();
        let time = fs::metadata(&p).unwrap().modified().unwrap();
        fs::write(&p, b"BBB").unwrap();
        File::options()
            .write(true)
            .open(&p)
            .unwrap()
            .set_modified(time)
            .unwrap();
        assert!(replace(&p, b"CCC", stamp.as_ref()).is_err());
        assert_eq!(fs::read(&p).unwrap(), b"BBB");
        fs::remove_file(&p).unwrap();
        assert!(replace(&p, b"CCC", stamp.as_ref()).is_err());
        assert!(!p.exists());
        fs::write(&p, b"new arrival").unwrap();
        assert!(replace(&p, b"CCC", None).is_err());
        assert_eq!(fs::read(&p).unwrap(), b"new arrival");
    }
}
