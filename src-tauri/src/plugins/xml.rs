use quick_xml::events::{BytesEnd, BytesStart, BytesText, Event};
use quick_xml::{Reader, Writer, XmlVersion};
use serde_json::{json, Map, Value};

#[derive(Debug, Clone, PartialEq)]
enum XmlNode {
    Element(XmlElement),
    Text(String),
}

#[derive(Debug, Clone, PartialEq)]
struct XmlElement {
    name: String,
    attributes: Vec<(String, String)>,
    children: Vec<XmlNode>,
}

pub(super) fn call(name: &str, payload: &Value) -> Result<Value, String> {
    let xml = payload
        .get("xml")
        .and_then(Value::as_str)
        .unwrap_or_default();
    match name {
        "xml.getRootAttributes" => {
            let root = parse(xml)?;
            Ok(Value::Object(attributes_to_json(&root.attributes)))
        }
        "xml.findElements" => {
            let root = parse(xml)?;
            let query = payload.get("query").unwrap_or(&Value::Null);
            let mut results = Vec::new();
            walk(&root, &mut |element| {
                if matches_query(element, query) {
                    results.push(element_to_json(element));
                }
            });
            Ok(Value::Array(results))
        }
        "xml.replaceChildrenByAttr" => {
            let mut root = parse(xml)?;
            replace_children_by_attr(&mut root, payload.get("options").unwrap_or(&Value::Null))?;
            Ok(Value::String(serialize_element(&root)?))
        }
        "xml.removeElements" => {
            let mut root = parse(xml)?;
            remove_elements(&mut root, payload.get("query").unwrap_or(&Value::Null));
            collapse_empty_translations(&mut root);
            Ok(Value::String(serialize_element(&root)?))
        }
        _ => Err(format!("Unsupported XML host API: {name}")),
    }
}

fn parse(xml: &str) -> Result<XmlElement, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(false);
    let mut stack: Vec<XmlElement> = Vec::new();
    let mut root = None;

    loop {
        match reader.read_event().map_err(|error| error.to_string())? {
            Event::Start(start) => stack.push(element_from_start(&start)?),
            Event::Empty(start) => {
                let element = element_from_start(&start)?;
                if let Some(parent) = stack.last_mut() {
                    parent.children.push(XmlNode::Element(element));
                } else {
                    root = Some(element);
                }
            }
            Event::Text(text) => {
                if let Some(parent) = stack.last_mut() {
                    let value = quick_xml::escape::unescape(text.as_ref())
                        .map_err(|error| error.to_string())?
                        .into_owned();
                    if !value.is_empty() {
                        parent.children.push(XmlNode::Text(value));
                    }
                }
            }
            Event::CData(text) => {
                if let Some(parent) = stack.last_mut() {
                    let value = text.as_ref().to_string();
                    if !value.is_empty() {
                        parent.children.push(XmlNode::Text(value));
                    }
                }
            }
            Event::End(_) => {
                let element = stack
                    .pop()
                    .ok_or_else(|| "Unexpected XML closing tag".to_string())?;
                if let Some(parent) = stack.last_mut() {
                    parent.children.push(XmlNode::Element(element));
                } else {
                    root = Some(element);
                }
            }
            Event::GeneralRef(reference) => {
                if let Some(parent) = stack.last_mut() {
                    let escaped = format!("&{};", reference.as_ref());
                    let value = quick_xml::escape::unescape(&escaped)
                        .map_err(|error| error.to_string())?
                        .into_owned();
                    parent.children.push(XmlNode::Text(value));
                }
            }
            Event::Eof => break,
            Event::Decl(_) | Event::PI(_) | Event::DocType(_) | Event::Comment(_) => {}
        }
    }

    if !stack.is_empty() {
        return Err("Unclosed XML element".to_string());
    }
    Ok(root.unwrap_or_else(|| XmlElement {
        name: "root".to_string(),
        attributes: Vec::new(),
        children: Vec::new(),
    }))
}

fn element_from_start(start: &BytesStart<'_>) -> Result<XmlElement, String> {
    let name = start.name().as_ref().to_string();
    let mut attributes = Vec::new();
    for attribute in start.attributes().with_checks(false) {
        let attribute = attribute.map_err(|error| error.to_string())?;
        let key = attribute.key.as_ref().to_string();
        let value = attribute
            .normalized_value(XmlVersion::Implicit1_0)
            .map_err(|error| error.to_string())?
            .into_owned();
        attributes.push((key, value));
    }
    Ok(XmlElement {
        name,
        attributes,
        children: Vec::new(),
    })
}

fn parse_fragment(fragment: &str) -> Result<Vec<XmlNode>, String> {
    Ok(parse(&format!("<root>{fragment}</root>"))?.children)
}

fn serialize_element(element: &XmlElement) -> Result<String, String> {
    serialize_node(&XmlNode::Element(element.clone()))
}

fn serialize_node(node: &XmlNode) -> Result<String, String> {
    let mut writer = Writer::new(Vec::new());
    write_node(&mut writer, node)?;
    String::from_utf8(writer.into_inner()).map_err(|error| error.to_string())
}

