//! Import other formats as Markdown: HTML, Word (.docx) and plain text.

use std::collections::HashMap;
#[cfg(test)]
use std::fs::File;
use std::io::Read;
use std::path::Path;

use quick_xml::events::{BytesStart, Event};
use quick_xml::Reader;

use crate::fileio;

/// Upper bound for a single XML part inside a .docx (guards against zip bombs).
const MAX_PART_BYTES: u64 = 16 * 1024 * 1024;

pub fn import(path: &Path) -> Result<String, String> {
    let ext = path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "html" | "htm" | "xhtml" => html_to_markdown(&fileio::read_text(path)?.text),
        "docx" => docx_to_markdown(path),
        "doc" => Err(
            "The old .doc format is not supported. Save the file as .docx in Word first.".into(),
        ),
        "txt" => Ok(fileio::read_text(path)?.text),
        _ => Err("Choose an HTML, Word (.docx), or plain text (.txt) file to import.".into()),
    }
}

pub fn html_to_markdown(html: &str) -> Result<String, String> {
    use htmd::options::{BulletListMarker, CodeBlockStyle, HeadingStyle, Options};

    let converter = htmd::HtmlToMarkdown::builder()
        .skip_tags(vec![
            "script", "style", "noscript", "head", "iframe", "svg", "template",
        ])
        .options(Options {
            heading_style: HeadingStyle::Atx,
            code_block_style: CodeBlockStyle::Fenced,
            bullet_list_marker: BulletListMarker::Dash,
            ul_bullet_spacing: 1,
            ol_number_spacing: 1,
            ..Default::default()
        })
        .build();
    let markdown = converter
        .convert(html)
        .map_err(|e| format!("The HTML could not be converted: {e}"))?;
    Ok(tidy(&markdown))
}

/// Preserve interior whitespace, especially hard breaks and fenced code.
fn tidy(markdown: &str) -> String {
    let body = markdown.trim_matches('\n');
    if body.is_empty() {
        String::new()
    } else {
        format!("{body}\n")
    }
}

// ---------------------------------------------------------------------------
// Word (.docx)

pub fn docx_to_markdown(path: &Path) -> Result<String, String> {
    let (bytes, _) = crate::storage::read(path)?;
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(bytes))
        .map_err(|_| "This file is not a valid Word document (.docx).".to_owned())?;
    let mut part = |name: &str, root: &str| -> Result<Option<String>, String> {
        let entry = match archive.by_name(name) {
            Ok(entry) => entry,
            Err(zip::result::ZipError::FileNotFound) => return Ok(None),
            Err(e) => return Err(format!("{name}: {e}")),
        };
        let size = entry.size();
        if size > MAX_PART_BYTES {
            return Err(format!("{name} exceeds the 16 MiB import limit."));
        }
        let mut text = String::new();
        entry
            .take(MAX_PART_BYTES + 1)
            .read_to_string(&mut text)
            .map_err(|e| format!("{name}: {e}"))?;
        if text.len() as u64 != size {
            return Err(format!("Incomplete Word part: {name}"));
        }
        validate_xml(&text, root).map_err(|e| format!("{name}: {e}"))?;
        Ok(Some(text))
    };
    let document = part("word/document.xml", "w:document")?
        .ok_or("This Word document has no main document part.")?;
    let context = DocxContext {
        links: part("word/_rels/document.xml.rels", "Relationships")?
            .map(|x| parse_rels(&x))
            .unwrap_or_default(),
        headings: part("word/styles.xml", "w:styles")?
            .map(|x| parse_styles(&x))
            .unwrap_or_default(),
        numbering: part("word/numbering.xml", "w:numbering")?
            .map(|x| parse_numbering(&x))
            .unwrap_or_default(),
    };
    Ok(tidy(&convert_document(&document, &context)))
}

