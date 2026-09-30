use super::manifest::PluginManifest;
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const MAX_LOCALE_BYTES: u64 = 512 * 1024;
const MAX_LOCALES: usize = 64;
const MAX_FORMAT_ARGS: usize = 64;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Token {
    Literal(char),
    Percent,
    Argument { index: usize, kind: char },
}

/// Parses `%s`, `%d`, `%1$s`, `%2$d` and `%%` placeholders.
pub(crate) fn parse_tokens(text: &str) -> Result<Vec<Token>, String> {
    let chars = text.chars().collect::<Vec<_>>();
    let mut tokens = Vec::new();
    let mut implicit = 0_usize;
    let mut has_implicit = false;
    let mut has_explicit = false;
    let mut index = 0_usize;
    while index < chars.len() {
        let current = chars[index];
        if current != '%' {
            tokens.push(Token::Literal(current));
            index += 1;
            continue;
        }
        let start = index;
        index += 1;
        let mut position = None;
        if index < chars.len() && chars[index].is_ascii_digit() {
            let digits_start = index;
            while index < chars.len() && chars[index].is_ascii_digit() {
                index += 1;
            }
            let digits = chars[digits_start..index].iter().collect::<String>();
            if digits.starts_with('0') || index >= chars.len() || chars[index] != '$' {
                return Err(format!("Unsupported format at {start}: {text}"));
            }
            index += 1;
            position = Some(digits.parse::<usize>().map_err(|_| format!("Unsupported format at {start}: {text}"))?);
        }
        if index >= chars.len() {
            return Err(format!("Unsupported format at {start}: {text}"));
        }
        let kind = chars[index];
        index += 1;
        if !matches!(kind, 's' | 'd' | '%') {
            return Err(format!("Unsupported format at {start}: {text}"));
        }
        if kind == '%' {
            if position.is_some() {
                return Err("Use %% for a literal percent".to_string());
            }
            tokens.push(Token::Percent);
            continue;
        }
        let argument_index = match position {
            Some(value) => {
                has_explicit = true;
                value
            }
            None => {
                has_implicit = true;
                implicit += 1;
                implicit
            }
        };
        if argument_index > MAX_FORMAT_ARGS {
            return Err(format!("At most {MAX_FORMAT_ARGS} format arguments are supported"));
        }
        tokens.push(Token::Argument {
            index: argument_index,
            kind,
        });
    }
    if has_implicit && has_explicit {
        return Err("Do not mix indexed and unindexed placeholders".to_string());
    }
    if has_implicit && implicit > 1 {
        return Err("Multiple arguments require positional placeholders".to_string());
    }
    Ok(tokens)
}

fn signature(tokens: &[Token]) -> Result<BTreeMap<usize, char>, String> {
    let mut result: BTreeMap<usize, char> = BTreeMap::new();
    for token in tokens {
        let Token::Argument { index, kind } = token else {
            continue;
        };
        match result.get(index) {
            Some(existing) if existing != kind => {
                return Err(format!("Conflicting argument types at {index}"));
            }
            Some(_) => {}
            None => {
                result.insert(*index, *kind);
            }
        }
    }
    if !result.is_empty() && *result.keys().next_back().unwrap() != result.len() {
        return Err("Argument indexes must be contiguous".to_string());
    }
    Ok(result)
}

/// Detects `%s` / `%d` placeholders the same way the Android host does.
pub(crate) fn has_arguments(text: &str) -> bool {
    let chars = text.chars().collect::<Vec<_>>();
    let mut index = 0;
    while index < chars.len() {
        if chars[index] != '%' {
            index += 1;
            continue;
        }
        let mut cursor = index + 1;
        if cursor < chars.len() && chars[cursor].is_ascii_digit() {
            while cursor < chars.len() && chars[cursor].is_ascii_digit() {
                cursor += 1;
            }
            if cursor < chars.len() && chars[cursor] == '$' {
                cursor += 1;
            } else {
                index += 1;
                continue;
            }
        }
        if cursor < chars.len() && matches!(chars[cursor], 's' | 'd') {
            return true;
        }
        index += 1;
    }
    false
}

