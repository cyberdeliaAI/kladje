// Kladje — a light, fast Markdown editor.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod documents;
mod window_geometry;
use documents::{Decision, Documents, Launch, Request, Route};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, MutexGuard};

use serde::Serialize;
use tauri::menu::{
    CheckMenuItem, MenuBuilder, MenuItem, MenuItemBuilder, PredefinedMenuItem, Submenu,
    SubmenuBuilder,
};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};

use kladje::markdown::{Renderer, Target, PREVIEW_ID_PREFIX};
use kladje::recovery::{Candidate, Draft};
use kladje::{export, fileio, history, storage};

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
    launch: Option<Launch>,
}

#[tauri::command(async)]
fn setup(
    window: WebviewWindow,
    state: State<'_, AppState>,
    docs: Windows<'_>,
) -> Result<Setup, String> {
    Ok(Setup {
        syntax_css_light: state.renderer.syntax_css_light.clone(),
        syntax_css_dark: state.renderer.syntax_css_dark.clone(),
        id_prefix: PREVIEW_ID_PREFIX,
        launch: lock(&docs)?.get(window.label())?.launch.take(),
        pending_open: (window.label() == "main")
            .then(|| {
                state
                    .pending_open
                    .lock()
                    .ok()
                    .and_then(|mut p| p.pop_front())
            })
            .flatten(),
    })
}

#[tauri::command(async)]
fn take_pending_open(
    window: WebviewWindow,
    docs: Windows<'_>,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let docs = lock(&docs)?;
    let receiver = if docs.windows.contains_key("main") {
        Some("main")
    } else {
        docs.windows.keys().next().map(String::as_str)
    };
    if receiver != Some(window.label())
        || docs.quitting.is_some()
        || docs.windows[window.label()].closing
    {
        return Ok(None);
    }
    Ok(state
        .pending_open
        .lock()
        .map_err(|e| e.to_string())?
        .pop_front())
}

#[tauri::command(async)]
fn render(
    state: State<'_, AppState>,
    markdown: String,
    source: Option<String>,
    remote: Option<bool>,
    known_images: Option<Vec<String>>,
) -> Result<kladje::markdown::Rendered, String> {
    state.renderer.preview_update(
        &markdown,
        source.as_deref().map(Path::new),
        remote.unwrap_or(false),
        known_images.unwrap_or_default(),
    )
}

#[tauri::command(async)]
fn clipboard_markdown(html: String) -> Result<String, String> {
    if html.len() > 1024 * 1024 {
        return Err("Clipboard HTML exceeds 1 MiB.".into());
    }
    kladje::import::html_to_markdown(&html)
}

#[tauri::command(async)]
fn formatted_selection(state: State<'_, AppState>, markdown: String) -> Result<String, String> {
    if markdown.len() > 256 * 1024 {
        return Err("Select up to 256 KiB to copy formatted text.".into());
    }
    let html = state
        .renderer
        .render_document(&markdown, Target::Export, None, false)?
        .html;
    #[cfg(target_os = "macos")]
    {
        clipboard::write(
            &objc2_app_kit::NSPasteboard::generalPasteboard(),
            &markdown,
            &html,
        )?;
        Ok(String::new())
    }
    #[cfg(not(target_os = "macos"))]
    Ok(html)
}

#[cfg(target_os = "macos")]
mod clipboard;

