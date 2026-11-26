//! Update state shared by every window: a daily release check when it is
//! turned on, a download the user asked for, and installation once every
//! window agreed to quit.
use kladje::markdown::Target;
use kladje::preferences;
use kladje::updates::{self, Cache, Installation, Platform, Prepared, CANCELLED};
use semver::Version;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

const DAY: u64 = 24 * 60 * 60;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Idle,
    Checking,
    Downloading,
    Ready,
    /// Waiting for the windows to close before the update replaces Kladje.
    Installing,
}

pub struct Updates {
    path: PathBuf,
    current: Version,
    cache: Cache,
    phase: Phase,
    error: Option<String>,
    prepared: Option<Prepared>,
    /// Why this copy of Kladje cannot replace itself, once a download found out.
    blocked: Option<String>,
    cancel: Arc<AtomicBool>,
}

impl Updates {
    fn available(&self) -> Option<&updates::Release> {
        self.cache
            .latest
            .as_ref()
            .filter(|release| release.newer_than(&self.current))
    }

    fn persist(&self) {
        if let Err(error) = self.cache.save(&self.path) {
            if cfg!(debug_assertions) {
                eprintln!("Update cache: {error}");
            }
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Available {
    version: String,
    preview: bool,
    page: String,
    notes_html: String,
    downloadable: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    current: String,
    phase: Phase,
    available: Option<Available>,
    /// Seconds since the last check, when that check succeeded.
    checked_ago: Option<u64>,
    error: Option<String>,
    /// Why the update has to come from GitHub instead, such as a development build.
    blocked: Option<String>,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn user_agent(current: &Version) -> String {
    format!("Kladje/{current}")
}

fn lock(app: &AppHandle) -> Result<MutexGuard<'_, Updates>, String> {
    app.try_state::<Mutex<Updates>>()
        .ok_or("Updates are not available yet.")?
        .inner()
        .lock()
        .map_err(|e| e.to_string())
}

pub fn init(app: &AppHandle) -> tauri::Result<()> {
    let path = app.path().app_data_dir()?.join("updates.json");
    let mut cache = Cache::load(&path);
    let error = cache.install_error.take();
    let state = Updates {
        path,
        current: app.package_info().version.clone(),
        cache,
        phase: Phase::Idle,
        error,
        prepared: None,
        blocked: None,
        cancel: Arc::new(AtomicBool::new(false)),
    };
    if state.error.is_some() {
        state.persist();
    }
    app.manage(Mutex::new(state));
    std::thread::spawn(updates::remove_stale_staging);
    let app = app.clone();
    std::thread::spawn(move || {
        // The first check waits until the windows have read the settings.
        std::thread::sleep(Duration::from_secs(30));
        loop {
            if due(&app) {
                check(&app, true);
            }
            std::thread::sleep(Duration::from_secs(15 * 60));
        }
    });
    Ok(())
}

/// Automatic checks run once a day while they are turned on. Until a window
/// has read the settings, nothing is known about that choice, so nothing runs.
fn due(app: &AppHandle) -> bool {
    let automatic = app
        .try_state::<Mutex<preferences::Store>>()
        .and_then(|store| {
            let store = store.lock().ok()?;
            let values = store.loaded()?;
            Some(
                values
                    .get("autoUpdate")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(true),
            )
        })
        .unwrap_or(false);
    automatic
        && lock(app).is_ok_and(|updates| {
            updates.phase == Phase::Idle
                && now()
                    .checked_sub(updates.cache.attempted)
                    .is_none_or(|elapsed| elapsed >= DAY)
        })
}

pub fn status(app: &AppHandle) -> Result<Status, String> {
    let (status, notes) = {
        let updates = lock(app)?;
        let available = updates.available().cloned();
        let checked = updates.cache.attempted > 0 && !updates.cache.failed;
        let status = Status {
            current: updates.current.to_string(),
            phase: updates.phase,
            available: available.as_ref().map(|release| Available {
                version: release.version.clone(),
                preview: release.preview,
                page: release.page.clone(),
                notes_html: String::new(),
                downloadable: release.asset.is_some() && updates.blocked.is_none(),
            }),
            checked_ago: checked.then(|| now().saturating_sub(updates.cache.attempted)),
            error: updates.error.clone(),
            blocked: updates.blocked.clone(),
        };
        (status, available.map(|release| release.notes))
    };
    let mut status = status;
    if let (Some(available), Some(notes)) = (status.available.as_mut(), notes) {
        // The same sanitizer as the preview, without navigable links or images.
        available.notes_html = app
            .state::<crate::AppState>()
            .renderer
            .render(&notes, Target::QuickOpen);
    }
    Ok(status)
}

fn emit(app: &AppHandle) {
    if let Ok(status) = status(app) {
        let _ = app.emit("update-status", status);
    }
}

/// Asks GitHub for the newest release. Blocks; callers run it in the background.
pub fn check(app: &AppHandle, automatic: bool) {
    let (current, cancel) = {
        let Ok(mut updates) = lock(app) else {
            return;
        };
        if updates.phase != Phase::Idle {
            return;
        }
        updates.phase = Phase::Checking;
        updates.error = None;
        updates.cache.attempted = now();
        updates.cancel.store(false, Ordering::Relaxed);
        updates.persist();
        (updates.current.clone(), updates.cancel.clone())
    };
    emit(app);
    let result = updates::fetch_releases(&user_agent(&current), &cancel)
        .and_then(|bytes| updates::choose(&bytes, &current, Platform::current()));
    if let Ok(mut updates) = lock(app) {
        updates.phase = Phase::Idle;
        match result {
            Ok(latest) => {
                updates.cache.latest = latest;
                updates.cache.failed = false;
            }
            Err(error) => {
                updates.cache.failed = true;
                updates.error = (error != CANCELLED).then_some(error);
            }
        }
        // Settings already shows the result of a check someone asked for.
        if !automatic {
            if let Some(version) = updates.available().map(|r| r.version.clone()) {
                updates.cache.announced = Some(version);
            }
        }
        updates.persist();
    }
    emit(app);
    if automatic {
        crate::announce_update_in_focus(app);
    }
}

/// Tells one window, once per version, that an update is available. Called for
/// the focused window, so an update found in the background is not missed.
pub fn announce(app: &AppHandle, label: &str) {
    let version = {
        let Ok(mut updates) = lock(app) else {
            return;
        };
        let Some(version) = updates.available().map(|r| r.version.clone()) else {
            return;
        };
        if updates.cache.announced.as_deref() == Some(version.as_str()) {
            return;
        }
        updates.cache.announced = Some(version.clone());
        updates.persist();
        version
    };
    let _ = app.emit_to(label, "update-found", version);
}

/// Downloads and verifies the available update in the background.
pub fn download(app: &AppHandle) -> Result<(), String> {
    let (current, cancel, version) = {
        let mut updates = lock(app)?;
        if updates.phase != Phase::Idle {
            return Ok(());
        }
        let version = updates
            .available()
            .map(|r| r.version.clone())
            .ok_or("There is no update to download.")?;
        updates.phase = Phase::Downloading;
        updates.error = None;
        updates.cancel.store(false, Ordering::Relaxed);
        (updates.current.clone(), updates.cancel.clone(), version)
    };
    emit(app);
    let app = app.clone();
    std::thread::spawn(move || {
        let agent = user_agent(&current);
        let installation = Installation::detect();
        if let Err(reason) = &installation {
            // The same answer would follow every time, so Settings offers GitHub instead.
            if let Ok(mut updates) = lock(&app) {
                updates.phase = Phase::Idle;
                updates.blocked = Some(reason.clone());
            }
            emit(&app);
            return;
        }
        let result = (|| {
            let installation = installation?;
            let bytes = updates::fetch_releases(&agent, &cancel)?;
            let release = updates::choose(&bytes, &current, Platform::current())?
                .filter(|r| r.version == version && r.newer_than(&current))
                .ok_or("The release on GitHub changed. Check for updates again.")?;
            let prepared = installation.prepare(&release, &agent, &cancel)?;
            Ok::<_, String>((prepared, release))
        })();
        if let Ok(mut updates) = lock(&app) {
            match result {
                Ok((prepared, release)) => {
                    updates.cache.latest = Some(release);
                    updates.prepared = Some(prepared);
                    updates.phase = Phase::Ready;
                }
                Err(error) => {
                    updates.phase = Phase::Idle;
                    updates.error = (error != CANCELLED).then_some(error);
                }
            }
            updates.persist();
        }
        emit(&app);
    });
    Ok(())
}

/// Marks the prepared update for installation. The caller then starts the
/// regular quit, which asks about unsaved documents in every window.
pub fn request_install(app: &AppHandle) -> Result<(), String> {
    {
        let mut updates = lock(app)?;
        if updates.phase != Phase::Ready || updates.prepared.is_none() {
            return Err("Download the update before installing it.".into());
        }
        updates.phase = Phase::Installing;
        updates.error = None;
    }
    emit(app);
    Ok(())
}

/// A window kept Kladje open, so the update waits for the next request.
pub fn quit_cancelled(app: &AppHandle) {
    let changed = lock(app).is_ok_and(|mut updates| {
        let installing = updates.phase == Phase::Installing;
        if installing {
            updates.phase = Phase::Ready;
        }
        installing
    });
    if changed {
        emit(app);
    }
}

/// Runs as Kladje ends. An update marked for installation replaces the app and
/// opens the new version; any other prepared update is discarded.
pub fn exit(app: &AppHandle) {
    let Ok(mut updates) = lock(app) else {
        return;
    };
    updates.cancel.store(true, Ordering::Relaxed);
    let prepared = updates.prepared.take();
    if updates.phase == Phase::Installing {
        if let Some(prepared) = prepared {
            let version = prepared.version.clone();
            if let Err(error) = prepared.install() {
                updates.cache.install_error =
                    Some(format!("Kladje {version} was not installed. {error}"));
                updates.persist();
            }
        }
    }
}
