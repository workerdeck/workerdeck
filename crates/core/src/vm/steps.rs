// The lines under a session card: its agents, its tasks, its shells, in that order (web `sessionSteps`, iOS kit).
use crate::controller::shell;
use crate::rest::{SessionInfo, SessionStatus, ShellInfo, ShellStatus, SubagentStatus};
use crate::vm::checklist::{SessionTask, SessionTaskSource, SessionTaskState, displayed_tasks};
use crate::vm::session_list::{
    FoldableStepKind, StepDisplay, ViewConfig, is_agent_record, subagent_label, visible_shells, visible_subagents,
};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepKind {
    Agent,
    Task,
    Shell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StepState {
    Done,
    Running,
    Failed,
    Pending,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Step {
    pub key: String,
    pub kind: StepKind,
    // The chip this row folds into: a spawned background job is `Bash`, a checklist item `Task`.
    pub fold: FoldableStepKind,
    pub label: String,
    pub state: StepState,
    pub detail: Option<String>,
    pub title: String,
    pub killable: bool,
    pub tool_use_id: Option<String>,
}

// A checklist item left in progress on a session whose turn is over is drawn pending: nothing is working on it.
pub fn session_live(info: &SessionInfo) -> bool {
    matches!(info.status, SessionStatus::Running | SessionStatus::Starting | SessionStatus::AwaitingApproval)
}

pub fn session_steps(info: &SessionInfo, config: &ViewConfig, now: f64) -> Vec<Step> {
    let mut steps: Vec<Step> = visible_subagents(info, config.subagents)
        .iter()
        .filter(|sub| is_agent_record(sub))
        .map(|sub| {
            let label = subagent_label(sub);
            let tools = sub.tool_count;
            Step {
                key: sub.tool_use_id.clone(),
                kind: StepKind::Agent,
                fold: FoldableStepKind::Agent,
                title: format!("{label} · {tools} tool{}", if tools == 1 { "" } else { "s" }),
                label,
                state: match sub.status {
                    SubagentStatus::Running => StepState::Running,
                    SubagentStatus::Failed => StepState::Failed,
                    SubagentStatus::Done | SubagentStatus::Unknown => StepState::Done,
                },
                detail: (tools > 0).then(|| tools.to_string()),
                killable: false,
                tool_use_id: None,
            }
        })
        .collect();
    if let Some(show) = config.tasks {
        let live = session_live(info);
        let checklist = info.checklist.as_deref().unwrap_or_default();
        let subagents = info.subagents.as_deref().unwrap_or_default();
        steps.extend(displayed_tasks(checklist, subagents, show).iter().map(|task| task_step(task, live)));
    }
    steps.extend(visible_shells(info, config.shells.unwrap_or(StepDisplay::Active), now).iter().map(shell_step));
    steps
}

fn task_step(task: &SessionTask, live: bool) -> Step {
    let stalled = task.source == SessionTaskSource::Checklist && task.state == SessionTaskState::Running && !live;
    Step {
        key: task.key.clone(),
        kind: StepKind::Task,
        fold: if task.source == SessionTaskSource::Spawn { FoldableStepKind::Bash } else { FoldableStepKind::Task },
        label: task.label.clone(),
        state: match task.state {
            SessionTaskState::Pending => StepState::Pending,
            SessionTaskState::Running if stalled => StepState::Pending,
            SessionTaskState::Running => StepState::Running,
            SessionTaskState::Done => StepState::Done,
            SessionTaskState::Failed => StepState::Failed,
        },
        detail: task.detail.clone(),
        title: if stalled { format!("{} · left in progress", task.label) } else { task.label.clone() },
        killable: task.stoppable == Some(true) && task.tool_use_id.is_some(),
        tool_use_id: task.tool_use_id.clone(),
    }
}

// A running shell's status is the word "running", which the spinner already says.
fn shell_step(info: &ShellInfo) -> Step {
    let status = shell::status_text(info);
    let running = info.status == ShellStatus::Running;
    let failed = info.status == ShellStatus::Exited && info.exit_code != Some(0);
    Step {
        key: info.id.clone(),
        kind: StepKind::Shell,
        fold: FoldableStepKind::Shell,
        label: shell::label(info),
        state: if failed {
            StepState::Failed
        } else if running {
            StepState::Running
        } else {
            StepState::Done
        },
        detail: (!running).then(|| status.clone()),
        title: format!("{} · {status}", shell::title(info)),
        killable: running,
        tool_use_id: None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FoldStep {
    pub key: String,
    pub fold: FoldableStepKind,
    pub state: StepState,
}

impl From<&Step> for FoldStep {
    fn from(step: &Step) -> Self {
        FoldStep { key: step.key.clone(), fold: step.fold, state: step.state }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepChip {
    pub kind: FoldableStepKind,
    pub count: u32,
    pub label: String,
    pub open: bool,
    pub failed: bool,
    pub running: u32,
    pub holds_active: bool,
}

const CHIP_ORDER: [(FoldableStepKind, &str, &str); 4] = [
    (FoldableStepKind::Agent, "agent", "agents"),
    (FoldableStepKind::Task, "task", "tasks"),
    (FoldableStepKind::Bash, "bash", "bash"),
    (FoldableStepKind::Shell, "shell", "shells"),
];

// One chip per kind a card's steps fold into, in a fixed order; `expanded` kinds draw their rows under the card.
pub fn step_chips(steps: &[FoldStep], expanded: &[FoldableStepKind], active_step_key: Option<&str>) -> Vec<StepChip> {
    CHIP_ORDER
        .iter()
        .filter_map(|&(kind, one, many)| {
            let own: Vec<&FoldStep> = steps.iter().filter(|step| step.fold == kind).collect();
            if own.is_empty() {
                return None;
            }
            let open = expanded.contains(&kind);
            let count = own.len() as u32;
            Some(StepChip {
                kind,
                count,
                label: format!("{count} {}", if count == 1 { one } else { many }),
                open,
                failed: own.iter().any(|step| step.state == StepState::Failed),
                running: own.iter().filter(|step| step.state == StepState::Running).count() as u32,
                holds_active: !open && own.iter().any(|step| Some(step.key.as_str()) == active_step_key),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn info(status: &str) -> SessionInfo {
        serde_json::from_value(json!({
            "id": "s", "status": status, "cwd": "/w", "createdAt": 0, "lastSeq": 0, "pendingPermissionCount": 0,
            "subagents": [
                {"toolUseId": "t_agent", "agentType": "Explore", "description": "map it", "status": "running", "startedAt": 0, "toolCount": 3},
                {"toolUseId": "t_spawn", "description": "side job", "status": "running", "startedAt": 0, "toolCount": 0, "stoppable": true},
            ],
            "checklist": [{"text": "write it", "status": "in_progress"}, {"text": "ship it", "status": "pending"}],
            "shells": [
                {"id": "sh_1", "sessionId": "s", "ordinal": 1, "command": "npm run dev", "label": "", "cwd": "/w", "owner": "user",
                 "status": "running", "startedAt": 0, "bytes": 0, "cols": 80, "rows": 24},
                {"id": "sh_2", "sessionId": "s", "ordinal": 2, "command": "false", "label": "", "cwd": "/w", "owner": "user",
                 "status": "exited", "exitCode": 1, "startedAt": 0, "bytes": 0, "cols": 80, "rows": 24},
            ],
        }))
        .unwrap()
    }

    #[test]
    fn agents_then_tasks_then_shells() {
        let config = ViewConfig { shells: Some(StepDisplay::All), ..ViewConfig::default() };
        let steps = session_steps(&info("running"), &config, 10_000.0);
        let kinds: Vec<_> = steps.iter().map(|s| (s.kind, s.key.as_str(), s.state)).collect();
        assert_eq!(
            kinds,
            vec![
                (StepKind::Agent, "t_agent", StepState::Running),
                (StepKind::Task, "checklist:0", StepState::Running),
                (StepKind::Task, "checklist:1", StepState::Pending),
                (StepKind::Task, "spawn:t_spawn", StepState::Running),
                (StepKind::Shell, "sh_1", StepState::Running),
                (StepKind::Shell, "sh_2", StepState::Failed),
            ]
        );
        assert_eq!(steps[0].label, "Explore · map it");
        assert_eq!(steps[0].detail.as_deref(), Some("3"));
        assert!(steps[3].killable && steps[3].tool_use_id.as_deref() == Some("t_spawn"));
        assert_eq!(
            steps.iter().map(|s| s.fold).collect::<Vec<_>>()[1..4],
            [FoldableStepKind::Task, FoldableStepKind::Task, FoldableStepKind::Bash]
        );
        assert!(steps[4].killable && steps[4].detail.is_none());
        assert!(!steps[5].killable && steps[5].detail.is_some());
    }

    #[test]
    fn a_checklist_item_left_running_after_the_turn_is_pending() {
        let steps = session_steps(&info("idle"), &ViewConfig::default(), 0.0);
        let item = steps.iter().find(|s| s.key == "checklist:0").unwrap();
        assert_eq!(item.state, StepState::Pending);
        assert_eq!(item.title, "write it · left in progress");
        assert!(steps.iter().all(|s| s.kind != StepKind::Shell));
    }
}