fn validate_xml(xml: &str, root: &str) -> Result<(), String> {
    let mut reader = Reader::from_str(xml);
    let (mut seen, mut depth, mut body) = (false, 0usize, false);
    loop {
        let event = reader.read_event().map_err(|e| e.to_string())?;
        match &event {
            Event::Start(e) | Event::Empty(e) => {
                if depth == 0 {
                    if seen || e.name().as_ref() != root {
                        return Err("Unexpected XML document element.".into());
                    }
                    seen = true;
                }
                if depth == 1 && e.name().as_ref() == "w:body" {
                    body = true;
                }
                for attr in e.attributes() {
                    let attr = attr.map_err(|e| e.to_string())?;
                    quick_xml::escape::unescape(&attr.value).map_err(|e| e.to_string())?;
                }
                if matches!(event, Event::Start(_)) {
                    depth += 1;
                }
                if depth > 128 {
                    return Err("XML nesting limit exceeded.".into());
                }
            }
            Event::End(_) => {
                depth = depth.checked_sub(1).ok_or("Unexpected XML end tag.")?;
            }
            Event::DocType(_) => return Err("Document type declarations are unsupported.".into()),
            Event::CData(_) | Event::GeneralRef(_) if depth == 0 => {
                return Err("Character data outside XML root.".into())
            }
            Event::GeneralRef(r) => {
                if r.resolve_char_ref().map_err(|e| e.to_string())?.is_none()
                    && quick_xml::escape::resolve_xml_entity(r).is_none()
                {
                    return Err("Unknown XML entity.".into());
                }
            }
            Event::Text(t) if depth == 0 && !t.xml10_content().trim().is_empty() => {
                return Err("Text outside XML root.".into())
            }
            Event::Eof => break,
            _ => (),
        }
    }
    if !seen || depth != 0 || (root == "w:document" && !body) {
        return Err("Incomplete Word XML.".into());
    }
    Ok(())
}

#[derive(Default)]
struct DocxContext {
    /// Relationship id → hyperlink target.
    links: HashMap<String, String>,
    /// Paragraph style id → what kind of block it is.
    headings: HashMap<String, StyleKind>,
    /// (numId, level) → true when the list is numbered.
    numbering: HashMap<(String, u8), bool>,
}

#[derive(Clone, Copy, PartialEq)]
enum StyleKind {
    Heading(u8),
    Bullet,
    Numbered,
    Quote,
    Code,
}

fn attr(e: &BytesStart, name: &str) -> Option<String> {
    let a = e.try_get_attribute(name).ok()??;
    quick_xml::escape::unescape(&a.value)
        .ok()
        .map(|v| v.into_owned())
}

/// `<w:b/>` means on; `<w:b w:val="0"/>` or `"false"` means off.
fn toggle(e: &BytesStart) -> bool {
    !matches!(attr(e, "w:val").as_deref(), Some("0" | "false" | "none"))
}

