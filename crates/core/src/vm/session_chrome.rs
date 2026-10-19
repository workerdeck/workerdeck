use crate::protocol::SessionStatus;
use crate::rest::AttachmentKind;
use crate::row_menu::can_background;
use crate::transcript::{Item, TranscriptState};
use crate::vm::model_name::friendly_model;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SessionChrome {
    pub status: String,
    pub status_label: String,
    pub busy: bool,
    pub enabled: bool,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub model_label: Option<String>,
    pub permission_mode: Option<String>,
    pub mode_label: Option<String>,
    pub can_run_shell: bool,
    pub can_clear_context: bool,
    pub queued: u32,
    pub can_sleep: bool,
    // When (epoch ms) Send now shows: `SEND_NOW_AFTER_MS` after the oldest running top-level call the engine can move
    // to the background started (the web's `backgroundableSince`).
    pub send_now_at: Option<i64>,
    pub cwd: Option<String>,
    pub attachment_kinds: Vec<String>,
    pub archived: bool,
    pub superseded_by: Option<String>,
    // An agent's current conversation: New conversation replaces Clear context, and says why while it waits.
    pub agent_id: Option<String>,
    pub agent_name: Option<String>,
    pub new_conversation_blocked: Option<String>,
}

pub const SEND_NOW_AFTER_MS: i64 = 5000;

pub fn status_label(status: SessionStatus) -> &'static str {
    match status {
        SessionStatus::Starting => "Starting",
        SessionStatus::Running => "Running",
        SessionStatus::AwaitingApproval => "Needs approval",
        SessionStatus::Idle => "Idle",
        SessionStatus::Parked => "Parked",
        SessionStatus::Failed => "Failed",
        SessionStatus::Closed => "Closed",
    }
}

pub fn is_busy(status: SessionStatus) -> bool {
    matches!(status, SessionStatus::Starting | SessionStatus::Running | SessionStatus::AwaitingApproval)
}

pub fn mode_short_label(mode: &str) -> Option<&'static str> {
    Some(match mode {
        "default" => "Manual",
        "acceptEdits" => "Edits",
        "bypassPermissions" => "Bypass",
        "plan" => "Plan",
        "dontAsk" => "Don't ask",
        "auto" => "Auto",
        _ => return None,
    })
}

