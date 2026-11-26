//! Release checks against GitHub and the platform steps of an update the user
//! asked for. Requests go through the system's own curl, so Kladje carries no
//! TLS stack of its own. Nothing about documents or settings is sent.
use semver::Version;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const RELEASES: &str = "https://api.github.com/repos/cyberdeliaAI/kladje/releases?per_page=20";
const DOWNLOADS: &str = "https://github.com/cyberdeliaAI/kladje/releases/download/";
/// Release pages that may be opened from Settings.
pub const PAGES: &str = "https://github.com/cyberdeliaAI/kladje/releases/";
/// Hidden folders beside the app that hold a verified update until it is installed.
pub const STAGING_PREFIX: &str = ".kladje-update-";
const METADATA_LIMIT: u64 = 4 * 1024 * 1024;
const ASSET_LIMIT: u64 = 512 * 1024 * 1024;
const NOTES_LIMIT: usize = 24_000;
pub const CANCELLED: &str = "The update download was cancelled.";
type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    pub version: String,
    pub tag: String,
    pub preview: bool,
    /// Markdown from the GitHub release, without its download instructions.
    pub notes: String,
    pub page: String,
    pub asset: Option<Asset>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Asset {
    pub name: String,
    pub size: u64,
    /// Lowercase hexadecimal SHA-256, as GitHub reports it for the uploaded file.
    pub digest: String,
}

#[derive(Deserialize)]
struct Metadata {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    body: Option<String>,
    html_url: String,
    assets: Vec<GitAsset>,
}

#[derive(Deserialize)]
struct GitAsset {
    name: String,
    size: u64,
    digest: Option<String>,
}

/// The download that installs Kladje on this system.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Platform {
    MacUniversal,
    WindowsX64,
    Other,
}

impl Platform {
    pub fn current() -> Self {
        match (std::env::consts::OS, std::env::consts::ARCH) {
            ("macos", _) => Self::MacUniversal,
            ("windows", "x86_64") => Self::WindowsX64,
            _ => Self::Other,
        }
    }

    fn matches(self, name: &str, version: &str) -> bool {
        let Some(rest) = name.strip_prefix(&format!("Kladje_{version}_")) else {
            return false;
        };
        match self {
            Self::MacUniversal => rest == "universal.dmg",
            // Kladje_0.1.0_x64-setup.exe or Kladje_0.1.0_windows-x64-preview-setup.exe
            Self::WindowsX64 => {
                rest.ends_with("-setup.exe") && rest.split(['-', '_']).any(|part| part == "x64")
            }
            Self::Other => false,
        }
    }
}

/// Before 1.0 every Kladje release is a preview, so previews are offered.
/// A stable 1.0 or later is offered stable releases only.
fn previews_allowed(current: &Version) -> bool {
    current.major == 0 || !current.pre.is_empty()
}

fn sha256_hex(digest: Option<&str>) -> Option<String> {
    let hex = digest?.strip_prefix("sha256:")?.to_ascii_lowercase();
    (hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit())).then_some(hex)
}