fn parse_rels(xml: &str) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let mut reader = Reader::from_str(xml);
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) if e.name().as_ref() == "Relationship" => {
                let external = attr(&e, "TargetMode").as_deref() == Some("External");
                if let (true, Some(id), Some(target)) =
                    (external, attr(&e, "Id"), attr(&e, "Target"))
                {
                    map.insert(id, target);
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    map
}

/// Word stores localised style ids ("Kop1" in Dutch) but the style *name* is
/// always the English one ("heading 1"), so that is what we classify on.
fn parse_styles(xml: &str) -> HashMap<String, StyleKind> {
    let mut map = HashMap::new();
    let mut current: Option<String> = None;
    let mut reader = Reader::from_str(xml);
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) if e.name().as_ref() == "w:style" => {
                current = attr(&e, "w:styleId")
            }
            Ok(Event::End(e)) if e.name().as_ref() == "w:style" => current = None,
            Ok(Event::Empty(e)) if e.name().as_ref() == "w:name" => {
                if let (Some(id), Some(name)) = (&current, attr(&e, "w:val")) {
                    if let Some(kind) = classify_style(&name) {
                        map.insert(id.clone(), kind);
                    }
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    map
}

fn classify_style(name: &str) -> Option<StyleKind> {
    let name = name.to_ascii_lowercase();
    if let Some(level) = name.strip_prefix("heading ") {
        return level
            .trim()
            .parse::<u8>()
            .ok()
            .map(|l| StyleKind::Heading(l.clamp(1, 6)));
    }
    match name.as_str() {
        "title" => Some(StyleKind::Heading(1)),
        "subtitle" => Some(StyleKind::Heading(2)),
        "quote" | "intense quote" | "block text" => Some(StyleKind::Quote),
        "html preformatted" | "plain text" | "macro" => Some(StyleKind::Code),
        n if n.starts_with("list bullet") => Some(StyleKind::Bullet),
        n if n.starts_with("list number") => Some(StyleKind::Numbered),
        _ => None,
    }
}

fn parse_numbering(xml: &str) -> HashMap<(String, u8), bool> {
    let mut abstract_levels: HashMap<(String, u8), bool> = HashMap::new();
    let mut num_to_abstract: Vec<(String, String)> = Vec::new();
    let (mut abstract_id, mut num_id, mut level) = (None::<String>, None::<String>, 0u8);
    let mut reader = Reader::from_str(xml);
    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => match e.name().as_ref() {
                "w:abstractNum" => abstract_id = attr(&e, "w:abstractNumId"),
                "w:num" => num_id = attr(&e, "w:numId"),
                "w:lvl" => level = attr(&e, "w:ilvl").and_then(|v| v.parse().ok()).unwrap_or(0),
                "w:numFmt" => {
                    if let (Some(id), Some(fmt)) = (&abstract_id, attr(&e, "w:val")) {
                        abstract_levels
                            .insert((id.clone(), level), fmt != "bullet" && fmt != "none");
                    }
                }
                "w:abstractNumId" => {
                    if let (Some(num), Some(abs)) = (&num_id, attr(&e, "w:val")) {
                        num_to_abstract.push((num.clone(), abs));
                    }
                }
                _ => {}
            },
            Ok(Event::End(e)) => match e.name().as_ref() {
                "w:abstractNum" => abstract_id = None,
                "w:num" => num_id = None,
                _ => {}
            },
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
    }
    let mut map = HashMap::new();
    for (num, abs) in num_to_abstract {
        for ((id, lvl), ordered) in &abstract_levels {
            if *id == abs {
                map.insert((num.clone(), *lvl), *ordered);
            }
        }
    }
    map
}

#[derive(Clone, Copy, Default, PartialEq)]
struct Format {
    bold: bool,
    italic: bool,
    strike: bool,
    code: bool,
}

#[derive(Default)]
struct Paragraph {
    style: Option<String>,
    list: Option<(String, u8)>,
    /// Text segments with their formatting; adjacent equal formats are merged.
    segments: Vec<(Format, String)>,
    /// Set at a hyperlink boundary: the next text starts a new segment.
    barrier: bool,
}

impl Paragraph {
    fn push_literal(&mut self, format: Format, source: &str) {
        let mut escaped = String::new();
        escape_markdown(source, &mut escaped);
        self.push(format, &escaped);
    }

    fn push(&mut self, format: Format, text: &str) {
        if text.is_empty() {
            return;
        }
        match self.segments.last_mut() {
            Some((f, t)) if *f == format && !self.barrier => t.push_str(text),
            _ => self.segments.push((format, text.to_string())),
        }
        self.barrier = false;
    }

    fn inline_markdown(&self, plain: bool) -> String {
        let mut out = String::new();
        for (format, text) in &self.segments {
            if plain {
                out.push_str(text);
                continue;
            }
            // Emphasis markers must hug the text, so whitespace moves outside.
            let core = text.trim();
            if core.is_empty() {
                out.push_str(text);
                continue;
            }
            let lead = &text[..text.len() - text.trim_start().len()];
            let trail = &text[text.trim_end().len()..];
            let (open, close) = match format {
                Format { code: true, .. } => ("`", "`"),
                Format {
                    bold: true,
                    italic: true,
                    ..
                } => ("***", "***"),
                Format { bold: true, .. } => ("**", "**"),
                Format { italic: true, .. } => ("*", "*"),
                _ => ("", ""),
            };
            let strike = if format.strike && !format.code {
                "~~"
            } else {
                ""
            };
            out.push_str(lead);
            out.push_str(strike);
            out.push_str(open);
            out.push_str(core);
            out.push_str(close);
            out.push_str(strike);
            out.push_str(trail);
        }
        out
    }
}

fn escape_markdown(text: &str, out: &mut String) {
    for c in text.chars() {
        if matches!(c, '\\' | '*' | '_' | '`' | '[' | ']' | '<' | '|') {
            out.push('\\');
        }
        out.push(c);
    }
}

/// Escape characters that would turn an ordinary paragraph into another block.
fn escape_line_start(line: &str) -> String {
    let trimmed = line.trim_start();
    let first = trimmed.chars().next();
    let needs = match first {
        Some('#' | '>') => true,
        Some('-' | '+') => trimmed[1..].starts_with(' '),
        Some(c) if c.is_ascii_digit() => {
            let rest = trimmed.trim_start_matches(|c: char| c.is_ascii_digit());
            rest.starts_with(". ") || rest.starts_with(") ")
        }
        _ => false,
    };
    if !needs {
        return line.to_string();
    }
    match first {
        Some(c) if c.is_ascii_digit() => {
            let digits = trimmed.len()
                - trimmed
                    .trim_start_matches(|c: char| c.is_ascii_digit())
                    .len();
            format!("{}\\{}", &trimmed[..digits], &trimmed[digits..])
        }
        _ => format!("\\{trimmed}"),
    }
}

#[derive(Default)]
struct Table {
    rows: Vec<Vec<String>>,
    row: Vec<String>,
    cell: Vec<String>,
}

fn convert_document(xml: &str, cx: &DocxContext) -> String {
    let mut out = String::new();
    let mut reader = Reader::from_str(xml);

    let mut para: Option<Paragraph> = None;
    let mut tables: Vec<Table> = Vec::new();
    let mut run = Format::default();
    let (mut in_ppr, mut in_run, mut in_text) = (false, false, false);
    let mut link: Option<(Option<String>, usize)> = None; // (target, segment index at start)
    let mut last_was_list = false;
    let mut code_block_open = false;

    loop {
        let event = match reader.read_event() {
            Ok(Event::Eof) | Err(_) => break,
            Ok(e) => e,
        };
        match event {
            Event::Start(e) => match e.name().as_ref() {
                "w:p" => para = Some(Paragraph::default()),
                "w:pPr" => in_ppr = true,
                "w:r" => {
                    in_run = true;
                    run = Format::default();
                }
                "w:t" => in_text = in_run,
                "w:tbl" => tables.push(Table::default()),
                "w:hyperlink" => {
                    let target = attr(&e, "r:id").and_then(|id| cx.links.get(&id).cloned());
                    if let Some(p) = para.as_mut() {
                        p.barrier = true;
                    }
                    link = Some((target, para.as_ref().map_or(0, |p| p.segments.len())));
                }
                name => start_or_empty(name, &e, &mut para, &mut run, in_ppr, in_run),
            },
            Event::Empty(e) => {
                start_or_empty(e.name().as_ref(), &e, &mut para, &mut run, in_ppr, in_run)
            }
            Event::Text(t) if in_text => {
                if let Some(p) = para.as_mut() {
                    p.push_literal(run, &t.xml10_content());
                }
            }
            Event::CData(t) if in_text => {
                if let Some(p) = para.as_mut() {
                    p.push_literal(run, &t.xml10_content());
                }
            }
            Event::GeneralRef(r) if in_text => {
                let ch = match r.resolve_char_ref() {
                    Ok(Some(c)) => Some(c),
                    _ => match &*r.into_inner() {
                        "amp" => Some('&'),
                        "lt" => Some('<'),
                        "gt" => Some('>'),
                        "quot" => Some('"'),
                        "apos" => Some('\''),
                        _ => None,
                    },
                };
                if let (Some(c), Some(p)) = (ch, para.as_mut()) {
                    p.push_literal(run, c.encode_utf8(&mut [0; 4]));
                }
            }
            Event::End(e) => match e.name().as_ref() {
                "w:pPr" => in_ppr = false,
                "w:r" => in_run = false,
                "w:t" => in_text = false,
                "w:hyperlink" => {
                    if let Some(p) = para.as_mut() {
                        p.barrier = true;
                    }
                    if let (Some((Some(url), start)), Some(p)) = (link.take(), para.as_mut()) {
                        if start < p.segments.len() {
                            let tail: Vec<_> = p.segments.drain(start..).collect();
                            let text = Paragraph {
                                segments: tail,
                                ..Default::default()
                            }
                            .inline_markdown(false);
                            let url = url.replace(' ', "%20").replace(')', "%29");
                            p.segments
                                .push((Format::default(), format!("[{}]({url})", text.trim())));
                        }
                    }
                }
                "w:p" => {
                    let Some(p) = para.take() else { continue };
                    let kind = p.style.as_ref().and_then(|s| cx.headings.get(s).copied());
                    let is_code = kind == Some(StyleKind::Code);

                    if let Some(table) = tables.last_mut() {
                        let text = p.inline_markdown(false);
                        if !text.trim().is_empty() {
                            table.cell.push(text.trim().to_string());
                        }
                        continue;
                    }

                    if code_block_open && !is_code {
                        out.push_str("```\n\n");
                        code_block_open = false;
                    }
                    let text = p.inline_markdown(is_code);
                    if text.trim().is_empty() && !is_code {
                        continue;
                    }

                    let list = match (&p.list, kind) {
                        (Some((num, level)), _) if num != "0" => Some((
                            cx.numbering
                                .get(&(num.clone(), *level))
                                .copied()
                                .unwrap_or(false),
                            *level,
                        )),
                        (None, Some(StyleKind::Bullet)) => Some((false, 0)),
                        (None, Some(StyleKind::Numbered)) => Some((true, 0)),
                        _ => None,
                    };

                    if is_code {
                        if !code_block_open {
                            out.push_str("```\n");
                            code_block_open = true;
                        }
                        out.push_str(&unescape_code(&text));
                        out.push('\n');
                        last_was_list = false;
                        continue;
                    }
                    let text = text.trim();
                    if let Some(StyleKind::Heading(level)) = kind {
                        let plain = text.replace('\n', " ");
                        out.push_str(&format!("{} {}\n\n", "#".repeat(level as usize), plain));
                        last_was_list = false;
                    } else if let Some((ordered, level)) = list {
                        let indent = "    ".repeat(level.min(8) as usize);
                        let marker = if ordered { "1." } else { "-" };
                        let body = text.replace('\n', &format!("\n{indent}  "));
                        out.push_str(&format!("{indent}{marker} {body}\n"));
                        last_was_list = true;
                        continue;
                    } else if kind == Some(StyleKind::Quote) {
                        if last_was_list {
                            out.push('\n');
                        }
                        out.push_str(&format!("> {}\n\n", text.replace('\n', "\n> ")));
                        last_was_list = false;
                    } else {
                        if last_was_list {
                            out.push('\n');
                        }
                        let lines: Vec<String> = text.split('\n').map(escape_line_start).collect();
                        out.push_str(&lines.join("  \n"));
                        out.push_str("\n\n");
                        last_was_list = false;
                    }
                }
                "w:tc" => {
                    if let Some(table) = tables.last_mut() {
                        let cell = std::mem::take(&mut table.cell).join("<br>");
                        table.row.push(cell.replace('\n', "<br>"));
                    }
                }
                "w:tr" => {
                    if let Some(table) = tables.last_mut() {
                        let row = std::mem::take(&mut table.row);
                        table.rows.push(row);
                    }
                }
                "w:tbl" => {
                    let Some(table) = tables.pop() else { continue };
                    let markdown = table_markdown(&table.rows);
                    match tables.last_mut() {
                        // A table inside a table cannot be expressed in Markdown;
                        // keep its text in the surrounding cell.
                        Some(outer) => outer.cell.push(
                            table
                                .rows
                                .iter()
                                .flatten()
                                .cloned()
                                .collect::<Vec<_>>()
                                .join(" "),
                        ),
                        None => {
                            if last_was_list {
                                out.push('\n');
                            }
                            out.push_str(&markdown);
                            out.push('\n');
                            last_was_list = false;
                        }
                    }
                }
                _ => {}
            },
            _ => {}
        }
    }
    if code_block_open {
        out.push_str("```\n");
    }
    out
}

/// Elements that carry their meaning in attributes and may be written either
/// as `<w:x .../>` or `<w:x ...></w:x>`.
fn start_or_empty(
    name: &str,
    e: &BytesStart,
    para: &mut Option<Paragraph>,
    run: &mut Format,
    in_ppr: bool,
    in_run: bool,
) {
    let Some(p) = para.as_mut() else { return };
    match name {
        "w:pStyle" if in_ppr => p.style = attr(e, "w:val"),
        "w:numId" if in_ppr => {
            let level = p.list.take().map_or(0, |(_, l)| l);
            p.list = attr(e, "w:val").map(|id| (id, level));
        }
        "w:ilvl" if in_ppr => {
            let level = attr(e, "w:val").and_then(|v| v.parse().ok()).unwrap_or(0);
            let id = p.list.take().map_or_else(String::new, |(id, _)| id);
            p.list = Some((id, level));
        }
        // Run properties inside <w:pPr> describe the paragraph mark, not text.
        "w:b" if in_run && !in_ppr => run.bold = toggle(e),
        "w:i" if in_run && !in_ppr => run.italic = toggle(e),
        "w:strike" if in_run && !in_ppr => run.strike = toggle(e),
        "w:rStyle" if in_run && !in_ppr => {
            let style = attr(e, "w:val").unwrap_or_default().to_ascii_lowercase();
            run.code = style.contains("code") || style.contains("verbatim");
        }
        "w:tab" if in_run => p.push(*run, " "),
        "w:br" | "w:cr" if in_run => {
            if attr(e, "w:type").as_deref() != Some("page") {
                p.push(*run, "\n");
            }
        }
        _ => {}
    }
}

fn unescape_code(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' {
            if let Some(next) = chars.next() {
                out.push(next);
                continue;
            }
        }
        out.push(c);
    }
    out
}

