//! Safe, thread-confined ownership of a TagLib file. Business rules belong in audio.rs.
use std::collections::BTreeMap;
use std::ffi::{c_char, c_void, CStr, CString};
use std::marker::PhantomData;
use std::path::Path;
use std::ptr::NonNull;
use std::rc::Rc;

pub(crate) type Properties = BTreeMap<String, Vec<String>>;
#[derive(Default)]
#[repr(C)]
pub(crate) struct AudioProperties {
    pub duration_ms: i64,
    pub bitrate: i32,
    pub sample_rate: i32,
    pub channels: i32,
    pub has_cover: i32,
}
#[derive(Clone)]
pub(crate) struct Cover {
    pub mime: String,
    pub data: Vec<u8>,
}
unsafe extern "C" {
    fn lyrico_taglib_open(path: *const c_char, audio_properties: i32, read_only: i32) -> *mut c_void;
    fn lyrico_taglib_close(handle: *mut c_void);
    fn lyrico_taglib_error() -> *const c_char;
    fn lyrico_taglib_free(buffer: *mut u8);
    fn lyrico_taglib_properties(handle: *mut c_void, output: *mut *mut u8, size: *mut usize)
        -> i32;
    fn lyrico_taglib_audio_properties(handle: *mut c_void, output: *mut AudioProperties) -> i32;
    fn lyrico_taglib_cover(handle: *mut c_void, output: *mut *mut u8, size: *mut usize) -> i32;
    fn lyrico_taglib_set_property(
        handle: *mut c_void,
        key: *const c_char,
        data: *const u8,
        size: usize,
    ) -> i32;
    fn lyrico_taglib_set_cover(
        handle: *mut c_void,
        data: *const u8,
        size: usize,
        mime: *const c_char,
    ) -> i32;
    fn lyrico_taglib_save(handle: *mut c_void) -> i32;
}