pub(crate) fn format(text: &str, args: &[Value]) -> Result<String, String> {
    let tokens = parse_tokens(text)?;
    let signature = signature(&tokens)?;
    if args.len() != signature.len() {
        return Err(format!(
            "Expected {} arguments, got {}",
            signature.len(),
            args.len()
        ));
    }
    for (position, kind) in &signature {
        let value = args
            .get(position - 1)
            .ok_or_else(|| format!("Invalid argument {position} for %{kind}"))?;
        let valid = match kind {
            's' => value.is_string(),
            'd' => value.as_f64().is_some_and(|number| {
                number.is_finite() && number.fract() == 0.0 && number.abs() <= 9_007_199_254_740_991.0
            }),
            _ => false,
        };
        if !valid {
            return Err(format!("Invalid argument {position} for %{kind}"));
        }
    }
    let mut output = String::with_capacity(text.len());
    for token in tokens {
        match token {
            Token::Literal(value) => output.push(value),
            Token::Percent => output.push('%'),
            Token::Argument { index, kind } => {
                let value = args
                    .get(index - 1)
                    .ok_or_else(|| format!("Invalid argument {index} for %{kind}"))?;
                if kind == 'd' {
                    output.push_str(&value.as_f64().map(|number| number as i64).unwrap_or_default().to_string());
                } else {
                    output.push_str(value.as_str().unwrap_or_default());
                }
            }
        }
    }
    Ok(output)
}

#[derive(Debug, Clone, Default)]
struct LocaleParts {
    language: String,
    script: String,
    region: String,
}

fn parse_locale(tag: &str) -> LocaleParts {
    let mut parts = LocaleParts::default();
    for (offset, subtag) in tag.split('-').enumerate() {
        match offset {
            0 => parts.language = subtag.to_lowercase(),
            1 if subtag.len() == 4 && subtag.chars().all(|value| value.is_ascii_alphabetic()) => {
                parts.script = capitalize(subtag);
            }
            1 if subtag.len() == 2 && subtag.chars().all(|value| value.is_ascii_alphabetic()) => {
                parts.region = subtag.to_uppercase();
            }
            1 if subtag.len() == 3 && subtag.chars().all(|value| value.is_ascii_digit()) => {
                parts.region = subtag.to_string();
            }
            2 if parts.script.is_empty()
                && subtag.len() == 2
                && subtag.chars().all(|value| value.is_ascii_alphabetic()) =>
            {
                parts.region = subtag.to_uppercase();
            }
            2 if parts.script.is_empty()
                && subtag.len() == 3
                && subtag.chars().all(|value| value.is_ascii_digit()) =>
            {
                parts.region = subtag.to_string();
            }
            _ => {}
        }
    }
    parts
}

fn capitalize(value: &str) -> String {
    let mut chars = value.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().collect::<String>() + &chars.as_str().to_lowercase(),
        None => String::new(),
    }
}

/// Mirrors the ICU-free script inference used by the Android host for Chinese.
fn script_of(tag: &str) -> String {
    let parts = parse_locale(tag);
    if !parts.script.is_empty() {
        return parts.script;
    }
    if parts.language == "zh" {
        return if ["TW", "HK", "MO"].contains(&parts.region.as_str()) {
            "Hant".to_string()
        } else {
            "Hans".to_string()
        };
    }
    String::new()
}

fn canonicalize_locale(tag: &str) -> Option<String> {
    if tag.is_empty() || tag == "und" || tag.contains('_') || tag.contains('\\') {
        return None;
    }
    let mut output = Vec::new();
    for (offset, subtag) in tag.split('-').enumerate() {
        if subtag.is_empty()
            || subtag.len() > 8
            || !subtag.chars().all(|value| value.is_ascii_alphanumeric())
        {
            return None;
        }
        let canonical = match offset {
            0 => {
                if !(2..=3).contains(&subtag.len()) && !(5..=8).contains(&subtag.len()) {
                    return None;
                }
                subtag.to_lowercase()
            }
            1 if subtag.len() == 4 && subtag.chars().all(|value| value.is_ascii_alphabetic()) => {
                capitalize(subtag)
            }
            1 if subtag.len() == 2 && subtag.chars().all(|value| value.is_ascii_alphabetic()) => {
                subtag.to_uppercase()
            }
            _ => subtag.to_lowercase(),
        };
        output.push(canonical);
    }
    Some(output.join("-"))
}

