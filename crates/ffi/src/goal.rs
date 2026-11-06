use crate::rest::HttpCall;
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
    pub holds_engine: bool,
}

impl From<core::GoalView> for GoalView {
    fn from(v: core::GoalView) -> Self {
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
