// Kladje — a light, fast Markdown editor.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod window_geometry;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use tauri::menu::{
    CheckMenuItem, MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem, Submenu,
    SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use kladje::markdown::{Renderer, Target, PREVIEW_ID_PREFIX};
use kladje::recovery::{Candidate, Draft, Recovery};
use kladje::{export, fileio, import, storage};

struct AppState {
    renderer: Renderer,
    /// A file the OS asked us to open (command line, double-click, "Open with")
    /// that the window has not picked up yet.
    pending_open: Mutex<VecDeque<String>>,
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
        pending_open: state
            .pending_open
            .lock()
            .ok()
            .and_then(|mut p| p.pop_front()),
    }
}

#[tauri::command(async)]
fn take_pending_open(state: State<'_, AppState>) -> Option<String> {
    state
        .pending_open
        .lock()
        .ok()
        .and_then(|mut p| p.pop_front())
}

#[tauri::command(async)]
fn render(
    state: State<'_, AppState>,
    markdown: String,
    source: Option<String>,
    remote: Option<bool>,
) -> Result<String, String> {
    Ok(state
        .renderer
        .render_document(
            &markdown,
            Target::Preview,
            source.as_deref().map(Path::new),
            remote.unwrap_or(false),
        )?
        .html)
}

#[tauri::command(async)]
fn insert_image(source: String, image: String, copy: bool) -> Result<Option<String>, String> {
    kladje::images::insert_path(Path::new(&source), Path::new(&image), copy)
}

#[tauri::command(async)]
fn paste_image(source: String, encoded: String) -> Result<String, String> {
    kladje::images::paste(Path::new(&source), &encoded)
}

#[tauri::command(async)]
fn read_file(path: String) -> Result<fileio::Opened, String> {
    fileio::open_document(Path::new(&path))
}