#[tauri::command(async)]
fn reveal_document(path: String) -> Result<(), String> {
    let path = Path::new(&path);
    fileio::markdown_path(path)?;
    if !path.is_absolute() || !path.is_file() {
        return Err("The document is no longer at its saved location.".into());
    }
    tauri_plugin_opener::reveal_item_in_dir(path).map_err(|e| e.to_string())
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
fn read_file(
    window: WebviewWindow,
    docs: Windows<'_>,
    path: String,
    bind: Option<bool>,
) -> Result<fileio::Opened, String> {
    let file = fileio::open_document(Path::new(&path))?;
    if bind == Some(true) {
        lock(&docs)?.bind_version(window.label(), Path::new(&path), &file.version)?;
    }
    Ok(file)
}

#[tauri::command(async)]
fn comparison_text(path: String) -> Result<String, String> {
    fileio::comparison_text(Path::new(&path))
}

#[tauri::command(async)]
fn write_file(
    window: WebviewWindow,
    docs: Windows<'_>,
    bind: Option<bool>,
    path: String,
    content: String,
    format: fileio::TextFormat,
    expected: Option<storage::Version>,
) -> Result<storage::Written, String> {
    lock(&docs)?.write(window.label(), Path::new(&path), bind == Some(true), || {
        fileio::write_document(Path::new(&path), &content, &format, expected.as_ref())
    })
}

#[tauri::command(async)]
fn save_protected_copy(
    window: WebviewWindow,
    docs: Windows<'_>,
    path: String,
    content: String,
    format: fileio::TextFormat,
) -> Result<storage::Written, String> {
    lock(&docs)?.write(window.label(), Path::new(&path), true, || {
        fileio::copy_document(Path::new(&path), &content, &format)
    })
}

#[tauri::command(async)]
fn file_version(path: String) -> Result<Option<storage::Version>, String> {
    storage::version(Path::new(&path))
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

type Windows<'a> = State<'a, Mutex<Documents>>;

fn lock<'a>(docs: &'a Mutex<Documents>) -> Result<MutexGuard<'a, Documents>, String> {
    docs.lock().map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn recovery_list(window: WebviewWindow, docs: Windows<'_>) -> Result<Vec<Candidate>, String> {
    lock(&docs)?
        .get(window.label())?
        .recovery
        .list()
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn recovery_claim(
    window: WebviewWindow,
    docs: Windows<'_>,
    id: String,
    restore: Option<bool>,
) -> Result<Draft, String> {
    let mut docs = lock(&docs)?;
    let mut draft = docs
        .get(window.label())?
        .recovery
        .claim(&id)
        .map_err(|e| e.to_string())?;
    if restore == Some(true) {
        if let Some(path) = &draft.path {
            if docs.bind(window.label(), path).is_err() {
                // Another window can own this name. Restore the edits as an unbound draft.
                draft.path = None;
                draft.version = None;
            }
        }
    }
    Ok(draft)
}

#[tauri::command(async)]
fn recovery_write(window: WebviewWindow, docs: Windows<'_>, draft: Draft) -> Result<(), String> {
    lock(&docs)?
        .get(window.label())?
        .recovery
        .write(draft)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn recovery_clear(window: WebviewWindow, docs: Windows<'_>, id: String) -> Result<(), String> {
    lock(&docs)?
        .get(window.label())?
        .recovery
        .clear(&id)
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn open_document_window(
    window: WebviewWindow,
    docs: Windows<'_>,
    request: Request,
    tab: Option<bool>,
) -> Result<(), String> {
    let app = window.app_handle();
    let _group = tab == Some(true) && matches!(request, Request::New);
    let route = lock(&docs)?.reserve(request)?;
    match route {
        Route::Create(label) => {
            let mut config = app.config().app.windows[0].clone();
            config.label.clone_from(&label);
            let result = tauri::WebviewWindowBuilder::from_config(app, &config)
                .and_then(|builder| builder.build());
            match result {
                Ok(created) => {
                    configure_document(&created)?;
                    #[cfg(target_os = "macos")]
                    if _group {
                        let source = window.clone();
                        created
                            .with_webview(move |platform| {
                                use objc2_app_kit::{NSWindow, NSWindowOrderingMode};
                                if let Ok(ptr) = source.ns_window() {
                                    // Both native handles belong to live windows on the AppKit thread.
                                    let parent = unsafe { &*ptr.cast::<NSWindow>() };
                                    let child =
                                        unsafe { &*platform.ns_window().cast::<NSWindow>() };
                                    if !parent
                                        .tabbedWindows()
                                        .is_some_and(|tabs| tabs.containsObject(child))
                                    {
                                        parent.addTabbedWindow_ordered(
                                            child,
                                            NSWindowOrderingMode::Above,
                                        );
                                    }
                                    child.makeKeyAndOrderFront(None);
                                }
                            })
                            .map_err(|e| e.to_string())?;
                    }
                    Ok(())
                }
                Err(error) => {
                    remove_window(app, &label);
                    Err(error.to_string())
                }
            }
        }
        Route::Focus(label) => {
            if let Some(window) = app.get_webview_window(&label) {
                if window.is_minimized().unwrap_or(false) {
                    window.unminimize().map_err(|e| e.to_string())?;
                }
                window.set_focus().map_err(|e| e.to_string())?;
                app.emit_to(label.as_str(), "document-fragment", ())
                    .map_err(|e| e.to_string())?;
            }
            Ok(())
        }
    }
}

fn configure_document(_window: &WebviewWindow) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    _window
        .with_webview(|platform| {
            if let Some(mtm) = objc2::MainThreadMarker::new() {
                objc2_app_kit::NSWindow::setAllowsAutomaticWindowTabbing(true, mtm);
            }
            let view = unsafe { &*platform.inner().cast::<objc2_web_kit::WKWebView>() };
            unsafe { view.configuration().preferences().setTabFocusesLinks(true) };
        })
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command(async)]
fn take_fragment(window: WebviewWindow, docs: Windows<'_>) -> Result<Option<String>, String> {
    Ok(lock(&docs)?.get(window.label())?.fragment.take())
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

fn prompt_next(app: &AppHandle) -> Result<(), String> {
    let docs = app.state::<Mutex<Documents>>();
    let next = {
        let docs = lock(&docs)?;
        docs.quitting.as_ref().and_then(|quit| {
            let label = quit.waiting.front()?;
            docs.windows
                .get(label)?
                .ready
                .then(|| (label.clone(), quit.epoch, quit.first_window()))
        })
    };
    if let Some((label, epoch, first)) = next {
        let window = app
            .get_webview_window(&label)
            .ok_or("Document window closed.")?;
        if window.is_minimized().unwrap_or(false) {
            let _ = window.unminimize();
        }
        window.set_focus().map_err(|e| e.to_string())?;
        app.emit_to(
            label.as_str(),
            "prepare-quit",
            serde_json::json!({"epoch":epoch,"rememberWindow":first}),
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn continue_quit(app: &AppHandle) -> Result<(), String> {
    if let Err(error) = prompt_next(app) {
        let attempt = lock(&app.state::<Mutex<Documents>>())?.quitting.take();
        if let Some(attempt) = attempt {
            app.emit("cancel-quit", attempt.epoch)
                .map_err(|e| e.to_string())?;
        }
        return Err(error);
    }
    Ok(())
}

#[tauri::command]
fn begin_close(window: WebviewWindow, docs: Windows<'_>) -> Result<bool, String> {
    lock(&docs)?.begin_close(window.label())
}

#[tauri::command]
fn cancel_close(window: WebviewWindow, docs: Windows<'_>) -> Result<(), String> {
    lock(&docs)?.get(window.label())?.closing = false;
    window
        .app_handle()
        .emit("open-requested", ())
        .map_err(|e| e.to_string())
}

#[tauri::command(async)]
fn accept_reload(
    window: WebviewWindow,
    docs: Windows<'_>,
    path: String,
    version: storage::Version,
) -> Result<(), String> {
    lock(&docs)?.bind_version(window.label(), Path::new(&path), &version)
}

#[tauri::command]
fn document_ready(window: WebviewWindow, docs: Windows<'_>) -> Result<(), String> {
    let mut docs = lock(&docs)?;
    docs.get(window.label())?.ready = true;
    let waiting = docs
        .quitting
        .as_ref()
        .and_then(|q| q.waiting.front())
        .is_some_and(|s| s == window.label());
    drop(docs);
    if waiting {
        continue_quit(window.app_handle())?;
    }
    Ok(())
}

#[tauri::command]
fn quit(window: WebviewWindow, docs: Windows<'_>) -> Result<(), String> {
    if lock(&docs)?.start_quit(window.label()) {
        continue_quit(window.app_handle())?;
    }
    Ok(())
}

#[tauri::command(async)]
fn quit_vote(
    window: WebviewWindow,
    docs: Windows<'_>,
    epoch: u64,
    allow: bool,
    draft: Option<String>,
) -> Result<(), String> {
    let decision = lock(&docs)?.vote(window.label(), epoch, allow, draft)?;
    let app = window.app_handle();
    match decision {
        Decision::Cancel => {
            app.emit("cancel-quit", epoch).map_err(|e| e.to_string())?;
            app.emit("open-requested", ()).map_err(|e| e.to_string())
        }
        Decision::Next => continue_quit(app),
        Decision::Finish(approved) => {
            let mut docs = lock(&docs)?;
            for (label, draft) in approved {
                if let Some(id) = draft {
                    // An undeletable draft is retained for the next launch.
                    if let Err(e) = docs.get(&label)?.recovery.clear(&id) {
                        eprintln!("Recovery cleanup: {e}");
                    }
                }
            }
            drop(docs);
            app.exit(0);
            Ok(())
        }
    }
}

fn remove_window(app: &AppHandle, label: &str) {
    if let Some(docs) = app.try_state::<Mutex<Documents>>() {
        if let Ok(mut windows) = docs.lock() {
            windows.windows.remove(label);
            let attempt = windows.interrupt_quit();
            drop(windows);
            if let Some(epoch) = attempt {
                let _ = app.emit("cancel-quit", epoch);
            }
            let _ = app.emit("open-requested", ());
        }
    }
}

// Choosing a native menu item can temporarily remove keyboard focus. With a
// sole document the destination is unambiguous. With several, never guess.
fn route_menu(app: &AppHandle, id: &str) {
    let windows = app.webview_windows();
    let target = if windows.len() == 1 {
        windows.values().next()
    } else {
        windows
            .values()
            .find(|window| window.is_focused().unwrap_or(false))
    };
    if id == "quit" {
        if let Some(window) = target.or_else(|| windows.values().next()) {
            if let Err(e) = quit(window.clone(), app.state()) {
                eprintln!("Quit: {e}");
            }
        }
    } else if let Some(window) = target {
        let _ = app.emit_to(window.label(), "menu", id);
    }
}

struct CheckItems(Vec<CheckMenuItem<tauri::Wry>>);

#[tauri::command]
fn set_menu_checks(
    window: WebviewWindow,
    items: State<'_, CheckItems>,
    checked: Vec<String>,
) -> Result<(), String> {
    if !window.is_focused().unwrap_or(false) {
        return Ok(());
    }
    for item in &items.0 {
        let on = checked.contains(&item.id().0);
        item.set_checked(on).map_err(|e| e.to_string())?;
    }
    Ok(())
}

struct RecentMenu(Submenu<tauri::Wry>);

#[tauri::command]
fn update_history(
    app: AppHandle,
    menu: State<'_, RecentMenu>,
    store: State<'_, Mutex<history::Store>>,
    change: history::Change,
    seed: Option<history::History>,
) -> Result<history::History, String> {
    let mut store = store.lock().map_err(|e| e.to_string())?;
    let previous = store.current().map(|h| h.paths().to_owned());
    let history = store.update(change, seed)?;
    let paths = history.paths();
    if previous.as_deref() == Some(paths) {
        return Ok(history);
    }
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
    update().map_err(|e| e.to_string())?;
    Ok(history)
}

#[tauri::command(async)]
fn document_headings(markdown: String) -> Result<Vec<kladje::markdown::Heading>, String> {
    kladje::markdown::headings(&markdown)
}

#[tauri::command(async)]
fn diagram_sources(markdown: String) -> Result<Vec<String>, String> {
    kladje::markdown::diagram_sources(&markdown)
}

#[tauri::command(async)]
fn store_diagrams(
    state: State<'_, AppState>,
    diagrams: Vec<export::Diagram>,
) -> Result<(), String> {
    state.renderer.store_diagrams(diagrams)
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
    let file = SubmenuBuilder::new(app, "File").item(&item("new", "New", Some("CmdOrCtrl+N"))?);
    #[cfg(target_os = "macos")]
    let file = file.item(&item("new_tab", "New Tab", Some("Cmd+T"))?);
    let mut file = file
        .item(&item("new_template", "New from Template…", None)?)
        .item(&item("open", "Open…", Some("CmdOrCtrl+O"))?)
        .item(&recent)
        .item(&item(
            "reveal",
            if cfg!(target_os = "macos") {
                "Reveal in Finder"
            } else {
                "Show in Folder"
            },
            None,
        )?)
        .separator()
        .item(&item("save", "Save", Some("CmdOrCtrl+S"))?)
        .item(&item("save_as", "Save As…", Some("CmdOrCtrl+Shift+S"))?)
        .item(&item("compare_disk", "Compare with Disk…", None)?)
        .separator()
        .item(&item("import", "Import…", Some("CmdOrCtrl+Shift+I"))?)
        .item(&export)
        .separator()
        .item(&item("close_window", "Close Window", Some("CmdOrCtrl+W"))?);
    if !cfg!(target_os = "macos") {
        file = file
            .item(&item("settings", "Settings…", Some("CmdOrCtrl+Comma"))?)
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
        .item(&item("copy_formatted", "Copy as Formatted Text", None)?)
        .select_all()
        .separator()
        .item(&item(
            "jump_heading",
            "Jump to Heading…",
            Some("CmdOrCtrl+Shift+J"),
        )?)
        .item(&item("find", "Find and Replace…", Some("CmdOrCtrl+F"))?)
        .item(&item(
            "find_selection",
            "Use Selection for Find",
            Some("CmdOrCtrl+E"),
        )?)
        .build()?;

    let heading = SubmenuBuilder::new(app, "Heading")
        .item(&item("h1", "Heading 1", Some("CmdOrCtrl+1"))?)
        .item(&item("h2", "Heading 2", Some("CmdOrCtrl+2"))?)
        .item(&item("h3", "Heading 3", Some("CmdOrCtrl+3"))?)
        .item(&item("h4", "Heading 4", Some("CmdOrCtrl+4"))?)
        .item(&item("h5", "Heading 5", Some("CmdOrCtrl+5"))?)
        .item(&item("h6", "Heading 6", Some("CmdOrCtrl+6"))?)
        .item(&item("h0", "Paragraph", Some("CmdOrCtrl+Alt+0"))?)
        .build()?;

    let format = SubmenuBuilder::new(app, "Format")
        .item(&item("bold", "Bold", Some("CmdOrCtrl+B"))?)
        .item(&item("italic", "Italic", Some("CmdOrCtrl+I"))?)
        .item(&item("strike", "Strikethrough", Some("CmdOrCtrl+Shift+X"))?)
        .item(&item("code", "Inline Code", Some("CmdOrCtrl+Shift+C"))?)
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
        .item(&check("document_outline", "Document Outline", None)?)
        .item(&check("sync_scroll", "Synchronize Scrolling", None)?)
        .item(&item("fold", "Fold or Unfold at Cursor", None)?)
        .item(&check("gutter", "Line Numbers", None)?)
        .item(&check("wrap", "Wrap Long Lines", None)?)
        .item(&check("measure", "Limit Writing Width", None)?)
        .item(&item("zoom_in", "Larger Text", Some("CmdOrCtrl+="))?)
        .item(&item("zoom_out", "Smaller Text", Some("CmdOrCtrl+-"))?)
        .item(&item(
            "zoom_reset",
            "Default Text Size",
            Some("CmdOrCtrl+0"),
        )?)
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
            .item(&item("settings", "Settings…", Some("CmdOrCtrl+Comma"))?)
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
        let window = SubmenuBuilder::with_id(app, tauri::menu::WINDOW_SUBMENU_ID, "Window")
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
    #[cfg(target_os = "macos")]
    app.run_on_main_thread(|| {
        use objc2::{sel, MainThreadMarker};
        use objc2_app_kit::NSApplication;
        use objc2_foundation::NSString;
        let mtm = MainThreadMarker::new().expect("AppKit menu on main thread");
        let app = NSApplication::sharedApplication(mtm);
        if let Some(menu) = app.windowsMenu() {
            for (title, action) in [
                ("Move Tab to New Window", sel!(moveTabToNewWindow:)),
                ("Merge All Windows", sel!(mergeAllWindows:)),
            ] {
                if !menu
                    .itemArray()
                    .iter()
                    .any(|item| item.action() == Some(action))
                {
                    // Standard NSWindow responder actions, taking a single sender argument.
                    unsafe {
                        menu.addItemWithTitle_action_keyEquivalent(
                            &NSString::from_str(title),
                            Some(action),
                            &NSString::new(),
                        )
                    };
                }
            }
        }
    })?;
    Ok(())
}

#[cfg(target_os = "macos")]
/// Hand a file to the window: remembered until the window asks for it, and
/// announced in case the window is already running.
fn request_open(app: &AppHandle, path: PathBuf) {
    // A Finder Open arriving during review is a new user action. Retain the
    // documents under review and let the new request proceed.
    let epoch = app
        .try_state::<Mutex<Documents>>()
        .and_then(|docs| docs.lock().ok()?.interrupt_quit());
    if let Some(epoch) = epoch {
        let _ = app.emit("cancel-quit", epoch);
    }
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
        .filter(|p| p.is_file())
        .filter_map(|p| std::path::absolute(p).ok())
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
            pending_open: Mutex::new(from_args.collect()),
        })
        .setup(|app| {
            app.manage(Mutex::new(history::Store::new(
                app.path().app_data_dir()?.join("recent-documents.json"),
            )));
            app.manage(Mutex::new(Documents::new(
                app.path().app_data_dir()?.join("recovery-v1"),
            )));
            if let Some(window) = app.get_webview_window("main") {
                configure_document(&window)?;
            }
            build_menu(app.handle())?;
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                remove_window(window.app_handle(), window.label());
            }
        })
        .on_menu_event(|app, event| {
            route_menu(app, event.id().0.as_str());
        })
        .invoke_handler(tauri::generate_handler![
            setup,
            open_document_window,
            take_fragment,
            document_ready,
            quit_vote,
            take_pending_open,
            update_history,
            set_menu_checks,
            window_geometry::window_bounds,
            window_geometry::restore_window_bounds,
            document_headings,
            diagram_sources,
            store_diagrams,
            render,
            read_file,
            comparison_text,
            write_file,
            save_protected_copy,
            file_version,
            recovery_list,
            recovery_claim,
            recovery_write,
            recovery_clear,
            accept_reload,
            begin_close,
            cancel_close,
            export_html,
            insert_image,
            paste_image,
            clipboard_markdown,
            formatted_selection,
            reveal_document,
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
            if !app.webview_windows().is_empty() {
                api.prevent_exit();
                route_menu(app, "quit");
            }
        }
        // macOS delivers "open this document" as an event, not as an argument.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = &event {
            for path in urls.iter().filter_map(|u| u.to_file_path().ok()) {
                request_open(app, path);
            }
        }
    });
}
