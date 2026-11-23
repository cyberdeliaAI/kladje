//! Private per-document drafts. An OS lock distinguishes a live window from a
//! crashed owner. Each generation is immutable and independently verifiable.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use crate::storage::{sync_directory, Version};

const STAGING_PREFIX: &str = ".pending-";

const MAX_GENERATIONS: usize = 3;
const MAX_BYTES: u64 = 128 * 1024 * 1024;

#[derive(Deserialize, Serialize)]
pub struct Draft {
    id: String,
    revision: u64,
    name: String,
    path: Option<PathBuf>,
    version: Option<Version>,
    format: crate::fileio::TextFormat,
    content: String,
    time: u64,
}

#[derive(Serialize, Deserialize)]
struct Generation {
    schema: u8,
    checksum: String,
    draft: Draft,
}

#[derive(Serialize)]
pub struct Candidate {
    problem: Option<String>,
    id: String,
    name: String,
    time: u64,
}

pub struct Recovery {
    root: PathBuf,
    owned: HashMap<String, File>,
}

fn valid_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|c| c.is_ascii_hexdigit())
}

fn private_dir(path: &Path) -> io::Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)
}

fn generations(dir: &Path) -> io::Result<Vec<(u64, PathBuf)>> {
    let mut found = Vec::new();
    for entry in dir.read_dir()? {
        let path = entry?.path();
        if path.extension().is_some_and(|s| s == "json") {
            if let Some(n) = path
                .file_stem()
                .and_then(|s| s.to_str()?.parse::<u64>().ok())
            {
                found.push((n, path));
            }
        }
    }
    found.sort_unstable_by_key(|(number, _)| std::cmp::Reverse(*number));
    Ok(found)
}

fn digest(draft: &Draft) -> io::Result<String> {
    let mut hash = Sha256::new();
    serde_json::to_writer(&mut hash, draft)?;
    Ok(format!("{:x}", hash.finalize()))
}

fn latest(dir: &Path, id: &str) -> io::Result<Option<Draft>> {
    let mut entries = generations(dir)?;
    // An abrupt exit can leave a fully written first snapshot awaiting publication.
    for entry in dir.read_dir()? {
        let entry = entry?;
        if entry
            .file_name()
            .to_string_lossy()
            .starts_with(STAGING_PREFIX)
        {
            entries.push((0, entry.path()));
        }
    }
    for (_, path) in &entries {
        let Ok(file) = File::open(path) else { continue };
        if !file
            .metadata()
            .is_ok_and(|m| m.is_file() && m.len() <= MAX_BYTES)
        {
            continue;
        }
        if let Ok(g) = serde_json::from_reader::<_, Generation>(io::BufReader::new(file)) {
            if g.schema == 1 && g.draft.id == id && digest(&g.draft)? == g.checksum {
                return Ok(Some(g.draft));
            }
        }
    }
    if entries.is_empty() {
        Ok(None)
    } else {
        Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "No intact generation in {}. Files have been retained.",
                dir.display()
            ),
        ))
    }
}

impl Recovery {
    pub fn new(root: PathBuf) -> Self {
        Self {
            root,
            owned: HashMap::new(),
        }
    }

    fn dir(&self, id: &str) -> io::Result<PathBuf> {
        if !valid_id(id) {
            return Err(io::ErrorKind::InvalidInput.into());
        }
        Ok(self.root.join(id))
    }

    fn create(&mut self, id: &str) -> io::Result<PathBuf> {
        let dir = self.dir(id)?;
        if !self.owned.contains_key(id) {
            fs::create_dir_all(self.root.parent().ok_or(io::ErrorKind::InvalidInput)?)?;
            match private_dir(&self.root) {
                Err(e) if e.kind() == io::ErrorKind::AlreadyExists => (),
                result => result?,
            }
            private_dir(&dir)?;
            let owner = dir.join("owner");
            let lease = File::create_new(&owner).inspect_err(|_| {
                // Allow a later retry after a full disk prevented lease creation.
                let _ = fs::remove_dir(&dir);
            })?;
            lease.lock().inspect_err(|_| {
                let _ = fs::remove_file(&owner);
                let _ = fs::remove_dir(&dir);
            })?;
            self.owned.insert(id.to_owned(), lease);
        }
        // Retry these flushes even if this process acquired the lease on an earlier attempt.
        sync_directory(self.root.parent().ok_or(io::ErrorKind::InvalidInput)?)?;
        sync_directory(&self.root)?;
        Ok(dir)
    }

    pub fn write(&mut self, draft: Draft) -> io::Result<()> {
        self.write_with(draft, |file, bytes| file.write_all(bytes))
    }

    fn write_with(
        &mut self,
        draft: Draft,
        write: impl FnOnce(&mut File, &[u8]) -> io::Result<()>,
    ) -> io::Result<()> {
        let dir = self.create(&draft.id)?;
        let entries = generations(&dir)?;
        let number = entries.first().map_or(1, |(n, _)| n.saturating_add(1));
        let checksum = digest(&draft)?;
        let bytes = serde_json::to_vec(&Generation {
            schema: 1,
            checksum,
            draft,
        })?;
        if bytes.len() as u64 > MAX_BYTES {
            return Err(io::Error::other(
                "Draft exceeds the recovery storage limit. Save a copy.",
            ));
        }
        let mut temp = tempfile::Builder::new()
            .prefix(STAGING_PREFIX)
            .tempfile_in(&dir)?;
        write(temp.as_file_mut(), &bytes)?;
        temp.as_file().sync_all()?;
        temp.persist_noclobber(dir.join(format!("{number}.json")))?;
        sync_directory(&dir)?;
        // No retirement until the newly published generation is durable.
        for entry in dir.read_dir()? {
            let entry = entry?;
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with(STAGING_PREFIX)
            {
                fs::remove_file(entry.path())?;
            }
        }
        let mut total = bytes.len() as u64;
        for (index, (_, path)) in entries.into_iter().enumerate() {
            total += path.metadata()?.len();
            if index + 1 >= MAX_GENERATIONS || total > MAX_BYTES {
                fs::remove_file(path)?;
            }
        }
        Ok(())
    }

