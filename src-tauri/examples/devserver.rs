//! Development aid: serves the UI in an ordinary browser, backed by the real
//! Rust core, so the interface can be exercised without building the desktop app.
//!
//!     cargo run --example devserver            # then open http://127.0.0.1:4777
//!
//! Native things (menus, file dialogs, window title) are replaced by a small
//! shim; drive them from the browser console through `window.__dev`:
//!
//!     __dev.menu("bold")                        // any menu item id
//!     __dev.answers.open = "note.md"   // what the next Open dialog returns
//!     __dev.answers.save = "out.md"
//!     __dev.answers.message = "Don't Save"      // answer to the unsaved-changes prompt
//!
//! Not part of the shipped application. It only listens on 127.0.0.1.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use kladje::markdown::{Renderer, Target, PREVIEW_ID_PREFIX};
use kladje::recovery::Recovery;
use kladje::{export, fileio, history, import, storage};
use serde_json::{json, Value};

const SHIM: &str = r#"
(() => {
  const handlers = {};
  const call = async (cmd, args) => {
    const res = await fetch("/invoke/" + cmd, { method: "POST", body: JSON.stringify(args || {}) });
    const data = await res.json();
    if ("err" in data) throw data.err;
    return data.ok;
  };
  const dev = (window.__dev = {
    answers: { open: null, save: null, message: "Cancel", ask: false },
    log: [],
    opened: [],
    title: "",
    menu: (id) => handlers.menu && handlers.menu({ payload: id }),
    emit: (name, payload) => handlers[name] && handlers[name]({ payload }),
    closeRequested: null,
  });
  const note = (kind, detail) => { dev.log.push([kind, detail]); };
  window.__TAURI__ = {
    core: {
      invoke: async (cmd, args) => {
        if (cmd === "open_document_window") {
          // Browser preview uses fixture files. Exercise native ownership and Quit in the desktop build.
          const url = new URL(location.href);
          url.hash = encodeURIComponent(JSON.stringify(args.request));
          window.open(url, "_blank", "noopener");
          return;
        }
        if (cmd === "setup" && location.hash.length > 1) {
          const request = JSON.parse(decodeURIComponent(location.hash.slice(1)));
          const launch = {...request};
          if (request.kind === "open") launch.file = await call("read_file",request);
          if (request.kind === "import") launch.content = await call("import_file",request);
          if (request.kind === "template") launch.content = (await call("read_file",request)).content;
          return {...await call("setup"), launch};
        }
        if (cmd === "begin_close") return true;
        if (cmd === "quit_vote") {note("quit decision",args.allow); dev.emit("cancel-quit",args.epoch); return;}
        if (cmd === "print_document") { note("print"); return Promise.resolve(); }
        if (cmd === "quit") { note("quit"); dev.emit("prepare-quit",{epoch:Date.now(),rememberWindow:true}); return; }
        if (cmd === "log_message") { note("log", args.message); console.log("[ui]", args.message); return Promise.resolve(); }
        return call(cmd, args);
      },
    },
    event: { listen: async (name, cb) => { handlers[name] = cb; return () => {}; } },
    dialog: {
      open: async (o) => { note("dialog.open", o); const v = dev.answers.open; dev.answers.open = null; return v; },
      save: async (o) => { note("dialog.save", o); const v = dev.answers.save; dev.answers.save = null; return v; },
      message: async (m, o) => { note("dialog.message", m); return o && o.buttons ? dev.answers.message : "Ok"; },
      ask: async (m) => { note("dialog.ask", m); return dev.answers.ask; },
    },
    opener: { openUrl: async (url) => { dev.opened.push(url); } },
    window: {
      getCurrentWindow: () => ({
        setTitle: async (t) => { dev.title = t; },
        onCloseRequested: async (cb) => { dev.closeRequested = cb; return () => {}; },
        destroy: async () => note("destroy"),
      }),
    },
    webview: { getCurrentWebview: () => ({ onDragDropEvent: async (cb) => { dev.drop = (paths) => cb({ payload: { type: "drop", paths } }); return () => {}; } }) },
  };
})();
"#;

fn main() {
    let ui = Path::new(env!("CARGO_MANIFEST_DIR")).join("../ui");
    let renderer = Renderer::new();
    let profile = tempfile::tempdir().expect("create private development profile");
    let mut recovery = Recovery::new(profile.path().join("recovery-v1"));
    let fixtures = profile.path().join("documents");
    std::fs::create_dir(&fixtures).expect("create fixture folder");
    println!("Development documents: {}", fixtures.display());
    let port = std::env::args().nth(1).unwrap_or_else(|| "4777".into());
    let listener = TcpListener::bind(format!("127.0.0.1:{port}")).expect("port in use");
    println!("Kladje dev server on http://127.0.0.1:{port}");
    for stream in listener.incoming().flatten() {
        if let Err(e) = handle(stream, &ui, &renderer, &mut recovery, &fixtures) {
            eprintln!("request failed: {e}");
        }
    }
}

