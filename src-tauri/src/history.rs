//! One bounded recent-document list for every window. Migrate the webview's
//! previous list on first use and publish updates before acknowledging them.
use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(default)]
pub struct History {
    #[serde(rename = "lastPath")]
    last_path: Option<String>,
    paths: Vec<String>,
    places: Vec<Place>,
}

#[derive(Clone, Deserialize, Serialize)]
pub struct Place {
    path: String,
    digest: String,
    offset: usize,
    top: f64,
}

#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
pub enum Change {
    Read,
    Touch {
        path: String,
        #[serde(default)]
        resume: bool,
    },
    Remove {
        path: String,
    },
    Position {
        place: Place,
    },
    Clear,
}

pub struct Store {
    file: PathBuf,
    current: Option<History>,
}

impl History {
    pub fn paths(&self) -> &[String] {
        &self.paths
    }
}

impl Store {
    pub fn current(&self) -> Option<&History> {
        self.current.as_ref()
    }
    pub fn new(file: PathBuf) -> Self {
        Self {
            file,
            current: None,
        }
    }

    pub fn update(&mut self, change: Change, seed: Option<History>) -> Result<History, String> {
        if let (Change::Read, Some(current)) = (&change, self.current.as_ref()) {
            return Ok(current.clone());
        }
        let mut next = match self.current.as_ref() {
            Some(current) => current.clone(),
            None => match std::fs::File::open(&self.file) {
                Ok(file) => serde_json::from_reader(file)
                    .map_err(|e| format!("Could not read recent documents: {e}"))?,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => seed.unwrap_or_default(),
                Err(e) => return Err(e.to_string()),
            },
        };
        match change {
            Change::Read => (),
            Change::Touch { path, resume } => {
                if resume {
                    next.last_path = Some(path.clone());
                }
                next.paths.retain(|item| item != &path);
                next.paths.insert(0, path);
            }
            Change::Remove { path } => next.paths.retain(|item| item != &path),
            Change::Position { place } => {
                next.places.retain(|item| item.path != place.path);
                next.places.insert(0, place);
            }
            Change::Clear => next = History::default(),
        }
        let mut seen = std::collections::HashSet::new();
        next.paths.retain(|p| {
            Path::new(p).is_absolute() && !p.chars().any(char::is_control) && seen.insert(p.clone())
        });
        next.paths.truncate(10);
        if next
            .last_path
            .as_ref()
            .is_some_and(|p| !next.paths.contains(p))
        {
            next.last_path = None;
        }
        next.places.retain(|p| next.paths.contains(&p.path));
        next.places.truncate(10);
        let dir = self
            .file
            .parent()
            .ok_or("Missing application data directory")?;
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let mut stage = tempfile::NamedTempFile::new_in(dir).map_err(|e| e.to_string())?;
        serde_json::to_writer(&mut stage, &next).map_err(|e| e.to_string())?;
        stage.flush().map_err(|e| e.to_string())?;
        stage.persist(&self.file).map_err(|e| e.to_string())?;
        self.current = Some(next.clone());
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recent_edits_and_positions_survive_restart_and_clear_does_not_reimport_stale_browser_data() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("history.json");
        let path = |n| {
            tmp.path()
                .join(format!("{n}.md"))
                .to_string_lossy()
                .into_owned()
        };
        let mut store = Store::new(file.clone());
        let seed = History {
            last_path: None,
            paths: vec![path(0)],
            places: vec![],
        };
        for n in 1..13 {
            store
                .update(
                    Change::Touch {
                        path: path(n),
                        resume: true,
                    },
                    Some(seed.clone()),
                )
                .unwrap();
        }
        let found = store
            .update(
                Change::Position {
                    place: Place {
                        path: path(8),
                        digest: "a".into(),
                        offset: 12,
                        top: 4.0,
                    },
                },
                None,
            )
            .unwrap();
        assert_eq!(found.paths.len(), 10);
        let mut restarted = Store::new(file.clone());
        let found = restarted
            .update(
                Change::Touch {
                    path: path(8),
                    resume: true,
                },
                None,
            )
            .unwrap();
        assert_eq!(found.paths[0], path(8));
        assert_eq!(found.places[0].offset, 12);
        assert!(restarted
            .update(Change::Remove { path: path(8) }, None)
            .unwrap()
            .places
            .is_empty());
        restarted.update(Change::Clear, None).unwrap();
        assert!(Store::new(file)
            .update(Change::Read, Some(seed))
            .unwrap()
            .paths
            .is_empty());
    }
}
