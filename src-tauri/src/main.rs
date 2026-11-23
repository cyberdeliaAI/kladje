// Kladje — a light, fast Markdown editor.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use kladje::markdown::{Renderer, Target, PREVIEW_ID_PREFIX};
use kladje::recovery::{Candidate, Draft, Recovery};
use kladje::{export, fileio, import, storage};

struct AppState {
    renderer: Renderer,
    /// A file the OS asked us to open (command line, double-click, "Open with")
    /// that the window has not picked up yet.
    pending_open: Mutex<Option<String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Setup {
    syntax_css_light: String,
    syntax_css_dark: String,
    id_prefix: &'static str,
    pending_open: Option<String>,
}

#[tauri::command(async)]
fn setup(state: State<'_, AppState>) -> Setup {
    Setup {
        syntax_css_light: state.renderer.syntax_css_light.clone(),
        syntax_css_dark: state.renderer.syntax_css_dark.clone(),
        id_prefix: PREVIEW_ID_PREFIX,
        pending_open: state.pending_open.lock().ok().and_then(|mut p| p.take()),
    }
}

#[tauri::command(async)]
fn take_pending_open(state: State<'_, AppState>) -> Option<String> {
    state.pending_open.lock().ok().and_then(|mut p| p.take())
}

#[tauri::command(async)]
fn render(state: State<'_, AppState>, markdown: String) -> String {
    state.renderer.render(&markdown, Target::Preview)
}

#[tauri::command(async)]
fn read_file(path: String) -> Result<fileio::Opened, String> {
    fileio::open_document(Path::new(&path))
}

#[tauri::command(async)]
fn write_file(
    path: String,
    content: String,
    format: fileio::TextFormat,
    expected: Option<storage::Version>,
) -> Result<storage::Written, String> {
    fileio::write_document(Path::new(&path), &content, &format, expected.as_ref())
}

#[tauri::command(async)]
fn file_version(path: String) -> Result<Option<storage::Version>, String> {
    storage::version(Path::new(&path))
}

#[tauri::command(async)]
fn import_file(path: String) -> Result<String, String> {
    import::import(Path::new(&path))
}

#[tauri::command(async)]
fn export_html(
    state: State<'_, AppState>,
    path: String,
    markdown: String,
    title: String,
    source: Option<String>,
    expected: Option<storage::Version>,
) -> Result<storage::Written, String> {
    let html = export::standalone_html(&state.renderer, &markdown, &title);
    export::write_html(
        Path::new(&path),
        &html,
        source.as_deref().map(Path::new),
        expected.as_ref(),
    )
}

type DraftStore<'a> = State<'a, Mutex<Recovery>>;

#[tauri::command(async)]
fn recovery_list(store: DraftStore<'_>) -> Result<Vec<Candidate>, String> {
    store
        .lock()
        .map_err(|e| e.to_string())?
        .list()
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn recovery_claim(store: DraftStore<'_>, id: String) -> Result<Draft, String> {
    store
        .lock()
        .map_err(|e| e.to_string())?
        .claim(&id)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn recovery_write(store: DraftStore<'_>, draft: Draft) -> Result<(), String> {
    store
        .lock()
        .map_err(|e| e.to_string())?
        .write(draft)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn recovery_clear(store: DraftStore<'_>, id: String) -> Result<(), String> {
    store
        .lock()
        .map_err(|e| e.to_string())?
        .clear(&id)
        .map_err(|e| e.to_string())
}

/// Opens the system print dialog, which is also how a PDF is produced.
#[tauri::command]
fn print_document(window: WebviewWindow) -> Result<(), String> {
    window.print().map_err(|e| e.to_string())
}

/// Front-end errors end up on stderr in development builds.
#[tauri::command]
fn log_message(message: String) {
    if cfg!(debug_assertions) {
        eprintln!("[ui] {message}");
    }
}

#[tauri::command]
fn quit(app: AppHandle) {
    app.exit(0);
}

fn build_menu(app: &AppHandle) -> tauri::Result<()> {
    let item = |id: &str, text: &str, accelerator: Option<&str>| {
        let mut builder = MenuItemBuilder::with_id(id, text);
        if let Some(a) = accelerator {
            builder = builder.accelerator(a);
        }
        builder.build(app)
    };

    let export = SubmenuBuilder::new(app, "Export")
        .item(&item("export_html", "HTML…", Some("CmdOrCtrl+Shift+E"))?)
        .item(&item("export_pdf", "PDF / Print…", Some("CmdOrCtrl+P"))?)
        .build()?;

    let mut file = SubmenuBuilder::new(app, "File")
        .item(&item("new", "New", Some("CmdOrCtrl+N"))?)
        .item(&item("open", "Open…", Some("CmdOrCtrl+O"))?)
        .separator()
        .item(&item("save", "Save", Some("CmdOrCtrl+S"))?)
        .item(&item("save_as", "Save As…", Some("CmdOrCtrl+Shift+S"))?)
        .separator()
        .item(&item("import", "Import…", Some("CmdOrCtrl+Shift+I"))?)
        .item(&export);
    if !cfg!(target_os = "macos") {
        file = file.separator().item(&item("quit", "Quit", Some("CmdOrCtrl+Q"))?);
    }
    let file = file.build()?;

    // Undo/redo/find go to the editor itself rather than to the webview's own
    // undo stack, so they are ordinary items; clipboard items are native.
    let edit = SubmenuBuilder::new(app, "Edit")
        .item(&item("undo", "Undo", Some("CmdOrCtrl+Z"))?)
        .item(&item("redo", "Redo", Some("CmdOrCtrl+Shift+Z"))?)
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .separator()
        .item(&item("find", "Find and Replace…", Some("CmdOrCtrl+F"))?)
        .build()?;

    let heading = SubmenuBuilder::new(app, "Heading")
        .item(&item("h1", "Heading 1", Some("CmdOrCtrl+1"))?)
        .item(&item("h2", "Heading 2", Some("CmdOrCtrl+2"))?)
        .item(&item("h3", "Heading 3", Some("CmdOrCtrl+3"))?)
        .item(&item("h4", "Heading 4", Some("CmdOrCtrl+4"))?)
        .item(&item("h0", "Paragraph", Some("CmdOrCtrl+0"))?)
        .build()?;

    let format = SubmenuBuilder::new(app, "Format")
        .item(&item("bold", "Bold", Some("CmdOrCtrl+B"))?)
        .item(&item("italic", "Italic", Some("CmdOrCtrl+I"))?)
        .item(&item("strike", "Strikethrough", Some("CmdOrCtrl+Shift+X"))?)
        .item(&item("code", "Inline Code", Some("CmdOrCtrl+E"))?)
        .item(&item("link", "Link", Some("CmdOrCtrl+K"))?)
        .separator()
        .item(&heading)
        .item(&item("bullet", "Bullet List", Some("CmdOrCtrl+Shift+8"))?)
        .item(&item("numbered", "Numbered List", Some("CmdOrCtrl+Shift+7"))?)
        .item(&item("task", "Task List", Some("CmdOrCtrl+Shift+9"))?)
        .item(&item("quote", "Quote", Some("CmdOrCtrl+Shift+."))?)
        .separator()
        .item(&item("codeblock", "Code Block", Some("CmdOrCtrl+Alt+C"))?)
        .item(&item("table", "Table", Some("CmdOrCtrl+Alt+T"))?)
        .item(&item("rule", "Horizontal Rule", None)?)
        .build()?;

    let theme = SubmenuBuilder::new(app, "Appearance")
        .item(&item("theme_auto", "Match System", None)?)
        .item(&item("theme_light", "Light", None)?)
        .item(&item("theme_dark", "Dark", None)?)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&item("view_editor", "Editor Only", Some("CmdOrCtrl+Alt+1"))?)
        .item(&item("view_split", "Editor and Preview", Some("CmdOrCtrl+Alt+2"))?)
        .item(&item("view_preview", "Preview Only", Some("CmdOrCtrl+Alt+3"))?)
        .separator()
        .item(&item("sync_scroll", "Toggle Scroll Sync", None)?)
        .item(&item("zoom_in", "Larger Text", Some("CmdOrCtrl+="))?)
        .item(&item("zoom_out", "Smaller Text", Some("CmdOrCtrl+-"))?)
        .item(&item("zoom_reset", "Default Text Size", None)?)
        .separator()
        .item(&theme)
        .separator()
        .fullscreen()
        .build()?;

    let mut menu = MenuBuilder::new(app);
    if cfg!(target_os = "macos") {
        // The standard Quit item would end the app without giving the window a
        // chance to ask about unsaved changes, so Quit is routed through it.
        let app_menu = SubmenuBuilder::new(app, "Kladje")
            .about(None)
            .separator()
            .services()
            .separator()
            .hide()
            .hide_others()
            .show_all()
            .separator()
            .item(&item("quit", "Quit Kladje", Some("CmdOrCtrl+Q"))?)
            .build()?;
        menu = menu.item(&app_menu);
    }
    let mut menu = menu.item(&file).item(&edit).item(&format).item(&view);
    if cfg!(target_os = "macos") {
        let window = SubmenuBuilder::new(app, "Window").minimize().maximize().build()?;
        menu = menu.item(&window);
    }
    let help = SubmenuBuilder::new(app, "Help")
        .item(&item("guide", "Markdown Guide", None)?)
        .build()?;
    let menu = menu.item(&help);
    app.set_menu(menu.build()?)?;
    Ok(())
}

#[cfg(target_os = "macos")]
/// Hand a file to the window: remembered until the window asks for it, and
/// announced in case the window is already running.
fn request_open(app: &AppHandle, path: PathBuf) {
    if let Some(state) = app.try_state::<AppState>() {
        if let Ok(mut pending) = state.pending_open.lock() {
            *pending = Some(path.to_string_lossy().into_owned());
        }
    }
    let _ = app.emit("open-requested", ());
}

fn main() {
    // A file passed on the command line (Windows/Linux "Open with", or a terminal).
    let from_args = std::env::args_os()
        .skip(1)
        .map(PathBuf::from)
        .find(|p| p.is_file())
        .and_then(|p| std::path::absolute(p).ok())
        .map(|p| p.to_string_lossy().into_owned());

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            renderer: Renderer::new(),
            pending_open: Mutex::new(from_args),
        })
        .setup(|app| {
            app.manage(Mutex::new(Recovery::new(
                app.path().app_data_dir()?.join("recovery-v1"),
            )));
            build_menu(app.handle())?;
            Ok(())
        })
        .on_menu_event(|app, event| {
            let _ = app.emit("menu", event.id().0.as_str());
        })
        .invoke_handler(tauri::generate_handler![
            setup,
            take_pending_open,
            render,
            read_file,
            write_file,
            file_version,
            recovery_list,
            recovery_claim,
            recovery_write,
            recovery_clear,
            import_file,
            export_html,
            print_document,
            log_message,
            quit
        ])
        .build(tauri::generate_context!())
        .expect("error while starting Kladje");

    app.run(|app, event| {
        // Dock/system Quit can bypass our menu. A confirmed quit calls exit(0).
        if let tauri::RunEvent::ExitRequested {
            code: None, api, ..
        } = &event
        {
            if app.get_webview_window("main").is_some() {
                api.prevent_exit();
                let _ = app.emit("menu", "quit");
            }
        }
        // macOS delivers "open this document" as an event, not as an argument.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = &event {
            if let Some(path) = urls.iter().find_map(|u| u.to_file_path().ok()) {
                request_open(app, path);
            }
        }
    });
}