fn request_allowed(authority: &str, method: &str, host: &str, origin: &str, length: usize) -> bool {
    host == authority
        && length <= 16 * 1024 * 1024
        && match method {
            "GET" => length == 0,
            "POST" => origin == format!("http://{authority}"),
            _ => false,
        }
}

fn handle(
    stream: TcpStream,
    ui: &Path,
    renderer: &Renderer,
    recovery: &mut Recovery,
    fixtures: &Path,
) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(5)))?;
    let authority = stream.local_addr()?.to_string();
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    (&mut reader).take(8192).read_line(&mut request_line)?;
    if !request_line.ends_with('\n') {
        return Ok(());
    }
    let mut parts = request_line.split_whitespace();
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or("/"));

    let mut length = 0usize;
    let mut host = String::new();
    let mut origin = String::new();
    let mut header_size = 0;
    loop {
        let mut header = String::new();
        header_size += (&mut reader).take(8192).read_line(&mut header)?;
        if header_size > 32768 || !header.ends_with('\n') {
            return Ok(());
        }
        if header.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.eq_ignore_ascii_case("host") {
                host = value.trim().to_owned();
            }
            if name.eq_ignore_ascii_case("origin") {
                origin = value.trim().to_owned();
            }
            if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().unwrap_or(0);
            }
        }
    }
    if !request_allowed(&authority, method, &host, &origin, length) {
        let mut stream = stream;
        return stream.write_all(
            b"HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
        );
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;

    let (path, _) = target.split_once('?').unwrap_or((target, ""));
    let (status, mime, bytes): (&str, &str, Vec<u8>) = if method == "POST" {
        let args: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        let reply = match invoke(
            path.trim_start_matches("/invoke/"),
            &args,
            renderer,
            recovery,
            fixtures,
        ) {
            Ok(value) => json!({ "ok": value }),
            Err(message) => json!({ "err": message }),
        };
        ("200 OK", "application/json", reply.to_string().into_bytes())
    } else if path == "/__dev/shim.js" {
        ("200 OK", "text/javascript", SHIM.as_bytes().to_vec())
    } else {
        let relative = if path == "/" {
            "index.html"
        } else {
            path.trim_start_matches('/')
        };
        let file: PathBuf = ui.join(relative);
        let inside = file
            .canonicalize()
            .ok()
            .zip(ui.canonicalize().ok())
            .is_some_and(|(f, u)| f.starts_with(u));
        match (
            inside,
            if inside {
                std::fs::read(&file)
            } else {
                Err(std::io::ErrorKind::PermissionDenied.into())
            },
        ) {
            (true, Ok(bytes)) if relative == "index.html" => {
                let html = String::from_utf8_lossy(&bytes).replace(
                    "<script src=\"vendor/editor.js\">",
                    "<script src=\"/__dev/shim.js\"></script>\n  <script src=\"vendor/editor.js\">",
                );
                ("200 OK", "text/html; charset=utf-8", html.into_bytes())
            }
            (true, Ok(bytes)) => ("200 OK", mime_of(&file), bytes),
            _ => ("404 Not Found", "text/plain", b"not found".to_vec()),
        }
    };

    let mut stream = stream;
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nContent-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'\r\nConnection: close\r\n\r\n",
        bytes.len()
    )?;
    stream.write_all(&bytes)
}