fn write_node(writer: &mut Writer<Vec<u8>>, node: &XmlNode) -> Result<(), String> {
    match node {
        XmlNode::Text(value) => writer
            .write_event(Event::Text(BytesText::new(value)))
            .map_err(|error| error.to_string())?,
        XmlNode::Element(element) => {
            let mut start = BytesStart::new(element.name.as_str());
            for (name, value) in &element.attributes {
                start.push_attribute((name.as_str(), value.as_str()));
            }
            writer
                .write_event(Event::Start(start))
                .map_err(|error| error.to_string())?;
            for child in &element.children {
                write_node(writer, child)?;
            }
            writer
                .write_event(Event::End(BytesEnd::new(element.name.as_str())))
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn walk(element: &XmlElement, block: &mut impl FnMut(&XmlElement)) {
    block(element);
    for child in &element.children {
        if let XmlNode::Element(child) = child {
            walk(child, block);
        }
    }
}

fn walk_mut(element: &mut XmlElement, block: &mut impl FnMut(&mut XmlElement)) {
    block(element);
    for child in &mut element.children {
        if let XmlNode::Element(child) = child {
            walk_mut(child, block);
        }
    }
}

fn matches_query(element: &XmlElement, query: &Value) -> bool {
    let tag = query.get("tag").and_then(Value::as_str).unwrap_or_default();
    if !tag.is_empty() && element.name != tag {
        return false;
    }
    query
        .get("attrs")
        .and_then(Value::as_object)
        .is_none_or(|attrs| {
            attrs.iter().all(|(name, expected)| {
                attribute(element, name) == expected.as_str().unwrap_or_default()
            })
        })
}

fn attribute<'a>(element: &'a XmlElement, name: &str) -> &'a str {
    element
        .attributes
        .iter()
        .find_map(|(key, value)| (key == name).then_some(value.as_str()))
        .unwrap_or_default()
}

fn set_attribute(element: &mut XmlElement, name: &str, value: String) {
    if let Some((_, current)) = element.attributes.iter_mut().find(|(key, _)| key == name) {
        *current = value;
    } else {
        element.attributes.push((name.to_string(), value));
    }
}

fn replace_children_by_attr(root: &mut XmlElement, options: &Value) -> Result<(), String> {
    let target_tag = options
        .get("targetTag")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let key_attr = options
        .get("keyAttr")
        .and_then(Value::as_str)
        .unwrap_or_default();
    if target_tag.is_empty() || key_attr.is_empty() {
        return Ok(());
    }

    if let Some(attributes) = options.get("rootAttributes").and_then(Value::as_object) {
        for (name, value) in attributes {
            set_attribute(root, name, value.as_str().unwrap_or_default().to_string());
        }
    }
    let replacements = options
        .get("replacements")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let mut error = None;
    walk_mut(root, &mut |element| {
        if error.is_some() || element.name != target_tag {
            return;
        }
        let key = attribute(element, key_attr);
        let Some(replacement) = replacements.get(key) else {
            return;
        };
        let mode = replacement
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("text");
        let value = replacement
            .get("value")
            .and_then(Value::as_str)
            .unwrap_or_default();
        match if mode == "xml" {
            parse_fragment(value)
        } else {
            Ok(vec![XmlNode::Text(value.to_string())])
        } {
            Ok(children) => element.children = children,
            Err(reason) => error = Some(reason),
        }
    });
    error.map_or(Ok(()), Err)
}

fn remove_elements(element: &mut XmlElement, query: &Value) {
    let mut remaining = Vec::with_capacity(element.children.len());
    for child in std::mem::take(&mut element.children) {
        match child {
            XmlNode::Element(child) if matches_query(&child, query) => {}
            XmlNode::Element(mut child) => {
                remove_elements(&mut child, query);
                remaining.push(XmlNode::Element(child));
            }
            text => remaining.push(text),
        }
    }
    element.children = remaining;
}

fn collapse_empty_translations(element: &mut XmlElement) {
    if element.name == "translations"
        && !element
            .children
            .iter()
            .any(|child| matches!(child, XmlNode::Element(_)))
    {
        element.children.clear();
    }
    for child in &mut element.children {
        if let XmlNode::Element(child) = child {
            collapse_empty_translations(child);
        }
    }
}

fn attributes_to_json(attributes: &[(String, String)]) -> Map<String, Value> {
    attributes
        .iter()
        .map(|(name, value)| (name.clone(), Value::String(value.clone())))
        .collect()
}

fn element_to_json(element: &XmlElement) -> Value {
    json!({
        "tag": element.name,
        "attrs": attributes_to_json(&element.attributes),
        "text": text_content(element),
        "innerXml": element.children.iter().map(serialize_node).collect::<Result<String, _>>().unwrap_or_default(),
        "children": element.children.iter().filter_map(|child| match child {
            XmlNode::Element(child) => Some(element_to_json(child)),
            XmlNode::Text(_) => None,
        }).collect::<Vec<_>>(),
    })
}

fn text_content(element: &XmlElement) -> String {
    element
        .children
        .iter()
        .map(|child| match child {
            XmlNode::Text(value) => value.clone(),
            XmlNode::Element(child) => text_content(child),
        })
        .collect()
}