fn is_canonical_locale(tag: &str) -> bool {
    canonicalize_locale(tag).as_deref() == Some(tag)
}

#[derive(Debug, Clone)]
pub(crate) struct PluginStrings {
    default_locale: String,
    catalogs: BTreeMap<String, Arc<BTreeMap<String, String>>>,
}

#[derive(Debug, Clone)]
pub(crate) struct Snapshot {
    locale: String,
    chain: Vec<Arc<BTreeMap<String, String>>>,
}

impl Snapshot {
    pub(crate) fn locale(&self) -> &str {
        &self.locale
    }

    /// Resolves `@key` references and `@@escape` literals exactly once.
    pub(crate) fn text(&self, value: &str) -> Result<String, String> {
        if value.starts_with("@@") {
            return Ok(value[1..].to_string());
        }
        match value.strip_prefix('@') {
            Some(key) => self.lookup(key),
            None => Ok(value.to_string()),
        }
    }

    pub(crate) fn lookup(&self, key: &str) -> Result<String, String> {
        self.chain
            .iter()
            .find_map(|catalog| catalog.get(key).cloned())
            .ok_or_else(|| format!("Unknown plugin string: {key}"))
    }

    pub(crate) fn format(&self, key: &str, args: &[Value]) -> Result<String, String> {
        let template = self.lookup(key)?;
        if args.is_empty() {
            return Ok(template);
        }
        super::i18n::format(&template, args)
    }
}

impl PluginStrings {
    pub(crate) fn und() -> Self {
        Self {
            default_locale: "und".to_string(),
            catalogs: BTreeMap::new(),
        }
    }

    pub(crate) fn snapshot(&self, preferences: &[String]) -> Snapshot {
        let available = self.catalogs.keys().cloned().collect::<Vec<_>>();
        if available.is_empty() {
            return Snapshot {
                locale: self.default_locale.clone(),
                chain: Vec::new(),
            };
        }
        let selected = preferences
            .iter()
            .find_map(|preference| {
                let wanted = canonicalize_locale(preference).unwrap_or_else(|| preference.clone());
                available
                    .iter()
                    .find(|candidate| candidate.eq_ignore_ascii_case(&wanted))
                    .cloned()
                    .or_else(|| {
                        let wanted_parts = parse_locale(&wanted);
                        let wanted_script = script_of(&wanted);
                        let mut candidates = available
                            .iter()
                            .filter(|candidate| {
                                parse_locale(candidate).language == wanted_parts.language
                                    && script_of(candidate) == wanted_script
                            })
                            .cloned()
                            .collect::<Vec<_>>();
                        candidates.sort_by(|left, right| {
                            let left_region = !parse_locale(left).region.is_empty();
                            let right_region = !parse_locale(right).region.is_empty();
                            right_region
                                .cmp(&left_region)
                                .then_with(|| left.cmp(right))
                        });
                        candidates.into_iter().next()
                    })
            })
            .unwrap_or_else(|| self.default_locale.clone());
        let parts = parse_locale(&selected);
        let mut chain = vec![selected.clone()];
        if !parts.region.is_empty() {
            let mut parent = parts.language.clone();
            if !parts.script.is_empty() {
                parent.push('-');
                parent.push_str(&parts.script);
            }
            chain.push(parent);
        }
        if script_of(&parts.language) == script_of(&selected) {
            chain.push(parts.language.clone());
        }
        chain.push(self.default_locale.clone());
        let mut seen = HashSet::new();
        let chain = chain
            .into_iter()
            .filter(|tag| seen.insert(tag.clone()))
            .filter_map(|tag| self.catalogs.get(&tag).cloned())
            .collect();
        Snapshot {
            locale: selected,
            chain,
        }
    }

