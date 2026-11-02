//! JS value semantics shared by the envelope parser and the daemon protocol — `String(v ?? '')` and truthiness —
//! so a hook envelope field and a daemon answer field are read exactly as scripts/inject-context.js reads them.
use serde_json::Value;

/// JS `String(v ?? '')` for a JSON value (absent/null → '').
pub fn js_string(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => n.to_string(),
        Some(Value::Array(a)) => a.iter().map(|x| js_string(Some(x))).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

/// JS truthiness of a JSON value (absent → false; arrays and objects are always truthy).
pub fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Array(_)) | Some(Value::Object(_)) => true,
    }
}
