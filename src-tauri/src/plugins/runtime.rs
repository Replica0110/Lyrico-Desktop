use super::manifest::SourcePlugin;
use super::manifest::{HOST_API_VERSION, PLUGIN_API_VERSION};
use aes::Aes128;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use cipher::block_padding::Pkcs7;
use cipher::{BlockModeDecrypt, BlockModeEncrypt, KeyInit};
use ecb::{Decryptor, Encryptor};
use flate2::read::ZlibDecoder;
use md5::{Digest, Md5};
use reqwest::blocking::Client;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue, CONTENT_TYPE, USER_AGENT};
use rquickjs::{function::Func, Context, Function, Runtime};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use walkdir::WalkDir;

const MEMORY_LIMIT: usize = 64 * 1024 * 1024;
const STACK_LIMIT: usize = 2 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(15);
const SUPPORTED_FUNCTIONS: &[&str] = &["searchSongs", "getLyrics", "searchCovers"];
static PLUGIN_LOCKS: OnceLock<Mutex<HashMap<String, Arc<Mutex<()>>>>> = OnceLock::new();

pub(crate) fn invoke(
    plugin: &SourcePlugin,
    function_name: &str,
    request: Value,
    locale: Option<&str>,
) -> Result<Value, String> {
    let operation = crate::logging::Operation::new(
        "plugins",
        "invoke",
        json!({"pluginId":plugin.manifest.id,"version":plugin.manifest.version_name,"function":function_name,"page":request.get("page"),"pageSize":request.get("pageSize")}),
        log::Level::Debug,
    );
    let result = invoke_inner(plugin, function_name, request, locale);
    // Never persist arbitrary JS exceptions or host payloads; preserve the business result.
    let diagnostic = result
        .as_ref()
        .map(|_| ())
        .map_err(|error| plugin_error_summary(error));
    if let Ok(value) = &result {
        let count = value.as_array().map(Vec::len).or_else(|| {
            ["items", "results", "songs", "data"]
                .iter()
                .find_map(|key| value.get(key)?.as_array().map(Vec::len))
        });
        crate::logging::event(
            log::Level::Debug,
            "plugins",
            "response.summary",
            json!({"pluginId":plugin.manifest.id,"function":function_name,"resultCount":count}),
        );
    }
    operation.finish(&diagnostic);
    result
}

fn plugin_error_summary(error: &str) -> String {
    for kind in [
        "TypeError",
        "SyntaxError",
        "ReferenceError",
        "RangeError",
        "InternalError",
        "Error",
    ] {
        if error.contains(&format!("JavaScript {kind}:")) {
            return format!("JavaScript {kind}; inspect plugin code and runtime limits");
        }
    }
    if error.starts_with("Plugin is disabled") {
        return "Plugin is disabled".into();
    }
    if error.starts_with("Unsupported plugin function:") {
        return "Unsupported plugin function".into();
    }
    if error.starts_with("Could not read ") {
        return "Cannot read plugin script".into();
    }
    "Plugin runtime failed; inspect preceding network or script diagnostics".into()
}

fn invoke_inner(
    plugin: &SourcePlugin,
    function_name: &str,
    request: Value,
    locale: Option<&str>,
) -> Result<Value, String> {
    if !plugin.is_enabled_anywhere() {
        return Err("Plugin is disabled for every search type".to_string());
    }
    let plugin_lock = {
        let mut locks = PLUGIN_LOCKS
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(|_| "Plugin execution registry was poisoned".to_string())?;
        Arc::clone(
            locks
                .entry(plugin.manifest.id.clone())
                .or_insert_with(|| Arc::new(Mutex::new(()))),
        )
    };
    let _execution = plugin_lock
        .lock()
        .map_err(|_| "Plugin execution lock was poisoned".to_string())?;
    if !SUPPORTED_FUNCTIONS.contains(&function_name) {
        return Err(format!("Unsupported plugin function: {function_name}"));
    }
    let declares_function = if plugin.manifest.capabilities.is_empty() {
        function_name == "searchSongs"
    } else {
        plugin
            .manifest
            .capabilities
            .iter()
            .any(|capability| capability == function_name)
    };
    if !declares_function {
        return Err(format!(
            "Plugin does not declare the {function_name} capability"
        ));
    }

    let scripts = load_scripts(plugin)?;
    let runtime = Runtime::new().map_err(|error| error.to_string())?;
    runtime.set_memory_limit(MEMORY_LIMIT);
    runtime.set_max_stack_size(STACK_LIMIT);
    let started = Instant::now();
    runtime.set_interrupt_handler(Some(Box::new(move || started.elapsed() >= TIMEOUT)));
    let context = Context::full(&runtime).map_err(|error| error.to_string())?;
    let host = Arc::new(Mutex::new(HostApi::new(plugin, locale)?));

    context.with(|ctx| {
        let host = Arc::clone(&host);
        ctx.globals()
            .set(
                "__lyricoHostCall",
                Func::from(move |name: String, payload: String| {
                    let result = host
                        .lock()
                        .map_err(|_| "Plugin host lock was poisoned".to_string())
                        .and_then(|mut host| host.call(&name, &payload));
                    match result {
                        Ok(value) => json!({ "value": value }).to_string(),
                        Err(error) => json!({ "error": error }).to_string(),
                    }
                }),
            )
            .map_err(|error| error.to_string())?;
        ctx.eval::<(), _>(HOST_BOOTSTRAP)
            .map_err(|error| format_js_error(&ctx, error))?;
        for (filename, source) in scripts {
            ctx.eval::<(), _>(source.as_bytes())
                .map_err(|error| format!("{filename}: {}", format_js_error(&ctx, error)))?;
        }
        let function: Function = ctx
            .globals()
            .get(function_name)
            .map_err(|_| format!("JavaScript function not found: {function_name}"))?;
        let request_json = serde_json::to_string(&request).map_err(|error| error.to_string())?;
        let request_value: rquickjs::Value = ctx
            .json_parse(request_json)
            .map_err(|error| format_js_error(&ctx, error))?;
        let result: rquickjs::Value = function
            .call((request_value,))
            .map_err(|error| format_js_error(&ctx, error))?;
        let output = ctx
            .json_stringify(result)
            .map_err(|error| format_js_error(&ctx, error))?;
        match output {
            Some(value) => serde_json::from_str(
                value
                    .to_string()
                    .map_err(|error| error.to_string())?
                    .as_str(),
            )
            .map_err(|error| error.to_string()),
            None => Ok(Value::Null),
        }
    })
}