    pub(crate) fn load(root: &Path, manifest: &PluginManifest) -> Result<Self, String> {
        let references = referenced_keys(manifest);
        let Some(spec) = manifest.i18n.as_ref() else {
            if !references.is_empty() {
                return Err("String references require i18n resources".to_string());
            }
            return Ok(Self::und());
        };
        if !references.is_empty() && manifest.min_host_api_version < 4 {
            return Err("String references require minHostApiVersion >= 4".to_string());
        }
        if spec.resources.is_empty() || spec.resources.len() > MAX_LOCALES {
            return Err(format!("Expected 1..{MAX_LOCALES} plugin locales"));
        }
        if !spec.resources.contains_key(&spec.default_locale) {
            return Err("Default locale resource is missing".to_string());
        }
        for (tag, path) in &spec.resources {
            if !is_canonical_locale(tag) {
                return Err(format!("Use a canonical BCP 47 locale: {tag}"));
            }
            validate_locale_path(path)?;
        }
        let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
        let catalogs = spec
            .resources
            .iter()
            .map(|(tag, path)| {
                let file = canonical_resource_path(&canonical_root, path)?;
                let metadata = fs::metadata(&file).map_err(|error| error.to_string())?;
                if !metadata.is_file() {
                    return Err(format!("Invalid locale resource: {path}"));
                }
                if metadata.len() > MAX_LOCALE_BYTES {
                    return Err(format!("Locale resource exceeds 512 KiB: {path}"));
                }
                let contents = fs::read_to_string(&file).map_err(|error| error.to_string())?;
                let values: BTreeMap<String, String> = serde_json::from_str(&contents)
                    .map_err(|error| format!("Locale resource is invalid: {path}: {error}"))?;
                if values.keys().any(|key| key.trim().is_empty()) {
                    return Err("Empty resource key".to_string());
                }
                Ok((tag.clone(), Arc::new(values)))
            })
            .collect::<Result<BTreeMap<_, _>, String>>()?;
        let defaults = catalogs
            .get(&spec.default_locale)
            .cloned()
            .ok_or_else(|| "Default locale resource is missing".to_string())?;
        let formatted_keys = catalogs
            .values()
            .flat_map(|values| {
                values
                    .iter()
                    .filter(|(key, value)| !references.contains(*key) && has_arguments(value))
                    .map(|(key, _)| key.clone())
                    .collect::<Vec<_>>()
            })
            .collect::<HashSet<_>>();
        for (tag, values) in &catalogs {
            for (key, value) in values.iter() {
                if !defaults.contains_key(key) {
                    return Err(format!("{tag}/{key} is absent from default resources"));
                }
                if formatted_keys.contains(key) {
                    let expected = placeholder_signature(defaults.get(key).map(String::as_str).unwrap_or_default())?;
                    let actual = placeholder_signature(value)?;
                    if expected != actual {
                        return Err(format!("{tag}/{key} has incompatible placeholders"));
                    }
                }
            }
        }
        for key in &references {
            if !defaults.contains_key(key) {
                return Err(format!("Missing default string: {key}"));
            }
        }
        Ok(Self {
            default_locale: spec.default_locale.clone(),
            catalogs,
        })
    }
}

fn referenced_keys(manifest: &PluginManifest) -> HashSet<String> {
    let mut values = vec![manifest.name.clone(), manifest.description.clone()];
    for field in &manifest.config_fields {
        values.push(field.title.clone());
        values.push(field.summary.clone().unwrap_or_default());
        values.push(field.group.clone());
        if field.field_type == "markdown" {
            values.push(field.default_value.clone());
        }
        for option in &field.options {
            values.push(option.label.clone());
            values.push(option.summary.clone());
        }
    }
    values
        .into_iter()
        .filter(|value| value.starts_with('@') && !value.starts_with("@@"))
        .filter_map(|value| value.strip_prefix('@').map(str::to_string))
        .collect()
}

