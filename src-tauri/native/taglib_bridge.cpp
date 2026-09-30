#include <fileref.h>
#include <audioproperties.h>
#include <tpropertymap.h>
#include <tvariant.h>
#include <cstdint>
#include <cstring>
#include <cstdlib>
#include <limits>
#include <memory>
#include <stdexcept>
#include <string>
#include <vector>
#ifdef _WIN32
#define NOMINMAX
#include <Windows.h>
#endif

namespace {
// Each handle owns one open file and one property map. No global mutable file state.
struct Session {
  std::unique_ptr<TagLib::FileRef> file;
  TagLib::PropertyMap properties;
  TagLib::StringList changed;
};
thread_local std::string last_error;
template<class F> int protect(F operation) noexcept {
  try { last_error.clear(); operation(); return 1; }
  catch(const std::exception &e) { last_error = e.what(); }
  catch(...) { last_error = "Unexpected TagLib error"; }
  return 0;
}
Session &session(void *handle) {
  if(!handle) throw std::runtime_error("Invalid TagLib file handle");
  return *static_cast<Session *>(handle);
}
void append_u32(std::vector<uint8_t> &out, uint32_t value) {
  for(int shift = 0; shift < 32; shift += 8) out.push_back(static_cast<uint8_t>(value >> shift));
}
void append_bytes(std::vector<uint8_t> &out, const char *bytes, size_t size) {
  if(size > std::numeric_limits<uint32_t>::max()) throw std::runtime_error("Metadata is too large");
  append_u32(out, static_cast<uint32_t>(size));
  out.insert(out.end(), bytes, bytes + size);
}
void append_string(std::vector<uint8_t> &out, const TagLib::String &value) {
  const auto bytes = value.to8Bit(true);
  append_bytes(out, bytes.data(), bytes.size());
}
void export_buffer(const std::vector<uint8_t> &bytes, uint8_t **output, size_t *size) {
  if(!output || !size) throw std::runtime_error("Missing output buffer");
  auto buffer = static_cast<uint8_t *>(std::malloc(bytes.size()));
  if(!buffer && !bytes.empty()) throw std::bad_alloc();
  if(!bytes.empty()) std::memcpy(buffer, bytes.data(), bytes.size());
  *output = buffer; *size = bytes.size();
}
uint32_t read_u32(const uint8_t *&data, size_t &size) {
  if(size < 4) throw std::runtime_error("Truncated metadata request");
  uint32_t result = 0;
  for(int shift = 0; shift < 32; shift += 8) result |= uint32_t(*data++) << shift;
  size -= 4; return result;
}
TagLib::String read_string(const uint8_t *&data, size_t &size) {
  auto length = read_u32(data, size);
  if(length > size) throw std::runtime_error("Truncated metadata string");
  TagLib::String value(TagLib::ByteVector(reinterpret_cast<const char *>(data), length), TagLib::String::UTF8);
  data += length; size -= length; return value;
}

}

