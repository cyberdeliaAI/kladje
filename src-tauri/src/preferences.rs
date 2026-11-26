//! One file for writing and appearance preferences. Document and recovery state
//! have their own stores and are never accepted as settings.
use serde::Serialize;
use serde_json::{Map, Value};
use std::io::Write;
use std::path::PathBuf;

type Values = Map<String, Value>;

fn allowed(key: &str, value: &Value) -> bool {
    match key {
        "view" => matches!(value.as_str(), Some("editor" | "split" | "preview")),
        "theme" => matches!(value.as_str(), Some("light" | "dark" | "auto")),
        "editorFont" => matches!(value.as_str(), Some("mono" | "sans")),
        "zoom" => value.as_f64().is_some_and(|x| (0.5..=3.).contains(&x)),
        "split" => value.as_f64().is_some_and(|x| (0.0..=100.).contains(&x)),
        "sync" | "gutter" | "wrap" | "measure" | "autosave" | "pairing" | "linkPaste"
        | "htmlPaste" | "tablePaste" | "confirmImage" | "readingTime" | "focusParagraph"
        | "typewriter" | "lineBreaks" | "formatBar" | "darkExport" | "pageNumbers"
        | "autoUpdate" => value.is_boolean(),
        _ => false,
    }
}

#[derive(Clone, Default, Serialize)]
pub struct Snapshot {
    pub revision: u64,
    pub values: Values,
}

pub struct Store {
    path: PathBuf,
    loaded: Option<Snapshot>,
}
impl Store {
    pub fn new(path: PathBuf) -> Self {
        Self { path, loaded: None }
    }

    fn persist(&self, values: &Values) -> Result<(), String> {
        let dir = self.path.parent().ok_or("Missing settings folder")?;
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let mut file = tempfile::NamedTempFile::new_in(dir).map_err(|e| e.to_string())?;
        serde_json::to_writer_pretty(&mut file, values).map_err(|e| e.to_string())?;
        file.write_all(b"\n")
            .and_then(|_| file.as_file().sync_all())
            .map_err(|e| e.to_string())?;
        file.persist(&self.path).map_err(|e| e.to_string())?;
        Ok(())
    }

    pub fn read(&mut self, mut seed: Values) -> Result<Snapshot, String> {
        if let Some(snapshot) = &self.loaded {
            return Ok(snapshot.clone());
        }
        let values = match std::fs::File::open(&self.path) {
            Ok(file) => {
                if file.metadata().map_err(|e| e.to_string())?.len() > 64 * 1024 {
                    return Err("The preferences file is too large.".into());
                }
                let mut map: Values = serde_json::from_reader(file).map_err(|_| {
                    "Could not read preferences.json. Check its JSON before restarting Kladje."
                })?;
                map.retain(|k, v| allowed(k, v));
                map
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                seed.retain(|k, v| allowed(k, v));
                self.persist(&seed)?;
                seed
            }
            Err(e) => return Err(e.to_string()),
        };
        let snapshot = Snapshot {
            revision: 0,
            values,
        };
        self.loaded = Some(snapshot.clone());
        Ok(snapshot)
    }

    /// The values a window has read, without reading or creating the file.
    pub fn loaded(&self) -> Option<&Values> {
        self.loaded.as_ref().map(|snapshot| &snapshot.values)
    }

    pub fn set(&mut self, key: String, value: Value) -> Result<Snapshot, String> {
        if !allowed(&key, &value) {
            return Err("Invalid preference value.".into());
        }
        let mut next = self.read(Values::new())?;
        if next.values.get(&key) == Some(&value) {
            return Ok(next);
        }
        next.values.insert(key, value);
        self.persist(&next.values)?;
        next.revision += 1;
        self.loaded = Some(next.clone());
        Ok(next)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn migrates_once_combines_edits_and_keeps_a_damaged_file() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("preferences.json");
        let mut store = Store::new(path.clone());
        let seed =
            json!({"theme":"dark","autosave":false,"recovery":"private draft","zoom":"invalid"})
                .as_object()
                .unwrap()
                .clone();
        let first = store.read(seed).unwrap();
        assert_eq!(first.values.len(), 2);
        store.set("autosave".into(), json!(true)).unwrap();
        let last = store.set("theme".into(), json!("light")).unwrap();
        assert_eq!(last.revision, 2);
        assert_eq!(last.values["autosave"], true);
        assert!(store.set("other".into(), json!("no")).is_err());
        let mut restarted = Store::new(path.clone());
        assert_eq!(restarted.read(Values::new()).unwrap().values, last.values);
        std::fs::write(&path, b"{bad").unwrap();
        assert!(Store::new(path.clone()).read(Values::new()).is_err());
        assert_eq!(std::fs::read(path).unwrap(), b"{bad");
    }
}
