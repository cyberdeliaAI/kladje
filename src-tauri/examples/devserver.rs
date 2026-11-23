//! Development aid: serves the UI in an ordinary browser, backed by the real
//! Rust core, so the interface can be exercised without building the desktop app.
//!
//!     cargo run --example devserver            # then open http://127.0.0.1:4777
//!
//! Native things (menus, file dialogs, window title) are replaced by a small
//! shim; drive them from the browser console through `window.__dev`:
//!
//!     __dev.menu("bold")                        // any menu item id
//!     __dev.answers.open = "/path/to/file.md"   // what the next Open dialog returns
//!     __dev.answers.save = "/tmp/out.md"
//!     __dev.answers.message = "Don't Save"      // answer to the unsaved-changes prompt
//!
//! Not part of the shipped application. It only listens on 127.0.0.1.

use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};

use kladje::markdown::{Renderer, Target, PREVIEW_ID_PREFIX};
use kladje::recovery::Recovery;
use kladje::{export, fileio, import, storage};
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
      invoke: (cmd, args) => {
        if (cmd === "print_document") { note("print"); return Promise.resolve(); }
        if (cmd === "quit") { note("quit"); return Promise.resolve(); }
        if (cmd === "log_message") { note("log", args.message); console.log("[ui]", args.message); return Promise.resolve(); }
        return call(cmd, args);
      },
      convertFileSrc: (path) => "/__file?path=" + encodeURIComponent(path),
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
    let port = std::env::args().nth(1).unwrap_or_else(|| "4777".into());
    let listener = TcpListener::bind(format!("127.0.0.1:{port}")).expect("port in use");
    println!("Kladje dev server on http://127.0.0.1:{port}");
    for stream in listener.incoming().flatten() {
        if let Err(e) = handle(stream, &ui, &renderer, &mut recovery) {
            eprintln!("request failed: {e}");
        }
    }
}

fn handle(
    stream: TcpStream,
    ui: &Path,
    renderer: &Renderer,
    recovery: &mut Recovery,
) -> std::io::Result<()> {
    let mut reader = BufReader::new(stream.try_clone()?);
    let mut request_line = String::new();
    reader.read_line(&mut request_line)?;
    let mut parts = request_line.split_whitespace();
    let (method, target) = (parts.next().unwrap_or(""), parts.next().unwrap_or("/"));

    let mut length = 0usize;
    loop {
        let mut header = String::new();
        if reader.read_line(&mut header)? == 0 || header.trim().is_empty() {
            break;
        }
        if let Some((name, value)) = header.split_once(':') {
            if name.eq_ignore_ascii_case("content-length") {
                length = value.trim().parse().unwrap_or(0);
            }
        }
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body)?;

    let (path, query) = target.split_once('?').unwrap_or((target, ""));
    let (status, mime, bytes): (&str, &str, Vec<u8>) = if method == "POST" {
        let args: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
        let reply = match invoke(
            path.trim_start_matches("/invoke/"),
            &args,
            renderer,
            recovery,
        ) {
            Ok(value) => json!({ "ok": value }),
            Err(message) => json!({ "err": message }),
        };
        ("200 OK", "application/json", reply.to_string().into_bytes())
    } else if path == "/__dev/shim.js" {
        ("200 OK", "text/javascript", SHIM.as_bytes().to_vec())
    } else if path == "/__file" {
        let file = percent_decode(query.trim_start_matches("path="));
        match std::fs::read(&file) {
            Ok(bytes) => ("200 OK", mime_of(Path::new(&file)), bytes),
            Err(_) => ("404 Not Found", "text/plain", b"not found".to_vec()),
        }
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
        match (inside, std::fs::read(&file)) {
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
        "HTTP/1.1 {status}\r\nContent-Type: {mime}\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
        bytes.len()
    )?;
    stream.write_all(&bytes)
}

fn invoke(
    command: &str,
    args: &Value,
    renderer: &Renderer,
    recovery: &mut Recovery,
) -> Result<Value, String> {
    let text = |key: &str| {
        args.get(key)
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string()
    };
    Ok(match command {
        "setup" => json!({
            "syntaxCssLight": renderer.syntax_css_light,
            "syntaxCssDark": renderer.syntax_css_dark,
            "idPrefix": PREVIEW_ID_PREFIX,
            "pendingOpen": null,
        }),
        "render" => json!(renderer.render(&text("markdown"), Target::Preview)),
        "recovery_list" => json!(recovery.list().map_err(|e| e.to_string())?),
        "recovery_claim" => json!(recovery.claim(&text("id")).map_err(|e| e.to_string())?),
        "recovery_clear" => json!(recovery.clear(&text("id")).map_err(|e| e.to_string())?),
        "recovery_write" => {
            let draft = serde_json::from_value(args["draft"].clone()).map_err(|e| e.to_string())?;
            recovery.write(draft).map_err(|e| e.to_string())?;
            Value::Null
        }
        "read_file" => json!(fileio::open_document(Path::new(&text("path")))?),
        "write_file" => {
            let expected: Option<storage::Version> =
                serde_json::from_value(args["expected"].clone()).map_err(|e| e.to_string())?;
            let format =
                serde_json::from_value(args["format"].clone()).map_err(|e| e.to_string())?;
            json!(fileio::write_document(
                Path::new(&text("path")),
                &text("content"),
                &format,
                expected.as_ref()
            )?)
        }
        "file_version" => json!(storage::version(Path::new(&text("path")))?),
        "import_file" => json!(import::import(Path::new(&text("path")))?),
        "export_html" => {
            let html = export::standalone_html(renderer, &text("markdown"), &text("title"));
            let expected: Option<storage::Version> =
                serde_json::from_value(args["expected"].clone()).map_err(|e| e.to_string())?;
            json!(export::write_html(
                Path::new(&text("path")),
                &html,
                args["source"].as_str().map(Path::new),
                expected.as_ref()
            )?)
        }
        "take_pending_open" => Value::Null,
        other => return Err(format!("unknown command {other}")),
    })
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() + 1 && i + 3 <= bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok();
            if let Some(byte) = hex.and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
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
