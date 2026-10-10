use std::{env, fs, path::PathBuf};

pub fn build() {
    assert_eq!(
        env::var("HOST").unwrap(),
        env::var("TARGET").unwrap(),
        "Build FFmpeg on the target operating system and architecture"
    );
    let out = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let profile = out.ancestors().nth(3).unwrap();
    let cache = profile
        .parent()
        .unwrap()
        .join("native/ffmpeg")
        .join(env::var("TARGET").unwrap());
    fs::create_dir_all(&cache).unwrap();
    // Cargo serializes one profile, but debug and release share this SDK cache.
    let lock = fs::File::options()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(cache.join("build.lock"))
        .unwrap();
    lock.lock()
        .expect("Cannot lock the FFmpeg CMake build cache");
    let mut cmake = cmake::Config::new("native/ffmpeg");
    cmake
        .out_dir(cache)
        .profile("Release")
        .define("FFMPEG_ARCH", env::var("CARGO_CFG_TARGET_ARCH").unwrap());
    #[cfg(windows)]
    {
        cmake.generator("Ninja");
        if let Some(root) = env::var_os("LYRICO_MSYS2_ROOT") {
            cmake.define("MSYS2_ROOT", root);
        }
    }
    let install = cmake.build();
    // Install only the sonames used at runtime, not duplicate symlink aliases.
    let libraries = match env::var("CARGO_CFG_TARGET_OS").unwrap().as_str() {
        "windows" => [
            "lyrico_ffmpeg_bridge.dll",
            "avformat-62.dll",
            "avcodec-62.dll",
            "avutil-60.dll",
            "swresample-6.dll",
        ],
        "linux" => [
            "liblyrico_ffmpeg_bridge.so",
            "libavformat.so.62",
            "libavcodec.so.62",
            "libavutil.so.60",
            "libswresample.so.6",
        ],
        "macos" => [
            "liblyrico_ffmpeg_bridge.dylib",
            "libavformat.62.dylib",
            "libavcodec.62.dylib",
            "libavutil.60.dylib",
            "libswresample.6.dylib",
        ],
        os => panic!("Unsupported FFmpeg platform: {os}"),
    };
    let files: Vec<_> = libraries
        .into_iter()
        .chain(["COPYING.LGPLv2.1", "COPYING.GPLv2", "NOTICE.md"])
        .collect();
    let module = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("native/ffmpeg");
    for destination in [module.join("runtime"), profile.join("ffmpeg")] {
        fs::create_dir_all(&destination).unwrap();
        for entry in fs::read_dir(&destination).unwrap() {
            let entry = entry.unwrap();
            if !files.iter().any(|name| entry.file_name() == *name)
                && (entry.file_type().unwrap().is_file() || entry.file_type().unwrap().is_symlink())
            {
                fs::remove_file(entry.path()).unwrap();
            }
        }
        for name in &files {
            let source = install.join("runtime").join(name);
            let target = destination.join(name);
            if fs::read(&target).ok() != Some(fs::read(&source).unwrap()) {
                fs::copy(source, target).unwrap();
            }
        }
    }
    for file in [
        "CMakeLists.txt",
        "build.rs",
        "build.sh",
        "cl-deps.sh",
        "bridge.c",
        "NOTICE.md",
        "upstream",
    ] {
        println!("cargo:rerun-if-changed=native/ffmpeg/{file}");
    }
    println!("cargo:rerun-if-env-changed=LYRICO_MSYS2_ROOT");
}
