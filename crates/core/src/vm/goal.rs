use crate::rest::{EngineCapabilities, GoalCapabilities, GoalLimit, GoalSetter, GoalState, SessionGoal, SessionInfo};
use crate::transcript::NoticeLevel;
use crate::vm::text::{js_trim, utf16_len};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const GOAL_TEXT_MAX: usize = 4000;
pub const GOAL_EMOJI: &str = "🎯";
pub const GOAL_CLEAR_ALIASES: [&str; 6] = ["clear", "stop", "off", "reset", "none", "cancel"];
pub const GOAL_HOLDS_ENGINE_HINT: &str = "The goal keeps the engine working and awake; pause or clear it to let the session sleep";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GoalNotice {
    Set,
    CheckFailed,
    Met,
    Failed,
    Limited,
    Blocked,
    Paused,
    Resumed,
    Cleared,
}

impl GoalNotice {
    pub fn parse(raw: &str) -> Option<Self> {
        serde_json::from_value(Value::from(raw)).ok()
    }
}

// `token_budget`: outer `None` leaves the budget alone, `Some(None)` removes it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalInput {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub token_budget: Option<Option<u64>>,
}

pub fn goal_active(goal: Option<&SessionGoal>) -> bool {
    goal.is_some_and(|goal| goal.state == GoalState::Active)
}

pub fn goal_capabilities(capabilities: Option<&EngineCapabilities>) -> Option<GoalCapabilities> {
    capabilities.and_then(|capabilities| capabilities.goals)
}

pub fn read_goal_input(input: &Value, capabilities: Option<GoalCapabilities>) -> Result<GoalInput, String> {
    let Some(capabilities) = capabilities else {
        return Err("this engine does not support goals".into());
    };
    let Value::Object(input) = input else {
        return Err("goal must be an object".into());
    };
    let Some(text) = input.get("text").and_then(Value::as_str) else {
        return Err("goal.text must be a string".into());
    };
    let line = js_trim(text);
    if line.is_empty() {
        return Err("goal.text must not be empty".into());
    }
    if utf16_len(line) > GOAL_TEXT_MAX {
        return Err(format!("goal.text is longer than {GOAL_TEXT_MAX} characters"));
    }
    if GOAL_CLEAR_ALIASES.contains(&line.to_lowercase().as_str()) {
        return Err(format!("\"{line}\" is a clear command, not a goal"));
    }
    let text = line.to_owned();
    let Some(budget) = input.get("tokenBudget") else {
        return Ok(GoalInput { text, token_budget: None });
    };
    if !capabilities.budget {
        return Err("this engine does not support goal token budgets".into());
    }
    if budget.is_null() {
        return Ok(GoalInput { text, token_budget: Some(None) });
    }
    match budget.as_f64() {
        Some(n) if n.fract() == 0.0 && n > 0.0 && n <= 9_007_199_254_740_991.0 => {
            Ok(GoalInput { text, token_budget: Some(Some(n as u64)) })
        }
        _ => Err("goal.tokenBudget must be a positive integer or null".into()),
    }
}

pub fn goal_state_text(state: GoalState, limit: Option<GoalLimit>) -> &'static str {
    match state {
        GoalState::Active => "Active",
        GoalState::Paused => "Paused",
        GoalState::Blocked => "Blocked",
        GoalState::Met => "Met",
        GoalState::Failed => "Failed",
        GoalState::Limited if limit == Some(GoalLimit::Budget) => "Token budget reached",
        GoalState::Limited => "Usage limit reached",
    }
}