#[tauri::command(async)]
fn comparison_text(path: String) -> Result<String, String> {
    fileio::comparison_text(Path::new(&path))
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
    export::export_document(
        &state.renderer,
        Path::new(&path),
        &markdown,
        &title,
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
    #[cfg(target_os = "macos")]
    {
        use objc2_app_kit::{NSPrintInfo, NSWindow};
        use objc2_web_kit::WKWebView;
        if !objc2::available!(macos = 11.0) {
            return Err("Native PDF printing requires macOS 11 or later.".into());
        }
        window
            .with_webview(|platform| {
                // Tauri provides these live AppKit/WebKit handles on the main thread.
                unsafe {
                    let webview = &*platform.inner().cast::<WKWebView>();
                    let parent = &*platform.ns_window().cast::<NSWindow>();
                    let info = NSPrintInfo::sharedPrintInfo();
                    info.setTopMargin(42.0);
                    info.setBottomMargin(42.0);
                    info.setLeftMargin(42.0);
                    info.setRightMargin(42.0);
                    let operation = webview.printOperationWithPrintInfo(&info);
                    if let Some(print_view) = operation.view() {
                        print_view.setFrame(webview.bounds());
                    }
                    operation.setCanSpawnSeparateThread(true);
                    operation.runOperationModalForWindow_delegate_didRunSelector_contextInfo(
                        parent,
                        None,
                        None,
                        std::ptr::null_mut(),
                    );
                }
            })
            .map_err(|e| e.to_string())
    }
    #[cfg(not(target_os = "macos"))]
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

struct CheckItems(Vec<CheckMenuItem<tauri::Wry>>);

#[tauri::command]
fn set_menu_checks(items: State<'_, CheckItems>, checked: Vec<String>) -> Result<(), String> {
    for item in &items.0 {
        let on = checked.contains(&item.id().0);
        item.set_checked(on).map_err(|e| e.to_string())?;
    }
    Ok(())
}

struct RecentMenu(Submenu<tauri::Wry>);

#[tauri::command]
fn set_recent_menu(
    app: AppHandle,
    menu: State<'_, RecentMenu>,
    paths: Vec<String>,
) -> Result<(), String> {
    let update = || -> tauri::Result<()> {
        for item in menu.0.items()? {
            menu.0.remove(&item)?;
        }
        for path in paths.iter().take(10) {
            let name = Path::new(path)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or(path);
            let duplicate = paths.iter().any(|other| {
                other != path && Path::new(other).file_name() == Path::new(path).file_name()
            });
            let label = if duplicate { path.as_str() } else { name };
            let item = MenuItem::with_id(
                &app,
                format!("recent:{path}"),
                label.replace('&', "&&"),
                true,
                None::<&str>,
            )?;
            menu.0.append(&item)?;
        }
        if !paths.is_empty() {
            menu.0.append(&PredefinedMenuItem::separator(&app)?)?;
        }
        menu.0.append(&MenuItem::with_id(
            &app,
            "clear_recent",
            "Clear Recent Documents",
            !paths.is_empty(),
            None::<&str>,
        )?)?;
        Ok(())
    };
    update().map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn document_headings(markdown: String) -> Result<Vec<kladje::markdown::Heading>, String> {
    kladje::markdown::headings(&markdown)
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

    let recent = SubmenuBuilder::new(app, "Open Recent").build()?;
    app.manage(RecentMenu(recent.clone()));
    let mut file = SubmenuBuilder::new(app, "File")
        .item(&item("new", "New", Some("CmdOrCtrl+N"))?)
        .item(&item("new_template", "New from Template…", None)?)
        .item(&item("open", "Open…", Some("CmdOrCtrl+O"))?)
        .item(&recent)
        .separator()
        .item(&item("save", "Save", Some("CmdOrCtrl+S"))?)
        .item(&item("save_as", "Save As…", Some("CmdOrCtrl+Shift+S"))?)
        .item(&item("compare_disk", "Compare with Disk…", None)?)
        .separator()
        .item(&item("import", "Import…", Some("CmdOrCtrl+Shift+I"))?)
        .item(&export);
    if !cfg!(target_os = "macos") {
        file = file
            .separator()
            .item(&item("quit", "Quit", Some("CmdOrCtrl+Q"))?);
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
        .item(&item(
            "jump_heading",
            "Jump to Heading…",
            Some("CmdOrCtrl+Shift+J"),
        )?)
        .item(&item("find", "Find and Replace…", Some("CmdOrCtrl+F"))?)
        .build()?;

    let heading = SubmenuBuilder::new(app, "Heading")
        .item(&item("h1", "Heading 1", Some("CmdOrCtrl+1"))?)
        .item(&item("h2", "Heading 2", Some("CmdOrCtrl+2"))?)
        .item(&item("h3", "Heading 3", Some("CmdOrCtrl+3"))?)
        .item(&item("h4", "Heading 4", Some("CmdOrCtrl+4"))?)
        .item(&item("h5", "Heading 5", Some("CmdOrCtrl+5"))?)
        .item(&item("h6", "Heading 6", Some("CmdOrCtrl+6"))?)
        .item(&item("h0", "Paragraph", Some("CmdOrCtrl+0"))?)
        .build()?;

    let format = SubmenuBuilder::new(app, "Format")
        .item(&item("bold", "Bold", Some("CmdOrCtrl+B"))?)
        .item(&item("italic", "Italic", Some("CmdOrCtrl+I"))?)
        .item(&item("strike", "Strikethrough", Some("CmdOrCtrl+Shift+X"))?)
        .item(&item("code", "Inline Code", Some("CmdOrCtrl+E"))?)
        .item(&item("link", "Link", Some("CmdOrCtrl+K"))?)
        .separator()
        .item(&item("insert_image", "Insert Local Image…", None)?)
        .item(&heading)
        .item(&item("bullet", "Bullet List", Some("CmdOrCtrl+Shift+8"))?)
        .item(&item(
            "numbered",
            "Numbered List",
            Some("CmdOrCtrl+Shift+7"),
        )?)
        .item(&item("task", "Task List", Some("CmdOrCtrl+Shift+9"))?)
        .item(&item("quote", "Quote", Some("CmdOrCtrl+Shift+."))?)
        .separator()
        .item(&item("codeblock", "Code Block", Some("CmdOrCtrl+Alt+C"))?)
        .item(&item("table", "Table", Some("CmdOrCtrl+Alt+T"))?)
        .item(&item("table_row", "Insert Table Row Below", None)?)
        .item(&item("rule", "Horizontal Rule", None)?)
        .build()?;

    let mut checks = Vec::new();
    let mut check = |id: &str, label: &str, accelerator: Option<&str>| -> tauri::Result<_> {
        let item = CheckMenuItem::with_id(app, id, label, true, false, accelerator)?;
        checks.push(item.clone());
        Ok(item)
    };
    let theme = SubmenuBuilder::new(app, "Appearance")
        .item(&check("theme_auto", "Match System", None)?)
        .item(&check("theme_light", "Light", None)?)
        .item(&check("theme_dark", "Dark", None)?)
        .build()?;

    let view = SubmenuBuilder::new(app, "View")
        .item(&check(
            "view_editor",
            "Editor Only",
            Some("CmdOrCtrl+Alt+1"),
        )?)
        .item(&check(
            "view_split",
            "Editor and Preview",
            Some("CmdOrCtrl+Alt+2"),
        )?)
        .item(&check(
            "view_preview",
            "Preview Only",
            Some("CmdOrCtrl+Alt+3"),
        )?)
        .separator()
        .item(&item(
            "remote_images",
            "Remote Images for This Document…",
            None,
        )?)
        .item(&check("sync_scroll", "Toggle Scroll Sync", None)?)
        .item(&check("gutter", "Line Numbers", None)?)
        .item(&check("wrap", "Wrap Long Lines", None)?)
        .item(&check("measure", "Limit Writing Width", None)?)
        .item(&item("zoom_in", "Larger Text", Some("CmdOrCtrl+="))?)
        .item(&item("zoom_out", "Smaller Text", Some("CmdOrCtrl+-"))?)
        .item(&item("zoom_reset", "Default Text Size", None)?)
        .separator()
        .item(&theme)
        .separator()
        .fullscreen()
        .build()?;

    app.manage(CheckItems(checks));
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
        let window = SubmenuBuilder::new(app, "Window")
            .minimize()
            .maximize()
            .build()?;
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
            pending.push_back(path.to_string_lossy().into_owned());
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
        .plugin(
            tauri::plugin::Builder::<tauri::Wry>::new("document-navigation")
                .on_navigation(|_, url| {
                    matches!(
                        (url.scheme(), url.host_str()),
                        ("tauri", Some("localhost")) | ("http" | "https", Some("tauri.localhost"))
                    ) && url.port().is_none()
                        && matches!(url.path(), "" | "/" | "/index.html")
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState {
            renderer: Renderer::new(),
            pending_open: Mutex::new(from_args.into_iter().collect()),
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
            set_recent_menu,
            set_menu_checks,
            window_geometry::window_bounds,
            window_geometry::restore_window_bounds,
            document_headings,
            render,
            read_file,
            comparison_text,
            write_file,
            file_version,
            recovery_list,
            recovery_claim,
            recovery_write,
            recovery_clear,
            import_file,
            export_html,
            insert_image,
            paste_image,
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
