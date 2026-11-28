// Shared menu definitions. Each platform appends these to its own webview menu.

use serde::Deserialize;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::install;
#[cfg(windows)]
mod windows;
#[cfg(windows)]
pub use windows::install;

const TAKE_CONTEXT: &str = "window.kladjeEditorMenu?.take() ?? null";

const PARAGRAPH_ITEMS: &[&[(&str, &str)]] = &[
    &[
        ("h1", "Heading 1"),
        ("h2", "Heading 2"),
        ("h3", "Heading 3"),
        ("h4", "Heading 4"),
        ("h5", "Heading 5"),
        ("h6", "Heading 6"),
    ],
    &[
        ("quote", "Quote"),
        ("bullet", "Bullet List"),
        ("numbered", "Numbered List"),
        ("task", "Task List"),
    ],
    &[("h0", "Paragraph")],
];

const FORMAT_ITEMS: &[&[(&str, &str)]] = &[
    &[
        ("bold", "Bold"),
        ("italic", "Italic"),
        ("strike", "Strikethrough"),
        ("highlight", "Highlight"),
        ("code", "Inline Code"),
        ("math", "Inline Math"),
    ],
    &[("link", "Link")],
];

const INSERT_ITEMS: &[&[(&str, &str)]] = &[
    &[("insert_image", "Insert Local Image…")],
    &[
        ("codeblock", "Code Block"),
        ("math_block", "Math Block"),
        ("table", "Insert Table"),
    ],
    &[("rule", "Horizontal Rule"), ("footnote", "Footnote")],
];

const TABLE_ITEMS: &[&[(&str, &str)]] = &[
    &[("rowAbove", "Add Row Above"), ("rowBelow", "Add Row Below")],
    &[
        ("columnBefore", "Add Column Before"),
        ("columnAfter", "Add Column After"),
    ],
    &[
        ("moveUp", "Move Row Up"),
        ("moveDown", "Move Row Down"),
        ("moveLeft", "Move Column Left"),
        ("moveRight", "Move Column Right"),
    ],
    &[
        ("deleteRow", "Delete Row"),
        ("deleteColumn", "Delete Column"),
    ],
];

struct Submenu {
    title: &'static str,
    groups: &'static [&'static [(&'static str, &'static str)]],
    table_only: bool,
}

const SUBMENUS: &[Submenu] = &[
    Submenu {
        title: "Paragraph",
        groups: PARAGRAPH_ITEMS,
        table_only: false,
    },
    Submenu {
        title: "Format",
        groups: FORMAT_ITEMS,
        table_only: false,
    },
    Submenu {
        title: "Insert",
        groups: INSERT_ITEMS,
        table_only: false,
    },
    Submenu {
        title: "Table",
        groups: TABLE_ITEMS,
        table_only: true,
    },
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EditorContext {
    id: u64,
    table_commands: Option<Vec<String>>,
}

fn command_script(id: u64, command: &str, table_only: bool) -> String {
    format!("window.kladjeEditorMenu?.choose({id}, '{command}', {table_only})")
}
