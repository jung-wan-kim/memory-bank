//! Which prompts are worth a context injection — prompt-gate.ts, rule for rule. Lengths are UTF-16 code
//! units like JS `.length`, so a prompt is "short" here exactly when it is short there.

pub const MIN_PROMPT_CHARS: usize = 20;

const MACHINE_PREFIXES: &[(&str, &str)] = &[
    ("<task-notification>", "task-notification"),
    ("<local-command-", "local-command"),
    ("<cross-session-message", "cross-session"),
    ("<teammate-message", "teammate-message"),
];

const REMINDER_OPEN: &str = "<system-reminder>";
const REMINDER_CLOSE: &str = "</system-reminder>";

pub enum Query {
    /// The text the daemon will search (injectionQuery().query in JS). The client sends the raw prompt and the
    /// daemon derives this again, so only the unit tests read it here — kept so both gates are checked on the same
    /// extracted text.
    #[cfg_attr(not(test), allow(dead_code))]
    Use(String),
    Skip(&'static str),
}

impl Query {
    pub fn skip_reason(&self) -> Option<&'static str> {
        match self {
            Query::Use(_) => None,
            Query::Skip(r) => Some(r),
        }
    }
}

/// JS `String.prototype.length`.
pub fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS String.prototype.trim(): ECMAScript WhiteSpace (TAB VT FF SP NBSP ZWNBSP + Unicode Zs) and
/// LineTerminator (LF CR LS PS). Not Rust's `char::is_whitespace`: that one also strips U+0085 and U+001C..1F,
/// which JS keeps — a prompt starting with U+0085 must be judged like JS judges it.
pub(crate) fn is_js_space(c: char) -> bool {
    matches!(c,
        '\u{9}' | '\u{A}' | '\u{B}' | '\u{C}' | '\u{D}' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}'
        | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}')
}

pub(crate) fn trim_start(s: &str) -> &str {
    s.trim_start_matches(is_js_space)
}

pub(crate) fn trim(s: &str) -> &str {
    s.trim_matches(is_js_space)
}

/// The text after any leading <system-reminder> blocks ('' when nothing follows or a block never closes).
fn after_leading_reminders(text: &str) -> &str {
    let mut rest = text;
    while rest.starts_with(REMINDER_OPEN) {
        match rest.find(REMINDER_CLOSE) {
            None => return "",
            Some(end) => rest = trim_start(&rest[end + REMINDER_CLOSE.len()..]),
        }
    }
    rest
}