// A card's goal line: the text while active, else the state; a met goal is done and leaves the card.
pub fn goal_card_text(goal: Option<&SessionGoal>) -> Option<String> {
    let goal = goal.filter(|goal| goal.state != GoalState::Met)?;
    let word = match goal.state {
        GoalState::Active => return Some(format!("{GOAL_EMOJI} {}", goal.text)),
        GoalState::Limited => "stopped",
        GoalState::Paused => "paused",
        GoalState::Blocked => "blocked",
        GoalState::Failed => "failed",
        GoalState::Met => unreachable!(),
    };
    Some(format!("{GOAL_EMOJI} Goal {word}"))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoalNoticeRow {
    pub level: NoticeLevel,
    pub text: String,
}

pub fn goal_notice_row(notice: GoalNotice, goal: Option<&SessionGoal>) -> GoalNoticeRow {
    let reason = goal.and_then(|goal| goal.last_reason.as_deref()).map(js_trim).filter(|reason| !reason.is_empty());
    let with_reason = |head: &str| match reason {
        Some(reason) => format!("{GOAL_EMOJI} {head}: {reason}"),
        None => format!("{GOAL_EMOJI} {head}"),
    };
    let info = |text: String| GoalNoticeRow { level: NoticeLevel::Info, text };
    let error = |text: String| GoalNoticeRow { level: NoticeLevel::Error, text };
    match notice {
        GoalNotice::Set => {
            let by = match goal.map(|goal| &goal.set_by) {
                Some(GoalSetter::Agent { name, .. }) => format!(" (set by {})", name.as_deref().unwrap_or("an agent")),
                _ => String::new(),
            };
            info(format!("{GOAL_EMOJI} Goal set{by}: {}", goal.map_or("", |goal| goal.text.as_str())))
        }
        GoalNotice::CheckFailed => info(with_reason("Goal not met yet")),
        GoalNotice::Met => info(with_reason("Goal met")),
        GoalNotice::Failed => error(with_reason("Goal failed")),
        GoalNotice::Limited => {
            let what = goal.map_or_else(|| "limit reached".to_owned(), |goal| goal_state_text(goal.state, goal.limit).to_lowercase());
            error(format!("{GOAL_EMOJI} Goal stopped: {what}"))
        }
        GoalNotice::Blocked => error(with_reason("Goal blocked")),
        GoalNotice::Paused => info(format!("{GOAL_EMOJI} Goal paused")),
        GoalNotice::Resumed => info(format!("{GOAL_EMOJI} Goal resumed")),
        GoalNotice::Cleared => info(format!("{GOAL_EMOJI} Goal cleared")),
    }
}

// A codex goal left active keeps the engine awake: idle sleep is refused until it is paused or cleared.
pub fn goal_holds_engine(info: &SessionInfo) -> bool {
    goal_active(info.goal.as_ref()) && goal_capabilities(info.capabilities.as_ref()).is_some_and(|goals| goals.pause)
}

// What a budget field asks for: outer `None` leaves the budget alone (untouched, so a change made elsewhere meanwhile
// stands), `Some(None)` removes the one that was shown, a number sets it. Digits only: the field filters the rest.
pub fn goal_budget_change(field: &str, shown: Option<u64>) -> Option<Option<f64>> {
    let value = js_trim(field);
    if value == shown.map(|shown| shown.to_string()).unwrap_or_default() {
        return None;
    }
    if value.is_empty() {
        return Some(None);
    }
    Some(Some(value.parse::<f64>().unwrap_or(f64::NAN)))
}

// The Set goal dialog's submit: the budget field counts only when the engine takes budgets, and an untouched one is
// left out; a refusal reads as a sentence ("The goal must not be empty").
pub fn goal_dialog_input(
    text: &str,
    budget_field: &str,
    shown: Option<u64>,
    capabilities: Option<GoalCapabilities>,
) -> Result<GoalInput, String> {
    let budgeted = capabilities.is_some_and(|goals| goals.budget);
    let mut input = serde_json::Map::from_iter([("text".to_owned(), Value::from(text))]);
    if budgeted && let Some(change) = goal_budget_change(budget_field, shown) {
        input.insert(
            "tokenBudget".to_owned(),
            change.map_or(Value::Null, |n| serde_json::Number::from_f64(n).map_or(Value::from(""), Value::Number)),
        );
    }
    read_goal_input(&Value::Object(input), capabilities).map_err(|message| {
        if let Some(rest) = message.strip_prefix("goal.text ") {
            format!("The goal {rest}")
        } else if let Some(rest) = message.strip_prefix("goal.tokenBudget ") {
            format!("The token budget {rest}")
        } else {
            message
        }
    })
}

// The goal as the session screen draws it: menu entries, the info sheet rows, the stop hint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GoalView {
    pub text: String,
    pub state: GoalState,
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

pub fn goal_view(goal: &SessionGoal, capabilities: Option<GoalCapabilities>) -> GoalView {
    let whole = |n: Option<f64>| n.filter(|n| n.is_finite() && *n >= 0.0).map(|n| n as u64);
    let (set_by, set_by_agent) = match &goal.set_by {
        GoalSetter::Human => ("You".to_owned(), false),
        GoalSetter::Agent { session_id, name } => (name.clone().unwrap_or_else(|| session_id.chars().take(8).collect()), true),
    };
    GoalView {
        text: goal.text.clone(),
        state: goal.state,
        state_text: goal_state_text(goal.state, goal.limit).to_owned(),
        card_text: goal_card_text(Some(goal)),
        set_by,
        set_by_agent,
        set_at: goal.set_at as i64,
        checks: whole(goal.checks).filter(|n| *n > 0).map(|n| n as u32),
        last_reason: goal.last_reason.as_deref().map(js_trim).filter(|r| !r.is_empty()).map(str::to_owned),
        tokens_used: whole(goal.tokens_used),
        token_budget: whole(goal.token_budget),
        time_used_seconds: whole(goal.time_used_seconds).filter(|n| *n > 0),
        holds_engine: goal.state == GoalState::Active && capabilities.is_some_and(|goals| goals.pause),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn goal(state: GoalState) -> SessionGoal {
        SessionGoal {
            text: "Ship it".into(),
            state,
            limit: None,
            set_at: 1.0,
            set_by: GoalSetter::Human,
            last_reason: None,
            checks: None,
            tokens_used: None,
            token_budget: None,
            time_used_seconds: None,
        }
    }

    #[test]
    fn card_text_hides_a_met_goal() {
        assert_eq!(goal_card_text(Some(&goal(GoalState::Active))).as_deref(), Some("🎯 Ship it"));
        assert_eq!(goal_card_text(Some(&goal(GoalState::Limited))).as_deref(), Some("🎯 Goal stopped"));
        assert_eq!(goal_card_text(Some(&goal(GoalState::Met))), None);
        assert_eq!(goal_card_text(None), None);
    }

    #[test]
    fn input_refuses_a_clear_alias_and_a_budget_without_support() {
        let claude = Some(GoalCapabilities { pause: false, budget: false });
        assert_eq!(read_goal_input(&json!({ "text": " Stop " }), claude), Err("\"Stop\" is a clear command, not a goal".into()));
        assert_eq!(
            read_goal_input(&json!({ "text": "x", "tokenBudget": 5 }), claude),
            Err("this engine does not support goal token budgets".into())
        );
        let codex = Some(GoalCapabilities { pause: true, budget: true });
        assert_eq!(
            read_goal_input(&json!({ "text": "x", "tokenBudget": null }), codex),
            Ok(GoalInput { text: "x".into(), token_budget: Some(None) })
        );
    }

    #[test]
    fn dialog_reads_its_refusals_as_sentences() {
        let codex = Some(GoalCapabilities { pause: true, budget: true });
        assert_eq!(goal_dialog_input("  ", "", None, codex), Err("The goal must not be empty".into()));
        assert_eq!(goal_dialog_input("x", "20000", Some(20000), codex), Ok(GoalInput { text: "x".into(), token_budget: None }));
        assert_eq!(goal_dialog_input("x", "", Some(20000), codex), Ok(GoalInput { text: "x".into(), token_budget: Some(None) }));
        let claude = Some(GoalCapabilities { pause: false, budget: false });
        assert_eq!(goal_dialog_input("x", "500", None, claude), Ok(GoalInput { text: "x".into(), token_budget: None }));
    }

    #[test]
    fn budget_change_leaves_an_untouched_field_alone() {
        assert_eq!(goal_budget_change("20000", Some(20000)), None);
        assert_eq!(goal_budget_change("", Some(20000)), Some(None));
        assert_eq!(goal_budget_change("60000", None), Some(Some(60000.0)));
        assert_eq!(goal_budget_change("", None), None);
    }
}