fn table_markdown(rows: &[Vec<String>]) -> String {
    let columns = rows.iter().map(Vec::len).max().unwrap_or(0);
    if columns == 0 {
        return String::new();
    }
    let mut out = String::new();
    for (i, row) in rows.iter().enumerate() {
        out.push('|');
        for c in 0..columns {
            out.push(' ');
            out.push_str(row.get(c).map_or("", String::as_str));
            out.push_str(" |");
        }
        out.push('\n');
        if i == 0 {
            out.push('|');
            out.push_str(&" --- |".repeat(columns));
            out.push('\n');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn html_import() {
        let md = html_to_markdown(
            "<html><head><title>t</title><style>p{}</style></head><body><h1>Title</h1>\
             <p>Some <strong>bold</strong> and <a href=\"https://example.com\">a link</a>.</p>\
             <ul><li>one</li><li>two</li></ul><script>alert(1)</script>\
             <pre><code>let a = 1;</code></pre></body></html>",
        )
        .unwrap();
        assert!(md.contains("# Title"), "{md}");
        assert!(md.contains("**bold**"), "{md}");
        assert!(md.contains("[a link](https://example.com)"), "{md}");
        assert!(md.contains("- one") || md.contains("-   one"), "{md}");
        assert!(md.contains("```"), "{md}");
        assert!(!md.contains("alert"), "{md}");
        assert!(!md.contains("p{}"), "{md}");
    }

    const DOCUMENT: &str = r#"<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>
<w:p><w:pPr><w:pStyle w:val="Kop1"/><w:rPr><w:b/></w:rPr></w:pPr><w:r><w:t>Report &amp; notes</w:t></w:r></w:p>
<w:p><w:r><w:t xml:space="preserve">Plain </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">bold </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>more</w:t></w:r><w:r><w:rPr><w:i/><w:b w:val="0"/></w:rPr><w:t xml:space="preserve"> italic</w:t></w:r><w:r><w:t xml:space="preserve"> and a </w:t></w:r><w:hyperlink r:id="rId5"><w:r><w:t>link</w:t></w:r></w:hyperlink><w:r><w:t>. 2*3_4</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>First bullet</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Nested</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>Step one</w:t></w:r></w:p>
<w:p><w:r><w:t>1. Not a list</w:t></w:r></w:p>
<w:tbl><w:tr><w:tc><w:p><w:r><w:t>Name</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>a|b</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p><w:p><w:r><w:t>2</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
<w:p><w:r><w:t>After</w:t></w:r></w:p>
</w:body></w:document>"#;

    const STYLES: &str = r#"<w:styles xmlns:w="x"><w:style w:type="paragraph" w:styleId="Kop1"><w:name w:val="heading 1"/></w:style></w:styles>"#;
    const RELS: &str = r#"<Relationships><Relationship Id="rId5" Type="hyperlink" Target="https://example.com/a b" TargetMode="External"/></Relationships>"#;
    const NUMBERING: &str = r#"<w:numbering xmlns:w="x">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl><w:lvl w:ilvl="1"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>"#;

    #[test]
    fn docx_import() {
        let path = std::env::temp_dir().join(format!("kladje-test-{}.docx", std::process::id()));
        {
            let mut zip = zip::ZipWriter::new(File::create(&path).unwrap());
            let options = zip::write::SimpleFileOptions::default();
            for (name, body) in [
                ("word/document.xml", DOCUMENT),
                ("word/styles.xml", STYLES),
                ("word/_rels/document.xml.rels", RELS),
                ("word/numbering.xml", NUMBERING),
            ] {
                zip.start_file(name, options).unwrap();
                zip.write_all(body.as_bytes()).unwrap();
            }
            zip.finish().unwrap();
        }
        let original = std::fs::read(&path).unwrap();
        let md = docx_to_markdown(&path).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), original);
        std::fs::remove_file(&path).unwrap();

        assert!(md.starts_with("# Report & notes\n"), "{md}");
        assert!(
            md.contains(
                "Plain **bold more** *italic* and a [link](https://example.com/a%20b). 2\\*3\\_4"
            ),
            "{md}"
        );
        assert!(
            md.contains("- First bullet\n    - Nested\n1. Step one\n"),
            "{md}"
        );
        assert!(md.contains("1\\. Not a list"), "{md}");
        assert!(
            md.contains("| Name | Value |\n| --- | --- |\n| a\\|b | 1<br>2 |\n"),
            "{md}"
        );
        assert!(md.trim_end().ends_with("After"), "{md}");
    }

    #[test]
    fn rejects_truncation_and_preserves_hard_breaks() {
        assert!(validate_xml("<w:document><w:body><w:p/></w:body>", "w:document").is_err());
        assert!(validate_xml("<w:document/>", "w:document").is_err());
        let xml = "<w:document><w:body><w:p><w:r><w:t>first</w:t><w:br/><w:t>second</w:t></w:r></w:p></w:body></w:document>";
        assert!(validate_xml(xml, "w:document").is_ok());
        let html = html_to_markdown("<p>first<br>second</p>").unwrap();
        let word = tidy(&convert_document(xml, &DocxContext::default()));
        let renderer = crate::markdown::Renderer::new();
        for text in [html, word] {
            assert!(
                renderer
                    .render(&text, crate::markdown::Target::Export)
                    .contains("<br"),
                "{text:?}"
            );
        }
    }

    #[test]
    fn preserves_cdata_and_rejects_undefined_word_entities() {
        let xml = "<w:document><w:body><w:p><w:r><w:t><![CDATA[AT&T 東京]]> &amp; caf&#233;</w:t></w:r></w:p></w:body></w:document>";
        validate_xml(xml, "w:document").unwrap();
        assert_eq!(
            convert_document(xml, &DocxContext::default()).trim(),
            "AT&T 東京 & café"
        );
        assert!(validate_xml(&xml.replace("&amp;", "&missing;"), "w:document").is_err());
        assert!(validate_xml(&xml.replace("<w:r>", "<w:r a='&missing;'>"), "w:document").is_err());
        assert!(validate_xml(&format!("{xml}<![CDATA[extra]]>"), "w:document").is_err());
    }

    #[test]
    fn not_a_docx() {
        let path = std::env::temp_dir().join(format!("kladje-bad-{}.docx", std::process::id()));
        std::fs::write(&path, b"not a zip").unwrap();
        assert!(docx_to_markdown(&path).is_err());
        std::fs::remove_file(&path).unwrap();
    }
}