fn safe_name(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// The newest release this copy of Kladje may move to, newer or not.
/// `None` means GitHub lists no release that applies.
pub fn choose(bytes: &[u8], current: &Version, platform: Platform) -> Result<Option<Release>> {
    let list: Vec<Metadata> = serde_json::from_slice(bytes)
        .map_err(|_| "GitHub sent release information that Kladje could not read.")?;
    let mut best: Option<(Version, Metadata)> = None;
    for release in list {
        let Some(version) = release
            .tag_name
            .strip_prefix('v')
            .and_then(|tag| Version::parse(tag).ok())
        else {
            continue;
        };
        let preview = release.prerelease || !version.pre.is_empty();
        if release.draft || !version.build.is_empty() || (preview && !previews_allowed(current)) {
            continue;
        }
        if best.as_ref().is_none_or(|(known, _)| version > *known) {
            best = Some((version, release));
        }
    }
    let Some((version, release)) = best else {
        return Ok(None);
    };
    let version = version.to_string();
    let mut matching = release
        .assets
        .into_iter()
        .filter(|asset| platform.matches(&asset.name, &version));
    let asset = match (matching.next(), matching.next()) {
        (Some(asset), None)
            if safe_name(&asset.name) && (1..=ASSET_LIMIT).contains(&asset.size) =>
        {
            sha256_hex(asset.digest.as_deref()).map(|digest| Asset {
                name: asset.name,
                size: asset.size,
                digest,
            })
        }
        _ => None,
    };
    let page = if release.html_url.starts_with(PAGES) {
        release.html_url
    } else {
        format!("{PAGES}tag/{}", release.tag_name)
    };
    Ok(Some(Release {
        preview: release.prerelease || version.contains('-'),
        notes: without_downloads(release.body.as_deref().unwrap_or_default()),
        version,
        tag: release.tag_name,
        page,
        asset,
    }))
}

impl Release {
    pub fn newer_than(&self, current: &Version) -> bool {
        Version::parse(&self.version).is_ok_and(|next| next > *current)
    }
}

/// Drops the Downloads section of release notes: inside the app, those
/// instructions do not apply. Notes are also capped in length.
pub fn without_downloads(markdown: &str) -> String {
    let mut kept = Vec::new();
    let mut skipping: Option<usize> = None;
    for line in markdown.lines() {
        let trimmed = line.trim_start();
        let level = trimmed.bytes().take_while(|&b| b == b'#').count();
        let heading = (1..=6).contains(&level) && trimmed[level..].starts_with(' ');
        if heading {
            if skipping.is_some_and(|skip| level <= skip) {
                skipping = None;
            }
            if trimmed[level..].trim().eq_ignore_ascii_case("downloads") {
                skipping = Some(level);
            }
        }
        if skipping.is_none() {
            kept.push(line);
        }
    }
    kept.join("\n").trim().chars().take(NOTES_LIMIT).collect()
}

// ---------------------------------------------------------------- network

fn curl(user_agent: &str) -> Result<Command> {
    #[cfg(windows)]
    let program = PathBuf::from(
        std::env::var_os("SystemRoot").ok_or("Kladje could not find the Windows system folder.")?,
    )
    .join("System32")
    .join("curl.exe");
    #[cfg(not(windows))]
    let program = PathBuf::from("/usr/bin/curl");
    if !program.is_file() {
        return Err("This system has no curl, which Kladje uses to reach GitHub.".into());
    }
    let mut command = Command::new(program);
    // --disable must come first: it keeps a personal .curlrc out of these requests.
    command
        .args([
            "--disable",
            "--silent",
            "--fail",
            "--location",
            "--proto",
            "=https",
            "--proto-redir",
            "=https",
            "--tlsv1.2",
            "--max-redirs",
            "5",
            "--connect-timeout",
            "15",
            "--write-out",
            "%{http_code}",
            "--user-agent",
            user_agent,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    Ok(command)
}

fn failure(code: Option<i32>, http: &str) -> String {
    match (code, http) {
        (Some(22), "403" | "429") => {
            "GitHub is limiting requests from this network. Try again in an hour.".into()
        }
        (Some(22), "404") => "This release is no longer on GitHub.".into(),
        (Some(22), _) => format!("GitHub answered with HTTP {http}. Try again later."),
        (Some(5..=7), _) => {
            "Kladje could not reach GitHub. Check your internet connection and try again.".into()
        }
        (Some(28), _) => "GitHub did not answer in time. Try again later.".into(),
        (Some(35 | 51 | 53 | 54 | 58 | 59 | 60 | 66 | 77 | 80 | 82 | 83 | 90 | 91), _) => {
            "Kladje could not set up a secure connection to GitHub.".into()
        }
        (Some(18 | 56 | 92), _) => "The connection to GitHub was interrupted.".into(),
        (Some(23), _) => "Kladje could not save the download. Check the free disk space.".into(),
        (Some(63), _) => "The download is larger than GitHub announced.".into(),
        (code, _) => format!(
            "The request to GitHub failed (curl {}).",
            code.map_or("stopped".into(), |c| c.to_string())
        ),
    }
}

/// Runs curl to completion, or stops it when `cancel` is set.
fn run(mut command: Command, cancel: &AtomicBool) -> Result<()> {
    let mut child = command
        .spawn()
        .map_err(|_| "Kladje could not start curl to reach GitHub.")?;
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let mut http = String::new();
                if let Some(mut out) = child.stdout.take() {
                    let _ = out.read_to_string(&mut http);
                }
                return if status.success() {
                    Ok(())
                } else {
                    Err(failure(status.code(), http.trim()))
                };
            }
            Ok(None) if cancel.load(Ordering::Relaxed) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(CANCELLED.into());
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(100)),
            Err(_) => {
                let _ = child.kill();
                return Err("Kladje lost track of the request to GitHub.".into());
            }
        }
    }
}