fn placeholder_signature(template: &str) -> Result<Vec<(usize, char)>, String> {
    Ok(signature(&parse_tokens(template)?)?.into_iter().collect())
}

fn validate_locale_path(relative: &str) -> Result<(), String> {
    if relative.is_empty()
        || relative.starts_with('/')
        || relative.contains('\\')
        || relative.split('/').any(|part| part.is_empty() || part == "..")
    {
        return Err(format!("Unsafe locale path: {relative}"));
    }
    if !relative.ends_with(".json") {
        return Err(format!("Invalid locale resource: {relative}"));
    }
    Ok(())
}

fn canonical_resource_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let path = root.join(relative);
    let canonical = path
        .canonicalize()
        .map_err(|_| format!("Invalid locale resource: {relative}"))?;
    if !canonical.starts_with(root) {
        return Err(format!("Invalid locale resource: {relative}"));
    }
    Ok(canonical)
}

/// Validates a manifest's i18n resources without producing display strings.
pub(crate) fn validate(root: &Path, manifest: &PluginManifest) -> Result<(), String> {
    PluginStrings::load(root, manifest).map(|_| ())
}

/// Localizes the display text of a manifest for the current language preference.
pub(crate) fn localize_manifest(
    manifest: &PluginManifest,
    root: &Path,
    preferences: &[String],
) -> Result<PluginManifest, String> {
    let snapshot = PluginStrings::load(root, manifest)?.snapshot(preferences);
    localize_with(manifest, &snapshot)
}

