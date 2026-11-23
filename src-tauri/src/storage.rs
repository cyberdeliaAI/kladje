//! Stage and flush beside the resolved target. Existing files are exchanged so
//! even an uncooperative writer racing the final version check has a recoverable copy.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use tempfile::NamedTempFile;

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
    pub warning: Option<String>,
}

fn target(path: &Path) -> io::Result<PathBuf> {
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

pub fn read(path: &Path) -> Result<(Vec<u8>, Version), String> {
    read_bounded(path, MAX_FILE_BYTES)
}

pub(crate) fn read_bounded(path: &Path, limit: u64) -> Result<(Vec<u8>, Version), String> {
    let resolved = target(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut options = File::options();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NONBLOCK);
    }
    let mut file = options
        .open(&resolved)
        .map_err(|e| format!("{}: {e}", path.display()))?;
    let meta = file.metadata().map_err(|e| e.to_string())?;
    if !meta.is_file() || meta.len() > limit {
        return Err(format!(
            "{} is not a regular file within the {} KiB limit.",
            path.display(),
            limit / 1024
        ));
    }
    let mut bytes = Vec::new();
    (&mut file)
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() as u64 > limit {
        return Err(format!("File exceeds the {} KiB limit.", limit / 1024));
    }
    let version = stamp(&resolved, &meta, &bytes);
    Ok((bytes, version))
}

pub fn version(path: &Path) -> Result<Option<Version>, String> {
    match fs::symlink_metadata(path) {
        Ok(_) => read(path).map(|(_, stamp)| Some(stamp)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
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
    swap: impl FnOnce(NamedTempFile, &Path) -> io::Result<tempfile::TempPath>,
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
        let displaced = if let Some(expected) = expected {
            let old = swap(staged, &resolved)?;
            // Validate the actual displaced object, including replacements in the
            // interval between the last comparison and the atomic exchange.
            if !read(&old)
                .is_ok_and(|(_, v)| v.digest == expected.digest && v.identity == expected.identity)
            {
                warnings.push("Another version changed during replacement.".to_owned());
            }
            Some(old)
        } else {
            staged.persist_noclobber(&resolved)?;
            None
        };
        if let Err(e) = flush(parent) {
            warnings.push(format!(
                "The file was written, but its directory could not be flushed: {e}."
            ));
        }
        if version(path).ok().flatten().as_ref() != Some(&installed) {
            warnings.push(
                "The destination changed during the save. Use Save As to keep these edits."
                    .to_owned(),
            );
        }
        if let Some(mut old) = displaced {
            if !warnings.is_empty() {
                old.disable_cleanup(true);
                warnings.push(format!("The previous file was kept at {}.", old.display()));
            }
        }
        drop(original);
        Ok(Written {
            version: installed,
            confirmed: warnings.is_empty(),
            warning: if warnings.is_empty() {
                None
            } else {
                Some(warnings.join(" "))
            },
        })
    })();
    result.map_err(|e| format!("{}: {e}", path.display()))
}

#[cfg(unix)]
fn exchange(staged: NamedTempFile, target: &Path) -> io::Result<tempfile::TempPath> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;
    let staged = staged.into_temp_path();
    let a = CString::new(staged.as_os_str().as_bytes())?;
    let b = CString::new(target.as_os_str().as_bytes())?;
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
        return Err(io::Error::last_os_error());
    }
    Ok(staged)
}

#[cfg(windows)]
fn exchange(staged: NamedTempFile, target: &Path) -> io::Result<tempfile::TempPath> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::ReplaceFileW;
    let wide = |p: &Path| {
        p.as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect::<Vec<_>>()
    };
    let staged = staged.into_temp_path();
    let mut backup = NamedTempFile::new_in(target.parent().unwrap())?.into_temp_path();
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
        return Err(io::Error::other(format!(
            "{} (check backup at {})",
            io::Error::last_os_error(),
            backup.display()
        )));
    }
    backup.disable_cleanup(false);
    Ok(backup)
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
mod conflicts {
    use super::*;

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
            |_, _| Err(io::ErrorKind::PermissionDenied.into()),
            sync_directory,
        );
        assert!(result.is_err());
        assert_eq!(fs::read(&path).unwrap(), b"old");
        assert_eq!(dir.path().read_dir().unwrap().count(), 1);
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
                        fs::write(target, b"external")?;
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