/// The list of recent releases, as GitHub's API returns it.
pub fn fetch_releases(user_agent: &str, cancel: &AtomicBool) -> Result<Vec<u8>> {
    let dir = tempfile::Builder::new()
        .prefix("kladje-releases-")
        .tempdir()
        .map_err(|_| "Kladje could not create a temporary file for the release check.")?;
    let file = dir.path().join("releases.json");
    let mut command = curl(user_agent)?;
    command
        .args(["--max-time", "30", "--max-filesize"])
        .arg(METADATA_LIMIT.to_string())
        .args(["--header", "Accept: application/vnd.github+json"])
        .args(["--header", "X-GitHub-Api-Version: 2022-11-28"])
        .arg("--output")
        .arg(&file)
        .arg(RELEASES);
    run(command, cancel)?;
    let mut bytes = Vec::new();
    File::open(&file)
        .and_then(|f| f.take(METADATA_LIMIT + 1).read_to_end(&mut bytes))
        .map_err(|_| "Kladje could not read the release information.")?;
    if bytes.len() as u64 > METADATA_LIMIT {
        return Err("GitHub sent more release information than expected.".into());
    }
    Ok(bytes)
}

/// Downloads the release's file for this platform into `dir` and checks its
/// size and SHA-256 against what GitHub published.
pub fn download(
    release: &Release,
    dir: &Path,
    user_agent: &str,
    cancel: &AtomicBool,
) -> Result<PathBuf> {
    let asset = release
        .asset
        .as_ref()
        .ok_or("This release has no download that Kladje can install on this system.")?;
    if !safe_name(&asset.name) || !safe_name(&release.tag) {
        return Err("The release has an unexpected file name.".into());
    }
    let file = dir.join(&asset.name);
    let mut command = curl(user_agent)?;
    // Stalled downloads end; slow ones may take their time.
    command
        .args([
            "--speed-limit",
            "1024",
            "--speed-time",
            "60",
            "--max-filesize",
        ])
        .arg(asset.size.to_string())
        .arg("--output")
        .arg(&file)
        .arg(format!("{DOWNLOADS}{}/{}", release.tag, asset.name));
    run(command, cancel)?;
    verify_file(&file, asset)?;
    Ok(file)
}

pub fn verify_file(path: &Path, asset: &Asset) -> Result<()> {
    let mut file = File::open(path).map_err(|_| "Kladje could not open the download.")?;
    let mut hash = Sha256::new();
    let mut buffer = vec![0u8; 1 << 16];
    let mut total = 0u64;
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|_| "Kladje could not read the download.")?;
        if read == 0 {
            break;
        }
        total += read as u64;
        if total > asset.size {
            break;
        }
        hash.update(&buffer[..read]);
    }
    if total != asset.size || format!("{:x}", hash.finalize()) != asset.digest {
        return Err("The download does not match the checksum GitHub published.".into());
    }
    Ok(())
}

// ---------------------------------------------------------------- check cache

/// What the last release check found, kept between launches.
#[derive(Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Cache {
    /// Seconds since the Unix epoch of the last check, successful or not.
    pub attempted: u64,
    pub latest: Option<Release>,
    pub failed: bool,
    /// The version whose availability was last announced in a window.
    pub announced: Option<String>,
    /// Why the last installation, after the windows closed, did not finish.
    pub install_error: Option<String>,
}