#[cfg(test)]
pub(crate) fn compile_plugin(plugin: &SourcePlugin, locale: Option<&str>) -> Result<(), String> {
    let scripts = load_scripts(plugin)?;
    let runtime = Runtime::new().map_err(|error| error.to_string())?;
    runtime.set_memory_limit(MEMORY_LIMIT);
    runtime.set_max_stack_size(STACK_LIMIT);
    let context = Context::full(&runtime).map_err(|error| error.to_string())?;
    let host = Arc::new(Mutex::new(HostApi::new(plugin, locale)?));
    context.with(|ctx| {
        let host = Arc::clone(&host);
        ctx.globals()
            .set(
                "__lyricoHostCall",
                Func::from(move |name: String, payload: String| {
                    let result = host
                        .lock()
                        .map_err(|_| "Plugin host lock was poisoned".to_string())
                        .and_then(|mut host| host.call(&name, &payload));
                    match result {
                        Ok(value) => json!({ "value": value }).to_string(),
                        Err(error) => json!({ "error": error }).to_string(),
                    }
                }),
            )
            .map_err(|error| error.to_string())?;
        ctx.eval::<(), _>(HOST_BOOTSTRAP)
            .map_err(|error| format_js_error(&ctx, error))?;
        for (filename, source) in scripts {
            ctx.eval::<(), _>(source.as_bytes())
                .map_err(|error| format!("{filename}: {}", format_js_error(&ctx, error)))?;
        }
        Ok(())
    })
}

fn format_js_error(ctx: &rquickjs::Ctx<'_>, error: rquickjs::Error) -> String {
    if ctx.has_exception() {
        let exception = ctx.catch();
        let kind = exception
            .as_object()
            .and_then(|object| object.get::<_, String>("name").ok())
            .filter(|name| {
                [
                    "TypeError",
                    "SyntaxError",
                    "ReferenceError",
                    "RangeError",
                    "InternalError",
                    "Error",
                ]
                .contains(&name.as_str())
            })
            .unwrap_or_else(|| "Error".into());
        format!("JavaScript {kind}: {error}: {exception:?}")
    } else {
        error.to_string()
    }
}

fn load_scripts(plugin: &SourcePlugin) -> Result<Vec<(String, String)>, String> {
    let root = Path::new(&plugin.plugin_dir);
    let mut paths = Vec::new();
    for include_dir in &plugin.manifest.include_dirs {
        let directory = root.join(include_dir);
        for entry in WalkDir::new(&directory).follow_links(false) {
            let entry = entry.map_err(|error| error.to_string())?;
            if entry.file_type().is_file()
                && entry
                    .path()
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value.eq_ignore_ascii_case("js"))
            {
                paths.push(entry.path().to_path_buf());
            }
        }
    }
    paths.sort_by_key(|path| {
        path.strip_prefix(root)
            .unwrap_or(path)
            .to_string_lossy()
            .replace('\\', "/")
    });
    paths.push(root.join(&plugin.manifest.entry));
    paths
        .into_iter()
        .map(|path| {
            let filename = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            let source = fs::read_to_string(&path)
                .map_err(|error| format!("Could not read {filename}: {error}"))?;
            Ok((filename, source))
        })
        .collect()
}

struct HostApi {
    plugin_id: String,
    cache_path: PathBuf,
    cache: Map<String, Value>,
    strings: Option<crate::plugins::i18n::Snapshot>,
}

impl HostApi {
    fn new(plugin: &SourcePlugin, locale: Option<&str>) -> Result<Self, String> {
        let cache_path = Path::new(&plugin.plugin_dir).join(".cache.json");
        let cache = fs::read_to_string(&cache_path)
            .ok()
            .and_then(|value| serde_json::from_str(&value).ok())
            .unwrap_or_default();
        let preferences = locale
            .map(|value| vec![value.to_string()])
            .unwrap_or_default();
        let strings = if plugin.manifest.i18n.is_some() {
            crate::plugins::i18n::PluginStrings::load(
                Path::new(&plugin.plugin_dir),
                &plugin.manifest,
            )
            .ok()
            .map(|strings| strings.snapshot(&preferences))
        } else {
            None
        };
        Ok(Self {
            plugin_id: plugin.manifest.id.clone(),
            cache_path,
            cache,
            strings,
        })
    }

