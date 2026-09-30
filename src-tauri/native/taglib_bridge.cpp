#include <fileref.h>
#include <tpropertymap.h>
#include <tstringlist.h>

#include <algorithm>
#include <cstring>
#include <memory>
#include <sstream>
#include <string>
#include <vector>

#ifdef _WIN32
#include <Windows.h>
#endif

namespace {

bool copy_to_buffer(const std::string &value, char *output, size_t capacity) {
  if (!output || capacity == 0 || value.size() + 1 > capacity) {
    return false;
  }
  std::memcpy(output, value.data(), value.size());
  output[value.size()] = '\0';
  return true;
}

std::vector<std::string> split_lines(const char *value) {
  std::vector<std::string> result;
  if (!value) {
    return result;
  }
  std::stringstream stream(value);
  std::string line;
  while (std::getline(stream, line)) {
    if (!line.empty()) {
      result.push_back(line);
    }
  }
  return result;
}

std::string join_values(const TagLib::StringList &values) {
  std::string result;
  for (size_t index = 0; index < values.size(); ++index) {
    if (index > 0) {
      result.push_back('\n');
    }
    result += values[index].toCString(true);
  }
  return result;
}

std::unique_ptr<TagLib::FileRef> open_file(const char *path, bool read_only) {
  if (!path || !*path) {
    return nullptr;
  }
#ifdef _WIN32
  // On Windows, convert UTF-8 path to wide string for proper Unicode support
  int size = MultiByteToWideChar(CP_UTF8, 0, path, -1, nullptr, 0);
  if (size <= 0) {
    return nullptr;
  }
  std::wstring wpath(size - 1, 0);
  MultiByteToWideChar(CP_UTF8, 0, path, -1, &wpath[0], size);
  auto file = std::make_unique<TagLib::FileRef>(TagLib::FileName(wpath.c_str()), read_only);
#else
  auto file = std::make_unique<TagLib::FileRef>(TagLib::FileName(path), read_only);
#endif
  if (file->isNull() || !file->file()) {
    return nullptr;
  }
  return file;
}

} // namespace

extern "C" {

int lyrico_taglib_list_properties(
    const char *path,
    char *output,
    size_t capacity
) {
  auto file = open_file(path, true);
  if (!file) {
    return 0;
  }
  const auto properties = file->file()->properties();
  std::string result;
  for (const auto &entry : properties) {
    if (!result.empty()) {
      result.push_back('\n');
    }
    result += entry.first.toCString(true);
  }
  return copy_to_buffer(result, output, capacity) ? 1 : 0;
}

int lyrico_taglib_read_property(
    const char *path,
    const char *key,
    char *output,
    size_t capacity
) {
  auto file = open_file(path, true);
  if (!file || !key) {
    return 0;
  }
  const auto properties = file->file()->properties();
  const auto it = properties.find(TagLib::String(key, TagLib::String::UTF8));
  if (it == properties.end()) {
    return copy_to_buffer("", output, capacity) ? 1 : 0;
  }
  return copy_to_buffer(join_values(it->second), output, capacity) ? 1 : 0;
}

int lyrico_taglib_write_property(
    const char *path,
    const char *key,
    const char *values
) {
  auto file = open_file(path, false);
  if (!file || !key) {
    return 0;
  }
  auto properties = file->file()->properties();
  const TagLib::String property_key(key, TagLib::String::UTF8);
  const auto parsed = split_lines(values);
  if (parsed.empty()) {
    properties.erase(property_key);
  } else {
    TagLib::StringList string_values;
    for (const auto &value : parsed) {
      string_values.append(TagLib::String(value, TagLib::String::UTF8));
    }
    properties.replace(property_key, string_values);
  }
  file->file()->setProperties(properties);
  return file->file()->save() ? 1 : 0;
}

} // extern "C"
