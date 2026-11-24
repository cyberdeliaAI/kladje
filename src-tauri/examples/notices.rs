//! Print the acknowledgements for the syntax definitions and colour themes
//! embedded through two-face. Used by scripts/build-notices.mjs.
fn main() {
    print!("{}", two_face::acknowledgement::listing().to_md());
}