pub fn session_chrome(
    state: &TranscriptState,
    init_model: Option<&str>,
    can_run_shell: bool,
    queued: u32,
    effort: Option<String>,
) -> SessionChrome {
    let model = state.model.as_deref().or_else(|| state.session.as_ref().and_then(|info| info.model.as_deref())).or(init_model);
    let permission_mode = state.permission_mode.clone().filter(|mode| !mode.is_empty());
    let model = friendly_model(model);
    SessionChrome {
        status: state.status.map(|status| status.raw().to_owned()).unwrap_or_default(),
        status_label: state.status.map(|status| status_label(status).to_owned()).unwrap_or_default(),
        busy: state.status.is_some_and(is_busy),
        enabled: state.status != Some(SessionStatus::Closed),
        model_label: model.as_ref().map(|name| effort.as_ref().map_or_else(|| name.clone(), |effort| format!("{name} \u{00B7} {effort}"))),
        model,
        effort,
        mode_label: permission_mode.as_deref().and_then(mode_short_label).map(str::to_owned),
        permission_mode,
        can_run_shell,
        can_clear_context: state.capabilities.as_ref().is_some_and(|c| c.clear_context == Some(true)),
        queued,
        can_sleep: state.capabilities.as_ref().is_some_and(|c| c.engine_sleep == Some(true))
            && state.status == Some(SessionStatus::Idle)
            && !state.engine_asleep
            && state.sdk_session_id.is_some(),
        send_now_at: if state.capabilities.as_ref().is_some_and(|c| c.background_tasks == Some(true)) {
            backgroundable_since(&state.items).map(|since| since + SEND_NOW_AFTER_MS)
        } else {
            None
        },
        cwd: state.cwd.clone().filter(|cwd| !cwd.is_empty()),
        attachment_kinds: state
            .capabilities
            .as_ref()
            .map(|c| {
                c.attachments
                    .iter()
                    .filter_map(|kind| match kind {
                        AttachmentKind::Image => Some("image"),
                        AttachmentKind::Pdf => Some("pdf"),
                        AttachmentKind::Text => Some("text"),
                        AttachmentKind::Unknown => None,
                    })
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default(),
        archived: false,
        superseded_by: None,
        agent_id: None,
        agent_name: None,
        new_conversation_blocked: None,
    }
}

// Walks back only through the current turn: a running call is never older than the last prompt.
pub fn backgroundable_since(items: &[Item]) -> Option<i64> {
    let mut since: Option<i64> = None;
    for item in items.iter().rev() {
        match item {
            Item::User { parent_tool_use_id: None, .. } => break,
            Item::ToolCall(call) if can_background(call) => {
                let ts = call.ts.unwrap_or(0.0) as i64;
                since = Some(since.map_or(ts, |since| since.min(ts)));
            }
            _ => {}
        }
    }
    since
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rest::EngineCapabilities;
    use crate::transcript::{ToolCall, ToolCallStatus};
    use std::sync::Arc;

    fn with_status(status: Option<SessionStatus>) -> SessionChrome {
        session_chrome(&TranscriptState { status, ..TranscriptState::default() }, None, false, 0, None)
    }

    #[test]
    fn every_status_carries_its_wire_name_label_and_busy_flag() {
        let cases = [
            (SessionStatus::Starting, "starting", "Starting", true),
            (SessionStatus::Running, "running", "Running", true),
            (SessionStatus::AwaitingApproval, "awaiting_approval", "Needs approval", true),
            (SessionStatus::Idle, "idle", "Idle", false),
            (SessionStatus::Parked, "parked", "Parked", false),
            (SessionStatus::Failed, "failed", "Failed", false),
            (SessionStatus::Closed, "closed", "Closed", false),
        ];
        for (status, wire, label, busy) in cases {
            let chrome = with_status(Some(status));
            assert_eq!((chrome.status.as_str(), chrome.status_label.as_str(), chrome.busy), (wire, label, busy));
            assert_eq!(chrome.enabled, status != SessionStatus::Closed);
        }
    }

    fn capable(engine_sleep: bool, background_tasks: bool) -> Option<EngineCapabilities> {
        Some(EngineCapabilities {
            engine_sleep: Some(engine_sleep),
            background_tasks: Some(background_tasks),
            attachments: vec![AttachmentKind::Image, AttachmentKind::Unknown, AttachmentKind::Pdf],
            ..EngineCapabilities::default()
        })
    }

    fn call(id: &str, name: &str, parent: Option<&str>, status: ToolCallStatus, ts: Option<f64>) -> Item {
        Item::ToolCall(Arc::new(ToolCall {
            id: id.into(),
            name: name.into(),
            parent_tool_use_id: parent.map(Into::into),
            title: None,
            input: Arc::new(serde_json::Value::Null),
            status,
            result: None,
            ts,
            live_tail: None,
            patch: None,
            execution_id: None,
            backend: None,
            logs: None,
        }))
    }

    fn prompt() -> Item {
        Item::User { id: "u".into(), text: "go".into(), parent_tool_use_id: None, attachments: None, origin: None }
    }

    #[test]
    fn sleep_needs_the_capability_an_idle_status_and_an_awake_engine() {
        let idle = |capabilities, asleep| TranscriptState {
            status: Some(SessionStatus::Idle),
            engine_asleep: asleep,
            capabilities,
            sdk_session_id: Some("sdk".into()),
            ..TranscriptState::default()
        };
        assert!(session_chrome(&idle(capable(true, false), false), None, false, 0, None).can_sleep);
        assert!(!session_chrome(&idle(capable(true, false), true), None, false, 0, None).can_sleep);
        assert!(!session_chrome(&idle(capable(false, false), false), None, false, 0, None).can_sleep);
        let fresh = TranscriptState { sdk_session_id: None, ..idle(capable(true, false), false) };
        assert!(!session_chrome(&fresh, None, false, 0, None).can_sleep);
        let running = TranscriptState { status: Some(SessionStatus::Running), ..idle(capable(true, false), false) };
        assert!(!session_chrome(&running, None, false, 0, None).can_sleep);
    }

    #[test]
    fn send_now_counts_from_the_oldest_running_top_level_call_of_this_turn() {
        let items = vec![
            call("old", "Bash", None, ToolCallStatus::Running, Some(1.0)),
            prompt(),
            call("read", "Read", None, ToolCallStatus::Running, Some(2.0)),
            call("nested", "Bash", Some("t"), ToolCallStatus::Running, Some(3.0)),
            call("bash", "Bash", None, ToolCallStatus::Running, Some(50.0)),
            call("agent", "Agent", None, ToolCallStatus::Pending, Some(40.0)),
            call("done", "Bash", None, ToolCallStatus::Settled, Some(10.0)),
        ];
        let state = TranscriptState { items, capabilities: capable(false, true), ..TranscriptState::default() };
        assert_eq!(session_chrome(&state, None, false, 0, None).send_now_at, Some(40 + SEND_NOW_AFTER_MS));
        let without = TranscriptState { capabilities: capable(false, false), ..state };
        assert_eq!(session_chrome(&without, None, false, 0, None).send_now_at, None);
    }

    #[test]
    fn cwd_and_attachment_kinds_come_from_the_state() {
        let state = TranscriptState { cwd: Some("/w".into()), capabilities: capable(false, false), ..TranscriptState::default() };
        let chrome = session_chrome(&state, None, false, 0, None);
        assert_eq!(chrome.cwd.as_deref(), Some("/w"));
        assert_eq!(chrome.attachment_kinds, vec!["image".to_owned(), "pdf".to_owned()]);
        let blank = TranscriptState { cwd: Some(String::new()), ..TranscriptState::default() };
        assert_eq!(session_chrome(&blank, None, false, 0, None).cwd, None);
    }

    #[test]
    fn an_unknown_status_is_blank_idle_and_enabled() {
        let chrome = with_status(None);
        assert_eq!((chrome.status.as_str(), chrome.status_label.as_str(), chrome.busy, chrome.enabled), ("", "", false, true));
    }

    #[test]
    fn every_mode_has_its_chip_label() {
        let cases = [
            ("default", "Manual"),
            ("acceptEdits", "Edits"),
            ("bypassPermissions", "Bypass"),
            ("plan", "Plan"),
            ("dontAsk", "Don't ask"),
            ("auto", "Auto"),
        ];
        for (mode, label) in cases {
            let state = TranscriptState { permission_mode: Some(mode.to_owned()), ..TranscriptState::default() };
            let chrome = session_chrome(&state, None, false, 0, None);
            assert_eq!(chrome.permission_mode.as_deref(), Some(mode));
            assert_eq!(chrome.mode_label.as_deref(), Some(label));
        }
        let state = TranscriptState { permission_mode: Some("yolo".to_owned()), ..TranscriptState::default() };
        let chrome = session_chrome(&state, None, false, 0, None);
        assert_eq!((chrome.permission_mode.as_deref(), chrome.mode_label), (Some("yolo"), None));
        assert_eq!(with_status(None).permission_mode, None);
    }

    #[test]
    fn the_model_prefers_the_transcript_then_the_init_model_and_is_friendly() {
        let state = TranscriptState { model: Some("claude-opus-5[1m]".to_owned()), ..TranscriptState::default() };
        assert_eq!(session_chrome(&state, Some("gpt-5"), false, 0, None).model.as_deref(), Some("Opus 5"));
        let chrome = session_chrome(&TranscriptState::default(), Some("gpt-5.6-luna"), true, 3, Some("high".to_owned()));
        assert_eq!(chrome.model.as_deref(), Some("GPT-5.6 Luna"));
        assert_eq!(chrome.model_label.as_deref(), Some("GPT-5.6 Luna \u{00B7} high"));
        assert!(chrome.can_run_shell);
        assert_eq!(chrome.queued, 3);
        assert_eq!(with_status(None).model, None);
    }

    #[test]
    fn clear_context_follows_the_capability() {
        use crate::rest::EngineCapabilities;
        let with = |clear: Option<bool>| TranscriptState {
            capabilities: Some(EngineCapabilities { clear_context: clear, ..EngineCapabilities::default() }),
            ..TranscriptState::default()
        };
        assert!(session_chrome(&with(Some(true)), None, false, 0, None).can_clear_context);
        assert!(!session_chrome(&with(Some(false)), None, false, 0, None).can_clear_context);
        assert!(!session_chrome(&with(None), None, false, 0, None).can_clear_context);
        assert!(!with_status(None).can_clear_context);
    }
}
