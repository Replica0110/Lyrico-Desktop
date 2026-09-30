use std::path::Path;
#[cfg(target_os = "windows")]
fn import_visual_studio_environment() {
    // Discover the installed toolchain instead of assuming an edition or install path.
    let root =
        std::env::var_os("ProgramFiles(x86)").unwrap_or_else(|| r"C:\Program Files (x86)".into());
    let vswhere = Path::new(&root).join(r"Microsoft Visual Studio\Installer\vswhere.exe");
    let Ok(output) = std::process::Command::new(vswhere)
        .args([
            "-latest",
            "-products",
            "*",
            "-requires",
            "Microsoft.VisualStudio.Component.VC.Tools.x86.x64",
            "-property",
            "installationPath",
        ])
        .output()
    else {
        return;
    };
    let installation = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if installation.is_empty() {
        return;
    }
    let target = std::env::var("CARGO_CFG_TARGET_ARCH").unwrap_or_default();
    let arch = match target.as_str() {
        "aarch64" => "arm64",
        "x86" => "x86",
        _ => "x64",
    };
    let script = Path::new(&installation).join(r"Common7\Tools\VsDevCmd.bat");
    let command = format!(
        "call \"{}\" -arch={arch} -host_arch=x64 >nul && set",
        script.display()
    );
    let Ok(output) = std::process::Command::new("cmd")
        .args(["/C", &command])
        .output()
    else {
        return;
    };
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if let Some((key, value)) = line.split_once('=') {
            if ["PATH", "INCLUDE", "LIB", "LIBPATH"]
                .iter()
                .any(|item| key.eq_ignore_ascii_case(item))
            {
                std::env::set_var(key, value);
            }
        }
    }
}
fn main() {
    if !Path::new("native/taglib-src/CMakeLists.txt").exists() {
        panic!("TagLib submodule is missing. Run: git submodule update --init --recursive");
    }
    #[cfg(target_os = "windows")]
    import_visual_studio_environment();
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
    println!("cargo:rerun-if-changed=native/taglib_bridge.cpp");
    println!("cargo:rerun-if-changed=native/taglib-src");
    tauri_build::build();
}
