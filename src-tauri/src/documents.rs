//! Process-local bindings. File contents, undo history and dirty state stay in the webview.
use kladje::{fileio, recovery::Recovery, storage};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Request {
    New,
    Guide,
    Open {
        path: PathBuf,
        fragment: Option<String>,
    },
    Import {
        path: PathBuf,
    },
    Template {
        path: PathBuf,
    },
    Restore {
        id: String,
    },
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Launch {
    New,
    Guide,
    Open { file: fileio::Opened },
    Import { path: PathBuf, content: String },
    Template { content: String },
    Restore { id: String },
}

pub struct Document {
    pub launch: Option<Launch>,
    path: Option<PathBuf>,
    source: Option<PathBuf>,
    pub closing: bool,
    pub fragment: Option<String>,
    pub ready: bool,
    pub recovery: Recovery,
}

pub struct Documents {
    root: PathBuf,
    serial: u64,
    pub windows: BTreeMap<String, Document>,
    pub quitting: Option<Quit>,
}

pub struct Quit {
    pub epoch: u64,
    pub waiting: VecDeque<String>,
    approved: Vec<(String, Option<String>)>,
}

impl Quit {
    pub fn first_window(&self) -> bool {
        self.approved.is_empty()
    }
}

pub enum Route {
    Create(String),
    Focus(String),
}

pub enum Decision {
    Cancel,
    Next,
    Finish(Vec<(String, Option<String>)>),
}

impl Documents {
    pub fn new(root: PathBuf) -> Self {
        let mut docs = Self {
            root,
            serial: 0,
            windows: BTreeMap::new(),
            quitting: None,
        };
        docs.insert("main".into(), None, None, None);
        docs
    }

    fn insert(
        &mut self,
        label: String,
        launch: Option<Launch>,
        path: Option<PathBuf>,
        fragment: Option<String>,
    ) {
        self.windows.insert(
            label,
            Document {
                launch,
                source: path.clone(),
                path,
                closing: false,
                fragment,
                ready: false,
                recovery: Recovery::new(self.root.clone()),
            },
        );
    }

    pub fn get(&mut self, label: &str) -> Result<&mut Document, String> {
        self.windows
            .get_mut(label)
            .ok_or_else(|| "The document window has closed.".into())
    }

    fn owner(&self, path: &Path, except: Option<&str>) -> Result<Option<String>, String> {
        let target = storage::target(path).map_err(|e| e.to_string())?;
        Ok(self.windows.iter().find_map(|(label, doc)| {
            if Some(label.as_str()) == except {
                return None;
            }
            let other = doc.path.as_ref()?;
            (other == &target
                || same_file::is_same_file(other, &target).unwrap_or(false)
                || doc.source.as_ref().is_some_and(|source| {
                    source != other && same_file::is_same_file(source, &target).unwrap_or(false)
                }))
            .then(|| label.clone())
        }))
    }

    /// Whether `path` is the document this window holds.
    pub fn owns(&self, label: &str, path: &Path) -> Result<bool, String> {
        let target = storage::target(path).map_err(|e| e.to_string())?;
        Ok(self
            .windows
            .get(label)
            .and_then(|doc| doc.path.as_ref())
            .is_some_and(|own| own == &target))
    }

    pub fn bind(&mut self, label: &str, path: &Path) -> Result<(), String> {
        self.available(label, path)?;
        let doc = self.get(label)?;
        doc.path = Some(storage::target(path).map_err(|e| e.to_string())?);
        doc.source = Some(path.to_owned());
        Ok(())
    }

    pub fn bind_version(
        &mut self,
        label: &str,
        path: &Path,
        version: &storage::Version,
    ) -> Result<(), String> {
        if storage::target(path).map_err(|e| e.to_string())? != version.target() {
            return Err("The file moved again. Your edits remain open.".into());
        }
        self.bind(label, path)
    }

    pub fn interrupt_quit(&mut self) -> Option<u64> {
        self.quitting
            .take_if(|q| !q.waiting.is_empty())
            .map(|q| q.epoch)
    }

    pub(crate) fn available(&self, label: &str, path: &Path) -> Result<(), String> {
        if self.owner(path, Some(label))?.is_some() {
            return Err("This file is open in another Kladje window. Save there or choose another filename.".into());
        }
        Ok(())
    }

    // Check ownership, execute the P0 storage operation and transfer the binding under one lock.
    pub fn write(
        &mut self,
        label: &str,
        path: &Path,
        bind: bool,
        operation: impl FnOnce() -> Result<storage::Written, String>,
    ) -> Result<storage::Written, String> {
        self.get(label)?;
        self.available(label, path)?;
        let written = operation()?;
        if bind {
            let doc = self.get(label)?;
            let target = written.version.target();
            doc.source = Some(
                if storage::target(path).ok().as_deref() == Some(target) {
                    path
                } else {
                    target
                }
                .to_owned(),
            );
            doc.path = Some(target.to_owned());
        }
        Ok(written)
    }

    pub fn reserve(&mut self, request: Request) -> Result<Route, String> {
        if self.quitting.is_some() {
            return Err("Finish or cancel Quit before opening another document.".into());
        }
        let mut source = None;
        let mut binding = None;
        let mut anchor = None;
        let launch = match request {
            Request::Open { path, fragment } => {
                fileio::markdown_path(&path)?;
                if let Some(owner) = self.owner(&path, None)? {
                    if fragment.is_some() {
                        self.get(&owner)?.fragment = fragment;
                    }
                    return Ok(Route::Focus(owner));
                }
                let file = fileio::open_document(&path)?;
                // A symlink may have changed between lookup and reading.
                if let Some(owner) = self.owner(file.version.target(), None)? {
                    if fragment.is_some() {
                        self.get(&owner)?.fragment = fragment;
                    }
                    return Ok(Route::Focus(owner));
                }
                binding = Some(file.version.target().to_owned());
                source = Some(path);
                anchor = fragment;
                Launch::Open { file }
            }
            Request::Template { path } => Launch::Template {
                content: fileio::open_document(&path)?.content,
            },
            Request::Import { path } => Launch::Import {
                content: kladje::import::import(&path)?,
                path,
            },
            Request::Restore { id } => Launch::Restore { id },
            Request::Guide => Launch::Guide,
            Request::New => Launch::New,
        };
        self.serial += 1;
        let label = format!("document-{}", self.serial);
        self.insert(label.clone(), Some(launch), binding, anchor);
        self.get(&label)?.source = source;
        Ok(Route::Create(label))
    }

    pub fn begin_close(&mut self, label: &str) -> Result<bool, String> {
        if self.quitting.is_some() {
            return Ok(false);
        }
        self.get(label)?.closing = true;
        Ok(true)
    }

    pub fn start_quit(&mut self, active: &str) -> bool {
        if self.quitting.is_some()
            || self.windows.values().any(|d| d.closing)
            || !self.windows.contains_key(active)
        {
            return false;
        }
        self.serial += 1;
        let mut waiting = VecDeque::from([active.to_string()]);
        waiting.extend(
            self.windows
                .keys()
                .filter(|k| k.as_str() != active)
                .cloned(),
        );
        self.quitting = Some(Quit {
            epoch: self.serial,
            waiting,
            approved: Vec::new(),
        });
        true
    }

    pub fn vote(
        &mut self,
        label: &str,
        epoch: u64,
        allow: bool,
        draft: Option<String>,
    ) -> Result<Decision, String> {
        let quit = self.quitting.as_mut().ok_or("Quit was cancelled.")?;
        if quit.epoch != epoch || quit.waiting.front().map(String::as_str) != Some(label) {
            return Err("This Quit request is no longer current.".into());
        }
        if !allow {
            self.quitting = None;
            return Ok(Decision::Cancel);
        }
        quit.approved
            .push((quit.waiting.pop_front().unwrap(), draft));
        if quit.waiting.is_empty() {
            // Keep the barrier in place until the process exits.
            Ok(Decision::Finish(std::mem::take(&mut quit.approved)))
        } else {
            Ok(Decision::Next)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    fn opened(path: &Path) -> Request {
        Request::Open {
            path: path.to_owned(),
            fragment: None,
        }
    }
    fn new_doc(d: &mut Documents) -> String {
        let Route::Create(label) = d.reserve(Request::New).unwrap() else {
            panic!("expected a new window")
        };
        label
    }
    #[test]
    fn duplicate_open_before_ready_focuses_reserved_owner_and_keeps_fragment() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("note.md");
        fs::write(&path, "one").unwrap();
        let link = tmp.path().join("hard.md");
        fs::hard_link(&path, &link).unwrap();
        let mut docs = Documents::new(tmp.path().join("recovery"));
        let Route::Create(owner) = docs.reserve(opened(&path)).unwrap() else {
            panic!()
        };
        let Route::Focus(focused) = docs
            .reserve(Request::Open {
                path: link,
                fragment: Some("section".into()),
            })
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(owner, focused);
        assert_eq!(
            docs.get(&owner).unwrap().fragment.as_deref(),
            Some("section")
        );
        assert_eq!(docs.windows.len(), 2);
    }
    #[test]
    fn failed_save_as_keeps_original_claim_and_success_releases_it() {
        let tmp = tempfile::tempdir().unwrap();
        let original = tmp.path().join("one.md");
        fs::write(&original, "one").unwrap();
        let dest = tmp.path().join("two.md");
        fs::write(&dest, "two").unwrap();
        let mut docs = Documents::new(tmp.path().join("recovery"));
        docs.bind("main", &original).unwrap();
        let b = new_doc(&mut docs);
        docs.bind(&b, &dest).unwrap();
        assert!(docs
            .write("main", &dest, true, || panic!(
                "must refuse before touching disk"
            ))
            .is_err());
        docs.windows.remove(&b);
        assert!(docs
            .write("main", &dest, true, || Err("disk full".into()))
            .is_err());
        assert!(matches!(
            docs.reserve(opened(&original)),
            Ok(Route::Focus(_))
        ));
        docs.write("main", &dest, true, || {
            Ok(storage::Written {
                basic: false,
                version: storage::version(&dest)?.unwrap(),
                confirmed: false,
                warning: Some("unconfirmed".into()),
            })
        })
        .unwrap();
        assert!(matches!(docs.reserve(opened(&dest)), Ok(Route::Focus(_))));
        assert!(matches!(
            docs.reserve(opened(&original)),
            Ok(Route::Create(_))
        ));
    }
    #[test]
    fn malformed_document_does_not_allocate_a_window_or_leak_a_binding() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("bad.md");
        fs::write(&path, [0, 1, 2]).unwrap();
        let mut docs = Documents::new(tmp.path().join("recovery"));
        assert!(docs.reserve(opened(&path)).is_err());
        assert_eq!(docs.windows.len(), 1);
        fs::write(&path, "now readable").unwrap();
        assert!(matches!(docs.reserve(opened(&path)), Ok(Route::Create(_))));
    }
    #[test]
    fn quit_waits_for_every_owner_and_rejects_stale_and_out_of_order_votes() {
        let tmp = tempfile::tempdir().unwrap();
        let mut docs = Documents::new(tmp.path().into());
        let second = new_doc(&mut docs);
        assert!(docs.start_quit(&second));
        let epoch = docs.quitting.as_ref().unwrap().epoch;
        assert!(!docs.start_quit("main"));
        assert!(docs.reserve(Request::New).is_err());
        assert!(docs.vote("main", epoch, true, None).is_err());
        assert!(matches!(
            docs.vote(&second, epoch, true, Some("second".into())),
            Ok(Decision::Next)
        ));
        assert!(matches!(
            docs.vote("main", epoch, false, None),
            Ok(Decision::Cancel)
        ));
        assert_eq!(docs.windows.len(), 2);
        assert!(docs.start_quit("main"));
        let retry = docs.quitting.as_ref().unwrap().epoch;
        assert!(docs.vote("main", epoch, true, None).is_err());
        assert!(matches!(
            docs.vote("main", retry, true, None),
            Ok(Decision::Next)
        ));
        let Decision::Finish(decisions) = docs
            .vote(&second, retry, true, Some("draft".into()))
            .unwrap()
        else {
            panic!()
        };
        assert_eq!(
            decisions,
            vec![("main".into(), None), (second, Some("draft".into()))]
        );
        assert!(docs.reserve(Request::New).is_err());
    }
}

#[cfg(test)]
mod races {
    use super::*;
    use std::sync::{Arc, Barrier, Mutex};

    #[test]
    fn simultaneous_save_as_to_one_destination_has_exactly_one_writer() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("shared.md");
        let docs = Arc::new(Mutex::new(Documents::new(tmp.path().join("drafts"))));
        let Route::Create(second) = docs.lock().unwrap().reserve(Request::New).unwrap() else {
            panic!()
        };
        let barrier = Barrier::new(2);
        std::thread::scope(|threads| {
            let save = |label: String| {
                barrier.wait();
                docs.lock()
                    .unwrap()
                    .write(&label, &path, true, || {
                        let format =
                            serde_json::from_str(r#"{"encoding":"utf8","eol":"lf"}"#).unwrap();
                        fileio::write_document(&path, &label, &format, None)
                    })
                    .map(|_| label)
            };
            let a = threads.spawn(move || save("main".into()));
            let b = threads.spawn(move || save(second));
            let results = [a.join().unwrap(), b.join().unwrap()];
            let winner = results.iter().find_map(|r| r.as_ref().ok()).unwrap();
            assert_eq!(results.iter().filter(|r| r.is_ok()).count(), 1);
            assert!(results
                .iter()
                .find_map(|r| r.as_ref().err())
                .unwrap()
                .contains("another Kladje window"));
            assert_eq!(&std::fs::read_to_string(&path).unwrap(), winner);
        });
    }
    #[cfg(unix)]
    #[test]
    fn retargeted_symlink_cannot_rebind_or_save_over_another_dirty_owner() {
        let tmp = tempfile::tempdir().unwrap();
        let first = tmp.path().join("one.md");
        let second = tmp.path().join("two.md");
        std::fs::write(&first, "one").unwrap();
        std::fs::write(&second, "two").unwrap();
        let alias = tmp.path().join("alias.md");
        std::os::unix::fs::symlink(&first, &alias).unwrap();
        let mut docs = Documents::new(tmp.path().join("drafts"));
        docs.bind("main", &alias).unwrap();
        let Route::Create(owner) = docs
            .reserve(Request::Open {
                path: second.clone(),
                fragment: None,
            })
            .unwrap()
        else {
            panic!()
        };
        std::fs::remove_file(&alias).unwrap();
        std::os::unix::fs::symlink(&second, &alias).unwrap();
        assert!(docs
            .bind_version("main", &alias, &storage::version(&second).unwrap().unwrap())
            .is_err());
        assert!(docs.write("main", &alias, true, || panic!()).is_err());
        docs.windows.remove("main");
        assert!(docs.available(&owner, &second).is_ok());
    }

    #[test]
    fn close_and_quit_cannot_retire_one_anothers_drafts() {
        let tmp = tempfile::tempdir().unwrap();
        let mut docs = Documents::new(tmp.path().into());
        let Route::Create(b) = docs.reserve(Request::New).unwrap() else {
            panic!()
        };
        assert!(docs.start_quit("main"));
        assert!(!docs.begin_close(&b).unwrap());
        let epoch = docs.interrupt_quit().unwrap();
        assert!(docs.vote("main", epoch, true, None).is_err());
        assert!(docs.begin_close(&b).unwrap());
        assert!(!docs.start_quit("main"));
    }
}