pub(crate) struct File {
    handle: NonNull<c_void>,
    // Handles must be opened, used and dropped on the same blocking worker.
    _thread: PhantomData<Rc<()>>,
}
impl Drop for File {
    fn drop(&mut self) {
        unsafe { lyrico_taglib_close(self.handle.as_ptr()) }
    }
}
struct Buffer {
    data: *mut u8,
    size: usize,
}
impl Drop for Buffer {
    fn drop(&mut self) {
        unsafe { lyrico_taglib_free(self.data) }
    }
}
impl Buffer {
    fn bytes(&self) -> Result<&[u8], String> {
        if self.size > 64 * 1024 * 1024 {
            return Err("Metadata exceeds 64 MB".into());
        }
        if self.size == 0 {
            return Ok(&[]);
        }
        if self.data.is_null() {
            return Err("TagLib returned an invalid buffer".into());
        }
        Ok(unsafe { std::slice::from_raw_parts(self.data, self.size) })
    }
}
fn checked(status: i32) -> Result<(), String> {
    if status != 0 {
        return Ok(());
    }
    Err(unsafe { CStr::from_ptr(lyrico_taglib_error()) }
        .to_string_lossy()
        .into_owned())
}
fn cstring(value: &str) -> Result<CString, String> {
    CString::new(value).map_err(|_| "Path or property key contains a NUL character".into())
}
impl File {
    pub(crate) fn open(path: &Path, audio_properties: bool) -> Result<Self, String> {
        Self::open_with_access(path, audio_properties, true)
    }
    pub(crate) fn open_writable(path: &Path) -> Result<Self, String> {
        Self::open_with_access(path, false, false)
    }
    fn open_with_access(path: &Path, audio_properties: bool, read_only: bool) -> Result<Self, String> {
        let path = path.to_str().ok_or("Audio path is not valid Unicode")?;
        let path = cstring(path)?;
        let handle = unsafe { lyrico_taglib_open(path.as_ptr(), i32::from(audio_properties), i32::from(read_only)) };
        match NonNull::new(handle) {
            Some(handle) => Ok(Self {
                handle,
                _thread: PhantomData,
            }),
            None => {
                checked(0)?;
                unreachable!()
            }
        }
    }
    fn buffer(
        &self,
        read: unsafe extern "C" fn(*mut c_void, *mut *mut u8, *mut usize) -> i32,
    ) -> Result<Buffer, String> {
        let mut result = Buffer {
            data: std::ptr::null_mut(),
            size: 0,
        };
        checked(unsafe { read(self.handle.as_ptr(), &mut result.data, &mut result.size) })?;
        Ok(result)
    }
    pub(crate) fn properties(&self) -> Result<Properties, String> {
        let buffer = self.buffer(lyrico_taglib_properties)?;
        let mut reader = Reader(buffer.bytes()?);
        let count = reader.count()?;
        let mut properties = Properties::new();
        for _ in 0..count {
            let key = reader.string()?;
            let count = reader.count()?;
            let mut values = Vec::new();
            for _ in 0..count {
                values.push(reader.string()?);
            }
            properties.insert(key, values);
        }
        reader.finish()?;
        Ok(properties)
    }
    pub(crate) fn audio_properties(&self) -> Result<AudioProperties, String> {
        let mut result = AudioProperties::default();
        checked(unsafe { lyrico_taglib_audio_properties(self.handle.as_ptr(), &mut result) })?;
        Ok(result)
    }
    pub(crate) fn cover(&self) -> Result<Option<Cover>, String> {
        let buffer = self.buffer(lyrico_taglib_cover)?;
        let bytes = buffer.bytes()?;
        if bytes.is_empty() {
            return Ok(None);
        }
        let mut reader = Reader(bytes);
        let mime = reader.string()?;
        let data = reader.blob()?.to_vec();
        reader.finish()?;
        Ok(Some(Cover { mime, data }))
    }
    pub(crate) fn set_property(&mut self, key: &str, values: &[String]) -> Result<(), String> {
        let key = cstring(key)?;
        let mut encoded = Vec::new();
        encode_length(&mut encoded, values.len())?;
        for value in values {
            encode_length(&mut encoded, value.len())?;
            encoded.extend_from_slice(value.as_bytes());
        }
        checked(unsafe {
            lyrico_taglib_set_property(
                self.handle.as_ptr(),
                key.as_ptr(),
                encoded.as_ptr(),
                encoded.len(),
            )
        })
    }
    pub(crate) fn set_cover(&mut self, cover: Option<&Cover>) -> Result<(), String> {
        let bytes = cover.map_or(&[][..], |cover| cover.data.as_slice());
        let mime = cstring(cover.map_or("", |cover| cover.mime.as_str()))?;
        checked(unsafe {
            lyrico_taglib_set_cover(
                self.handle.as_ptr(),
                bytes.as_ptr(),
                bytes.len(),
                mime.as_ptr(),
            )
        })
    }
    pub(crate) fn save(&mut self) -> Result<(), String> {
        checked(unsafe { lyrico_taglib_save(self.handle.as_ptr()) })
    }
}
fn encode_length(output: &mut Vec<u8>, length: usize) -> Result<(), String> {
    let length = u32::try_from(length).map_err(|_| "Metadata value is too large")?;
    output.extend_from_slice(&length.to_le_bytes());
    Ok(())
}
struct Reader<'a>(&'a [u8]);
impl<'a> Reader<'a> {
    fn count(&mut self) -> Result<usize, String> {
        let bytes = self.0.get(..4).ok_or("Truncated TagLib response")?;
        let count = u32::from_le_bytes(bytes.try_into().unwrap()) as usize;
        self.0 = &self.0[4..];
        Ok(count)
    }
    fn blob(&mut self) -> Result<&'a [u8], String> {
        let size = self.count()?;
        let value = self.0.get(..size).ok_or("Truncated TagLib value")?;
        self.0 = &self.0[size..];
        Ok(value)
    }
    fn string(&mut self) -> Result<String, String> {
        String::from_utf8(self.blob()?.to_vec()).map_err(|error| error.to_string())
    }
    fn finish(self) -> Result<(), String> {
        if self.0.is_empty() {
            Ok(())
        } else {
            Err("Trailing TagLib response data".into())
        }
    }
}
