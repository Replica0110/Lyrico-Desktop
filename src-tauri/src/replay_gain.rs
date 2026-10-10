use crate::models::ReplayGainAnalysis;
use ebur128::{Channel, EbuR128, Mode};
use md5::{Digest, Md5};
use std::{
    cell::Cell,
    ffi::{c_char, c_int, c_void, CStr, CString},
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        OnceLock,
    },
    time::{Duration, Instant},
};

#[derive(Debug, Clone, Copy, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PeakMode {
    #[default]
    SamplePeak,
    TruePeak,
}
pub(crate) const DEFAULT_TARGET_LOUDNESS_LUFS: f64 = -18.0;

static RESOURCE_DIRECTORY: OnceLock<PathBuf> = OnceLock::new();
static NATIVE: OnceLock<Result<Native, String>> = OnceLock::new();

pub(crate) fn configure_resources(directory: PathBuf) {
    let _ = RESOURCE_DIRECTORY.set(directory);
}
#[repr(C)]
struct AudioInfo {
    rate: c_int,
    channels: c_int,
    duration: f64,
    layout: [c_char; 128],
}
type Open = unsafe extern "C" fn(
    *const c_char,
    extern "C" fn(*mut c_void) -> c_int,
    *mut c_void,
    *mut AudioInfo,
    *mut c_char,
    usize,
) -> *mut c_void;
type Next =
    unsafe extern "C" fn(*mut c_void, *mut *const f64, *mut usize, *mut c_char, usize) -> c_int;