impl Cache {
    pub fn load(path: &Path) -> Self {
        let Ok(file) = File::open(path) else {
            return Self::default();
        };
        let mut bytes = Vec::new();
        if file.take(256 * 1024).read_to_end(&mut bytes).is_err() {
            return Self::default();
        }
        serde_json::from_slice(&bytes).unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<()> {
        let dir = path.parent().ok_or("Missing settings folder")?;
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        let mut file = tempfile::NamedTempFile::new_in(dir).map_err(|e| e.to_string())?;
        serde_json::to_writer_pretty(&mut file, self).map_err(|e| e.to_string())?;
        file.write_all(b"\n")
            .and_then(|_| file.as_file().sync_all())
            .map_err(|e| e.to_string())?;
        file.persist(path).map_err(|e| e.to_string())?;
        Ok(())
    }
}

// ---------------------------------------------------------------- installation

/// This copy of Kladje, as far as an update can replace it.
#[derive(Debug)]
#[cfg_attr(not(any(target_os = "macos", windows)), allow(dead_code))]
pub struct Installation {
    target: PathBuf,
}

/// A verified update, ready to replace the installation once the windows closed.
pub struct Prepared {
    dir: tempfile::TempDir,
    item: PathBuf,
    target: PathBuf,
    pub version: String,
}

#[cfg(target_os = "macos")]
mod platform {
    use super::*;

    const IDENTIFIER: &str = "app.kladje.editor";
    // Kladje's Developer ID team. Builds signed by anyone else are refused.
    const TEAM: &str = "H3G46VS6J7";

    fn requirement() -> String {
        format!(
            "=anchor apple generic and identifier \"{IDENTIFIER}\" and \
             certificate leaf[field.1.2.840.113635.100.6.1.13] exists and \
             certificate leaf[subject.OU] = \"{TEAM}\""
        )
    }

    fn quiet(command: &mut Command) -> bool {
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .is_ok_and(|status| status.success())
    }

    /// Mounts a disk image read-only and out of sight. Kladje's disk image shows
    /// its MIT license before it mounts; the user accepted it when installing,
    /// so the prompt is answered here.
    fn attach(image: &Path, volume: &Path) -> bool {
        let child = Command::new("/usr/bin/hdiutil")
            .args([
                "attach",
                "-readonly",
                "-nobrowse",
                "-noautoopen",
                "-mountpoint",
            ])
            .arg(volume)
            .arg(image)
            .env("PAGER", "/bin/cat")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        let Ok(mut child) = child else {
            return false;
        };
        if let Some(mut input) = child.stdin.take() {
            // An image without a license never reads this.
            let _ = input.write_all(b"Y\n");
        }
        child.wait().is_ok_and(|status| status.success())
    }

    fn verify_signature(app: &Path) -> Result<()> {
        if quiet(
            Command::new("/usr/bin/codesign")
                .args(["--verify", "--deep", "--strict", "-R"])
                .arg(requirement())
                .arg(app),
        ) {
            Ok(())
        } else {
            Err("The update does not carry Kladje’s Developer ID signature.".into())
        }
    }

    pub(super) fn bundle_version(app: &Path) -> Result<String> {
        let output = Command::new("/usr/libexec/PlistBuddy")
            .args(["-c", "Print :CFBundleShortVersionString"])
            .arg(app.join("Contents/Info.plist"))
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
            .map_err(|_| "Kladje could not read the app version.")?;
        let version = String::from_utf8(output.stdout).unwrap_or_default();
        let version = version.trim();
        if !output.status.success() || Version::parse(version).is_err() {
            return Err("Kladje could not read the app version.".into());
        }
        Ok(version.to_owned())
    }

    fn verify(app: &Path, version: &str, notarized: bool) -> Result<()> {
        verify_signature(app)?;
        if notarized
            && !quiet(
                Command::new("/usr/sbin/spctl")
                    .args(["--assess", "--type", "execute"])
                    .arg(app),
            )
        {
            return Err("macOS could not confirm that the update is notarized by Apple.".into());
        }
        if bundle_version(app)? != version {
            return Err(format!("The downloaded app is not Kladje {version}."));
        }
        Ok(())
    }

    impl Installation {
        pub fn detect() -> Result<Self> {
            let exe =
                std::env::current_exe().map_err(|_| "Kladje could not locate its own app.")?;
            let app = exe
                .ancestors()
                .nth(3)
                .filter(|app| {
                    app.extension().is_some_and(|e| e == "app")
                        && exe.parent() == Some(app.join("Contents/MacOS").as_path())
                })
                .ok_or(
                    "This copy of Kladje does not run from an app, so it cannot replace itself.",
                )?;
            if app
                .components()
                .any(|c| c.as_os_str() == "AppTranslocation")
            {
                return Err("Move Kladje to the Applications folder and open it from there before updating.".into());
            }
            let target = app
                .canonicalize()
                .map_err(|_| "Kladje could not locate its own app.")?;
            verify_signature(&target).map_err(|_| {
                "This copy of Kladje is not a signed release, so it cannot replace itself. Download the new version from GitHub."
            })?;
            Ok(Self { target })
        }

