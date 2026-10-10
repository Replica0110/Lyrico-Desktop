#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/samplefmt.h>
#include <libavutil/mem.h>
#include <stdarg.h>
#include <stdio.h>
#include <string.h>

#ifdef _WIN32
#define API __declspec(dllexport)
#define THREAD_LOCAL __declspec(thread)
#else
#define API __attribute__((visibility("default")))
#define THREAD_LOCAL _Thread_local
#endif

typedef struct {
    int rate, channels;
    double duration;
    char layout[128];
} AudioInfo;
typedef struct {
    AVFormatContext *format;
    AVCodecContext *codec;
    AVPacket *packet;
    AVFrame *frame;
    AVChannelLayout layout;
    double *pcm;
    size_t capacity;
    int stream, draining, errors, consecutive_errors;
    int (*interrupt)(void *);
    void *opaque;
    char diagnostic[1024];
} Decoder;
static THREAD_LOCAL Decoder *active;

/* Decoder work is synchronous and single-threaded, so diagnostics belong to
 * this thread's decoder even when independent tracks run concurrently. */
static void capture_log(void *context, int level, const char *format, va_list args) {
    (void)context;
    if (active && level <= AV_LOG_ERROR) {
        active->errors = 1;
        if (!active->diagnostic[0])
            vsnprintf(active->diagnostic, sizeof(active->diagnostic), format, args);
    }
}
static int interrupted(void *opaque) {
    Decoder *d = opaque;
    return d->interrupt && d->interrupt(d->opaque);
}
static int fail(int code, char *error, size_t length) {
    if (length) av_strerror(code, error, length);
    active = NULL;
    return -1;
}
API unsigned lyrico_decode_abi(void) { return 1; }
API void lyrico_decode_free(Decoder *d) {
    if (!d) return;
    av_frame_free(&d->frame);
    av_packet_free(&d->packet);
    avcodec_free_context(&d->codec);
    avformat_close_input(&d->format);
    av_channel_layout_uninit(&d->layout);
    av_free(d->pcm);
    av_free(d);
}
/* Called once before any decoder is created. */
API void lyrico_decode_init(void) { av_log_set_callback(capture_log); }
API Decoder *lyrico_decode_open(const char *path, int (*interrupt)(void *), void *opaque,
                               AudioInfo *info, char *error, size_t length) {
    Decoder *d = av_mallocz(sizeof(*d));
    AVDictionary *options = NULL;
    int result = AVERROR(ENOMEM);
    const AVCodec *codec;
    if (!d) { fail(result, error, length); return NULL; }
    d->interrupt = interrupt;
    d->opaque = opaque;
    d->format = avformat_alloc_context();
    if (!d->format) goto failed;
    active = d;
    d->format->interrupt_callback = (AVIOInterruptCB){interrupted, d};
    d->format->error_recognition = AV_EF_CRCCHECK | AV_EF_BITSTREAM | AV_EF_BUFFER
                                | AV_EF_CAREFUL | AV_EF_EXPLODE;
    av_dict_set(&options, "protocol_whitelist", "file", 0);
    result = avformat_open_input(&d->format, path, NULL, &options);
    av_dict_free(&options);
    if (result < 0) goto failed;
    if ((result = avformat_find_stream_info(d->format, NULL)) < 0) goto failed;
    d->stream = -1;
    for (unsigned i = 0; i < d->format->nb_streams; ++i) {
        if (d->format->streams[i]->codecpar->codec_type == AVMEDIA_TYPE_AUDIO) {
            d->stream = (int)i;
            break;
        }
    }
    if (d->stream < 0) { result = AVERROR_STREAM_NOT_FOUND; goto failed; }
    codec = avcodec_find_decoder(d->format->streams[d->stream]->codecpar->codec_id);
    if (!codec) { result = AVERROR_DECODER_NOT_FOUND; goto failed; }
    d->codec = avcodec_alloc_context3(codec);
    if (!d->codec) { result = AVERROR(ENOMEM); goto failed; }
    result = avcodec_parameters_to_context(d->codec, d->format->streams[d->stream]->codecpar);
    if (result < 0) goto failed;
    d->codec->thread_count = 1;
    d->codec->err_recognition = d->format->error_recognition;
    if ((result = avcodec_open2(d->codec, codec, NULL)) < 0) goto failed;
    if ((result = av_channel_layout_copy(&d->layout, &d->codec->ch_layout)) < 0) goto failed;
    d->frame = av_frame_alloc();
    d->packet = av_packet_alloc();
    if (!d->frame || !d->packet) { result = AVERROR(ENOMEM); goto failed; }
    memset(info, 0, sizeof(*info));
    info->rate = d->codec->sample_rate;
    info->channels = d->layout.nb_channels;
    av_channel_layout_describe(&d->layout, info->layout, sizeof(info->layout));
    AVStream *stream = d->format->streams[d->stream];
    info->duration = stream->duration != AV_NOPTS_VALUE
        ? stream->duration * av_q2d(stream->time_base)
        : d->format->duration != AV_NOPTS_VALUE
          ? (double)d->format->duration / AV_TIME_BASE : 0;
    active = NULL;
    return d;
failed:
    av_dict_free(&options);
    fail(result, error, length);
    lyrico_decode_free(d);
    return NULL;
}