type Diagnostics = unsafe extern "C" fn(*mut c_void, *mut c_char, usize) -> c_int;
struct Native {
    _library: libloading::Library,
    open: Open,
    next: Next,
    diagnostics: Diagnostics,
    free: unsafe extern "C" fn(*mut c_void),
}
impl Native {
    fn load() -> Result<Self, String> {
        let directory = match RESOURCE_DIRECTORY.get() {
            Some(path) => path.clone(),
            None => std::env::current_exe()
                .map_err(|e| e.to_string())?
                .parent()
                .ok_or("Application directory is missing")?
                .to_owned(),
        };
        let name = format!(
            "{}lyrico_ffmpeg_bridge{}",
            std::env::consts::DLL_PREFIX,
            std::env::consts::DLL_SUFFIX
        );
        let path = directory.join("ffmpeg").join(name);
        #[cfg(target_os = "macos")]
        let path = if directory.file_name() == Some(std::ffi::OsStr::new("Resources")) {
            directory
                .parent()
                .ok_or("Application bundle is missing")?
                .join("Frameworks")
                .join(path.file_name().unwrap())
        } else {
            path
        };
        // Keep FFmpeg dependencies in the private directory, without changing
        // process-wide DLL lookup or depending on a system FFmpeg installation.
        unsafe {
            #[cfg(windows)]
            let library: libloading::Library =
                libloading::os::windows::Library::load_with_flags(&path, 0x00000100 | 0x00001000)
                    .map_err(|e| e.to_string())?
                    .into();
            #[cfg(not(windows))]
            let library = libloading::Library::new(&path).map_err(|e| e.to_string())?;
            let abi: libloading::Symbol<unsafe extern "C" fn() -> u32> = library
                .get(b"lyrico_decode_abi\0")
                .map_err(|e| e.to_string())?;
            if abi() != 1 {
                return Err("Incompatible FFmpeg bridge ABI".into());
            }
            let init: libloading::Symbol<unsafe extern "C" fn()> = library
                .get(b"lyrico_decode_init\0")
                .map_err(|e| e.to_string())?;
            let open = *library
                .get::<Open>(b"lyrico_decode_open\0")
                .map_err(|e| e.to_string())?;
            let next = *library
                .get::<Next>(b"lyrico_decode_next\0")
                .map_err(|e| e.to_string())?;
            let diagnostics = *library
                .get::<Diagnostics>(b"lyrico_decode_diagnostics\0")
                .map_err(|e| e.to_string())?;
            let free = *library
                .get::<unsafe extern "C" fn(*mut c_void)>(b"lyrico_decode_free\0")
                .map_err(|e| e.to_string())?;
            init();
            Ok(Self {
                _library: library,
                open,
                next,
                diagnostics,
                free,
            })
        }
    }
}
struct Interrupt<'a> {
    cancelled: &'a AtomicBool,
    activity: Cell<Instant>,
}
extern "C" fn interrupted(context: *mut c_void) -> c_int {
    // C invokes this synchronously on the calling thread, only during decode.
    let context = unsafe { &*(context.cast::<Interrupt<'_>>()) };
    (context.cancelled.load(Ordering::Relaxed)
        || context.activity.get().elapsed() > Duration::from_secs(60)) as c_int
}
struct Decoder<'a> {
    handle: *mut c_void,
    native: &'static Native,
    _interrupt: &'a Interrupt<'a>,
}
impl Drop for Decoder<'_> {
    fn drop(&mut self) {
        unsafe { (self.native.free)(self.handle) };
    }
}
fn diagnostic_text(text: &[c_char]) -> String {
    unsafe { CStr::from_ptr(text.as_ptr()) }
        .to_string_lossy()
        .trim()
        .to_owned()
}
struct FlacInfo {
    frames: u64,
    bits: u32,
    channels: u32,
    rate: u32,
    md5: [u8; 16],
}
fn flac_info(path: &Path) -> Result<Option<FlacInfo>, String> {
    let mut file = File::open(path).map_err(|e| e.to_string())?;
    let mut marker = [0; 4];
    if file.read_exact(&mut marker).is_err() || &marker != b"fLaC" {
        return Ok(None);
    }
    let mut header = [0; 4];
    let mut data = [0; 34];
    file.read_exact(&mut header)
        .and_then(|_| file.read_exact(&mut data))
        .map_err(|_| "Truncated FLAC STREAMINFO")?;
    if header[0] & 127 != 0 || header[1..] != [0, 0, 34] {
        return Err("Invalid FLAC STREAMINFO".into());
    }
    let packed = u64::from_be_bytes(data[10..18].try_into().unwrap());
    Ok(Some(FlacInfo {
        frames: packed & 0xfffffffff,
        bits: ((packed >> 36) & 31) as u32 + 1,
        channels: ((packed >> 41) & 7) as u32 + 1,
        rate: (packed >> 44) as u32,
        md5: data[18..34].try_into().unwrap(),
    }))
}
fn channel_map(layout: &str, channels: u32) -> Result<Vec<Channel>, String> {
    use Channel::*;
    let map = match layout {
        "mono" => vec![Center],
        "stereo" => vec![Left, Right],
        "2.1" => vec![Left, Right, Unused],
        "3.0" => vec![Left, Right, Center],
        "3.0(back)" => vec![Left, Right, Mp180],
        "4.0" => vec![Left, Right, Center, Mp180],
        "quad" | "quad(side)" => vec![Left, Right, LeftSurround, RightSurround],
        "5.0" | "5.0(side)" => vec![Left, Right, Center, LeftSurround, RightSurround],
        "5.1" | "5.1(side)" => vec![Left, Right, Center, Unused, LeftSurround, RightSurround],
        "6.1" => vec![
            Left,
            Right,
            Center,
            Unused,
            Mp180,
            LeftSurround,
            RightSurround,
        ],
        "7.1" => vec![
            Left,
            Right,
            Center,
            Unused,
            Mp135,
            Mm135,
            LeftSurround,
            RightSurround,
        ],
        "7.1(wide)" => vec![
            Left,
            Right,
            Center,
            Unused,
            LeftSurround,
            RightSurround,
            MpSC,
            MmSC,
        ],
        "" | "unknown" | "1 channels" if channels == 1 => vec![Center],
        "" | "unknown" | "2 channels" if channels == 2 => vec![Left, Right],
        _ => {
            return Err(format!(
                "Unsupported or ambiguous audio channel layout: {layout} ({channels} channels)"
            ))
        }
    };
    if map.len() != channels as usize {
        return Err("Audio channel layout does not match channel count".into());
    }
    Ok(map)
}
pub(crate) fn analyze_track(
    job_id: String,
    path: &Path,
    target_loudness_lufs: f64,
    peak_mode: PeakMode,
    cancelled: &AtomicBool,
    mut on_progress: impl FnMut(f32),
) -> Result<ReplayGainAnalysis, String> {
    validate_target_loudness(target_loudness_lufs)?;
    let requested_path = path.to_string_lossy().into_owned();
    let path = path.canonicalize().map_err(|e| e.to_string())?;
    let original = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if !original.is_file() {
        return Err("ReplayGain requires a regular audio file".into());
    }
    let flac = flac_info(&path)?;
    on_progress(0.0);
    if cancelled.load(Ordering::Relaxed) {
        return Err("ReplayGain analysis cancelled".into());
    }
    let native = NATIVE
        .get_or_init(Native::load)
        .as_ref()
        .map_err(Clone::clone)?;
    let input = CString::new(path.to_str().ok_or("Audio path is not valid UTF-8")?)
        .map_err(|_| "Audio path contains a null byte")?;
    let interrupt = Interrupt {
        cancelled,
        activity: Cell::new(Instant::now()),
    };
    let mut spec = AudioInfo {
        rate: 0,
        channels: 0,
        duration: 0.0,
        layout: [0; 128],
    };
    let mut error = [0; 1024];
    let handle = unsafe {
        (native.open)(
            input.as_ptr(),
            interrupted,
            (&interrupt as *const Interrupt<'_>).cast_mut().cast(),
            &mut spec,
            error.as_mut_ptr(),
            error.len(),
        )
    };
    if handle.is_null() {
        return Err(if cancelled.load(Ordering::Relaxed) {
            "ReplayGain analysis cancelled".into()
        } else {
            format!("Cannot open audio: {}", diagnostic_text(&error))
        });
    }
    let decoder = Decoder {
        handle,
        native,
        _interrupt: &interrupt,
    };
    let rate = u32::try_from(spec.rate)
        .ok()
        .filter(|r| *r > 0 && *r <= 768000)
        .ok_or("Invalid audio sample rate")?;
    let channels = u32::try_from(spec.channels)
        .ok()
        .filter(|c| *c > 0 && *c <= 64)
        .ok_or("Invalid audio channel count")?;
    if let Some(info) = &flac {
        if info.rate != rate || info.channels != channels || !(4..=32).contains(&info.bits) {
            return Err("FLAC metadata disagrees with decoded stream".into());
        }
    }
    let declared = flac.as_ref().map(|f| f.frames).filter(|n| *n > 0);
    let duration = (spec.duration.is_finite() && spec.duration > 0.0).then_some(spec.duration);
    let mut analyzer = EbuR128::new(
        channels,
        rate,
        Mode::I
            | match peak_mode {
                PeakMode::SamplePeak => Mode::SAMPLE_PEAK,
                PeakMode::TruePeak => Mode::TRUE_PEAK,
            },
    )
    .map_err(|e| e.to_string())?;
    analyzer
        .set_channel_map(&channel_map(&diagnostic_text(&spec.layout), channels)?)
        .map_err(|e| e.to_string())?;
    let mut hash_bytes = Vec::new();
    let mut hash = Md5::new();
    let mut count = 0u64;
    let mut last_progress = Instant::now();
    loop {
        if cancelled.load(Ordering::Relaxed) {
            return Err("ReplayGain analysis cancelled".into());
        }
        let mut data = std::ptr::null();
        let mut length = 0usize;
        let result = unsafe {
            (native.next)(
                decoder.handle,
                &mut data,
                &mut length,
                error.as_mut_ptr(),
                error.len(),
            )
        };
        if result == 0 {
            break;
        }
        if result != 1 {
            return Err(if cancelled.load(Ordering::Relaxed) {
                "ReplayGain analysis cancelled".into()
            } else {
                format!("FFmpeg decoding failed: {}", diagnostic_text(&error))
            });
        }
        if length == 0 {
            continue;
        }
        if data.is_null() || length % channels as usize != 0 || length > 262144 * channels as usize
        {
            return Err("Invalid PCM frame from FFmpeg bridge".into());
        }
        // The bridge owns this buffer until the next decode call.
        let pcm = unsafe { std::slice::from_raw_parts(data, length) };
        hash_bytes.clear();
        for &value in pcm {
            if !value.is_finite() {
                return Err("Decoded PCM contains non-finite samples".into());
            }
            if let Some(info) = &flac {
                let scaled = value * (1u64 << (info.bits - 1)) as f64;
                if scaled.fract() != 0.0
                    || scaled < -(1i64 << (info.bits - 1)) as f64
                    || scaled >= (1i64 << (info.bits - 1)) as f64
                {
                    return Err("Decoded FLAC PCM is not lossless".into());
                }
                hash_bytes.extend_from_slice(
                    &(scaled as i64).to_le_bytes()[..info.bits.div_ceil(8) as usize],
                );
            }
        }
        hash.update(&hash_bytes);
        count = count
            .checked_add((pcm.len() / channels as usize) as u64)
            .ok_or("Audio sample count overflow")?;
        if declared.is_some_and(|total| count > total) {
            return Err("Decoded audio exceeds FLAC declared sample count".into());
        }
        analyzer.add_frames_f64(pcm).map_err(|e| e.to_string())?;
        interrupt.activity.set(Instant::now());
        if last_progress.elapsed() >= Duration::from_millis(100) {
            let total = declared
                .map(|n| n as f64)
                .or_else(|| duration.map(|d| d * rate as f64));
            if let Some(total) = total {
                on_progress((count as f64 / total).clamp(0.0, 0.99) as f32);
            }
            last_progress = Instant::now();
        }
    }
    if count == 0 {
        return Err("Decoded audio contains incomplete or no PCM frames".into());
    }
    if let Some(total) = declared {
        if count != total {
            return Err(format!(
                "Audio data is incomplete: decoded {count} of {total} samples"
            ));
        }
    }
    let verified = if let Some(info) = &flac {
        if info.md5 != [0; 16] {
            let actual: [u8; 16] = hash.finalize().into();
            if actual != info.md5 {
                return Err("FLAC PCM MD5 mismatch: audio is damaged or incomplete".into());
            }
            declared.is_some()
        } else {
            false
        }
    } else {
        false
    };
    let mut diagnostics = [0; 1024];
    let had_errors = unsafe {
        (native.diagnostics)(decoder.handle, diagnostics.as_mut_ptr(), diagnostics.len())
    } != 0;
    let diagnostics = diagnostic_text(&diagnostics);
    if had_errors && !verified {
        return Err(format!(
            "FFmpeg could not decode audio reliably: {diagnostics}"
        ));
    }
    let after = std::fs::metadata(&path).map_err(|e| e.to_string())?;
    if original.len() != after.len() || original.modified().ok() != after.modified().ok() {
        return Err("Audio file changed during ReplayGain analysis".into());
    }
    let loudness_lufs = analyzer.loudness_global().map_err(|e| e.to_string())?;
    if !loudness_lufs.is_finite() {
        return Err("Audio has no measurable integrated loudness (silence or too short)".into());
    }
    let mut peak = 0.0f64;
    for channel in 0..channels {
        peak = peak.max(
            match peak_mode {
                PeakMode::SamplePeak => analyzer.sample_peak(channel),
                PeakMode::TruePeak => analyzer.true_peak(channel),
            }
            .map_err(|e| e.to_string())?,
        );
    }
    if !peak.is_finite() {
        return Err("Audio peak is not finite".into());
    }
    if cancelled.load(Ordering::Relaxed) {
        return Err("ReplayGain analysis cancelled".into());
    }
    let warning = had_errors.then(|| {
        "Decoder reported anomalies; complete FLAC sample count and PCM MD5 verified".to_string()
    });
    if let Some(warning) = &warning {
        log::warn!("replaygain: {}: {warning}; {diagnostics}", path.display());
    }
    on_progress(1.0);
    Ok(ReplayGainAnalysis {
        job_id,
        path: requested_path,
        loudness_lufs,
        sample_count: count,
        declared_samples: declared,
        peak,
        track_gain: format_gain(loudness_lufs, target_loudness_lufs),
        track_peak: format_peak(peak),
        reference_loudness: format_reference_loudness(target_loudness_lufs),
        warning,
    })
}
fn validate_target_loudness(value: f64) -> Result<(), String> {
    if value.is_finite() && (-60.0..=0.0).contains(&value) {
        Ok(())
    } else {
        Err("ReplayGain target loudness must be between -60 and 0 LUFS".into())
    }
}
fn format_gain(loudness: f64, target: f64) -> String {
    format!("{:.2} dB", target - loudness)
}
fn format_peak(peak: f64) -> String {
    format!("{:.6}", peak.max(0.0))
}
fn format_reference_loudness(target: f64) -> String {
    if target.fract() == 0.0 {
        format!("{target:.0} LUFS")
    } else {
        format!("{target:.2} LUFS")
    }
}
