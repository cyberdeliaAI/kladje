use objc2_app_kit::{NSPasteboard, NSPasteboardTypeHTML, NSPasteboardTypeString};
use objc2_foundation::{NSArray, NSString};

pub fn write(board: &NSPasteboard, markdown: &str, html: &str) -> Result<(), String> {
    // AppKit constants live for the process lifetime. A nil owner supplies
    // both representations immediately, with no deferred clipboard access.
    unsafe {
        let types = NSArray::from_slice(&[NSPasteboardTypeString, NSPasteboardTypeHTML]);
        board.declareTypes_owner(&types, None);
        if board.setString_forType(&NSString::from_str(markdown), NSPasteboardTypeString)
            && board.setString_forType(&NSString::from_str(html), NSPasteboardTypeHTML)
        {
            return Ok(());
        }
    }
    Err("The clipboard could not receive both text formats. Copy again.".into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_pasteboard_receives_source_and_html() {
        let board = NSPasteboard::pasteboardWithUniqueName();
        write(&board, "**Café**", "<strong>Café</strong>").unwrap();
        unsafe {
            assert_eq!(
                board
                    .stringForType(NSPasteboardTypeString)
                    .unwrap()
                    .to_string(),
                "**Café**"
            );
            assert_eq!(
                board
                    .stringForType(NSPasteboardTypeHTML)
                    .unwrap()
                    .to_string(),
                "<strong>Café</strong>"
            );
        }
        board.clearContents();
    }
}
