use crate::models::ReplayGainAnalysis;
use ebur128::{EbuR128, Mode};
use std::fs::File;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use symphonia::core::audio::sample::Sample;
use symphonia::core::codecs::audio::AudioDecoderOptions;
use symphonia::core::errors::Error as SymphoniaError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, TrackType};
use symphonia::core::io::MediaSourceStream;
use symphonia::core::meta::MetadataOptions;

#[derive(Debug, Clone, Copy, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) enum PeakMode {
    #[default]
    SamplePeak,
    TruePeak,
}

pub(crate) const DEFAULT_TARGET_LOUDNESS_LUFS: f64 = -18.0;

pub(crate) fn analyze_track(
    job_id: String,
    path: &Path,
    target_loudness_lufs: f64,
    peak_mode: PeakMode,
    cancelled: &AtomicBool,
    mut on_progress: impl FnMut(f32),
) -> Result<ReplayGainAnalysis, String> {
    validate_target_loudness(target_loudness_lufs)?;
    let file = Box::new(File::open(path).map_err(|error| error.to_string())?);
    let file_size = file.metadata().map(|meta| meta.len()).unwrap_or(0);
    let source = MediaSourceStream::new(file, Default::default());
    let mut hint = Hint::new();
    if let Some(extension) = path.extension().and_then(|value| value.to_str()) {
        hint.with_extension(extension);
    }
    let mut format = symphonia::default::get_probe()
        .probe(
            &hint,
            source,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|error| error.to_string())?;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or_else(|| "No decodable audio track was found".to_string())?;
    let track_id = track.id;
    let total_frames = track.num_frames;
    let total_duration = track.duration.map(|duration| duration.get());
    let start_ts = track.start_ts.get();
    let codec_parameters = track
        .codec_params
        .as_ref()
        .and_then(|parameters| parameters.audio())
        .ok_or_else(|| "Audio codec parameters are missing".to_string())?
        .clone();
    let mut decoder = symphonia::default::get_codecs()
        .make_audio_decoder(&codec_parameters, &AudioDecoderOptions::default())
        .map_err(|error| error.to_string())?;

    let mut analyzer: Option<EbuR128> = None;
    let mut analyzer_spec: Option<(u32, u32)> = None;
    let mut samples = Vec::<f32>::new();
    let mut sample_count = 0_u64;
    let mut decoded_bytes = 0_u64;
    let mut last_progress = 0.0_f32;
    let mut last_progress_at = Instant::now();
    on_progress(0.0);

    while let Some(packet) = format.next_packet().map_err(|error| error.to_string())? {
        if cancelled.load(Ordering::Relaxed) {
            return Err("ReplayGain analysis cancelled".to_string());
        }
        if packet.track_id != track_id {
            continue;
        }
        let decoded = match decoder.decode(&packet) {
            Ok(decoded) => decoded,
            Err(SymphoniaError::DecodeError(_)) => continue,
            Err(error) => return Err(error.to_string()),
        };
        let spec = decoded.spec();
        let channels = u32::try_from(spec.channels().count())
            .map_err(|_| "Unsupported channel count".to_string())?;
        if channels == 0 || spec.rate() == 0 {
            return Err("Invalid decoded audio format".to_string());
        }
        if analyzer.is_none() {
            analyzer = Some(
                EbuR128::new(channels, spec.rate(), Mode::I | match peak_mode { PeakMode::SamplePeak => Mode::SAMPLE_PEAK, PeakMode::TruePeak => Mode::TRUE_PEAK })
                    .map_err(|error| error.to_string())?,
            );
            analyzer_spec = Some((channels, spec.rate()));
        } else if analyzer_spec != Some((channels, spec.rate())) {
            return Err("Audio format changed during ReplayGain analysis".to_string());
        }

        samples.resize(decoded.samples_interleaved(), f32::MID);
        decoded.copy_to_slice_interleaved(&mut samples);
        analyzer
            .as_mut()
            .expect("analyzer is initialized")
            .add_frames_f32(&samples)
            .map_err(|error| error.to_string())?;
        sample_count += u64::try_from(samples.len() / channels as usize).unwrap_or_default();

        decoded_bytes += packet.data.len() as u64;
        let progress = analysis_progress(sample_count, total_frames,
            packet.pts.get().saturating_sub(start_ts).max(0) as u64,
            total_duration, decoded_bytes, file_size).max(last_progress);
        if progress - last_progress >= 0.05
            || (progress > last_progress && last_progress_at.elapsed() >= Duration::from_millis(100))
        {
            on_progress(progress);
            last_progress = progress;
            last_progress_at = Instant::now();
        }

    }

    if cancelled.load(Ordering::Relaxed) {
        return Err("ReplayGain analysis cancelled".to_string());
    }
    let analyzer = analyzer.ok_or_else(|| "Decoded audio contains no samples".to_string())?;
    if sample_count == 0 {
        return Err("Decoded audio contains no samples".to_string());
    }
    let loudness_lufs = analyzer
        .loudness_global()
        .map_err(|error| error.to_string())?;
    let (channels, _) = analyzer_spec.expect("analyzer spec is initialized");
    let mut peak = 0.0_f64;
    for channel in 0..channels {
        peak = peak.max(
            match peak_mode {
                PeakMode::SamplePeak => analyzer.sample_peak(channel),
                PeakMode::TruePeak => analyzer.true_peak(channel),
            }.map_err(|error| error.to_string())?,
        );
    }
    on_progress(1.0);

    Ok(ReplayGainAnalysis {
        job_id,
        path: path.to_string_lossy().to_string(),
        loudness_lufs,
        sample_count,
        peak,
        track_gain: format_gain(loudness_lufs, target_loudness_lufs),
        track_peak: format_peak(peak),
        reference_loudness: format_reference_loudness(target_loudness_lufs),
    })
}