fn invoke(
    command: &str,
    args: &Value,
    renderer: &Renderer,
    recovery: &mut Recovery,
    fixtures: &Path,
) -> Result<Value, String> {
    let text = |key: &str| {
        args.get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    let path = |key| fixture_path(fixtures, &text(key));
    let source = args["source"]
        .as_str()
        .map(|s| fixture_path(fixtures, s))
        .transpose()?;
    Ok(match command {
        "setup" => json!({
            "syntaxCssLight": renderer.syntax_css_light,
            "syntaxCssDark": renderer.syntax_css_dark,
            "idPrefix": PREVIEW_ID_PREFIX,
            "pendingOpen": null,
        }),
        "update_history" => {
            let mut store = history::Store::new(fixtures.with_file_name("recent-documents.json"));
            json!(store.update(
                serde_json::from_value(args["change"].clone()).map_err(|e| e.to_string())?,
                serde_json::from_value(args["seed"].clone()).map_err(|e| e.to_string())?
            )?)
        }
        "document_ready"
        | "take_fragment"
        | "cancel_close"
        | "accept_reload"
        | "set_menu_checks"
        | "window_bounds"
        | "restore_window_bounds" => Value::Null,
        "document_headings" => json!(kladje::markdown::headings(&text("markdown"))?),
        "diagram_sources" => json!(kladje::markdown::diagram_sources(&text("markdown"))?),
        "store_diagrams" => {
            renderer.store_diagrams(
                serde_json::from_value(args["diagrams"].clone()).map_err(|e| e.to_string())?,
            )?;
            Value::Null
        }
        "render" => json!(renderer.preview_update(
            &text("markdown"),
            source.as_deref(),
            args["remote"].as_bool().unwrap_or(false),
            serde_json::from_value(args["knownImages"].clone()).unwrap_or_default(),
            args["lineBreaks"].as_bool().unwrap_or(false)
        )?),
        "clipboard_markdown" if text("html").len() <= 1024 * 1024 => {
            json!(kladje::import::html_to_markdown(&text("html"))?)
        }
        "formatted_selection" if text("markdown").len() <= 256 * 1024 => json!(
            renderer
                .render_with_breaks(
                    &text("markdown"),
                    Target::Export,
                    None,
                    false,
                    args["lineBreaks"].as_bool().unwrap_or(false)
                )?
                .html
        ),
        "paste_image" => json!(kladje::images::paste(&path("source")?, &text("encoded"))?),
        "insert_image" => json!(kladje::images::insert_path(
            &path("source")?,
            &path("image")?,
            args["copy"].as_bool().unwrap_or(false)
        )?),
        "recovery_list" => json!(recovery.list().map_err(|e| e.to_string())?),
        "recovery_claim" => json!(recovery.claim(&text("id")).map_err(|e| e.to_string())?),
        "recovery_clear" => json!(recovery.clear(&text("id")).map_err(|e| e.to_string())?),
        "recovery_write" => {
            let draft = serde_json::from_value(args["draft"].clone()).map_err(|e| e.to_string())?;
            recovery.write(draft).map_err(|e| e.to_string())?;
            Value::Null
        }
        "comparison_text" => json!(fileio::comparison_text(&path("path")?)?),
        "read_file" => json!(fileio::open_document(&path("path")?)?),
        "write_file" => {
            let expected: Option<storage::Version> =
                serde_json::from_value(args["expected"].clone()).map_err(|e| e.to_string())?;
            let format =
                serde_json::from_value(args["format"].clone()).map_err(|e| e.to_string())?;
            json!(fileio::write_document(
                &path("path")?,
                &text("content"),
                &format,
                expected.as_ref()
            )?)
        }
        "file_stamp" => json!(storage::disk_stamp(&path("path")?)?),
        "file_version" => json!(storage::version(&path("path")?)?),
        "move_document" => {
            let expected: Option<storage::Version> =
                serde_json::from_value(args["expected"].clone()).map_err(|e| e.to_string())?;
            json!(storage::move_noclobber(
                &path("from")?,
                &path("to")?,
                expected.as_ref()
            )?)
        }
        "import_file" => json!(import::import(&path("path")?)?),
        "export_html" => {
            let expected: Option<storage::Version> =
                serde_json::from_value(args["expected"].clone()).map_err(|e| e.to_string())?;
            json!(export::export_document(
                renderer,
                &path("path")?,
                &text("markdown"),
                &text("title"),
                source.as_deref(),
                expected.as_ref(),
                args["lineBreaks"].as_bool().unwrap_or(false)
            )?)
        }
        "take_pending_open" => Value::Null,
        other => return Err(format!("unknown command {other}")),
    })
}

fn fixture_path(root: &Path, name: &str) -> Result<PathBuf, String> {
    let path = Path::new(name);
    let name = path.strip_prefix(root).unwrap_or(path);
    let mut parts = name.components();
    let Some(Component::Normal(file)) = parts.next() else {
        return Err("Choose a file in the development documents folder.".into());
    };
    let path = root.join(file);
    if parts.next().is_some() || path.is_symlink() {
        return Err("Use a direct, non-linked fixture file.".into());
    }
    Ok(path)
}

fn mime_of(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "css" => "text/css",
        "js" => "text/javascript",
        "md" => "text/markdown; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn development_requests_require_the_bound_authority_and_origin() {
        let host = "127.0.0.1:4777";
        assert!(request_allowed(host, "GET", host, "", 0));
        assert!(request_allowed(
            host,
            "POST",
            host,
            "http://127.0.0.1:4777",
            50
        ));
        assert!(!request_allowed(host, "GET", "another.test", "", 0));
        assert!(!request_allowed(
            host,
            "POST",
            host,
            "https://another.test",
            50
        ));
        assert!(!request_allowed(host, "POST", host, "", 50));
        assert!(!request_allowed(
            host,
            "POST",
            host,
            "http://127.0.0.1:4777",
            17 * 1024 * 1024
        ));
    }

    #[test]
    fn file_commands_accept_only_direct_fixture_children() {
        let root = tempfile::tempdir().unwrap();
        let local = root.path().join("sample note.md");
        assert_eq!(fixture_path(root.path(), "sample note.md").unwrap(), local);
        assert_eq!(
            fixture_path(root.path(), local.to_str().unwrap()).unwrap(),
            local
        );
        for path in ["", "../outside.txt", "/elsewhere.txt", "nested/file.md"] {
            assert!(fixture_path(root.path(), path).is_err());
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&local, root.path().join("linked.md")).unwrap();
            assert!(fixture_path(root.path(), "linked.md").is_err());
        }
    }
}
