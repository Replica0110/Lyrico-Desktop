use std::path::Path;
#[path = "native/ffmpeg/build.rs"]
mod ffmpeg;

#[cfg(target_os = "windows")]
fn import_visual_studio_environment() {
    let target = std::env::var("TARGET").unwrap();
    let compiler = cc::windows_registry::find_tool(&target, "cl.exe")
        .expect("Visual Studio C++ toolchain is required");
    for (name, value) in compiler.env() {
        std::env::set_var(name, value);
    }
}
fn main() {
    if !Path::new("native/taglib/upstream/CMakeLists.txt").exists() {
        panic!("TagLib submodule is missing. Run: git submodule update --init --recursive");
    }
    #[cfg(target_os = "windows")]
    import_visual_studio_environment();
    ffmpeg::build();
    let mut build = cmake::Config::new("native/taglib");
    #[cfg(target_os = "windows")]
    {
        build.generator("Ninja");
        build.define("CMAKE_MSVC_RUNTIME_LIBRARY", "MultiThreadedDLL");
    }
    let native = build
        .define("BUILD_BINDINGS", "OFF")
        .define("BUILD_EXAMPLES", "OFF")
        .define("BUILD_TESTING", "OFF")
        .define("WITH_ZLIB", "OFF")
        .build();
    println!(
        "cargo:rustc-link-search=native={}",
        native.join("lib").display()
    );
    println!("cargo:rustc-link-lib=static=lyrico_taglib_bridge");
    println!("cargo:rustc-link-lib=static=tag");
    #[cfg(target_os = "macos")]
    println!("cargo:rustc-link-lib=c++");
    #[cfg(all(not(target_os = "windows"), not(target_os = "macos")))]
    println!("cargo:rustc-link-lib=stdc++");
    println!("cargo:rerun-if-changed=native/taglib/CMakeLists.txt");
    println!("cargo:rerun-if-changed=native/taglib/bridge.cpp");
    println!("cargo:rerun-if-changed=native/taglib/upstream");
    tauri_build::build();
}