    pub fn list(&self) -> io::Result<Vec<Candidate>> {
        let mut list = Vec::new();
        let entries = match self.root.read_dir() {
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(list),
            result => result?,
        };
        for entry in entries {
            let entry = entry?;
            let id = entry.file_name().to_string_lossy().into_owned();
            if !valid_id(&id) || self.owned.contains_key(&id) {
                continue;
            }
            let lease = match File::options()
                .read(true)
                .write(true)
                .open(entry.path().join("owner"))
            {
                Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                result => result?,
            };
            match lease.try_lock() {
                Err(fs::TryLockError::WouldBlock) => continue,
                Err(fs::TryLockError::Error(e)) => return Err(e),
                Ok(()) => (),
            }
            match latest(&entry.path(), &id) {
                Ok(Some(draft)) => list.push(Candidate {
                    id,
                    name: draft.name,
                    time: draft.time,
                    problem: None,
                }),
                Ok(None) => (),
                Err(error) => list.push(Candidate {
                    id,
                    name: String::new(),
                    time: 0,
                    problem: Some(format!(
                        "Could not read the draft in {}. Its files have been kept. {error}",
                        entry.path().display()
                    )),
                }),
            }
        }
        list.sort_by_key(|d| std::cmp::Reverse(d.time));
        Ok(list)
    }

    pub fn claim(&mut self, id: &str) -> io::Result<Draft> {
        let dir = self.dir(id)?;
        let lease = File::options()
            .read(true)
            .write(true)
            .open(dir.join("owner"))?;
        lease.try_lock().map_err(io::Error::from)?;
        let draft = latest(&dir, id)?.ok_or(io::ErrorKind::NotFound)?;
        self.owned.insert(id.to_owned(), lease);
        Ok(draft)
    }

    pub fn clear(&mut self, id: &str) -> io::Result<()> {
        let dir = self.dir(id)?;
        if self.owned.contains_key(id) {
            fs::remove_dir_all(dir)?;
            self.owned.remove(id);
            sync_directory(&self.root)?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    const ID: &str = "cafebabecafebabecafebabecafebabe";
    fn draft(revision: u64) -> Draft {
        Draft {
            id: ID.into(),
            revision,
            name: "Untitled".into(),
            path: None,
            version: None,
            format: serde_json::from_value(serde_json::json!({"encoding":"utf8","eol":"lf"}))
                .unwrap(),
            content: format!("draft {revision}"),
            time: revision,
        }
    }
    #[test]
    fn crash_recovers_last_good_generation_after_failed_write_and_partial_data() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("recovery");
        let mut owner = Recovery::new(root.clone());
        owner.write(draft(1)).unwrap();
        owner.write(draft(2)).unwrap();
        assert!(owner
            .write_with(draft(3), |f, _| {
                f.write_all(b"partial")?;
                Err(io::Error::other("quota"))
            })
            .is_err());
        let mut restarted = Recovery::new(root.clone());
        assert!(restarted.list().unwrap().is_empty());
        assert!(restarted.claim(ID).is_err());
        drop(owner); // process termination releases leases without clearing drafts
        fs::write(root.join(ID).join("3.json"), b"{").unwrap();
        assert_eq!(restarted.list().unwrap().len(), 1);
        assert_eq!(restarted.claim(ID).unwrap().content, "draft 2");
        restarted.clear(ID).unwrap();
        assert!(restarted.list().unwrap().is_empty());
    }
    #[test]
    fn first_complete_stage_survives_a_crash_before_publication() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("private");
        let mut owner = Recovery::new(root.clone());
        owner.write(draft(1)).unwrap();
        drop(owner);
        let pending = root.join(ID).join(".pending-interrupted");
        fs::rename(root.join(ID).join("1.json"), &pending).unwrap();
        let mut restarted = Recovery::new(root);
        assert_eq!(restarted.claim(ID).unwrap().revision, 1);
        restarted.write(draft(2)).unwrap();
        assert!(!pending.exists());
    }

    #[test]
    fn an_unreadable_draft_does_not_hide_other_documents() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("private");
        let mut owner = Recovery::new(root.clone());
        owner.write(draft(1)).unwrap();
        let mut other = draft(2);
        other.id = "0123456789abcdef0123456789abcdef".into();
        owner.write(other).unwrap();
        drop(owner);
        fs::write(root.join(ID).join("1.json"), b"damaged").unwrap();
        let found = Recovery::new(root).list().unwrap();
        assert_eq!(found.len(), 2);
        assert!(found[0].problem.is_none());
        assert!(found[1].problem.is_some());
    }

    #[test]
    fn retention_and_checksum_validation() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("private");
        let mut store = Recovery::new(root.clone());
        for revision in 1..=5 {
            store.write(draft(revision)).unwrap();
        }
        assert_eq!(generations(&root.join(ID)).unwrap().len(), 3);
        let newest = root.join(ID).join("5.json");
        fs::write(
            &newest,
            fs::read_to_string(&newest)
                .unwrap()
                .replace("draft 5", "draft 6"),
        )
        .unwrap();
        drop(store);
        assert_eq!(Recovery::new(root).claim(ID).unwrap().revision, 4);
    }
}