// Prefer sample count, then container duration. Packet bytes provide an estimate for
// streams without duration; completion is only reported after loudness is finalized.
fn analysis_progress(samples: u64, frames: Option<u64>, timestamp: u64, duration: Option<u64>, bytes: u64, size: u64) -> f32 {
    let ratio = if let Some(total) = frames.filter(|value| *value > 0) {
        samples as f64 / total as f64
    } else if let Some(total) = duration.filter(|value| *value > 0) {
        timestamp as f64 / total as f64
    } else if size > 0 { bytes as f64 / size as f64 } else { 0.0 };
    ratio.clamp(0.0, 0.99) as f32
}

fn validate_target_loudness(target_loudness_lufs: f64) -> Result<(), String> {
    if target_loudness_lufs.is_finite() && (-60.0..=0.0).contains(&target_loudness_lufs) {
        Ok(())
    } else {
        Err("ReplayGain target loudness must be between -60 and 0 LUFS".to_string())
    }
}

fn format_gain(loudness_lufs: f64, target_loudness_lufs: f64) -> String {
    format!("{:.2} dB", target_loudness_lufs - loudness_lufs)
}

fn format_peak(peak: f64) -> String {
    format!("{:.6}", peak.max(0.0))
}

fn format_reference_loudness(target_loudness_lufs: f64) -> String {
    if target_loudness_lufs.fract() == 0.0 {
        format!("{target_loudness_lufs:.0} LUFS")
    } else {
        format!("{target_loudness_lufs:.2} LUFS")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peak_modes_and_progress_use_decoded_audio() {
        let path = std::env::temp_dir().join(format!("lyrico-intersample-{}-{}.wav", std::process::id(), std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()));
        let count = 48000_u32 * 2;
        let data_len = count * 2;
        let mut wav = Vec::new();
        wav.extend(b"RIFF");
        wav.extend((36 + data_len).to_le_bytes());
        wav.extend(b"WAVEfmt ");
        wav.extend(16_u32.to_le_bytes());
        wav.extend(1_u16.to_le_bytes());
        wav.extend(1_u16.to_le_bytes());
        wav.extend(48000_u32.to_le_bytes());
        wav.extend(96000_u32.to_le_bytes());
        wav.extend(2_u16.to_le_bytes());
        wav.extend(16_u16.to_le_bytes());
        wav.extend(b"data");
        wav.extend(data_len.to_le_bytes());
        for index in 0..count {
            let phase = f64::from(index) * std::f64::consts::FRAC_PI_2 + std::f64::consts::FRAC_PI_4;
            wav.extend(((phase.sin() * 0.7 * f64::from(i16::MAX)) as i16).to_le_bytes());
        }
        std::fs::write(&path, wav).unwrap();
        let cancelled = AtomicBool::new(false);
        let mut progress = Vec::new();
        let sample = analyze_track("sample".into(), &path, -18.0, PeakMode::SamplePeak, &cancelled, |value| progress.push(value)).unwrap();
        let true_peak = analyze_track("true".into(), &path, -18.0, PeakMode::TruePeak, &cancelled, |_| {}).unwrap();
        assert!(sample.loudness_lufs.is_finite());
        assert!(true_peak.peak > sample.peak + 0.1, "true peak must detect intersample peaks");
        assert!(progress.iter().any(|value| *value > 0.0 && *value < 1.0));
        assert!(progress.windows(2).all(|pair| pair[1] >= pair[0]));
        assert_eq!(progress.last(), Some(&1.0));
        cancelled.store(true, Ordering::Relaxed);
        assert!(analyze_track("cancel".into(), &path, -18.0, PeakMode::SamplePeak, &cancelled, |_| {}).unwrap_err().contains("cancelled"));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn progress_falls_back_to_duration_then_packet_bytes() {
        assert_eq!(analysis_progress(50, Some(100), 0, None, 0, 0), 0.5);
        assert_eq!(analysis_progress(0, None, 50, Some(100), 0, 0), 0.5);
        assert_eq!(analysis_progress(0, None, 0, None, 50, 100), 0.5);
        assert_eq!(analysis_progress(100, Some(100), 0, None, 0, 0), 0.99);
    }

    #[test]
    fn formats_mobile_compatible_replay_gain_values() {
        assert_eq!(format_gain(-9.5, -18.0), "-8.50 dB");
        assert_eq!(format_gain(-9.5, -14.0), "-4.50 dB");
        assert_eq!(format_reference_loudness(-18.0), "-18 LUFS");
        assert_eq!(format_reference_loudness(-17.25), "-17.25 LUFS");
        assert!(validate_target_loudness(-60.0).is_ok());
        assert!(validate_target_loudness(0.0).is_ok());
        assert!(validate_target_loudness(-60.1).is_err());
        assert_eq!(format_peak(0.9876544), "0.987654");
        assert_eq!(format_peak(-0.1), "0.000000");
    }

    #[test]
    fn analyzes_configured_audio_fixture() {
        let Ok(path) = std::env::var("LYRICO_REPLAY_GAIN_FIXTURE") else {
            return;
        };
        let cancelled = AtomicBool::new(false);
        let analysis = analyze_track(
            "fixture".into(),
            Path::new(&path),
            DEFAULT_TARGET_LOUDNESS_LUFS,
            PeakMode::SamplePeak,
            &cancelled,
            |_| {},
        )
        .expect("fixture should be decoded and analyzed");

        assert!(analysis.sample_count > 0);
        assert!(analysis.loudness_lufs.is_finite());
        assert!(analysis.peak >= 0.0);
        assert_eq!(analysis.reference_loudness, "-18 LUFS");
    }
}
