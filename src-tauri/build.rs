use std::path::PathBuf;
use std::process::Command;

#[cfg(target_os = "windows")]
fn import_visual_studio_environment() {
    let candidates = [
        r"C:\Program Files\Microsoft Visual Studio\18\Community\Common7\Tools\VsDevCmd.bat",
        r"C:\Program Files\Microsoft Visual Studio\2022\Community\Common7\Tools\VsDevCmd.bat",
        r"C:\Program Files (x86)\Microsoft Visual Studio\2022\Community\Common7\Tools\VsDevCmd.bat",
    ];
    let Some(script) = candidates
        .iter()
        .map(PathBuf::from)
        .find(|path| path.exists())
    else {
        return;
    };
    let command = format!(
        "call \"{}\" -arch=x64 >nul && set",
        script.display()
    );
    let Ok(output) = Command::new("cmd").args(["/C", &command]).output() else {
        return;
    };
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        let Some((key, value)) = line.split_once('=') else {
            continue;
        };
        if !key.is_empty() {
            std::env::set_var(key, value);
        }
    }
}

fn main() {
    #[cfg(target_os = "windows")]
    {
        import_visual_studio_environment();
        let native = cmake::Config::new("native/taglib")
            .generator("Ninja")
            .profile("Release")
            .define("BUILD_BINDINGS", "OFF")
            .define("BUILD_EXAMPLES", "OFF")
            .define("BUILD_TESTING", "OFF")
            .define("WITH_ZLIB", "OFF")
            .build();
        println!("cargo:rustc-link-search=native={}", native.join("lib").display());
        println!("cargo:rustc-link-lib=static=lyrico_taglib_bridge");
        println!("cargo:rustc-link-lib=static=tag");
        println!("cargo:rerun-if-changed=native/taglib/CMakeLists.txt");
        println!("cargo:rerun-if-changed=native/taglib_bridge.cpp");
    }
    tauri_build::build()
}