static int convert(Decoder *d) {
    AVFrame *f = d->frame;
    if (f->sample_rate != d->codec->sample_rate ||
        av_channel_layout_compare(&f->ch_layout, &d->layout) != 0 ||
        f->nb_samples < 0 || f->nb_samples > 262144 ||
        d->layout.nb_channels < 1 || d->layout.nb_channels > 64)
        return AVERROR_INVALIDDATA;
    if (f->flags & AV_FRAME_FLAG_CORRUPT) d->errors = 1;
    size_t samples = (size_t)f->nb_samples * d->layout.nb_channels;
    if (samples > d->capacity) {
        double *pcm = av_realloc_array(d->pcm, samples, sizeof(double));
        if (!pcm) return AVERROR(ENOMEM);
        d->pcm = pcm;
        d->capacity = samples;
    }
    int planar = av_sample_fmt_is_planar(f->format);
    enum AVSampleFormat packed = av_get_packed_sample_fmt(f->format);
    int bytes = av_get_bytes_per_sample(f->format);
    if (!bytes) return AVERROR_INVALIDDATA;
    for (int i = 0; i < f->nb_samples; ++i) {
        for (int ch = 0; ch < d->layout.nb_channels; ++ch) {
            const uint8_t *plane = f->extended_data[planar ? ch : 0];
            if (!plane) return AVERROR_INVALIDDATA;
            const uint8_t *p = plane + ((size_t)i * (planar ? 1 : d->layout.nb_channels)
                                      + (planar ? 0 : ch)) * bytes;
            double value;
            switch (packed) {
            case AV_SAMPLE_FMT_U8: value = ((int)*p - 128) / 128.0; break;
            case AV_SAMPLE_FMT_S16: { int16_t v; memcpy(&v,p,2); value=v/32768.0; break; }
            case AV_SAMPLE_FMT_S32: { int32_t v; memcpy(&v,p,4); value=v/2147483648.0; break; }
            case AV_SAMPLE_FMT_S64: { int64_t v; memcpy(&v,p,8); value=v/9223372036854775808.0; break; }
            case AV_SAMPLE_FMT_FLT: { float v; memcpy(&v,p,4); value=v; break; }
            case AV_SAMPLE_FMT_DBL: memcpy(&value,p,8); break;
            default: return AVERROR_INVALIDDATA;
            }
            d->pcm[(size_t)i * d->layout.nb_channels + ch] = value;
        }
    }
    return 0;
}
/* 1 = frame, 0 = fully drained EOF, -1 = fatal error. PCM remains valid until
 * the next call. INVALIDDATA is recorded, never silently accepted by Rust. */
API int lyrico_decode_next(Decoder *d, const double **pcm, size_t *samples,
                           char *error, size_t length) {
    active = d;
    for (;;) {
        if (interrupted(d)) return fail(AVERROR_EXIT, error, length);
        int result = avcodec_receive_frame(d->codec, d->frame);
        if (result == 0) {
            result = convert(d);
            if (result < 0) return fail(result, error, length);
            *pcm = d->pcm;
            *samples = (size_t)d->frame->nb_samples * d->layout.nb_channels;
            av_frame_unref(d->frame);
            d->consecutive_errors = 0;
            active = NULL;
            return 1;
        }
        if (result == AVERROR_EOF) { active = NULL; return 0; }
        if (result == AVERROR_INVALIDDATA) {
            d->errors = 1;
            if (++d->consecutive_errors > 32) return fail(result, error, length);
            continue;
        }
        if (result != AVERROR(EAGAIN)) return fail(result, error, length);
        if (d->draining) return fail(AVERROR_BUG, error, length);
        for (;;) {
            if (interrupted(d)) return fail(AVERROR_EXIT, error, length);
            result = av_read_frame(d->format, d->packet);
            if (result == AVERROR_INVALIDDATA) {
                d->errors = 1;
                if (++d->consecutive_errors > 32) return fail(result, error, length);
                if (!avio_feof(d->format->pb)) continue;
                result = AVERROR_EOF;
            }
            if (result == AVERROR_EOF) {
                d->draining = 1;
                result = avcodec_send_packet(d->codec, NULL);
                if (result < 0 && result != AVERROR_EOF) return fail(result, error, length);
                break;
            }
            if (result < 0) return fail(result, error, length);
            if (d->packet->stream_index != d->stream) { av_packet_unref(d->packet); continue; }
            result = avcodec_send_packet(d->codec, d->packet);
            av_packet_unref(d->packet);
            if (result == AVERROR_INVALIDDATA) {
                d->errors = 1;
                if (++d->consecutive_errors > 32) return fail(result, error, length);
                continue;
            }
            if (result < 0) return fail(result, error, length);
            break;
        }
    }
}
API int lyrico_decode_diagnostics(Decoder *d, char *text, size_t length) {
    if (length) snprintf(text, length, "%s", d->diagnostic);
    return d->errors;
}
