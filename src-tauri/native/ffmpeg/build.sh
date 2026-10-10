#!/usr/bin/env bash
set -euo pipefail
mode=$1; source_dir=$2; build_dir=$3; prefix=$4
platform=$5; arch=$6; make_program=$7; compiler=$8; jobs=$9
if [[ "$platform" == windows ]]; then
  export PATH="/usr/bin:/mingw64/bin:$PATH"
  source_dir=$(cygpath -u "$source_dir")
  build_dir=$(cygpath -u "$build_dir")
  prefix=$(cygpath -u "$prefix")
  make_program=$(cygpath -u "$make_program")
fi
mkdir -p "$build_dir"
cd "$build_dir"
case "$mode" in
configure)
  # Configuration changes can remove components. Rebuild the out-of-tree
  # objects so no stale decoder registration survives a new configuration.
  if [[ -f ffbuild/config.mak ]]; then "$make_program" -r distclean; fi
  options=(--disable-everything --disable-autodetect --disable-static --enable-shared
    --disable-programs --disable-doc --disable-debug --disable-avdevice
    --disable-avfilter --disable-swscale --disable-network --disable-iconv
    --disable-gpl --disable-nonfree --disable-version3
    --enable-protocol=file
    --enable-demuxer=flac,mp3,mov,ogg,wav,aiff,aac
    --enable-decoder=flac,mp3,mp3float,aac,aac_fixed,aac_latm,alac,vorbis,opus
    --enable-decoder=pcm_s8,pcm_u8,pcm_s16le,pcm_s16be,pcm_u16le,pcm_u16be,pcm_s24le,pcm_s24be,pcm_u24le,pcm_u24be,pcm_s32le,pcm_s32be,pcm_u32le,pcm_u32be,pcm_s64le,pcm_s64be,pcm_f32le,pcm_f32be,pcm_f64le,pcm_f64be,pcm_alaw,pcm_mulaw
    --enable-decoder=adpcm_ima_wav,adpcm_ima_qt,adpcm_ms
    --enable-parser=flac,mpegaudio,aac,aac_latm,opus,vorbis
    --arch="$arch" --prefix="$prefix")
  case "$platform" in
    windows) options+=(--toolchain=msvc --dep-cc="$(dirname "${BASH_SOURCE[0]}")/cl-deps.sh") ;;
    macos) options+=(--target-os=darwin --cc="$compiler" --install-name-dir=@rpath) ;;
    linux) options+=(--target-os=linux --cc="$compiler") ;;
    *) exit 1 ;;
  esac
  "$source_dir/configure" "${options[@]}"
  ;;
build) "$make_program" -r -j"$jobs" ;;
install) "$make_program" -r install-libs install-headers ;;
*) exit 1 ;;
esac
