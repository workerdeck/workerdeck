use crate::rest::{ChecklistItem, ChecklistStatus, SubagentInfo, SubagentStatus};
use crate::vm::session_list::{StepDisplay, is_agent_record};
use crate::vm::text::js_trim;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionTaskState {
    Pending,
    Running,
    Done,
    Failed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionTaskSource {
    Checklist,
    Spawn,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTask {
    pub key: String,
    pub label: String,
    pub source: SessionTaskSource,
    pub state: SessionTaskState,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tool_use_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stoppable: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TaskSummary {
    pub total: u32,
    pub done: u32,
    pub running: u32,
    pub failed: u32,
}

fn checklist_entry(value: &Value) -> Option<ChecklistItem> {
    let raw = value.as_object()?;
    let status = match raw.get("status").and_then(Value::as_str)? {
        "pending" => ChecklistStatus::Pending,
        "in_progress" => ChecklistStatus::InProgress,
        "completed" => ChecklistStatus::Completed,
        _ => return None,
    };
    let content = raw.get("content").and_then(Value::as_str).map(js_trim).unwrap_or("");
    if content.is_empty() {
        return None;
    }
    let active = raw.get("activeForm").and_then(Value::as_str).map(js_trim).unwrap_or("");
    let text = if status == ChecklistStatus::InProgress && !active.is_empty() { active } else { content };
    Some(ChecklistItem { status, text: text.to_owned() })
}

pub fn parse_todo_write_input(input: &Value) -> Option<Vec<ChecklistItem>> {
    input.get("todos")?.as_array()?.iter().map(checklist_entry).collect()
}

fn checklist_state(status: ChecklistStatus) -> SessionTaskState {
    match status {
        ChecklistStatus::InProgress => SessionTaskState::Running,
        ChecklistStatus::Completed => SessionTaskState::Done,
        ChecklistStatus::Pending => SessionTaskState::Pending,
    }
}

fn spawn_state(status: SubagentStatus) -> SessionTaskState {
    match status {
        SubagentStatus::Running => SessionTaskState::Running,
        SubagentStatus::Done => SessionTaskState::Done,
        SubagentStatus::Failed => SessionTaskState::Failed,
    }
}

pub fn session_tasks(checklist: &[ChecklistItem], subagents: &[SubagentInfo]) -> Vec<SessionTask> {
    let listed = checklist.iter().enumerate().map(|(index, item)| SessionTask {
        key: format!("checklist:{index}"),
        label: item.text.clone(),
        source: SessionTaskSource::Checklist,
        state: checklist_state(item.status),
        detail: None,
        tool_use_id: None,
        stoppable: None,
    });
    let spawns = subagents.iter().filter(|sub| !is_agent_record(sub)).map(|sub| {
        let label = sub.description.as_deref().map(js_trim).filter(|d| !d.is_empty()).unwrap_or("Task");
        SessionTask {
            key: format!("spawn:{}", sub.tool_use_id),
            label: label.to_owned(),
            source: SessionTaskSource::Spawn,
            state: spawn_state(sub.status),
            detail: (sub.tool_count > 0).then(|| sub.tool_count.to_string()),
            tool_use_id: Some(sub.tool_use_id.clone()),
            stoppable: (sub.status == SubagentStatus::Running && sub.stoppable == Some(true)).then_some(true),
        }
    });
    listed.chain(spawns).collect()
}

pub fn task_summary(tasks: &[SessionTask]) -> TaskSummary {
    let count = |state| tasks.iter().filter(|task| task.state == state).count() as u32;
    TaskSummary {
        total: tasks.len() as u32,
        done: count(SessionTaskState::Done),
        running: count(SessionTaskState::Running),
        failed: count(SessionTaskState::Failed),
    }
}

pub fn task_count_label(summary: &TaskSummary) -> Option<String> {
    (summary.total > 0).then(|| format!("{}/{}", summary.done, summary.total))
}

pub fn visible_tasks(tasks: &[SessionTask], show_completed: bool) -> Vec<SessionTask> {
    tasks.iter().filter(|task| show_completed || task.state != SessionTaskState::Done).cloned().collect()
}

pub fn displayed_tasks(checklist: &[ChecklistItem], subagents: &[SubagentInfo], show: StepDisplay) -> Vec<SessionTask> {
    if show == StepDisplay::None {
        return Vec::new();
    }
    let tasks = session_tasks(checklist, subagents);
    if show == StepDisplay::All {
        return tasks;
    }
    tasks.into_iter().filter(|task| matches!(task.state, SessionTaskState::Running | SessionTaskState::Pending)).collect()
}