        /// The disk image is downloaded and checked privately, and the app it holds
        /// is copied beside the installed one, where the final swap is one rename.
        pub fn prepare(
            &self,
            release: &Release,
            user_agent: &str,
            cancel: &AtomicBool,
        ) -> Result<Prepared> {
            use std::os::unix::fs::PermissionsExt;
            let parent = self
                .target
                .parent()
                .ok_or("Kladje could not locate its folder.")?;
            let dir = tempfile::Builder::new()
                .prefix(STAGING_PREFIX)
                .permissions(std::fs::Permissions::from_mode(0o700))
                .tempdir_in(parent)
                .map_err(|_| {
                    "Kladje cannot write to the folder it is installed in. Download the new version from GitHub and replace the app yourself."
                })?;
            let private = tempfile::Builder::new()
                .prefix("kladje-update-")
                .tempdir()
                .map_err(|_| "Kladje could not create a folder for the download.")?;
            let image = download(release, private.path(), user_agent, cancel)?;
            let volume = private.path().join("volume");
            std::fs::create_dir(&volume).map_err(|_| "Kladje could not prepare the disk image.")?;
            if !attach(&image, &volume) {
                return Err("Kladje could not open the downloaded disk image.".into());
            }
            let item = dir.path().join("Kladje.app");
            let copied = quiet(
                Command::new("/usr/bin/ditto")
                    .arg(volume.join("Kladje.app"))
                    .arg(&item),
            );
            let detached = quiet(Command::new("/usr/bin/hdiutil").arg("detach").arg(&volume))
                || quiet(
                    Command::new("/usr/bin/hdiutil")
                        .args(["detach", "-force"])
                        .arg(&volume),
                );
            if !detached {
                // A live mount must not be removed with the folder around it.
                let _ = private.keep();
            }
            if !copied {
                return Err("Kladje could not copy the app from the disk image.".into());
            }
            if cancel.load(Ordering::Relaxed) {
                return Err(CANCELLED.into());
            }
            verify(&item, &release.version, true)?;
            Ok(Prepared {
                dir,
                item,
                target: self.target.clone(),
                version: release.version.clone(),
            })
        }
    }

    /// Opens the app at `target` once this process has ended.
    pub(super) fn reopen(target: &Path) {
        let _ = Command::new("/bin/sh")
            .arg("-c")
            .arg(
                "i=0; while /bin/kill -0 \"$1\" 2>/dev/null && [ $i -lt 150 ]; \
                 do /bin/sleep 0.2; i=$((i+1)); done; exec /usr/bin/open \"$2\"",
            )
            .arg("kladje-reopen")
            .arg(std::process::id().to_string())
            .arg(target)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
    }

    pub(super) fn swap(staged: &Path, target: &Path) -> Result<()> {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        let path = |p: &Path| {
            CString::new(p.as_os_str().as_bytes()).map_err(|_| "Unexpected installation path.")
        };
        let (from, to) = (path(staged)?, path(target)?);
        // Both paths are on one volume; the C strings outlive the call.
        if unsafe { libc::renamex_np(from.as_ptr(), to.as_ptr(), libc::RENAME_SWAP) } != 0 {
            return Err(
                "macOS could not replace the app. The previous version is still in place.".into(),
            );
        }
        Ok(())
    }

    impl Prepared {
        /// Replaces the installed app and opens the new version once this process ends.
        /// On failure the previous version opens again.
        pub fn install(self) -> Result<()> {
            self.install_then(reopen)
        }

        pub(super) fn install_then(self, reopen: impl FnOnce(&Path)) -> Result<()> {
            let result = (|| {
                let installed = bundle_version(&self.target)?;
                if Version::parse(&installed).ok() >= Version::parse(&self.version).ok() {
                    return Err(format!("Kladje {installed} is already installed."));
                }
                verify(&self.item, &self.version, false)?;
                swap(&self.item, &self.target)
            })();
            reopen(&self.target);
            // After a swap, the staging folder holds the previous version.
            drop(self.dir);
            result
        }
    }