pub fn injection_query(prompt: &str) -> Query {
    if trim(prompt).is_empty() {
        return Query::Skip("empty");
    }
    let head = trim_start(prompt);
    if head.starts_with("<command-message>") || head.starts_with("<command-name>") {
        // /<command-args>([\s\S]*?)<\/command-args>/ — first open tag, then the nearest close tag after it
        let args = head
            .find("<command-args>")
            .and_then(|o| {
                let after = &head[o + "<command-args>".len()..];
                after.find("</command-args>").map(|c| &after[..c])
            })
            .map(trim)
            .unwrap_or("");
        if args.is_empty() {
            return Query::Skip("slash-command");
        }
        return if js_len(args) >= MIN_PROMPT_CHARS { Query::Use(args.to_string()) } else { Query::Skip("short") };
    }
    if head.starts_with(REMINDER_OPEN) {
        let rest = after_leading_reminders(head);
        if rest.is_empty() {
            return Query::Skip("system-reminder");
        }
        return if js_len(rest) >= MIN_PROMPT_CHARS { Query::Use(rest.to_string()) } else { Query::Skip("short") };
    }
    for (prefix, reason) in MACHINE_PREFIXES {
        if head.starts_with(prefix) {
            return Query::Skip(reason);
        }
    }
    if js_len(prompt) < MIN_PROMPT_CHARS {
        return Query::Skip("short");
    }
    Query::Use(prompt.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reason(p: &str) -> Option<&'static str> {
        injection_query(p).skip_reason()
    }

    // The inputs of test/prompt-gate.test.ts, so both gates are judged by the same cases.
    #[test]
    fn harness_messages_are_skipped() {
        let cases = [
            ("<task-notification>\n<task-id>b9ex41zdi</task-id>\n<status>completed</status>", "task-notification"),
            ("  \n<task-notification><task-id>x</task-id></task-notification>", "task-notification"),
            ("<command-message>workflow-authoring</command-message>\n<command-name>/workflow</command-name>", "slash-command"),
            ("<command-name>/clear</command-name>\n<command-message>clear</command-message>", "slash-command"),
            ("<local-command-stdout>Set model to Opus 5.5 (1M context)</local-command-stdout>", "local-command"),
            ("<local-command-caveat>The command below was run locally</local-command-caveat>", "local-command"),
            ("<cross-session-message from=\"worker\">빌드 끝났습니다, 결과 확인 부탁</cross-session-message>", "cross-session"),
            ("<teammate-message teammate_id=\"qa\">테스트 전부 통과했습니다 — 증거 첨부</teammate-message>", "teammate-message"),
            ("<system-reminder>The user opened a file in the IDE</system-reminder>", "system-reminder"),
        ];
        for (p, r) in cases {
            assert_eq!(reason(p), Some(r), "{p}");
        }
    }

    #[test]
    fn short_and_empty_are_told_apart() {
        assert_eq!(reason(""), Some("empty"));
        assert_eq!(reason("   "), Some("empty"));
        assert_eq!(reason(&"x".repeat(MIN_PROMPT_CHARS - 1)), Some("short"));
        assert_eq!(reason(&"x".repeat(MIN_PROMPT_CHARS)), None);
        // UTF-16 length: 19 Hangul syllables are short, 20 are not — like JS
        assert_eq!(reason(&"가".repeat(19)), Some("short"));
        assert_eq!(reason(&"가".repeat(20)), None);
    }

    #[test]
    fn whitespace_is_the_js_set_not_rusts() {
        assert!(is_js_space('\u{FEFF}') && is_js_space('\u{3000}') && is_js_space('\u{2028}') && is_js_space('\u{A0}'));
        assert!(!is_js_space('\u{85}') && !is_js_space('\u{1C}') && !is_js_space('\u{200B}'));
        // U+0085 before a machine tag is not stripped by JS trimStart → the prompt is text, not a tag → searched
        assert_eq!(reason("\u{85}<task-notification>x</task-notification> 뒤에 충분히 긴 본문이 이어진다"), None);
        assert_eq!(reason("\u{FEFF}<task-notification>x</task-notification>"), Some("task-notification"));
    }

    #[test]
    fn human_prompts_pass() {
        for p in ["결함은 그럼 수정해야되잖아? 주입 지연이랑도 관련있는거 아냐?", "이 로그에 <task-notification> 태그가 왜 남는지 설명해줘", "[Slack 메시지 from 사용자] 배포 상태 다시 확인해 줘"] {
            assert_eq!(reason(p), None, "{p}");
        }
    }

    #[test]
    fn expanded_slash_command_searches_its_arguments() {
        let p = "<command-message>qa-cycle</command-message>\n<command-name>/qa-cycle</command-name>\n<command-args>결제 페이지 환불 버그를 재현하고 원인을 찾아줘</command-args>";
        match injection_query(p) {
            Query::Use(q) => assert_eq!(q, "결제 페이지 환불 버그를 재현하고 원인을 찾아줘"),
            Query::Skip(r) => panic!("skipped: {r}"),
        }
        assert_eq!(reason("<command-name>/model</command-name>\n<command-args></command-args>"), Some("slash-command"));
        assert_eq!(reason("<command-name>/model</command-name>\n<command-args>opus</command-args>"), Some("short"));
        assert_eq!(reason("<command-name>/model</command-name>\n<command-args>never closed"), Some("slash-command"));
    }

    #[test]
    fn leading_reminders_are_stripped() {
        let p = "<system-reminder>The user opened src/a.ts in the IDE</system-reminder>\n<system-reminder>second</system-reminder>\n이 파일의 인증 흐름이 왜 두 번 도는지 설명해줘";
        match injection_query(p) {
            Query::Use(q) => assert_eq!(q, "이 파일의 인증 흐름이 왜 두 번 도는지 설명해줘"),
            Query::Skip(r) => panic!("skipped: {r}"),
        }
        assert_eq!(reason("<system-reminder>x</system-reminder>\n응"), Some("short"));
        assert_eq!(reason("<system-reminder>닫히지 않은 알림 뒤에 무엇이 와도 본문으로 보지 않는다"), Some("system-reminder"));
    }
}