    fn call(&mut self, name: &str, payload_json: &str) -> Result<Value, String> {
        let payload: Value = serde_json::from_str(payload_json).unwrap_or_else(|_| json!({}));
        match name {
            "i18n.getLocale" => Ok(Value::String(
                self.strings
                    .as_ref()
                    .map(|snapshot| snapshot.locale().to_string())
                    .unwrap_or_else(|| "und".to_string()),
            )),
            "i18n.t" => {
                let snapshot = self
                    .strings
                    .as_ref()
                    .ok_or_else(|| "Plugin has no string resources".to_string())?;
                let args = payload
                    .get("args")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                snapshot
                    .format(&string(&payload, "key"), &args)
                    .map(Value::String)
            }
            "app.info" => Ok(
                json!({"name":"Lyrico","packageName":"com.lonx.lyrico.desktop","versionName":env!("CARGO_PKG_VERSION"),"versionCode":1,"buildType":"desktop","debug":cfg!(debug_assertions)}),
            ),
            "app.userAgent" => Ok(Value::String(format!(
                "Lyrico/{}",
                env!("CARGO_PKG_VERSION")
            ))),
            "runtime.info" => Ok(
                json!({"pluginApiVersion":PLUGIN_API_VERSION,"hostApiVersion":HOST_API_VERSION,"engine":"quickjs","engineVersion":null,"supportedHostApis":SUPPORTED_HOST_APIS}),
            ),
            "log.debug" | "log.warn" | "log.error" => {
                let level = match name {
                    "log.error" => log::Level::Error,
                    "log.warn" => log::Level::Warn,
                    _ => log::Level::Debug,
                };
                crate::logging::event(
                    level,
                    "plugins",
                    "host.diagnostic",
                    json!({"pluginId":self.plugin_id,"messageOmitted":true}),
                );
                Ok(Value::String(String::new()))
            }
            "cache.get" => self.cache_get(&string(&payload, "key")),
            "cache.set" => {
                self.cache_set(
                    &string(&payload, "key"),
                    &string(&payload, "value"),
                    payload.get("ttlMs").and_then(Value::as_i64).unwrap_or(0),
                )?;
                Ok(Value::String(String::new()))
            }
            "cache.remove" => {
                self.cache.remove(&string(&payload, "key"));
                self.save_cache()?;
                Ok(Value::String(String::new()))
            }
            "cache.clear" => {
                self.cache.clear();
                self.save_cache()?;
                Ok(Value::String(String::new()))
            }
            "crypto.md5" => Ok(Value::String(
                Md5::digest(string(&payload, "text").as_bytes())
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect(),
            )),
            "crypto.aesEcbPkcs5EncryptBase64" => Ok(Value::String(STANDARD.encode(aes_encrypt(
                &string(&payload, "text"),
                &string(&payload, "key"),
            )?))),
            "crypto.aesEcbPkcs5EncryptHex" => Ok(Value::String(
                aes_encrypt(&string(&payload, "text"), &string(&payload, "key"))?
                    .iter()
                    .map(|byte| format!("{byte:02X}"))
                    .collect(),
            )),
            "crypto.aesEcbPkcs5DecryptBase64ToText" => Ok(Value::String(aes_decrypt(
                &string(&payload, "base64"),
                &string(&payload, "key"),
            )?)),
            "base64.encodeText" => Ok(Value::String(STANDARD.encode(string(&payload, "text")))),
            "base64.decodeText" => Ok(Value::String(
                String::from_utf8(decode_standard(&string(&payload, "base64"))?)
                    .map_err(|error| error.to_string())?,
            )),
            "base64.dropBytes" => {
                let bytes = decode_standard(&string(&payload, "base64"))?;
                let count = payload.get("count").and_then(Value::as_u64).unwrap_or(0) as usize;
                Ok(Value::String(
                    STANDARD.encode(bytes.get(count..).unwrap_or_default()),
                ))
            }
            "base64.decodeBytes" => Ok(json!(decode_standard(&string(&payload, "base64"))?)),
            "base64.encodeBytes" => Ok(Value::String(
                STANDARD.encode(byte_array(payload.get("bytes"))),
            )),
            "base64.encodeUrlText" => Ok(Value::String(
                URL_SAFE_NO_PAD.encode(string(&payload, "text")),
            )),
            "base64.decodeUrlText" => Ok(Value::String(
                String::from_utf8(
                    URL_SAFE_NO_PAD
                        .decode(string(&payload, "base64Url"))
                        .map_err(|error| error.to_string())?,
                )
                .map_err(|error| error.to_string())?,
            )),
            "base64.encodeUrlBytes" => Ok(Value::String(
                URL_SAFE_NO_PAD.encode(byte_array(payload.get("bytes"))),
            )),
            "base64.decodeUrlBytes" => Ok(json!(URL_SAFE_NO_PAD
                .decode(string(&payload, "base64Url"))
                .map_err(|error| error.to_string())?)),
            "base64.toUrl" => Ok(Value::String(
                string(&payload, "base64")
                    .replace('+', "-")
                    .replace('/', "_")
                    .trim_end_matches('=')
                    .to_string(),
            )),
            "base64.fromUrl" => {
                let mut value = string(&payload, "base64Url")
                    .replace('-', "+")
                    .replace('_', "/");
                while value.len() % 4 != 0 {
                    value.push('=');
                }
                Ok(Value::String(value))
            }
            "bytes.xor" => Ok(json!(xor(
                &byte_array(payload.get("bytes")),
                &byte_array(payload.get("key"))
            )?)),
            "bytes.xorBase64" => Ok(Value::String(STANDARD.encode(xor(
                &decode_standard(&string(&payload, "base64"))?,
                &byte_array(payload.get("key")),
            )?))),
            "compression.inflateBytesToText" => {
                Ok(Value::String(inflate(&byte_array(payload.get("bytes")))?))
            }
            "compression.inflateBase64ToText" => Ok(Value::String(inflate(&decode_standard(
                &string(&payload, "base64"),
            )?)?)),
            name if name.starts_with("http.") => http_call(&self.plugin_id, name, &payload),
            name if name.starts_with("xml.") => super::xml::call(name, &payload),
            _ => Err(format!("Unsupported host API: {name}")),
        }
    }