    /// Removes staging folders that a quit or crash left beside the app.
    pub fn remove_stale_staging() {
        let Ok(exe) = std::env::current_exe() else {
            return;
        };
        // Only beside an app bundle, never beside a development build.
        let bundled = exe
            .ancestors()
            .nth(3)
            .is_some_and(|app| app.extension().is_some_and(|e| e == "app"));
        let Some(parent) = exe.ancestors().nth(4).filter(|_| bundled) else {
            return;
        };
        let Ok(entries) = std::fs::read_dir(parent) else {
            return;
        };
        for entry in entries.flatten() {
            let stale = entry
                .file_name()
                .to_string_lossy()
                .starts_with(STAGING_PREFIX)
                && entry.file_type().is_ok_and(|t| t.is_dir());
            if stale {
                let _ = std::fs::remove_dir_all(entry.path());
            }
        }
    }
}

#[cfg(windows)]
mod platform {
    use super::*;

    impl Installation {
        pub fn detect() -> Result<Self> {
            let exe = std::env::current_exe().map_err(|_| "Kladje could not locate itself.")?;
            if exe
                .ancestors()
                .any(|dir| dir.file_name().is_some_and(|name| name == "target"))
            {
                return Err(
                    "This is a development build. Update it from the source checkout.".into(),
                );
            }
            Ok(Self { target: exe })
        }

        pub fn prepare(
            &self,
            release: &Release,
            user_agent: &str,
            cancel: &AtomicBool,
        ) -> Result<Prepared> {
            let dir = tempfile::Builder::new()
                .prefix("kladje-update-")
                .tempdir()
                .map_err(|_| "Kladje could not create a folder for the download.")?;
            let item = download(release, dir.path(), user_agent, cancel)?;
            Ok(Prepared {
                dir,
                item,
                target: self.target.clone(),
                version: release.version.clone(),
            })
        }
    }

    impl Prepared {
        /// Starts the installer once Kladje has closed its windows. It replaces
        /// Kladje with a progress bar only and opens the new version.
        pub fn install(self) -> Result<()> {
            let started = Command::new(&self.item)
                .args(["/P", "/R", "/UPDATE"])
                .stdin(Stdio::null())
                .spawn();
            match started {
                Ok(_) => {
                    // The installer runs from this folder after Kladje has quit.
                    let _ = self.dir.keep();
                    Ok(())
                }
                Err(error) => {
                    let _ = Command::new(&self.target).spawn();
                    Err(if error.raw_os_error() == Some(740) {
                        "The installer needs administrator rights. Download it from GitHub and run it yourself.".into()
                    } else {
                        "Kladje could not start the installer.".into()
                    })
                }
            }
        }
    }

    pub fn remove_stale_staging() {}
}

#[cfg(not(any(target_os = "macos", windows)))]
mod platform {
    use super::*;

    impl Installation {
        pub fn detect() -> Result<Self> {
            Err("Kladje installs updates itself on macOS and Windows. Download the new version from GitHub.".into())
        }

        pub fn prepare(&self, _: &Release, _: &str, _: &AtomicBool) -> Result<Prepared> {
            Err("Updates are not installed on this system.".into())
        }
    }

    impl Prepared {
        pub fn install(self) -> Result<()> {
            let _ = (&self.dir, &self.item, &self.target);
            Err("Updates are not installed on this system.".into())
        }
    }

