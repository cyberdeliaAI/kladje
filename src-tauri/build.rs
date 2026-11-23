fn main() {
    // A newly added frontend asset also needs to invalidate the embedded bundle.
    println!("cargo:rerun-if-changed=../ui");
    tauri_build::build()
}
