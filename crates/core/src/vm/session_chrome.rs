use crate::protocol::SessionStatus;
use crate::transcript::TranscriptState;
use crate::vm::model_name::friendly_model;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SessionChrome {
    pub status: String,
    pub status_label: String,
    pub busy: bool,
    pub enabled: bool,
    pub model: Option<String>,
    pub permission_mode: Option<String>,
    pub mode_label: Option<String>,
    pub can_run_shell: bool,
    pub queued: u32,
}

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

pub fn session_chrome(state: &TranscriptState, init_model: Option<&str>, can_run_shell: bool, queued: u32) -> SessionChrome {
    let model = state.model.as_deref().or_else(|| state.session.as_ref().and_then(|info| info.model.as_deref())).or(init_model);
    let permission_mode = state.permission_mode.clone().filter(|mode| !mode.is_empty());
    SessionChrome {
        status: state.status.map(|status| status.raw().to_owned()).unwrap_or_default(),
        status_label: state.status.map(|status| status_label(status).to_owned()).unwrap_or_default(),
        busy: state.status.is_some_and(is_busy),
        enabled: state.status != Some(SessionStatus::Closed),
        model: friendly_model(model),
        mode_label: permission_mode.as_deref().and_then(mode_short_label).map(str::to_owned),
        permission_mode,
        can_run_shell,
        queued,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn with_status(status: Option<SessionStatus>) -> SessionChrome {
        session_chrome(&TranscriptState { status, ..TranscriptState::default() }, None, false, 0)
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
            let chrome = session_chrome(&state, None, false, 0);
            assert_eq!(chrome.permission_mode.as_deref(), Some(mode));
            assert_eq!(chrome.mode_label.as_deref(), Some(label));
        }
        let state = TranscriptState { permission_mode: Some("yolo".to_owned()), ..TranscriptState::default() };
        let chrome = session_chrome(&state, None, false, 0);
        assert_eq!((chrome.permission_mode.as_deref(), chrome.mode_label), (Some("yolo"), None));
        assert_eq!(with_status(None).permission_mode, None);
    }

    #[test]
    fn the_model_prefers_the_transcript_then_the_init_model_and_is_friendly() {
        let state = TranscriptState { model: Some("claude-opus-5[1m]".to_owned()), ..TranscriptState::default() };
        assert_eq!(session_chrome(&state, Some("gpt-5"), false, 0).model.as_deref(), Some("Opus 5"));
        let chrome = session_chrome(&TranscriptState::default(), Some("gpt-5.6-luna"), true, 3);
        assert_eq!(chrome.model.as_deref(), Some("GPT-5.6 Luna"));
        assert!(chrome.can_run_shell);
        assert_eq!(chrome.queued, 3);
        assert_eq!(with_status(None).model, None);
    }
}