    fn cache_get(&mut self, key: &str) -> Result<Value, String> {
        let Some(item) = self.cache.get(key) else {
            return Ok(Value::String(String::new()));
        };
        let expires = item.get("expiresAt").and_then(Value::as_u64).unwrap_or(0);
        if expires > 0 && expires <= now_ms() {
            self.cache.remove(key);
            self.save_cache()?;
            return Ok(Value::String(String::new()));
        }
        Ok(Value::String(
            item.get("value")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string(),
        ))
    }

    fn cache_set(&mut self, key: &str, value: &str, ttl_ms: i64) -> Result<(), String> {
        if key.is_empty() {
            return Err("Cache key must not be empty".to_string());
        }
        let expires_at = if ttl_ms > 0 {
            now_ms().saturating_add(ttl_ms as u64)
        } else {
            0
        };
        self.cache.insert(
            key.to_string(),
            json!({"value": value, "expiresAt": expires_at}),
        );
        self.save_cache()
    }

    fn save_cache(&self) -> Result<(), String> {
        fs::write(
            &self.cache_path,
            serde_json::to_vec(&self.cache).map_err(|error| error.to_string())?,
        )
        .map_err(|error| error.to_string())
    }
}

fn http_call(plugin_id: &str, name: &str, payload: &Value) -> Result<Value, String> {
    let started = Instant::now();
    let result = http_call_inner(plugin_id, name, payload);
    if result.is_err() {
        crate::logging::event(
            log::Level::Warn,
            "network",
            "http.failed",
            json!({"pluginId":plugin_id,"host":reqwest::Url::parse(&string(payload,"url")).ok().and_then(|url| url.host_str().map(str::to_owned)),"method":if name.contains("post") {"POST"} else {"GET"},"elapsedMs":started.elapsed().as_millis(),"error":result.as_ref().err().map(|error| http_error_summary(error))}),
        );
    }
    result
}

fn http_error_summary(error: &str) -> &'static str {
    if error.starts_with("HTTP timeout:") {
        "Request timed out"
    } else if error.starts_with("HTTP connection:") {
        "Cannot establish connection (DNS, TCP or TLS)"
    } else if error.starts_with("HTTP redirect:") {
        "Redirect limit or redirect policy failure"
    } else if error.starts_with("HTTP response body:") {
        "Cannot read response body"
    } else if error.starts_with("HTTP request:") {
        "Invalid or unsuccessful HTTP request"
    } else {
        "Cannot prepare request or decode response"
    }
}
fn request_error(error: reqwest::Error, stage: &str) -> String {
    let category = if error.is_timeout() {
        "timeout"
    } else if error.is_connect() {
        "connection"
    } else if error.is_redirect() {
        "redirect"
    } else if stage == "response body" {
        "response body"
    } else {
        "request"
    };
    format!("HTTP {category}: {error}")
}

