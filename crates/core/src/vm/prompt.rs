use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ShellRequest {
    Run {
        command: String,
    },
    #[serde(rename_all = "camelCase")]
    Write {
        shell_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        data: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        keys: Option<Vec<String>>,
    },
    #[serde(rename_all = "camelCase")]
    Kill {
        shell_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Grant {
        shell_id: String,
        reason: String,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ChoiceKey {
    Allow,
    Deny,
    Stop,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct PermissionChoice {
    pub key: ChoiceKey,
    pub button: &'static str,
    pub option: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub danger: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionPromptModel {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub plan: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub shell: Option<ShellRequest>,
    pub heading: String,
    pub question: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub decision_reason: Option<String>,
    pub choices: [PermissionChoice; 3],
    pub deny_placeholder: &'static str,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct QuestionOption {
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preview: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UserQuestion {
    pub question: String,
    pub header: String,
    pub options: Vec<QuestionOption>,
    pub multi_select: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Selection {
    pub labels: Vec<String>,
    pub other: String,
    pub other_active: bool,
}

fn text<'a>(object: &'a Value, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

fn owned(object: &Value, key: &str) -> Option<String> {
    text(object, key).map(str::to_owned)
}

pub fn plan_from_request(request: &Value) -> Option<String> {
    if text(request, "toolName") != Some("ExitPlanMode") {
        return None;
    }
    let plan = request.get("input")?.get("plan")?.as_str()?;
    (!plan.trim().is_empty()).then(|| plan.to_owned())
}

const SHELL_WRITE_TOOLS: [&str; 4] = ["shell_run", "shell_write", "shell_kill", "shell_request_write"];

pub fn shell_tool_of(tool_name: &str) -> Option<&'static str> {
    let bare = match tool_name.strip_prefix("mcp__") {
        Some(rest) => rest.find("__").map_or("", |at| &rest[at + 2..]),
        None => tool_name,
    };
    SHELL_WRITE_TOOLS.into_iter().find(|tool| *tool == bare)
}

pub fn shell_request_payload(request: &Value) -> Option<ShellRequest> {
    let tool = shell_tool_of(text(request, "toolName")?)?;
    let input = request.get("input").filter(|input| input.is_object()).cloned().unwrap_or(Value::Object(Map::new()));
    let shell_id = owned(&input, "shellId").unwrap_or_default();
    Some(match tool {
        "shell_run" => ShellRequest::Run { command: owned(&input, "command").unwrap_or_default() },
        "shell_write" => {
            let keys: Option<Vec<String>> =
                input.get("keys").and_then(Value::as_array).map(|keys| keys.iter().filter_map(Value::as_str).map(str::to_owned).collect());
            ShellRequest::Write { shell_id, data: owned(&input, "data"), keys: keys.filter(|keys| !keys.is_empty()) }
        }
        "shell_kill" => ShellRequest::Kill { shell_id },
        _ => ShellRequest::Grant { shell_id, reason: owned(&input, "reason").unwrap_or_default() },
    })
}

pub fn shell_request_title(payload: &ShellRequest) -> String {
    match payload {
        ShellRequest::Run { .. } => "Agent wants to start a shell".into(),
        ShellRequest::Write { shell_id, .. } => format!("Agent wants to type into shell {shell_id}"),
        ShellRequest::Kill { shell_id } => format!("Agent wants to kill shell {shell_id}"),
        ShellRequest::Grant { shell_id, .. } => format!("Agent asks to type into your shell {shell_id}"),
    }
}

pub fn shell_request_lines(payload: &ShellRequest) -> Vec<String> {
    match payload {
        ShellRequest::Run { command } => command
            .split('\n')
            .enumerate()
            .map(|(index, line)| if index == 0 { format!("$ {line}") } else { format!("  {line}") })
            .collect(),
        ShellRequest::Write { data, keys, .. } => {
            let mut lines = Vec::new();
            if let Some(data) = data {
                lines.push(format!("types: {}", visible_controls(data)));
            }
            if let Some(keys) = keys {
                lines.push(format!("presses: {}", keys.iter().map(|key| format!("[{key}]")).collect::<Vec<_>>().join(" ")));
            }
            lines
        }
        ShellRequest::Kill { shell_id } => vec![format!("kill {shell_id}")],
        ShellRequest::Grant { reason, .. } => {
            vec![format!("why: {}", visible_controls(reason)), "until the shell ends or you revoke it".into()]
        }
    }
}

pub fn visible_controls(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        let code = ch as u32;
        if code >= 0x20 && code != 0x7f {
            out.push(ch);
            continue;
        }
        match ch {
            '\r' => out.push_str("[enter]"),
            '\n' => out.push_str("[newline]"),
            '\t' => out.push_str("[tab]"),
            '\x1b' => out.push_str("[escape]"),
            '\x7f' => out.push_str("[backspace]"),
            _ => out.push_str(&format!("[ctrl-{}]", char::from_u32(code + 64).unwrap_or('?').to_ascii_lowercase())),
        }
    }
    out
}

const fn choice(key: ChoiceKey, button: &'static str, option: &'static str, danger: bool) -> PermissionChoice {
    PermissionChoice { key, button, option, danger: if danger { Some(true) } else { None } }
}

pub fn permission_prompt_model(request: &Value) -> PermissionPromptModel {
    let description = owned(request, "description");
    let decision_reason = owned(request, "decisionReason");
    if let Some(plan) = plan_from_request(request) {
        return PermissionPromptModel {
            plan: Some(plan),
            shell: None,
            heading: "Plan ready for review".into(),
            question: "Ready to implement this plan?",
            description,
            decision_reason,
            choices: [
                choice(ChoiceKey::Allow, "Approve plan", "Approve plan", false),
                choice(ChoiceKey::Deny, "Keep planning", "Keep planning - tell it what to change", false),
                choice(ChoiceKey::Stop, "Stop the turn", "No, and stop the turn", true),
            ],
            deny_placeholder: "What should change? (optional) - the agent keeps planning and reads this",
        };
    }
    let shell = shell_request_payload(request);
    let heading = match &shell {
        Some(shell) => shell_request_title(shell),
        None => owned(request, "title").or_else(|| owned(request, "displayName")).unwrap_or_else(|| "Permission needed".into()),
    };
    PermissionPromptModel {
        question: if shell.is_some() { "Do you want to let it?" } else { "Do you want to proceed?" },
        shell,
        plan: None,
        heading,
        description,
        decision_reason,
        choices: [
            choice(ChoiceKey::Allow, "Allow", "Yes", false),
            choice(ChoiceKey::Deny, "Deny", "No, and tell the agent what to do differently", false),
            choice(ChoiceKey::Stop, "Deny & stop", "No, and stop the turn", true),
        ],
        deny_placeholder: "Reason (optional) - the agent reads this and can try something else",
    }
}

pub fn parse_user_questions(input: &Value) -> Vec<UserQuestion> {
    let Some(raw) = input.get("questions").and_then(Value::as_array) else {
        return Vec::new();
    };
    raw.iter()
        .filter_map(|entry| {
            let question = text(entry, "question")?;
            let options: Vec<QuestionOption> = entry
                .get("options")?
                .as_array()?
                .iter()
                .filter(|option| option.get("label").is_some_and(Value::is_string))
                .map(|option| QuestionOption {
                    label: owned(option, "label").unwrap_or_default(),
                    description: owned(option, "description"),
                    preview: owned(option, "preview"),
                })
                .collect();
            (!options.is_empty()).then(|| UserQuestion {
                question: question.to_owned(),
                header: owned(entry, "header").unwrap_or_default(),
                options,
                multi_select: entry.get("multiSelect") == Some(&Value::Bool(true)),
            })
        })
        .collect()
}

pub fn answer_for(selection: &Selection) -> String {
    let mut parts = selection.labels.clone();
    let other = selection.other.trim();
    if selection.other_active && !other.is_empty() {
        parts.push(other.to_owned());
    }
    parts.join(", ")
}

pub fn toggle_label(selection: &Selection, label: &str, multi_select: bool) -> Selection {
    if !multi_select {
        return Selection { labels: vec![label.to_owned()], other_active: false, ..selection.clone() };
    }
    let labels = if selection.labels.iter().any(|l| l == label) {
        selection.labels.iter().filter(|l| *l != label).cloned().collect()
    } else {
        selection.labels.iter().cloned().chain([label.to_owned()]).collect()
    };
    Selection { labels, ..selection.clone() }
}

pub fn toggle_other(selection: &Selection, multi_select: bool) -> Selection {
    let other_active = !selection.other_active;
    let labels = if other_active && !multi_select { Vec::new() } else { selection.labels.clone() };
    Selection { labels, other_active, other: selection.other.clone() }
}

pub fn answers_for(questions: &[UserQuestion], selections: &[Selection]) -> Map<String, Value> {
    let empty = Selection::default();
    questions
        .iter()
        .enumerate()
        .map(|(index, question)| (question.question.clone(), Value::String(answer_for(selections.get(index).unwrap_or(&empty)))))
        .collect()
}

// The tool's own input with `answers` added, never replaced: the CLI reads the answers next to the questions it sent.
pub fn answered_input(input: &Value, questions: &[UserQuestion], selections: &[Selection]) -> Map<String, Value> {
    let mut updated = input.as_object().cloned().unwrap_or_default();
    updated.insert("answers".into(), Value::Object(answers_for(questions, selections)));
    updated
}

fn preferred_keys(tool_name: &str) -> &'static [&'static str] {
    match tool_name {
        "Bash" | "BashOutput" | "KillShell" => &["command", "description", "shell_id"],
        "Read" | "Write" | "Edit" | "MultiEdit" | "NotebookEdit" => &["file_path", "notebook_path", "path"],
        "Glob" | "Grep" => &["pattern", "query", "path"],
        "WebFetch" | "WebSearch" => &["url", "query", "prompt"],
        "Task" | "Agent" => &["description", "subagent_type", "prompt"],
        "TodoWrite" => &["todos"],
        "TaskCreate" | "TaskUpdate" => &["subject", "activeForm", "status", "taskId"],
        "Skill" => &["skill", "command"],
        _ => &["path", "file_path", "command", "query", "pattern", "url", "description", "name"],
    }
}

// What an approval is about, whole: a phone prompt scrolls, so the command it asks to run is never clipped.
pub fn tool_input_subject(tool_name: &str, input: &Value) -> Option<String> {
    let pretty = || serde_json::to_string_pretty(input).ok();
    let Some(object) = input.as_object() else {
        return if input.is_null() { None } else { pretty() };
    };
    if object.is_empty() {
        return None;
    }
    let nonempty = |key: &str| object.get(key).and_then(Value::as_str).filter(|value| !value.is_empty()).map(str::to_owned);
    if let Some(found) = preferred_keys(tool_name).iter().find_map(|key| nonempty(key)) {
        return Some(found);
    }
    let mut keys: Vec<&String> = object.keys().collect();
    keys.sort();
    keys.into_iter().find_map(|key| nonempty(key)).or_else(pretty)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PromptBody {
    Permission { model: Box<PermissionPromptModel>, subject: Option<String>, shell_lines: Vec<String> },
    Question { title: String, questions: Vec<UserQuestion> },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Prompt {
    pub request_id: String,
    pub tool_name: String,
    pub waiting: usize,
    pub body: PromptBody,
}

pub fn prompt_for(request: &Value, waiting: usize) -> Option<Prompt> {
    let request_id = owned(request, "id")?;
    let tool_name = owned(request, "toolName").unwrap_or_default();
    let input = request.get("input").unwrap_or(&Value::Null);
    let questions = if tool_name == "AskUserQuestion" { parse_user_questions(input) } else { Vec::new() };
    let body = if questions.is_empty() {
        let model = permission_prompt_model(request);
        let shell_lines = model.shell.as_ref().map(shell_request_lines).unwrap_or_default();
        let subject = if model.plan.is_some() || model.shell.is_some() { None } else { tool_input_subject(&tool_name, input) };
        PromptBody::Permission { model: Box::new(model), subject, shell_lines }
    } else {
        PromptBody::Question { title: owned(request, "title").unwrap_or_else(|| "The agent has a question".into()), questions }
    };
    Some(Prompt { request_id, tool_name, waiting, body })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_subject_is_the_preferred_field_whole() {
        let command = "cat a | tee b\nrm -rf c";
        assert_eq!(tool_input_subject("Bash", &json!({ "description": "x", "command": command })).as_deref(), Some(command));
        assert_eq!(tool_input_subject("Mystery", &json!({ "zeta": "z", "alpha": "" , "beta": "b" })).as_deref(), Some("b"));
        assert_eq!(tool_input_subject("Mystery", &json!({})), None);
        assert_eq!(tool_input_subject("Mystery", &Value::Null), None);
        assert_eq!(tool_input_subject("Mystery", &json!({ "n": 1 })).as_deref(), Some("{\n  \"n\": 1\n}"));
    }

    #[test]
    fn a_question_with_no_usable_options_falls_back_to_the_permission_prompt() {
        let request = json!({ "id": "r", "toolName": "AskUserQuestion", "input": { "questions": [{ "question": "q", "options": [] }] } });
        assert!(matches!(prompt_for(&request, 1).unwrap().body, PromptBody::Permission { .. }));
    }

    #[test]
    fn answers_extend_the_input_in_question_order() {
        let input = json!({ "questions": [
            { "question": "Which?", "header": "A", "options": [{ "label": "x" }, { "label": "y" }] },
            { "question": "And?", "header": "B", "multiSelect": true, "options": [{ "label": "p" }, { "label": "q" }] },
        ] });
        let questions = parse_user_questions(&input);
        let selections = [
            Selection { labels: vec!["y".into()], ..Selection::default() },
            Selection { labels: vec!["p".into(), "q".into()], other: " more ".into(), other_active: true },
        ];
        let updated = answered_input(&input, &questions, &selections);
        assert_eq!(updated["answers"], json!({ "Which?": "y", "And?": "p, q, more" }));
        assert!(updated.contains_key("questions"));
    }
}
