//! JS value semantics shared by the envelope parser and the daemon protocol — `String(v ?? '')` and truthiness —
//! so a hook envelope field and a daemon answer field are read exactly as scripts/inject-context.js reads them.
use serde_json::Value;

/// JS `String(v ?? '')` for a JSON value (absent/null → '').
pub fn js_string(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => js_number_string(n),
        Some(Value::Array(a)) => a.iter().map(|x| js_string(Some(x))).collect::<Vec<_>>().join(","),
        Some(Value::Object(_)) => "[object Object]".to_string(),
    }
}

/// JS `String(number)` for the values a JSON document can carry: integers print without a fraction (`1.0` → "1"),
/// other finite numbers in their shortest form. (serde_json would print `1.0`.)
fn js_number_string(n: &serde_json::Number) -> String {
    if let Some(i) = n.as_i64() {
        return i.to_string();
    }
    if let Some(u) = n.as_u64() {
        return u.to_string();
    }
    match n.as_f64() {
        Some(f) if f.is_finite() && f.fract() == 0.0 && f.abs() < 1e21 => format!("{f:.0}"),
        Some(f) => f.to_string(),
        None => n.to_string(),
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

/// JSON.parse accepts a lone surrogate escape (`\ud83d` without its pair) and the string carries the lone
/// surrogate; writing it to stdout then yields U+FFFD. serde_json refuses the escape. Replace lone surrogate
/// escapes with `\ufffd` before parsing so both clients print the same bytes — the daemon can produce one
/// when a fact is cut at a UTF-16 index inside an astral character.
pub fn sanitize_lone_surrogate_escapes(text: &str) -> String {
    let b = text.as_bytes();
    let hex4 = |i: usize| -> Option<u32> {
        if i + 6 > b.len() || b[i] != b'\\' || b[i + 1] != b'u' {
            return None;
        }
        std::str::from_utf8(&b[i + 2..i + 6]).ok().and_then(|h| u32::from_str_radix(h, 16).ok())
    };
    let mut out = String::with_capacity(text.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'\\' && i + 1 < b.len() {
            if let Some(cp) = hex4(i) {
                if (0xD800..0xDC00).contains(&cp) {
                    match hex4(i + 6) {
                        Some(low) if (0xDC00..0xE000).contains(&low) => {
                            out.push_str(&text[i..i + 12]);
                            i += 12;
                        }
                        _ => {
                            out.push_str("\\ufffd");
                            i += 6;
                        }
                    }
                    continue;
                }
                if (0xDC00..0xE000).contains(&cp) {
                    out.push_str("\\ufffd");
                    i += 6;
                    continue;
                }
                out.push_str(&text[i..i + 6]);
                i += 6;
                continue;
            }
            // any other escape: copy the backslash and its escaped character together (so `\\u` is not an escape).
            // Only an ASCII byte can be taken as one byte — a non-ASCII char after the backslash is copied by the
            // normal path below (slicing at i + 2 inside a multi-byte char would panic; round-2 critique N1).
            if b[i + 1] < 0x80 {
                out.push_str(&text[i..i + 2]);
                i += 2;
            } else {
                out.push('\\');
                i += 1;
            }
            continue;
        }
        // copy one UTF-8 character
        let ch_len = text[i..].chars().next().map(char::len_utf8).unwrap_or(1);
        out.push_str(&text[i..i + ch_len]);
        i += ch_len;
    }
    out
}


#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    #[test]
    fn lone_surrogate_escapes_become_replacement_chars_and_pairs_survive() {
        assert_eq!(sanitize_lone_surrogate_escapes(r#"{"context":"a\ud83d"}"#), r#"{"context":"a\ufffd"}"#);
        assert_eq!(sanitize_lone_surrogate_escapes(r#"{"context":"\ud83d\ude00"}"#), r#"{"context":"\ud83d\ude00"}"#);
        assert_eq!(sanitize_lone_surrogate_escapes(r#"{"context":"\ude00x"}"#), r#"{"context":"\ufffdx"}"#);
        assert_eq!(sanitize_lone_surrogate_escapes(r#"{"c":"\\ud83d"}"#), r#"{"c":"\\ud83d"}"#); // escaped backslash, not an escape
        assert_eq!(sanitize_lone_surrogate_escapes("{\"c\":\"한글 🙂 \\u00e9\"}"), "{\"c\":\"한글 🙂 \\u00e9\"}");
        let v: Value = serde_json::from_str(&sanitize_lone_surrogate_escapes(r#"{"ok":true,"context":"x\ud83d"}"#)).unwrap();
        assert_eq!(v["context"].as_str().unwrap(), "x\u{FFFD}");
    }

    #[test]
    fn a_backslash_before_a_non_ascii_or_invalid_byte_never_panics() {
        // `\é` — the byte after the backslash starts a 2-byte character; `\` + U+FFFD (what from_utf8_lossy makes of 0xFF)
        for s in ["{\"ok\":true,\"context\":\"\\é\"}", "{\"ok\":true,\"context\":\"\\\u{FFFD}\"}", "\\", "\\\\", "x\\"] {
            let out = sanitize_lone_surrogate_escapes(s);
            assert!(!out.is_empty());
            // still not valid JSON (JSON.parse would throw too) → the caller answers daemon-error, never a panic
            assert!(serde_json::from_str::<Value>(&out).is_err() || !s.starts_with('{'));
        }
        assert_eq!(sanitize_lone_surrogate_escapes("\\é"), "\\é");
    }
}
