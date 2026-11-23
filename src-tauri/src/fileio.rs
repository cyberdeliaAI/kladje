//! Reading and writing text files safely.

use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

/// Files larger than this are refused rather than loaded into the editor.
pub const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

pub struct Decoded {
    pub text: String,
    /// True when the file was not UTF-8 and had to be converted. Saving will
    /// write UTF-8, so the UI warns about it.
    pub converted: bool,
}

pub fn read_text(path: &Path) -> Result<Decoded, String> {
    let meta = fs::metadata(path).map_err(|e| describe(path, &e))?;
    if meta.is_dir() {
        return Err(format!("“{}” is a folder, not a file.", path.display()));
    }
    if meta.len() > MAX_FILE_BYTES {
        return Err(format!(
            "“{}” is too large to open ({} MB).",
            path.display(),
            meta.len() / (1024 * 1024)
        ));
    }
    let bytes = fs::read(path).map_err(|e| describe(path, &e))?;
    Ok(decode(bytes))
}

/// Decode bytes as text: UTF-8 (with or without BOM), UTF-16 with BOM, and as a
/// last resort Latin-1 so that no file is ever refused or silently truncated.
pub fn decode(bytes: Vec<u8>) -> Decoded {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        if let Ok(text) = std::str::from_utf8(rest) {
            return Decoded { text: text.to_string(), converted: false };
        }
    }
    if bytes.starts_with(&[0xFF, 0xFE]) || bytes.starts_with(&[0xFE, 0xFF]) {
        let little = bytes[0] == 0xFF;
        let units = bytes[2..].chunks_exact(2).map(|c| {
            if little {
                u16::from_le_bytes([c[0], c[1]])
            } else {
                u16::from_be_bytes([c[0], c[1]])
            }
        });
        let text = char::decode_utf16(units)
            .map(|r| r.unwrap_or(char::REPLACEMENT_CHARACTER))
            .collect();
        return Decoded { text, converted: true };
    }
    match String::from_utf8(bytes) {
        Ok(text) => Decoded { text, converted: false },
        Err(e) => Decoded {
            text: e.into_bytes().iter().map(|&b| b as char).collect(),
            converted: true,
        },
    }
}

/// Write a file atomically: the new content goes to a temporary file next to
/// the target and replaces it in a single rename, so a crash or a full disk
/// can never leave a half-written document behind.
pub fn write_atomic(path: &Path, content: &[u8]) -> Result<(), String> {
    let dir = path.parent().filter(|p| !p.as_os_str().is_empty()).unwrap_or(Path::new("."));
    let name = path
        .file_name()
        .ok_or_else(|| format!("“{}” is not a valid file name.", path.display()))?;
    let tmp: PathBuf = dir.join(format!(
        ".{}.{}.tmp",
        name.to_string_lossy(),
        std::process::id()
    ));

    let result = (|| -> std::io::Result<()> {
        let mut file = File::create(&tmp)?;
        file.write_all(content)?;
        file.sync_all()?;
        drop(file);
        if let Ok(meta) = fs::metadata(path) {
            // Keep the original permissions (e.g. an executable script).
            let _ = fs::set_permissions(&tmp, meta.permissions());
        }
        fs::rename(&tmp, path)
    })();

    match result {
        Ok(()) => Ok(()),
        Err(first) => {
            let _ = fs::remove_file(&tmp);
            // Some locations (network shares, folders where only the file itself
            // is writable) do not allow the temp-file dance; write in place there.
            fs::write(path, content).map_err(|e| {
                format!("{} ({})", describe(path, &e), first)
            })
        }
    }
}

/// Last-modified time in milliseconds since the Unix epoch, if the file exists.
pub fn mtime_ms(path: &Path) -> Option<u64> {
    let modified = fs::metadata(path).ok()?.modified().ok()?;
    Some(modified.duration_since(UNIX_EPOCH).ok()?.as_millis() as u64)
}

fn describe(path: &Path, e: &std::io::Error) -> String {
    use std::io::ErrorKind::*;
    let what = match e.kind() {
        NotFound => "does not exist".to_string(),
        PermissionDenied => "cannot be accessed (permission denied)".to_string(),
        _ => format!("could not be used: {e}"),
    };
    format!("“{}” {what}.", path.display())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_utf8_bom_utf16_and_latin1() {
        assert_eq!(decode(b"\xEF\xBB\xBFhi".to_vec()).text, "hi");
        let d = decode(vec![0xFF, 0xFE, b'h', 0, b'i', 0]);
        assert_eq!((d.text.as_str(), d.converted), ("hi", true));
        let d = decode(vec![b'c', b'a', b'f', 0xE9]);
        assert_eq!((d.text.as_str(), d.converted), ("café", true));
        assert!(!decode("café".as_bytes().to_vec()).converted);
    }

    #[test]
    fn atomic_write_replaces_and_leaves_no_temp_file() {
        let dir = std::env::temp_dir().join(format!("kladje-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("doc.md");
        write_atomic(&file, b"one").unwrap();
        write_atomic(&file, b"two").unwrap();
        assert_eq!(fs::read_to_string(&file).unwrap(), "two");
        assert_eq!(fs::read_dir(&dir).unwrap().count(), 1);
        assert!(mtime_ms(&file).is_some());
        fs::remove_dir_all(&dir).unwrap();
    }
}