    pub fn remove_stale_staging() {}
}

pub use platform::remove_stale_staging;

#[cfg(test)]
impl Installation {
    fn at(target: PathBuf) -> Self {
        Self { target }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn listing(releases: serde_json::Value) -> Vec<u8> {
        serde_json::to_vec(&releases).unwrap()
    }

    fn release(tag: &str, prerelease: bool, assets: serde_json::Value) -> serde_json::Value {
        json!({"tag_name": tag, "draft": false, "prerelease": prerelease, "body": "Notes",
               "html_url": format!("{PAGES}tag/{tag}"), "assets": assets})
    }

    const DIGEST: &str = "sha256:43F4147B445D467D1B20F4333F822695D76F9B207C39C732D43104B4D26B49B8";

    #[test]
    fn previews_are_offered_only_before_one_point_oh() {
        let list = listing(json!([
            release("v0.2.0", true, json!([])),
            release("v0.1.0", true, json!([])),
            release("v0.3.0", true, json!([])),
            {"tag_name": "v9.0.0", "draft": true, "prerelease": false, "html_url": "", "assets": []},
            release("nightly", false, json!([])),
        ]));
        let early = Version::parse("0.1.0").unwrap();
        let chosen = choose(&list, &early, Platform::MacUniversal)
            .unwrap()
            .unwrap();
        assert_eq!(chosen.version, "0.3.0");
        assert!(chosen.preview && chosen.newer_than(&early));
        let stable = Version::parse("1.0.0").unwrap();
        assert_eq!(
            choose(&list, &stable, Platform::MacUniversal).unwrap(),
            None
        );
        let list = listing(json!([
            release("v1.1.0", false, json!([])),
            release("v1.2.0-beta.1", false, json!([]))
        ]));
        let chosen = choose(&list, &stable, Platform::MacUniversal)
            .unwrap()
            .unwrap();
        assert_eq!(chosen.version, "1.1.0");
        assert!(!chosen.preview);
        assert!(!chosen.newer_than(&Version::parse("1.1.0").unwrap()));
        assert!(choose(b"{", &stable, Platform::MacUniversal).is_err());
    }

    #[test]
    fn requires_one_platform_file_with_a_published_digest() {
        let assets = json!([
            {"name": "Kladje_0.2.0_universal.dmg", "size": 12, "digest": DIGEST},
            {"name": "Kladje_0.2.0_windows-x64-preview-setup.exe", "size": 5, "digest": DIGEST},
            {"name": "SHA256SUMS.txt", "size": 3, "digest": DIGEST},
        ]);
        let list = listing(json!([release("v0.2.0", true, assets)]));
        let current = Version::parse("0.1.0").unwrap();
        let mac = choose(&list, &current, Platform::MacUniversal)
            .unwrap()
            .unwrap();
        let asset = mac.asset.unwrap();
        assert_eq!(asset.name, "Kladje_0.2.0_universal.dmg");
        assert_eq!(asset.digest, DIGEST[7..].to_ascii_lowercase());
        let windows = choose(&list, &current, Platform::WindowsX64)
            .unwrap()
            .unwrap();
        assert_eq!(
            windows.asset.unwrap().name,
            "Kladje_0.2.0_windows-x64-preview-setup.exe"
        );
        assert!(choose(&list, &current, Platform::Other)
            .unwrap()
            .unwrap()
            .asset
            .is_none());

        let unverified =
            json!([{"name": "Kladje_0.2.0_universal.dmg", "size": 12, "digest": null}]);
        let list = listing(json!([release("v0.2.0", true, unverified)]));
        assert!(choose(&list, &current, Platform::MacUniversal)
            .unwrap()
            .unwrap()
            .asset
            .is_none());
        let twice = json!([
            {"name": "Kladje_0.2.0_x64-setup.exe", "size": 5, "digest": DIGEST},
            {"name": "Kladje_0.2.0_windows-x64-setup.exe", "size": 5, "digest": DIGEST},
        ]);
        let list = listing(json!([release("v0.2.0", true, twice)]));
        assert!(choose(&list, &current, Platform::WindowsX64)
            .unwrap()
            .unwrap()
            .asset
            .is_none());
    }

    #[test]
    fn release_pages_stay_on_the_kladje_repository() {
        let mut entry = release("v0.2.0", true, json!([]));
        entry["html_url"] = json!("https://example.com/kladje");
        let list = listing(json!([entry]));
        let chosen = choose(&list, &Version::parse("0.1.0").unwrap(), Platform::Other)
            .unwrap()
            .unwrap();
        assert_eq!(chosen.page, format!("{PAGES}tag/v0.2.0"));
    }

    #[test]
    fn release_notes_leave_out_download_instructions() {
        let notes = "## Downloads\n\n- **macOS** — drag into Applications\n### Checksums\nabc\n\n## What’s included\n\n- Quick Open\n";
        assert_eq!(
            without_downloads(notes),
            "## What’s included\n\n- Quick Open"
        );
        assert_eq!(
            without_downloads("# Kladje\nText\n## downloads\nx"),
            "# Kladje\nText"
        );
        assert_eq!(without_downloads("#Downloads\nkept"), "#Downloads\nkept");
    }

    #[test]
    fn a_wrong_or_incomplete_download_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("file");
        std::fs::write(&path, b"good").unwrap();
        let digest = format!("{:x}", Sha256::digest(b"good"));
        let asset = |size| Asset {
            name: "file".into(),
            size,
            digest: digest.clone(),
        };
        assert!(verify_file(&path, &asset(4)).is_ok());
        assert!(verify_file(&path, &asset(5)).is_err());
        assert!(verify_file(&path, &asset(3)).is_err());
        std::fs::write(&path, b"evil").unwrap();
        assert!(verify_file(&path, &asset(4)).is_err());
    }