fn http_call_inner(plugin_id: &str, name: &str, payload: &Value) -> Result<Value, String> {
    let started = Instant::now();
    let timeout = payload
        .get("readTimeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(12_000)
        .clamp(1_000, 60_000);
    let redirects = if payload
        .get("followRedirects")
        .and_then(Value::as_bool)
        .unwrap_or(true)
    {
        reqwest::redirect::Policy::limited(10)
    } else {
        reqwest::redirect::Policy::none()
    };
    let client = Client::builder()
        .timeout(Duration::from_millis(timeout))
        .redirect(redirects)
        .build()
        .map_err(|error| error.to_string())?;
    let mut headers = HeaderMap::new();
    if let Some(values) = payload.get("headers").and_then(Value::as_object) {
        for (key, value) in values {
            headers.insert(
                HeaderName::from_bytes(key.as_bytes()).map_err(|error| error.to_string())?,
                HeaderValue::from_str(value.as_str().unwrap_or_default())
                    .map_err(|error| error.to_string())?,
            );
        }
    }
    if !headers.contains_key(USER_AGENT) {
        headers.insert(USER_AGENT, HeaderValue::from_static("Lyrico/0.1.0"));
    }
    let url = string(payload, "url");
    let mut request = if name.contains("post") || name.contains("postBytes") {
        let body = http_request_body(payload)?;
        let content_type = payload
            .get("contentType")
            .and_then(Value::as_str)
            .unwrap_or("application/json; charset=utf-8");
        headers.insert(
            CONTENT_TYPE,
            HeaderValue::from_str(content_type).map_err(|error| error.to_string())?,
        );
        client.post(url).body(body)
    } else {
        client.get(url)
    };
    request = request.headers(headers);
    let response = request
        .send()
        .map_err(|error| request_error(error, "send"))?;
    let status = response.status();
    crate::logging::event(
        if status.is_client_error() || status.is_server_error() {
            log::Level::Warn
        } else {
            log::Level::Debug
        },
        "network",
        "http.response",
        json!({"pluginId":plugin_id,"elapsedMs":started.elapsed().as_millis(),"host":response.url().host_str(),"status":status.as_u16(),"method":if name.contains("post") {"POST"} else {"GET"},"timeoutMs":timeout}),
    );
    let response_headers = response
        .headers()
        .iter()
        .fold(Map::new(), |mut map, (key, value)| {
            map.entry(key.to_string())
                .or_insert_with(|| json!([]))
                .as_array_mut()
                .unwrap()
                .push(Value::String(
                    value.to_str().unwrap_or_default().to_string(),
                ));
            map
        });
    let bytes = response
        .bytes()
        .map_err(|error| request_error(error, "response body"))?;
    if name == "http.getText" || name == "http.postText" {
        return String::from_utf8(bytes.to_vec())
            .map(Value::String)
            .map_err(|error| error.to_string());
    }
    if name == "http.postBytes" {
        return Ok(Value::String(STANDARD.encode(bytes)));
    }
    let binary = name == "http.getBytes" || name == "http.postBytesResponse";
    Ok(
        json!({"code":status.as_u16(),"message":status.canonical_reason().unwrap_or_default(),"headers":response_headers,"body":if binary { String::new() } else { String::from_utf8_lossy(&bytes).into_owned() },"bodyBase64":if binary { STANDARD.encode(bytes) } else { String::new() }}),
    )
}

fn http_request_body(payload: &Value) -> Result<Vec<u8>, String> {
    if let Some(value) = payload.get("bodyBytes").filter(|value| value.is_array()) {
        Ok(byte_array(Some(value)))
    } else if !string(payload, "bodyBase64").is_empty() {
        decode_standard(&string(payload, "bodyBase64"))
    } else {
        Ok(string(payload, "body").into_bytes())
    }
}

fn aes_encrypt(text: &str, key: &str) -> Result<Vec<u8>, String> {
    Encryptor::<Aes128>::new_from_slice(key.as_bytes())
        .map_err(|error| error.to_string())
        .map(|cipher| cipher.encrypt_padded_vec::<Pkcs7>(text.as_bytes()))
}
fn aes_decrypt(base64: &str, key: &str) -> Result<String, String> {
    let bytes = decode_standard(base64)?;
    let plain = Decryptor::<Aes128>::new_from_slice(key.as_bytes())
        .map_err(|error| error.to_string())?
        .decrypt_padded_vec::<Pkcs7>(&bytes)
        .map_err(|error| error.to_string())?;
    String::from_utf8(plain).map_err(|error| error.to_string())
}
fn decode_standard(value: &str) -> Result<Vec<u8>, String> {
    STANDARD.decode(value).map_err(|error| error.to_string())
}
fn byte_array(value: Option<&Value>) -> Vec<u8> {
    value
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_u64)
        .map(|value| value as u8)
        .collect()
}
fn xor(bytes: &[u8], key: &[u8]) -> Result<Vec<u8>, String> {
    if key.is_empty() {
        return Err("XOR key must not be empty".to_string());
    }
    Ok(bytes
        .iter()
        .enumerate()
        .map(|(index, byte)| byte ^ key[index % key.len()])
        .collect())
}
fn inflate(bytes: &[u8]) -> Result<String, String> {
    let mut decoder = ZlibDecoder::new(bytes);
    let mut text = String::new();
    decoder
        .read_to_string(&mut text)
        .map_err(|error| error.to_string())?;
    Ok(text)
}
fn string(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

const SUPPORTED_HOST_APIS: &[&str] = &[
    "i18n.getLocale",
    "i18n.t",
    "app.info",
    "app.userAgent",
    "runtime.info",
    "cache.get",
    "cache.set",
    "cache.remove",
    "cache.clear",
    "crypto.md5",
    "crypto.aesEcbPkcs5EncryptBase64",
    "crypto.aesEcbPkcs5EncryptHex",
    "crypto.aesEcbPkcs5DecryptBase64ToText",
    "base64.encodeText",
    "base64.decodeText",
    "base64.dropBytes",
    "base64.decodeBytes",
    "base64.encodeBytes",
    "base64.encodeUrlText",
    "base64.decodeUrlText",
    "base64.encodeUrlBytes",
    "base64.decodeUrlBytes",
    "base64.toUrl",
    "base64.fromUrl",
    "bytes.xor",
    "bytes.xorBase64",
    "compression.inflateBytesToText",
    "compression.inflateBase64ToText",
    "http.getText",
    "http.postText",
    "http.postBytes",
    "http.get",
    "http.post",
    "http.getBytes",
    "http.postBytesResponse",
    "xml.getRootAttributes",
    "xml.findElements",
    "xml.replaceChildrenByAttr",
    "xml.removeElements",
    "log.debug",
    "log.warn",
    "log.error",
];

const HOST_BOOTSTRAP: &str = r#"
(function(){
 function call(name,payload){var r=JSON.parse(__lyricoHostCall(name,JSON.stringify(payload||{})));if(r.error)throw new Error(r.error);return r.value}
 function opts(o){o=o||{};return {headers:o.headers||{},contentType:o.contentType,connectTimeoutMs:o.connectTimeoutMs,readTimeoutMs:o.readTimeoutMs,followRedirects:o.followRedirects,bodyBase64:o.bodyBase64||'',bodyBytes:o.bodyBytes||null}}
 function body(url,value,o){o=opts(o);return {url:String(url||''),body:value==null?'':String(value),bodyBase64:o.bodyBase64,bodyBytes:o.bodyBytes,contentType:o.contentType||'application/json; charset=utf-8',headers:o.headers,connectTimeoutMs:o.connectTimeoutMs,readTimeoutMs:o.readTimeoutMs,followRedirects:o.followRedirects}}
 var app={getInfo:function(){return call('app.info',{})},getUserAgent:function(){return call('app.userAgent',{})}};
 var runtime={getInfo:function(){return call('runtime.info',{})}};
  var map={
   i18n:{getLocale:function(){return call('i18n.getLocale',{})},t:function(k){return call('i18n.t',{key:String(k||''),args:Array.prototype.slice.call(arguments,1)})}},
  cache:{get:function(k){return call('cache.get',{key:String(k||'')})},set:function(k,v,t){return call('cache.set',{key:String(k||''),value:v==null?'':String(v),ttlMs:Number(t||0)})},remove:function(k){return call('cache.remove',{key:String(k||'')})},clear:function(){return call('cache.clear',{})}},
  crypto:{md5:function(v){return call('crypto.md5',{text:String(v||'')})},aesEcbPkcs5EncryptBase64:function(v,k){return call('crypto.aesEcbPkcs5EncryptBase64',{text:String(v||''),key:String(k||'')})},aesEcbPkcs5EncryptHex:function(v,k){return call('crypto.aesEcbPkcs5EncryptHex',{text:String(v||''),key:String(k||'')})},aesEcbPkcs5DecryptBase64ToText:function(v,k){return call('crypto.aesEcbPkcs5DecryptBase64ToText',{base64:String(v||''),key:String(k||'')})}},
  base64:{encodeText:function(v){return call('base64.encodeText',{text:String(v||'')})},decodeText:function(v){return call('base64.decodeText',{base64:String(v||'')})},dropBytes:function(v,n){return call('base64.dropBytes',{base64:String(v||''),count:Number(n||0)})},decodeBytes:function(v){return call('base64.decodeBytes',{base64:String(v||'')})},encodeBytes:function(v){return call('base64.encodeBytes',{bytes:Array.from(v||[])})},encodeUrlText:function(v){return call('base64.encodeUrlText',{text:String(v||'')})},decodeUrlText:function(v){return call('base64.decodeUrlText',{base64Url:String(v||'')})},encodeUrlBytes:function(v){return call('base64.encodeUrlBytes',{bytes:Array.from(v||[])})},decodeUrlBytes:function(v){return call('base64.decodeUrlBytes',{base64Url:String(v||'')})},toUrl:function(v){return call('base64.toUrl',{base64:String(v||'')})},fromUrl:function(v){return call('base64.fromUrl',{base64Url:String(v||'')})}},
  bytes:{xor:function(v,k){return call('bytes.xor',{bytes:Array.from(v||[]),key:Array.from(k||[])})},xorBase64:function(v,k){return call('bytes.xorBase64',{base64:String(v||''),key:Array.from(k||[])})}},
  compression:{inflateBytesToText:function(v){return call('compression.inflateBytesToText',{bytes:Array.from(v||[])})},inflateBase64ToText:function(v){return call('compression.inflateBase64ToText',{base64:String(v||'')})}},
  http:{getText:function(u,o){o=opts(o);return call('http.getText',Object.assign({url:String(u||'')},o))},postText:function(u,v,o){return call('http.postText',body(u,v,o))},postBytes:function(u,v,o){return call('http.postBytes',body(u,v,o))},get:function(u,o){o=opts(o);return call('http.get',Object.assign({url:String(u||'')},o))},post:function(u,v,o){return call('http.post',body(u,v,o))},getBytes:function(u,o){o=opts(o);return call('http.getBytes',Object.assign({url:String(u||'')},o))},postBytesResponse:function(u,v,o){return call('http.postBytesResponse',body(u,v,o))}},
   xml:{getRootAttributes:function(v){return call('xml.getRootAttributes',{xml:String(v||'')})},findElements:function(v,q){return call('xml.findElements',{xml:String(v||''),query:q||{}})},replaceChildrenByAttr:function(v,o){return call('xml.replaceChildrenByAttr',{xml:String(v||''),options:o||{}})},removeElements:function(v,q){return call('xml.removeElements',{xml:String(v||''),query:q||{}})}},
   log:{debug:function(t,m){if(m===undefined){m=t;t='PlatformPlugin'}return call('log.debug',{tag:String(t||''),message:String(m||'')})},warn:function(t,m){if(m===undefined){m=t;t='PlatformPlugin'}return call('log.warn',{tag:String(t||''),message:String(m||'')})},error:function(t,m){if(m===undefined){m=t;t='PlatformPlugin'}return call('log.error',{tag:String(t||''),message:String(m||'')})}}
 };
 map.app=app;map.runtime=runtime;globalThis.app=app;globalThis.runtime=runtime;globalThis.Platform=map;
})();
"#;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::manifest::{PluginManifest, PluginSourceState, SourcePlugin};
    use std::collections::BTreeMap;

    #[test]
    fn loads_include_scripts_before_entry_and_calls_host_api() {
        let root = std::env::temp_dir().join(format!("lyrico-plugin-runtime-{}", now_ms()));
        fs::create_dir_all(root.join("lib")).unwrap();
        fs::write(
            root.join("lib/01_shared.js"),
            "var sharedTitle = 'from include';",
        )
        .unwrap();
        fs::write(
            root.join("source.js"),
            "function searchSongs(request) { return [{ id: Platform.crypto.md5(request.keyword), title: sharedTitle, artist: Platform.app.getInfo().name }]; }",
        )
        .unwrap();
        let plugin = fixture_plugin(&root, true);

        let result = invoke(&plugin, "searchSongs", json!({"keyword":"test"}), None).unwrap();

        assert_eq!(result[0]["title"], "from include");
        assert_eq!(result[0]["artist"], "Lyrico");
        assert_eq!(result[0]["id"], "098f6bcd4621d373cade4e832627b4f6");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn exposes_api4_protocol_and_keeps_empty_capabilities_legacy_compatible() {
        let root = std::env::temp_dir().join(format!("lyrico-plugin-api4-{}", now_ms()));
        fs::create_dir_all(root.join("lib")).unwrap();
        fs::write(
            root.join("source.js"),
            "function searchSongs() { return [Platform.runtime.getInfo()]; }",
        )
        .unwrap();
        let mut plugin = fixture_plugin(&root, true);
        plugin.manifest.capabilities.clear();

        let result = invoke(&plugin, "searchSongs", json!({}), None).unwrap();

        assert_eq!(result[0]["pluginApiVersion"], PLUGIN_API_VERSION);
        assert_eq!(result[0]["hostApiVersion"], HOST_API_VERSION);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn refuses_disabled_plugin() {
        let root = std::env::temp_dir().join(format!("lyrico-plugin-disabled-{}", now_ms()));
        let plugin = fixture_plugin(&root, false);
        assert_eq!(
            invoke(&plugin, "searchSongs", json!({}), None).unwrap_err(),
            "Plugin is disabled for every search type"
        );
    }

    #[test]
    fn exposes_i18n_host_api_and_current_protocol_versions() {
        use crate::plugins::manifest::PluginI18n;
        use std::collections::BTreeMap;
        let root = std::env::temp_dir().join(format!("lyrico-plugin-i18n-runtime-{}", now_ms()));
        fs::create_dir_all(root.join("locales")).unwrap();
        fs::create_dir_all(root.join("lib")).unwrap();
        fs::write(
            root.join("locales/en.json"),
            json!({"greeting": "Hello %s"}).to_string(),
        )
        .unwrap();
        fs::write(
            root.join("locales/zh-Hans.json"),
            json!({"greeting": "你好 %s"}).to_string(),
        )
        .unwrap();
        fs::write(
            root.join("source.js"),
            "function searchSongs(request) { var info = Platform.runtime.getInfo(); return [{ id: Platform.i18n.getLocale(), title: Platform.i18n.t('greeting', 'World'), artist: info.pluginApiVersion + '/' + info.hostApiVersion + '/' + info.supportedHostApis[0] }]; }",
        )
        .unwrap();
        let mut plugin = fixture_plugin(&root, true);
        plugin.manifest.api_version = 5;
        plugin.manifest.min_host_api_version = 4;
        plugin.manifest.i18n = Some(PluginI18n {
            default_locale: "en".to_string(),
            resources: BTreeMap::from([
                ("en".to_string(), "locales/en.json".to_string()),
                ("zh-Hans".to_string(), "locales/zh-Hans.json".to_string()),
            ]),
        });

        let result = invoke(&plugin, "searchSongs", json!({}), Some("zh-Hans")).unwrap();
        assert_eq!(result[0]["id"], "zh-Hans", "{result}");
        assert_eq!(result[0]["title"], "你好 World", "{result}");
        assert_eq!(result[0]["artist"], "5/4/i18n.getLocale", "{result}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn i18n_translations_require_installed_string_resources() {
        let root = std::env::temp_dir().join(format!("lyrico-plugin-i18n-missing-{}", now_ms()));
        fs::create_dir_all(root.join("lib")).unwrap();
        fs::write(
            root.join("source.js"),
            "function searchSongs(request) { return [{ id: Platform.i18n.t('greeting') }]; }",
        )
        .unwrap();
        let plugin = fixture_plugin(&root, true);
        let error = invoke(&plugin, "searchSongs", json!({}), None).unwrap_err();
        assert!(error.contains("Plugin has no string resources"), "{error}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    #[ignore = "requires a mobile plugin checkout and network access"]
    fn invokes_a_mobile_plugin_package() {
        let root = PathBuf::from(std::env::var("LYRICO_MOBILE_PLUGIN_DIR").unwrap());
        let manifest: PluginManifest =
            serde_json::from_str(&fs::read_to_string(root.join("manifest.json")).unwrap()).unwrap();
        let source_states = enabled_source_states(&manifest.capabilities);
        let plugin = SourcePlugin {
            manifest,
            plugin_dir: root.to_string_lossy().to_string(),
            icon_path: None,
            icon_data_url: None,
            enabled: true,
            sort_order: 0,
            source_states,
            installed_at: String::new(),
            updated_at: String::new(),
            config: json!({}),
        };
        let result = invoke(
            &plugin,
            "searchSongs",
            json!({"keyword":"周杰伦 晴天","page":1,"pageSize":3,"separator":"/","config":{}}),
            None,
        )
        .unwrap();
        assert!(
            result.as_array().is_some_and(|items| !items.is_empty()),
            "{result}"
        );
        if plugin.manifest.api_version >= 4
            && plugin
                .manifest
                .capabilities
                .iter()
                .any(|capability| capability == "getLyrics")
        {
            let lyrics = invoke(
                &plugin,
                "getLyrics",
                json!({"song":result[0],"page":1,"pageSize":3,"config":plugin.config}),
                None,
            )
            .unwrap();
            let candidates = lyrics.as_array().expect("API4 lyrics must be an array");
            assert!(!candidates.is_empty(), "{lyrics}");
            for key in ["ti", "ar", "al", "date"] {
                assert!(
                    candidates[0]["tags"][key]
                        .as_str()
                        .is_some_and(|value| !value.trim().is_empty()),
                    "missing tags.{key}: {}",
                    candidates[0]
                );
            }
        }
    }

    #[test]
    #[ignore = "requires the mobile Apple plugin checkout"]
    fn runs_mobile_apple_same_family_localization_and_keeps_cross_family_subtitle() {
        let mobile_lib = std::env::var("LYRICO_MOBILE_APPLE_LIB")
            .map(PathBuf::from)
            .unwrap_or_else(|_| {
                PathBuf::from(r"E:\Lyrico\Lyrico-Plugins\apple\lib\01_apple_api.js")
            });
        let root = std::env::temp_dir().join(format!("lyrico-apple-xml-runtime-{}", now_ms()));
        fs::create_dir_all(root.join("lib")).unwrap();
        fs::copy(&mobile_lib, root.join("lib/01_apple_api.js")).unwrap();
        fs::write(
            root.join("source.js"),
            "function searchSongs(request) { return [{ id: 'localized', title: applyAppleOfficialLocalizationToTtml(request.ttml, request.language) }]; }",
        )
        .unwrap();
        let plugin = fixture_plugin(&root, true);
        let chinese = r#"<tt xml:lang="zh-Hant" xmlns:itunes="http://www.apple.com/itunes"><body><div><p itunes:key="L1">這裡有故事</p></div></body><metadata><translations><translation xml:lang="zh-Hans"><text for="L1">这里有故事</text></translation></translations></metadata></tt>"#;
        let localized = invoke(
            &plugin,
            "searchSongs",
            json!({"ttml":chinese,"language":"zh-Hans"}),
            None,
        )
        .unwrap();
        let localized = localized[0]["title"].as_str().unwrap();
        assert!(localized.contains("xml:lang=\"zh-Hans\""));
        assert!(localized.contains(">这里有故事</p>"));
        assert!(!localized.contains("<translation "));

        let english = r#"<tt xml:lang="en" xmlns:itunes="http://www.apple.com/itunes"><body><div><p itunes:key="L1">A story</p></div></body><metadata><translations><translation xml:lang="zh-Hans"><text for="L1">一个故事</text></translation></translations></metadata></tt>"#;
        let unchanged = invoke(
            &plugin,
            "searchSongs",
            json!({"ttml":english,"language":"zh-Hans"}),
            None,
        )
        .unwrap();
        let unchanged = unchanged[0]["title"].as_str().unwrap();
        assert!(unchanged.contains(">A story</p>"));
        assert!(unchanged.contains("<translation xml:lang=\"zh-Hans\""));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn latest_lyrico_plugins_compile() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../Lyrico-Plugins");
        if !root.is_dir() {
            return;
        }
        let supported_types = [
            "text", "textarea", "password", "number", "switch", "dropdown", "markdown",
        ];
        let mut seen = 0;
        for entry in fs::read_dir(&root).unwrap() {
            let dir = entry.unwrap().path();
            let manifest_path = dir.join("manifest.json");
            if !manifest_path.is_file() {
                continue;
            }
            let manifest: PluginManifest =
                serde_json::from_str(&fs::read_to_string(&manifest_path).unwrap())
                    .unwrap_or_else(|error| panic!("{}: {error}", dir.display()));
            assert!(
                (1..=PLUGIN_API_VERSION).contains(&manifest.api_version),
                "{} api {}",
                manifest.id,
                manifest.api_version
            );
            assert!(
                manifest.min_host_api_version <= HOST_API_VERSION,
                "{} host {}",
                manifest.id,
                manifest.min_host_api_version
            );
            for field in &manifest.config_fields {
                assert!(
                    supported_types.contains(&field.field_type.as_str()),
                    "{} field {} type {}",
                    manifest.id,
                    field.key,
                    field.field_type
                );
            }
            crate::plugins::i18n::validate(&dir, &manifest)
                .unwrap_or_else(|error| panic!("{}: {error}", manifest.id));
            let localized =
                crate::plugins::i18n::localize_manifest(&manifest, &dir, &["zh-CN".to_string()])
                    .unwrap_or_else(|error| panic!("{}: {error}", manifest.id));
            assert!(!localized.name.starts_with('@'), "{}", manifest.id);
            let source_states = enabled_source_states(&manifest.capabilities);
            let plugin = SourcePlugin {
                manifest,
                plugin_dir: dir.to_string_lossy().to_string(),
                icon_path: None,
                icon_data_url: None,
                enabled: true,
                sort_order: 0,
                source_states,
                installed_at: String::new(),
                updated_at: String::new(),
                config: json!({}),
            };
            compile_plugin(&plugin, Some("zh-CN"))
                .unwrap_or_else(|error| panic!("{}: {error}", plugin.manifest.id));
            seen += 1;
        }
        assert!(
            seen >= 7,
            "expected the Lyrico-Plugins packages, found {seen}"
        );
    }

    fn fixture_plugin(root: &Path, enabled: bool) -> SourcePlugin {
        let manifest = PluginManifest {
            id: "com.example.test".to_string(),
            name: "Test".to_string(),
            version_code: 1,
            version_name: "1.0.0".to_string(),
            author: String::new(),
            description: String::new(),
            api_version: 3,
            min_host_api_version: 3,
            entry: "source.js".to_string(),
            include_dirs: vec!["lib".to_string()],
            icon: None,
            capabilities: vec!["searchSongs".to_string()],
            config_fields: vec![],
            i18n: None,
        };
        let source_states = if enabled {
            enabled_source_states(&manifest.capabilities)
        } else {
            Default::default()
        };
        SourcePlugin {
            manifest,
            plugin_dir: root.to_string_lossy().to_string(),
            icon_path: None,
            icon_data_url: None,
            enabled,
            sort_order: 0,
            source_states,
            installed_at: String::new(),
            updated_at: String::new(),
            config: json!({}),
        }
    }

    fn enabled_source_states(capabilities: &[String]) -> BTreeMap<String, PluginSourceState> {
        let capabilities = if capabilities.is_empty() {
            vec!["searchSongs"]
        } else {
            capabilities.iter().map(String::as_str).collect()
        };
        let supports = |capability: &str| capabilities.contains(&capability);
        let mut kinds = Vec::new();
        if ["searchSongs", "getLyrics", "searchCovers"]
            .iter()
            .all(|capability| supports(capability))
        {
            kinds.push("aggregated");
        }
        if supports("searchSongs") {
            kinds.push("metadata");
        }
        if supports("getLyrics") {
            kinds.push("lyrics");
        }
        if supports("searchCovers") {
            kinds.push("covers");
        }
        kinds
            .into_iter()
            .map(|kind| {
                (
                    kind.to_string(),
                    PluginSourceState {
                        enabled: true,
                        priority: 0,
                    },
                )
            })
            .collect()
    }
}
#[test]
fn null_binary_body_does_not_override_text_body() {
    let payload = json!({"body":"{\"query\":\"晴天\"}","bodyBytes":null,"bodyBase64":""});
    assert_eq!(
        http_request_body(&payload).unwrap(),
        "{\"query\":\"晴天\"}".as_bytes()
    );
}