pub(crate) fn localize_with(
    manifest: &PluginManifest,
    snapshot: &Snapshot,
) -> Result<PluginManifest, String> {
    let mut localized = manifest.clone();
    localized.name = snapshot.text(&manifest.name)?;
    localized.description = snapshot.text(&manifest.description)?;
    for (field, source) in localized.config_fields.iter_mut().zip(&manifest.config_fields) {
        field.title = snapshot.text(&source.title)?;
        field.summary = source
            .summary
            .as_ref()
            .map(|summary| snapshot.text(summary))
            .transpose()?;
        if source.field_type == "markdown" {
            let body = if source.default_value.trim().is_empty() {
                source.summary.clone().unwrap_or_default()
            } else {
                source.default_value.clone()
            };
            field.default_value = snapshot.text(&body)?;
        }
        for (option, source_option) in field.options.iter_mut().zip(&source.options) {
            option.label = snapshot.text(&source_option.label)?;
            option.summary = snapshot.text(&source_option.summary)?;
        }
    }
    Ok(localized)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::plugins::manifest::PluginI18n;
    use serde_json::json;

    fn manifest_with(i18n: Option<PluginI18n>) -> PluginManifest {
        let mut manifest: PluginManifest = serde_json::from_value(json!({
            "id": "com.example.source",
            "name": "@plugin.name",
            "versionCode": 1,
            "versionName": "1.0.0",
            "apiVersion": 5,
            "minHostApiVersion": 4,
            "configFields": [
                {
                    "key": "region",
                    "title": "@config.region.title",
                    "group": "@group.request",
                    "type": "dropdown",
                    "defaultValue": "cn",
                    "options": [
                        {"value": "cn", "label": "@config.region.option.cn", "summary": "@config.region.option.summary"}
                    ]
                }
            ]
        }))
        .unwrap();
        manifest.i18n = i18n;
        manifest
    }

    fn fixture_root(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "lyrico-plugin-i18n-{name}-{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("locales")).unwrap();
        root
    }

    fn spec() -> PluginI18n {
        PluginI18n {
            default_locale: "en".to_string(),
            resources: BTreeMap::from([
                ("en".to_string(), "locales/en.json".to_string()),
                ("zh-Hans".to_string(), "locales/zh-Hans.json".to_string()),
                ("zh-Hant".to_string(), "locales/zh-Hant.json".to_string()),
            ]),
        }
    }

    fn write_catalog(root: &Path, name: &str, value: Value) {
        fs::write(root.join(format!("locales/{name}.json")), value.to_string()).unwrap();
    }

    fn write_default_catalogs(root: &Path) {
        write_catalog(
            root,
            "en",
            json!({
                "plugin.name": "Example Source",
                "config.region.title": "Region",
                "group.request": "Requests",
                "config.region.option.cn": "China",
                "config.region.option.summary": "Code",
                "error.failed": "Candidate %1$s failed"
            }),
        );
        write_catalog(
            root,
            "zh-Hans",
            json!({
                "config.region.title": "地区",
                "group.request": "请求",
                "config.region.option.cn": "中国",
                "config.region.option.summary": "代码",
                "error.failed": "候选 %1$s 失败"
            }),
        );
        write_catalog(
            root,
            "zh-Hant",
            json!({
                "config.region.title": "地區",
                "group.request": "請求",
                "config.region.option.cn": "中國",
                "config.region.option.summary": "代碼",
                "error.failed": "候選 %1$s 失敗"
            }),
        );
    }

    #[test]
    fn formats_positional_and_implicit_placeholders() {
        assert_eq!(
            format("Candidate %1$s failed: %2$s", &[json!("a"), json!("b")]).unwrap(),
            "Candidate a failed: b"
        );
        assert_eq!(format("%s", &[json!("plain")]).unwrap(), "plain");
        assert_eq!(format("100%% done", &[]).unwrap(), "100% done");
        assert_eq!(format("%d items", &[json!(42)]).unwrap(), "42 items");
        assert_eq!(
            format("%1$d", &[json!(42)]).unwrap(),
            "42"
        );
        assert!(format("%d items", &[json!(1.5)]).is_err());
        assert!(format("%s", &[json!(1)]).is_err());
        assert!(format("%s and %s", &[json!("a")]).is_err());
        assert!(format("%1$s %s", &[json!("a")]).is_err());
        assert!(format("%s", &[]).is_err());
    }

    #[test]
    fn rejects_unsupported_format_tokens() {
        assert!(parse_tokens("%20").is_err());
        assert!(parse_tokens("%").is_err());
        assert!(parse_tokens("%1$d %%").is_ok());
        assert!(!has_arguments("100% off"));
        assert!(has_arguments("100% off %s"));
        assert!(has_arguments("failed %s"));
        assert!(has_arguments("failed %2$s"));
        assert!(!has_arguments("literal @@value"));
    }

    #[test]
    fn loads_and_localizes_manifest() {
        let root = fixture_root("load");
        write_default_catalogs(&root);
        let manifest = manifest_with(Some(spec()));
        let localized = localize_manifest(&manifest, &root, &["zh-CN".to_string()]).unwrap();
        assert_eq!(localized.name, "Example Source");
        assert_eq!(localized.config_fields[0].title, "地区");
        assert_eq!(localized.config_fields[0].options[0].label, "中国");
        assert_eq!(localized.config_fields[0].default_value, "cn");
        assert_eq!(
            PluginStrings::load(&root, &manifest)
                .unwrap()
                .snapshot(&["zh-CN".to_string()])
                .locale(),
            "zh-Hans"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_references_without_i18n_resources() {
        let root = fixture_root("no-i18n");
        let manifest = manifest_with(None);
        assert_eq!(
            PluginStrings::load(&root, &manifest).unwrap_err(),
            "String references require i18n resources"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_references_below_host_api_four() {
        let root = fixture_root("host-api");
        write_default_catalogs(&root);
        let mut manifest = manifest_with(Some(spec()));
        manifest.min_host_api_version = 3;
        assert_eq!(
            PluginStrings::load(&root, &manifest).unwrap_err(),
            "String references require minHostApiVersion >= 4"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_translation_keys_missing_from_default_resources() {
        let root = fixture_root("missing-default");
        write_catalog(
            &root,
            "en",
            json!({
                "plugin.name": "Example Source",
                "config.region.title": "Region",
                "group.request": "Requests",
                "config.region.option.cn": "China",
                "config.region.option.summary": "Code"
            }),
        );
        write_catalog(
            &root,
            "zh-Hans",
            json!({"config.region.title": "地区", "extra.key": "额外"}),
        );
        write_catalog(&root, "zh-Hant", json!({"config.region.title": "地區"}));
        let error = PluginStrings::load(&root, &manifest_with(Some(spec()))).unwrap_err();
        assert!(error.contains("is absent from default resources"), "{error}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn rejects_incompatible_placeholder_signatures() {
        let root = fixture_root("signatures");
        write_catalog(
            &root,
            "en",
            json!({
                "plugin.name": "Example Source",
                "config.region.title": "Region",
                "group.request": "Requests",
                "config.region.option.cn": "China",
                "config.region.option.summary": "Code",
                "error.failed": "Candidate %1$s failed"
            }),
        );
        write_catalog(
            &root,
            "zh-Hans",
            json!({
                "config.region.title": "地区",
                "group.request": "请求",
                "config.region.option.cn": "中国",
                "config.region.option.summary": "代码",
                "error.failed": "候选 %1$s %2$s 失败"
            }),
        );
        write_catalog(
            &root,
            "zh-Hant",
            json!({
                "config.region.title": "地區",
                "group.request": "請求",
                "config.region.option.cn": "中國",
                "config.region.option.summary": "代碼",
                "error.failed": "候選 %1$s %2$s 失敗"
            }),
        );
        let error = PluginStrings::load(&root, &manifest_with(Some(spec()))).unwrap_err();
        assert!(error.contains("incompatible placeholders"), "{error}");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn validates_locale_tags_and_paths() {
        let root = fixture_root("paths");
        write_default_catalogs(&root);
        let mut bad_tag = spec();
        bad_tag
            .resources
            .insert("zh-cn".to_string(), "locales/zh-cn.json".to_string());
        assert!(PluginStrings::load(&root, &manifest_with(Some(bad_tag)))
            .unwrap_err()
            .contains("canonical BCP 47"));
        let mut bad_path = spec();
        bad_path
            .resources
            .insert("ja".to_string(), "../locales/ja.json".to_string());
        assert!(PluginStrings::load(&root, &manifest_with(Some(bad_path)))
            .unwrap_err()
            .contains("Unsafe locale path"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn snapshot_falls_back_to_parent_and_default_resources() {
        let root = fixture_root("fallback");
        write_default_catalogs(&root);
        let strings = PluginStrings::load(&root, &manifest_with(Some(spec()))).unwrap();
        let snapshot = strings.snapshot(&["zh-TW".to_string()]);
        assert_eq!(snapshot.locale(), "zh-Hant");
        assert_eq!(snapshot.lookup("config.region.title").unwrap(), "地區");
        assert_eq!(snapshot.lookup("plugin.name").unwrap(), "Example Source");
        assert_eq!(
            snapshot.format("error.failed", &[json!("x")]).unwrap(),
            "候選 x 失敗"
        );
        assert_eq!(snapshot.text("@@literal").unwrap(), "@literal");
        assert_eq!(strings.snapshot(&["de-DE".to_string()]).locale(), "en");
        assert_eq!(PluginStrings::und().snapshot(&["zh-CN".to_string()]).locale(), "und");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn without_i18n_the_manifest_keeps_literal_text() {
        let root = fixture_root("literal");
        let mut manifest = manifest_with(None);
        manifest.name = "Example Source".to_string();
        manifest.description = "Plain description".to_string();
        manifest.config_fields[0].title = "Region".to_string();
        manifest.config_fields[0].group = "Requests".to_string();
        manifest.config_fields[0].options[0].label = "China".to_string();
        manifest.config_fields[0].options[0].summary = String::new();
        assert_eq!(
            localize_manifest(&manifest, &root, &["zh-CN".to_string()]).unwrap().name,
            "Example Source"
        );
        fs::remove_dir_all(root).unwrap();
    }
}