    #[test]
    fn the_check_cache_survives_restarts_and_damage() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("updates.json");
        assert_eq!(Cache::load(&path), Cache::default());
        let cache = Cache {
            attempted: 42,
            failed: true,
            announced: Some("0.2.0".into()),
            ..Cache::default()
        };
        cache.save(&path).unwrap();
        assert_eq!(Cache::load(&path), cache);
        std::fs::write(&path, b"{bad").unwrap();
        assert_eq!(Cache::load(&path), Cache::default());
    }

    #[test]
    fn curl_failures_read_as_sentences() {
        assert!(failure(Some(22), "403").contains("limiting"));
        assert!(failure(Some(6), "000").contains("internet connection"));
        assert!(failure(Some(22), "500").contains("HTTP 500"));
        assert!(failure(None, "").contains("stopped"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn swapping_exchanges_two_folders_in_place() {
        let dir = tempfile::tempdir().unwrap();
        let (old, new) = (dir.path().join("Kladje.app"), dir.path().join("staged.app"));
        std::fs::create_dir(&old).unwrap();
        std::fs::create_dir(&new).unwrap();
        std::fs::write(old.join("version"), "0.1.0").unwrap();
        std::fs::write(new.join("version"), "0.2.0").unwrap();
        platform::swap(&new, &old).unwrap();
        assert_eq!(
            std::fs::read_to_string(old.join("version")).unwrap(),
            "0.2.0"
        );
        assert_eq!(
            std::fs::read_to_string(new.join("version")).unwrap(),
            "0.1.0"
        );
        assert!(platform::swap(&dir.path().join("missing"), &old).is_err());
    }

    /// The whole macOS path against the published release: download, checksum,
    /// disk image, Developer ID, notarization, version and the final swap.
    /// Run with `cargo test --lib updates -- --ignored` (downloads the disk image).
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "downloads the published macOS release from GitHub"]
    fn installs_the_published_release_over_an_older_app() {
        let older = Version::parse("0.0.1").unwrap();
        let cancel = AtomicBool::new(false);
        let agent = "Kladje-test";
        let bytes = fetch_releases(agent, &cancel).unwrap();
        let release = choose(&bytes, &older, Platform::MacUniversal)
            .unwrap()
            .unwrap();
        let plist = |version: &str| {
            format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict>\
                 <key>CFBundleShortVersionString</key><string>{version}</string></dict></plist>\n"
            )
        };
        // A stand-in for an older installation, in a folder of its own.
        let dir = tempfile::tempdir().unwrap();
        let installed = dir.path().join("Kladje.app");
        std::fs::create_dir_all(installed.join("Contents")).unwrap();
        std::fs::write(installed.join("Contents/Info.plist"), plist("0.0.1")).unwrap();
        let installation = Installation::at(installed.clone());

        // A changed file inside the verified copy is caught before the swap.
        let tampered = installation.prepare(&release, agent, &cancel).unwrap();
        std::fs::write(tampered.item.join("Contents/Resources/extra.txt"), "x").unwrap();
        let mut reopened = None;
        assert!(tampered
            .install_then(|path| reopened = Some(path.to_owned()))
            .is_err());
        assert_eq!(platform::bundle_version(&installed).unwrap(), "0.0.1");
        assert_eq!(reopened.as_deref(), Some(installed.as_path()));

        let prepared = installation.prepare(&release, agent, &cancel).unwrap();
        let mut reopened = None;
        prepared
            .install_then(|path| reopened = Some(path.to_owned()))
            .unwrap();
        assert_eq!(
            platform::bundle_version(&installed).unwrap(),
            release.version
        );
        assert_eq!(reopened.as_deref(), Some(installed.as_path()));
        // The previous version went with the staging folder.
        let left: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .flatten()
            .map(|e| e.file_name())
            .collect();
        assert_eq!(left, ["Kladje.app"]);
    }
}
