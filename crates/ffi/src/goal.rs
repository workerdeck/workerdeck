use crate::rest::HttpCall;
use wd_native::planner::{fmt_duration, fmt_tokens};
use wd_native::rest::calls;
use wd_native::rest::{GoalCapabilities as CoreCapabilities, GoalState};
use wd_native::vm::goal as core;

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Record)]
pub struct GoalCapabilities {
    pub pause: bool,
    pub budget: bool,
}

impl From<CoreCapabilities> for GoalCapabilities {
    fn from(c: CoreCapabilities) -> Self {
        Self { pause: c.pause, budget: c.budget }
    }
}

impl From<GoalCapabilities> for CoreCapabilities {
    fn from(c: GoalCapabilities) -> Self {
        Self { pause: c.pause, budget: c.budget }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum GoalStateKind {
    Active,
    Paused,
    Blocked,
    Met,
    Failed,
    Limited,
}

impl From<GoalState> for GoalStateKind {
    fn from(state: GoalState) -> Self {
        match state {
            GoalState::Active => Self::Active,
            GoalState::Paused => Self::Paused,
            GoalState::Blocked => Self::Blocked,
            GoalState::Met => Self::Met,
            GoalState::Failed => Self::Failed,
            GoalState::Limited => Self::Limited,
        }
    }
}

// The session's goal as the menu and the info sheet draw it. `holds_engine`: a codex goal left active keeps the engine
// awake (show `goal_holds_engine_hint()`).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct GoalView {
    pub text: String,
    pub state: GoalStateKind,
    pub state_text: String,
    pub card_text: Option<String>,
    pub set_by: String,
    pub set_by_agent: bool,
    pub set_at: i64,
    pub checks: Option<u32>,
    pub last_reason: Option<String>,
    pub tokens_used: Option<u64>,
    pub token_budget: Option<u64>,
    pub time_used_seconds: Option<u64>,
    // The info sheet's "Goal tokens" ("12.0k of 50.0k") and "Goal time" values, `None` when there is nothing to show.
    pub tokens_text: Option<String>,
    pub time_text: Option<String>,
    pub holds_engine: bool,
}

impl From<core::GoalView> for GoalView {
    fn from(v: core::GoalView) -> Self {
        let tokens_text = match (v.tokens_used, v.token_budget) {
            (None, None) => None,
            (used, budget) => Some(match budget {
                Some(budget) => format!("{} of {}", fmt_tokens(used.unwrap_or(0) as f64), fmt_tokens(budget as f64)),
                None => fmt_tokens(used.unwrap_or(0) as f64),
            }),
        };
        let time_text = v.time_used_seconds.filter(|s| *s > 0).map(|s| fmt_duration(s as f64 * 1000.0));
        Self {
            text: v.text,
            state: v.state.into(),
            state_text: v.state_text,
            card_text: v.card_text,
            set_by: v.set_by,
            set_by_agent: v.set_by_agent,
            set_at: v.set_at,
            checks: v.checks,
            last_reason: v.last_reason,
            tokens_used: v.tokens_used,
            token_budget: v.token_budget,
            time_used_seconds: v.time_used_seconds,
            tokens_text,
            time_text,
            holds_engine: v.holds_engine,
        }
    }
}

// The Set goal dialog's submit: a call to send, or the sentence to show under the field.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum GoalSubmit {
    Send { call: HttpCall },
    Refused { message: String },
}

// `budget_field` is the budget box's text (digits only; ignored unless the engine takes budgets); `shown_budget` the
// budget the dialog opened with, so an untouched field leaves a change made elsewhere alone.
#[uniffi::export]
pub fn set_goal_call(
    id: String,
    text: String,
    budget_field: String,
    shown_budget: Option<u64>,
    goals: Option<GoalCapabilities>,
    generation: i64,
) -> GoalSubmit {
    match core::goal_dialog_input(&text, &budget_field, shown_budget, goals.map(Into::into)) {
        Ok(input) => GoalSubmit::Send { call: calls::set_goal(&id, &input, generation).into() },
        Err(message) => GoalSubmit::Refused { message },
    }
}

#[uniffi::export]
pub fn clear_goal_call(id: String, generation: i64) -> HttpCall {
    calls::clear_goal(&id, generation).into()
}

#[uniffi::export]
pub fn pause_goal_call(id: String, paused: bool, generation: i64) -> HttpCall {
    calls::pause_goal(&id, paused, generation).into()
}

#[uniffi::export]
pub fn goal_holds_engine_hint() -> String {
    core::GOAL_HOLDS_ENGINE_HINT.to_owned()
}

#[uniffi::export]
pub fn goal_text_max() -> u32 {
    core::GOAL_TEXT_MAX as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    fn view(tokens_used: Option<u64>, token_budget: Option<u64>, time_used_seconds: Option<u64>) -> GoalView {
        core::GoalView {
            text: "ship".into(),
            state: GoalState::Active,
            state_text: "Active".into(),
            card_text: None,
            set_by: "You".into(),
            set_by_agent: false,
            set_at: 0,
            checks: None,
            last_reason: None,
            tokens_used,
            token_budget,
            time_used_seconds,
            holds_engine: false,
        }
        .into()
    }

    #[test]
    fn tokens_and_time_read_like_the_web_info_rows() {
        let none = view(None, None, None);
        assert_eq!((none.tokens_text, none.time_text), (None, None));
        assert_eq!(view(Some(12_000), Some(50_000), None).tokens_text.as_deref(), Some("12.0k of 50.0k"));
        assert_eq!(view(None, Some(50_000), None).tokens_text.as_deref(), Some("0 of 50.0k"));
        assert_eq!(view(Some(900), None, None).tokens_text.as_deref(), Some("900"));
        assert_eq!(view(None, None, Some(0)).time_text, None);
        assert_eq!(view(None, None, Some(64)).time_text.as_deref(), Some("1m 4s"));
    }
}
