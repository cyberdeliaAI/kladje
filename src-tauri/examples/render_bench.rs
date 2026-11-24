//! Measurement aid: time the Rust side of one preview update for given files.
//!
//!     node scripts/large-documents/fixture.mjs /tmp/kladje-fixtures
//!     cargo run --release --locked --example render_bench -- /tmp/kladje-fixtures/*.md
//!
//! Prints one Markdown table row per file. Not part of the shipped application.

use std::time::{Duration, Instant};

use kladje::markdown::{headings, Renderer, Target};

fn median(mut samples: Vec<Duration>) -> f64 {
    samples.sort();
    samples[samples.len() / 2].as_secs_f64() * 1000.0
}

fn timed<T>(runs: usize, mut work: impl FnMut() -> T) -> (f64, T) {
    let mut samples = Vec::with_capacity(runs);
    let mut last = None;
    for _ in 0..runs {
        let started = Instant::now();
        let value = work();
        samples.push(started.elapsed());
        last = Some(value);
    }
    (median(samples), last.expect("at least one run"))
}

fn main() {
    let renderer = Renderer::new();
    println!(
        "| File | Source KiB | Preview ms | HTML KiB | HTML/source | Export ms | Headings ms |"
    );
    println!("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
    for path in std::env::args().skip(1) {
        let markdown = std::fs::read_to_string(&path).expect("readable UTF-8 fixture");
        let runs = if markdown.len() > 8 << 20 { 3 } else { 7 };
        // The first render also warms syntect's lazily compiled grammars.
        let _ = renderer.preview_update(&markdown, None, false, Vec::new(), true);
        let (preview, html) = timed(runs, || {
            renderer
                .preview_update(&markdown, None, false, Vec::new(), true)
                .expect("preview")
                .html
        });
        let (export, _) = timed(runs, || {
            renderer
                .render_document(&markdown, Target::Export, None, false)
                .expect("export")
                .html
                .len()
        });
        let (outline, _) = timed(runs, || headings(&markdown).map(|h| h.len()).unwrap_or(0));
        let name = std::path::Path::new(&path)
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or(&path);
        println!(
            "| {name} | {:.0} | {preview:.1} | {:.0} | {:.2} | {export:.1} | {outline:.1} |",
            markdown.len() as f64 / 1024.0,
            html.len() as f64 / 1024.0,
            html.len() as f64 / markdown.len() as f64,
        );
    }
}
