use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

pub(crate) const MIN_PLUGIN_API_VERSION: u32 = 1;
pub(crate) const PLUGIN_API_VERSION: u32 = 5;
pub(crate) const MIN_HOST_API_VERSION: u32 = 1;
pub(crate) const HOST_API_VERSION: u32 = 4;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginManifest {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) version_code: u32,
    pub(crate) version_name: String,
    #[serde(default)]
    pub(crate) author: String,
    #[serde(default)]
    pub(crate) description: String,
    pub(crate) api_version: u32,
    #[serde(default = "default_host_api_version")]
    pub(crate) min_host_api_version: u32,
    #[serde(default = "default_entry")]
    pub(crate) entry: String,
    #[serde(default)]
    pub(crate) include_dirs: Vec<String>,
    #[serde(default)]
    pub(crate) icon: Option<String>,
    #[serde(default)]
    pub(crate) capabilities: Vec<String>,
    #[serde(default)]
    pub(crate) config_fields: Vec<PluginConfigField>,
    #[serde(default)]
    pub(crate) i18n: Option<PluginI18n>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginI18n {
    pub(crate) default_locale: String,
    #[serde(default)]
    pub(crate) resources: BTreeMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginConfigField {
    pub(crate) key: String,
    pub(crate) title: String,
    #[serde(default)]
    pub(crate) summary: Option<String>,
    #[serde(default)]
    pub(crate) group: String,
    #[serde(rename = "type")]
    pub(crate) field_type: String,
    #[serde(default)]
    pub(crate) required: bool,
    #[serde(default, deserialize_with = "deserialize_config_default")]
    pub(crate) default_value: String,
    #[serde(default)]
    pub(crate) options: Vec<PluginConfigOption>,
    #[serde(default)]
    pub(crate) dependency: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginConfigOption {
    pub(crate) value: String,
    pub(crate) label: String,
    #[serde(default)]
    pub(crate) summary: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SourcePlugin {
    #[serde(flatten)]
    pub(crate) manifest: PluginManifest,
    pub(crate) plugin_dir: String,
    pub(crate) icon_path: Option<String>,
    pub(crate) icon_data_url: Option<String>,
    pub(crate) enabled: bool,
    pub(crate) sort_order: i32,
    pub(crate) source_states: BTreeMap<String, PluginSourceState>,
    pub(crate) installed_at: String,
    pub(crate) updated_at: String,
    pub(crate) config: Value,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginSourceState {
    pub(crate) enabled: bool,
    pub(crate) priority: i32,
}

impl SourcePlugin {
    pub(crate) fn source_state(&self, kind: &str) -> Option<&PluginSourceState> {
        self.source_states.get(kind)
    }

    pub(crate) fn is_enabled_anywhere(&self) -> bool {
        self.source_states.values().any(|state| state.enabled)
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginInstallFailure {
    pub(crate) root_path: String,
    pub(crate) reason: String,
    pub(crate) plugin_id: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginInstallResult {
    pub(crate) installed: Vec<SourcePlugin>,
    pub(crate) failed: Vec<PluginInstallFailure>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginInstallPreviewCandidate {
    pub(crate) manifest: PluginManifest,
    pub(crate) relative_root: String,
    pub(crate) conflict: String,
    pub(crate) existing_version_name: Option<String>,
    pub(crate) icon_data_url: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PluginInstallPreview {
    pub(crate) candidates: Vec<PluginInstallPreviewCandidate>,
    pub(crate) failed: Vec<PluginInstallFailure>,
}

fn default_host_api_version() -> u32 {
    1
}

fn default_entry() -> String {
    "source.js".to_string()
}

fn deserialize_config_default<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = Value::deserialize(deserializer)?;
    match value {
        Value::String(value) => Ok(value),
        Value::Bool(value) => Ok(value.to_string()),
        Value::Number(value) => Ok(value.to_string()),
        Value::Null => Ok(String::new()),
        _ => Err(serde::de::Error::custom(
            "plugin config defaultValue must be a string, boolean, number, or null",
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scalar_config_defaults_are_normalized_to_runtime_strings() {
        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "id": "com.example.defaults",
            "name": "Defaults",
            "versionCode": 1,
            "versionName": "1.0.0",
            "apiVersion": 3,
            "configFields": [
                { "key": "enabled", "title": "Enabled", "type": "switch", "defaultValue": true },
                { "key": "limit", "title": "Limit", "type": "number", "defaultValue": 20 }
            ]
        }))
        .unwrap();

        assert_eq!(manifest.config_fields[0].default_value, "true");
        assert_eq!(manifest.config_fields[1].default_value, "20");
    }

    #[test]
    fn structured_config_defaults_are_rejected() {
        let result = serde_json::from_value::<PluginManifest>(serde_json::json!({
            "id": "com.example.defaults",
            "name": "Defaults",
            "versionCode": 1,
            "versionName": "1.0.0",
            "apiVersion": 3,
            "configFields": [
                { "key": "bad", "title": "Bad", "type": "text", "defaultValue": { "nested": true } }
            ]
        }));

        assert!(result.is_err());
    }

    #[test]
    fn serializes_the_legacy_switch_state_for_the_frontend() {
        let manifest: PluginManifest = serde_json::from_value(serde_json::json!({
            "id": "com.example.state",
            "name": "State",
            "versionCode": 1,
            "versionName": "1.0.0",
            "apiVersion": 3
        }))
        .unwrap();
        let plugin = SourcePlugin {
            manifest,
            plugin_dir: "C:/plugins/com.example.state".to_string(),
            icon_path: None,
            icon_data_url: None,
            enabled: true,
            sort_order: 3,
            source_states: BTreeMap::new(),
            installed_at: String::new(),
            updated_at: String::new(),
            config: Value::Object(Default::default()),
        };

        let value = serde_json::to_value(&plugin).unwrap();

        assert_eq!(value.get("enabled"), Some(&Value::Bool(true)));
        assert_eq!(value.get("sortOrder"), Some(&Value::from(3)));
    }
}