extern "C" {
const char *lyrico_taglib_error() noexcept { return last_error.c_str(); }
void lyrico_taglib_free(uint8_t *buffer) noexcept { std::free(buffer); }
void lyrico_taglib_close(void *handle) noexcept { delete static_cast<Session *>(handle); }
void *lyrico_taglib_open(const char *path, int audio_properties) noexcept {
  std::unique_ptr<Session> result;
  const auto ok = protect([&] {
    if(!path || !*path) throw std::runtime_error("Audio path is empty");
    result = std::make_unique<Session>();
#ifdef _WIN32
    const int size = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, nullptr, 0);
    if(size <= 0) throw std::runtime_error("Invalid UTF-8 audio path");
    std::wstring wide(size, L'\0');
    MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, path, -1, wide.data(), size);
    result->file = std::make_unique<TagLib::FileRef>(wide.c_str(), audio_properties != 0);
#else
    result->file = std::make_unique<TagLib::FileRef>(path, audio_properties != 0);
#endif
    if(result->file->isNull() || !result->file->file()->isValid())
      throw std::runtime_error("TagLib does not support this file or its audio data is invalid");
    result->properties = result->file->properties();
  });
  return ok ? result.release() : nullptr;
}
// Wire format: little-endian u32 counts and length-prefixed UTF-8 strings.
// Values may contain newlines, empty strings and embedded NULs.
int lyrico_taglib_properties(void *handle, uint8_t **output, size_t *size) noexcept {
  return protect([&] {
    auto &s = session(handle); std::vector<uint8_t> bytes;
    append_u32(bytes, s.properties.size());
    for(const auto &entry : s.properties) {
      append_string(bytes, entry.first); append_u32(bytes, entry.second.size());
      for(const auto &value : entry.second) append_string(bytes, value);
    }
    export_buffer(bytes, output, size);
  });
}
int lyrico_taglib_set_property(void *handle, const char *key, const uint8_t *data, size_t size) noexcept {
  return protect([&] {
    auto &s = session(handle);
    TagLib::String property_key(key, TagLib::String::UTF8);
    TagLib::StringList values;
    auto count = read_u32(data, size);
    if(count > size / 4) throw std::runtime_error("Invalid metadata value count");
    while(count--) values.append(read_string(data, size));
    if(size != 0) throw std::runtime_error("Trailing metadata request data");
    if(values.isEmpty()) s.properties.erase(property_key);
    else s.properties.replace(property_key, values);
    s.changed.append(property_key);
  });
}
struct AudioProperties { int64_t duration_ms; int32_t bitrate; int32_t sample_rate; int32_t channels; int32_t has_cover; };
int lyrico_taglib_audio_properties(void *handle, AudioProperties *output) noexcept {
  return protect([&] {
    auto &s = session(handle); *output = {};
    if(auto p = s.file->audioProperties()) {
      output->duration_ms = p->lengthInMilliseconds(); output->bitrate = p->bitrate();
      output->sample_rate = p->sampleRate(); output->channels = p->channels();
    }
    output->has_cover = !s.file->complexProperties("PICTURE").isEmpty();

  });
}
int lyrico_taglib_cover(void *handle, uint8_t **output, size_t *size) noexcept {
  return protect([&] {
    auto &s = session(handle); const auto pictures = s.file->complexProperties("PICTURE");
    std::vector<uint8_t> bytes;
    if(!pictures.isEmpty()) {
      const TagLib::VariantMap *selected = &pictures.front();
      for(const auto &picture : pictures) {
        if(picture.value("pictureType").value<TagLib::String>() == "Front Cover") { selected = &picture; break; }
      }
      append_string(bytes, selected->value("mimeType").value<TagLib::String>());
      const auto data = selected->value("data").value<TagLib::ByteVector>();
      append_bytes(bytes, data.data(), data.size());
    }
    export_buffer(bytes, output, size);
  });
}
int lyrico_taglib_set_cover(void *handle, const uint8_t *data, size_t size, const char *mime) noexcept {
  return protect([&] {
    auto &s = session(handle); const auto existing = s.file->complexProperties("PICTURE");
    TagLib::List<TagLib::VariantMap> pictures;
    bool removed_untyped = false;
    for(const auto &picture : existing) {
      // Formats without typed covers (MP4) treat their first image as front cover.
      const auto type = picture.value("pictureType").value<TagLib::String>();
      if(type == "Front Cover") continue;
      if(type.isEmpty() && !removed_untyped) { removed_untyped = true; continue; }
      pictures.append(picture);
    }
    if(size) {
      if(size > 25 * 1024 * 1024) throw std::runtime_error("Cover is larger than 25 MB");
      TagLib::VariantMap picture;
      picture.insert("data", TagLib::ByteVector(reinterpret_cast<const char *>(data), static_cast<unsigned int>(size)));
      picture.insert("mimeType", TagLib::String(mime, TagLib::String::UTF8));
      picture.insert("pictureType", TagLib::String("Front Cover"));
      picture.insert("description", TagLib::String());
      pictures.prepend(picture);
    }
    if(!s.file->setComplexProperties("PICTURE", pictures)) throw std::runtime_error("This format does not support cover editing");
  });
}
int lyrico_taglib_save(void *handle) noexcept {
  return protect([&] {
    auto &s = session(handle);
    const auto rejected = s.file->setProperties(s.properties);
    for(const auto &key : s.changed) {
      if(rejected.contains(key)) throw std::runtime_error("This format cannot write property: " + key.to8Bit(true));
    }
    if(!s.file->save()) throw std::runtime_error("TagLib could not save the audio file");
  });
}
}
