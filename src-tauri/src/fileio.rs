//! Document input, reversible decoding and explicit output formats.
use crate::storage::{self, Version, Written};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub const MAX_FILE_BYTES: u64 = 64 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Encoding {
    Utf8,
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    Latin1,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Eol {
    Lf,
    Crlf,
    Cr,
    Mixed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TextFormat {
    pub encoding: Encoding,
    pub eol: Eol,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    separators: String,
}

pub struct Decoded {
    pub text: String,
    pub format: TextFormat,
}

#[derive(Serialize)]
pub struct Opened {
    path: PathBuf,
    pub content: String,
    format: TextFormat,
    pub version: Version,
}

pub fn markdown_path(path: &Path) -> Result<(), String> {
    let ext = path
        .extension()
        .unwrap_or_default()
        .to_string_lossy()
        .to_ascii_lowercase();
    if matches!(
        ext.as_str(),
        "" | "md" | "markdown" | "mdown" | "mkd" | "mdx" | "txt"
    ) {
        Ok(())
    } else {
        Err(format!("“{}” is not a supported text document. Open Markdown or plain text, or import HTML and Word files.", path.display()))
    }
}

fn open_bounded(path: &Path, limit: u64) -> Result<Opened, String> {
    markdown_path(path)?;
    let (bytes, version) = storage::read_bounded(path, limit)?;
    markdown_path(version.target())?;
    let decoded = decode(bytes)?;
    Ok(Opened {
        path: path.to_owned(),
        content: decoded.text,
        format: decoded.format,
        version,
    })
}

pub fn open_document(path: &Path) -> Result<Opened, String> {
    open_bounded(path, MAX_FILE_BYTES)
}

pub fn comparison_text(path: &Path) -> Result<String, String> {
    open_bounded(path, 512 * 1024).map(|file| file.content)
}

pub fn read_text(path: &Path) -> Result<Decoded, String> {
    let (bytes, _) = storage::read(path)?;
    decode(bytes)
}

fn valid_text(text: &str) -> Result<(), String> {
    if text
        .chars()
        .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
    {
        return Err("This file contains binary or unsupported control characters.".into());
    }
    Ok(())
}

fn decode(bytes: Vec<u8>) -> Result<Decoded, String> {
    use Encoding::*;
    let invalid = || "Invalid text encoding. The original file has been left untouched.".to_owned();
    let (text, encoding) = if let Some(raw) = bytes.strip_prefix(&[0xef, 0xbb, 0xbf]) {
        (
            std::str::from_utf8(raw).map_err(|_| invalid())?.to_owned(),
            Utf8Bom,
        )
    } else if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        let (pairs, remainder) = bytes[2..].as_chunks::<2>();
        if !remainder.is_empty() {
            return Err(invalid());
        }
        let little = bytes[0] == 0xff;
        let units = pairs.iter().map(|pair| {
            if little {
                u16::from_le_bytes(*pair)
            } else {
                u16::from_be_bytes(*pair)
            }
        });
        let text: Result<String, _> = char::decode_utf16(units).collect();
        (
            text.map_err(|_| invalid())?,
            if little { Utf16Le } else { Utf16Be },
        )
    } else {
        for signature in [
            b"%PDF-".as_slice(),
            b"GIF87a",
            b"GIF89a",
            b"RIFF",
            b"PK\x03\x04",
            b"\x89PNG",
            b"\xff\xd8\xff",
        ] {
            if bytes.starts_with(signature) {
                return Err("This appears to be a binary file.".into());
            }
        }
        match String::from_utf8(bytes) {
            Ok(s) => (s, Utf8),
            Err(e) => (e.into_bytes().into_iter().map(char::from).collect(), Latin1),
        }
    };
    valid_text(&text)?;
    let mut separators = String::new();
    let mut chars = text.bytes().peekable();
    while let Some(b) = chars.next() {
        match b {
            b'\r' if chars.next_if_eq(&b'\n').is_some() => separators.push('w'),
            b'\r' => separators.push('r'),
            b'\n' => separators.push('n'),
            _ => (),
        }
    }
    let first = separators.bytes().next().unwrap_or(b'n');
    let eol = if separators.bytes().any(|c| c != first) {
        Eol::Mixed
    } else {
        separators.clear();
        match first {
            b'w' => Eol::Crlf,
            b'r' => Eol::Cr,
            _ => Eol::Lf,
        }
    };
    Ok(Decoded {
        text,
        format: TextFormat {
            encoding,
            eol,
            separators,
        },
    })
}

impl TextFormat {
    fn encode(&self, content: &str) -> Result<Vec<u8>, String> {
        valid_text(content)?;
        if content.contains('\r') {
            return Err("Expected normalized editor text.".into());
        }
        let text =
            match self.eol {
                Eol::Lf => std::borrow::Cow::Borrowed(content),
                Eol::Cr => content.replace('\n', "\r").into(),
                Eol::Crlf => content.replace('\n', "\r\n").into(),
                Eol::Mixed => {
                    let mut endings = self.separators.bytes();
                    let mut output = String::with_capacity(content.len());
                    for line in content.split_inclusive('\n') {
                        if let Some(line) = line.strip_suffix('\n') {
                            output.push_str(line);
                            output.push_str(match endings.next() {
                                Some(b'n') => "\n",
                                Some(b'r') => "\r",
                                Some(b'w') => "\r\n",
                                _ => return Err(
                                    "Choose a line ending for this edited mixed-ending document."
                                        .into(),
                                ),
                            });
                        } else {
                            output.push_str(line);
                        }
                    }
                    if endings.next().is_some() {
                        return Err(
                            "Choose a line ending for this edited mixed-ending document.".into(),
                        );
                    }
                    output.into()
                }
            };
        use Encoding::*;
        let bytes = match self.encoding {
            Utf8 => text.into_owned().into_bytes(),
            Utf8Bom => [b"\xef\xbb\xbf".as_slice(), text.as_bytes()].concat(),
            Utf16Le | Utf16Be => {
                let little = self.encoding == Utf16Le;
                let mut out = if little {
                    vec![0xff, 0xfe]
                } else {
                    vec![0xfe, 0xff]
                };
                for unit in text.encode_utf16() {
                    out.extend(if little {
                        unit.to_le_bytes()
                    } else {
                        unit.to_be_bytes()
                    });
                }
                out
            }
            Latin1 => text
                .chars()
                .map(|c| u8::try_from(c as u32))
                .collect::<Result<Vec<_>, _>>()
                .map_err(|_| {
                    "This text requires a Unicode encoding. Choose UTF-8 before saving."
                })?,
        };
        if bytes.len() as u64 > MAX_FILE_BYTES {
            return Err("The encoded document exceeds the 64 MiB limit.".into());
        }
        Ok(bytes)
    }
}

pub fn copy_document(path: &Path, content: &str, format: &TextFormat) -> Result<Written, String> {
    markdown_path(path)?;
    storage::protected_copy(path, &format.encode(content)?)
}

pub fn write_document(
    path: &Path,
    content: &str,
    format: &TextFormat,
    expected: Option<&Version>,
) -> Result<Written, String> {
    markdown_path(path)?;
    if let Some(existing) = expected {
        markdown_path(existing.target())?;
        // Save As may point to an existing file with a misleading extension.
        read_text(path)?;
    }
    storage::replace(path, &format.encode(content)?, expected)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn comparison_reads_supported_text_with_a_separate_small_limit() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("note.md");
        std::fs::write(&path, b"\xff\xfeH\0i\0").unwrap();
        assert_eq!(comparison_text(&path).unwrap(), "Hi");
        std::fs::write(&path, vec![b'a'; 512 * 1024 + 1]).unwrap();
        assert!(comparison_text(&path).unwrap_err().contains("512 KiB"));
        assert_eq!(open_document(&path).unwrap().content.len(), 512 * 1024 + 1);
    }

    #[test]
    fn round_trips_encodings_boms_and_line_endings() {
        for bytes in [
            b"\xef\xbb\xbfalpha\r\nbeta\r\n".to_vec(),
            "nø\n世界".as_bytes().to_vec(),
            vec![0xff, 0xfe, 0x68, 0, 0x0d, 0, 0x0a, 0],
            vec![0xfe, 0xff, 0, 0x68, 0, 0x0d],
            b"caf\xe9\r".to_vec(),
            b"a\r\nb\nc\rd\r\n".to_vec(),
            vec![],
        ] {
            let d = decode(bytes.clone()).unwrap();
            let normalized = d.text.replace("\r\n", "\n").replace('\r', "\n");
            assert_eq!(d.format.encode(&normalized).unwrap(), bytes);
        }
        let mixed = decode(b"a\r\nb\nc".to_vec()).unwrap().format;
        assert_eq!(mixed.encode("x\ny\nz").unwrap(), b"x\r\ny\nz");
        assert!(mixed.encode("x\ny").is_err());
        assert!(decode(b"caf\xe9".to_vec())
            .unwrap()
            .format
            .encode("😀")
            .is_err());
    }

    #[test]
    fn rejects_binary_or_lossy_input_and_protects_existing_targets() {
        for bytes in [
            b"abc\0def".as_slice(),
            b"%PDF-1.7",
            b"GIF89a",
            &[0xff, 0xfe, 0x61],
            &[0xff, 0xfe, 0x00, 0xd8],
        ] {
            assert!(decode(bytes.to_vec()).is_err());
        }
        let d = tempfile::tempdir().unwrap();
        let path = d.path().join("pretend.md");
        std::fs::write(&path, b"%PDF-1.7").unwrap();
        assert!(open_document(&path).is_err());
        let expected = storage::version(&path).unwrap();
        let format = decode(vec![]).unwrap().format;
        assert!(write_document(&path, "other", &format, expected.as_ref()).is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"%PDF-1.7");
        assert!(markdown_path(Path::new("photo.png")).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn markdown_alias_cannot_turn_an_unsupported_text_format_into_an_editable_file() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("drawing.svg");
        let alias = dir.path().join("note.md");
        std::fs::write(&source, "<svg/>").unwrap();
        std::os::unix::fs::symlink(&source, &alias).unwrap();
        assert!(open_document(&alias).is_err());
        let existing = storage::version(&alias).unwrap();
        assert!(write_document(
            &alias,
            "text",
            &decode(vec![]).unwrap().format,
            existing.as_ref()
        )
        .is_err());
        assert_eq!(std::fs::read(source).unwrap(), b"<svg/>");
    }

    #[test]
    fn atomic_write_replaces_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("doc.md");
        let format = decode(vec![]).unwrap().format;
        let first = write_document(&file, "one", &format, None).unwrap();
        write_document(&file, "two", &format, Some(&first.version)).unwrap();
        assert_eq!(std::fs::read(file).unwrap(), b"two");
        assert_eq!(dir.path().read_dir().unwrap().count(), 1);
    }
}
