use wd_native::rest::calls::{self, Edit};
use wd_native::rest::error::{self, Answer, RestErrorKind as CoreKind};
use wd_native::rest::files;

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct HttpCall {
    pub method: String,
    pub path: String,
    pub body: Option<String>,
    // The conversation a mutating session call is for: sent as the `generation_header()`, when set.
    pub generation: Option<i64>,
}

impl From<calls::HttpCall> for HttpCall {
    fn from(call: calls::HttpCall) -> Self {
        Self { method: call.method.to_owned(), path: call.path, body: call.body, generation: call.generation }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum RestErrorKind {
    Transport,
    Auth,
    NotGateway,
    NotFound,
    Conflict,
    Refused,
    Unreadable,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct RestError {
    pub status: u16,
    pub kind: RestErrorKind,
    pub message: String,
}

impl From<error::RestError> for RestError {
    fn from(e: error::RestError) -> Self {
        let kind = match e.kind {
            CoreKind::Transport => RestErrorKind::Transport,
            CoreKind::Auth => RestErrorKind::Auth,
            CoreKind::NotGateway => RestErrorKind::NotGateway,
            CoreKind::NotFound => RestErrorKind::NotFound,
            CoreKind::Conflict => RestErrorKind::Conflict,
            CoreKind::Refused => RestErrorKind::Refused,
            CoreKind::Unreadable => RestErrorKind::Unreadable,
        };
        Self { status: e.status, kind, message: e.message }
    }
}

// What came back for an `HttpCall`, untouched: a view model that takes one reads and classifies it itself.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct HttpAnswer {
    pub status: u16,
    pub content_type: Option<String>,
    pub body: String,
}

impl HttpAnswer {
    pub(crate) fn core(&self) -> Answer<'_> {
        Answer::new(self.status, self.content_type.as_deref(), &self.body)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum TextEdit {
    Set { value: String },
    Clear,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum StatusEdit {
    Set { text: String, emoji: Option<String> },
    Clear,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, uniffi::Record)]
pub struct SessionPatch {
    #[uniffi(default)]
    pub title: Option<TextEdit>,
    #[uniffi(default)]
    pub status_label: Option<StatusEdit>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum Sharing {
    Private,
    Shared,
}

#[derive(Debug, Clone, PartialEq, Default, uniffi::Record)]
pub struct AgentPatch {
    #[uniffi(default)]
    pub name: Option<String>,
    #[uniffi(default)]
    pub lead: Option<TextEdit>,
    #[uniffi(default)]
    pub order: Option<f64>,
    #[uniffi(default)]
    pub sharing: Option<Sharing>,
    #[uniffi(default)]
    pub cross_owner: Option<bool>,
}

// `updated_input_json` is the tool input as a JSON object; anything else is dropped.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum PermissionDecision {
    Allow { updated_input_json: Option<String> },
    Deny { message: Option<String>, interrupt: Option<bool> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum RetireMembers {
    Release,
    Retire,
}

fn edit(edit: Option<TextEdit>) -> Option<Edit<String>> {
    edit.map(|e| match e {
        TextEdit::Set { value } => Edit::Set(value),
        TextEdit::Clear => Edit::Clear,
    })
}

#[uniffi::export]
pub fn rest_error(status: u16, content_type: Option<String>, body: String) -> Option<RestError> {
    error::classify(status, content_type.as_deref(), &body).map(Into::into)
}

#[uniffi::export]
pub fn list_sessions_call() -> HttpCall {
    calls::list_sessions().into()
}

#[uniffi::export]
pub fn get_session_call(id: String) -> HttpCall {
    calls::get_session(&id).into()
}

// Every call that changes a session names the conversation the caller is looking at (`generation`, from
// `SessionChrome.conversation` or the list row's `conversation`); the gateway refuses it once that one ended.
#[uniffi::export]
pub fn update_session_call(id: String, patch: SessionPatch, generation: i64) -> HttpCall {
    let status_label = patch.status_label.map(|e| match e {
        StatusEdit::Set { text, emoji } => Edit::Set(calls::StatusInput { text, emoji }),
        StatusEdit::Clear => Edit::Clear,
    });
    calls::update_session(&id, &calls::SessionPatch { title: edit(patch.title), status_label, agent: None }, generation).into()
}

// Make agent (no `lead`) or a team join (`lead`, with `cross_owner` for another owner's lead) of an unnamed session:
// it keeps its id, now named.
#[uniffi::export(default(lead = None, cross_owner = None))]
pub fn name_session_call(id: String, lead: Option<String>, cross_owner: Option<bool>, generation: i64) -> HttpCall {
    let agent = calls::SessionAgent { lead, cross_owner, ..calls::SessionAgent::default() };
    calls::update_session(&id, &calls::SessionPatch { agent: Some(Edit::Set(agent)), ..Default::default() }, generation).into()
}

#[uniffi::export]
pub fn sleep_session_call(id: String, generation: i64) -> HttpCall {
    calls::sleep_session(&id, generation).into()
}

// Closes an unnamed session; a named one retires to Past agents, its members released.
#[uniffi::export]
pub fn delete_session_call(id: String, generation: i64) -> HttpCall {
    calls::delete_session(&id, generation).into()
}

#[uniffi::export]
pub fn stop_task_call(session_id: String, tool_use_id: String, generation: i64) -> HttpCall {
    calls::stop_task(&session_id, &tool_use_id, generation).into()
}

#[uniffi::export(default(tool_use_id = None))]
pub fn background_task_call(session_id: String, tool_use_id: Option<String>, generation: i64) -> HttpCall {
    calls::background_task(&session_id, tool_use_id.as_deref(), generation).into()
}

#[uniffi::export]
pub fn kill_shell_call(session_id: String, shell_id: String, generation: i64) -> HttpCall {
    calls::kill_shell(&session_id, &shell_id, generation).into()
}

#[uniffi::export]
pub fn resolve_permission_call(session_id: String, request_id: String, decision: PermissionDecision, generation: i64) -> HttpCall {
    let decision = match decision {
        PermissionDecision::Allow { updated_input_json } => {
            calls::PermissionDecision::Allow { updated_input: updated_input_json.and_then(|json| serde_json::from_str(&json).ok()) }
        }
        PermissionDecision::Deny { message, interrupt } => calls::PermissionDecision::Deny { message, interrupt },
    };
    calls::resolve_permission(&session_id, &request_id, &decision, generation).into()
}

#[uniffi::export]
pub fn conversations_call(id: String) -> HttpCall {
    calls::conversations(&id).into()
}

// New conversation: n+1 under the same id. A 409 may ask for `discard_confirmation`, or `uncertain_prompt_conversation`.
#[uniffi::export(default(prompt = None))]
pub fn new_conversation_call(id: String, expected_generation: i64, prompt: Option<String>) -> HttpCall {
    calls::new_conversation(&id, expected_generation, prompt.as_deref()).into()
}

// After a person confirmed a `DiscardConfirmation`: its `conversation` and `input_revision`.
#[uniffi::export(default(prompt = None))]
pub fn discard_and_cut_call(id: String, expected_generation: i64, input_revision: String, prompt: Option<String>) -> HttpCall {
    calls::discard_and_cut(&id, expected_generation, &input_revision, prompt.as_deref()).into()
}

#[uniffi::export]
pub fn retry_conversation_start_call(id: String, expected_generation: i64) -> HttpCall {
    calls::retry_conversation_start(&id, expected_generation).into()
}

#[uniffi::export]
pub fn settle_pending_prompt_call(id: String, send: bool, expected_generation: i64) -> HttpCall {
    calls::settle_pending_prompt(&id, send, expected_generation).into()
}

#[uniffi::export]
pub fn list_agents_call() -> HttpCall {
    calls::list_agents().into()
}

#[uniffi::export]
pub fn update_agent_call(id: String, patch: AgentPatch) -> HttpCall {
    let sharing = patch.sharing.map(|s| match s {
        Sharing::Private => wd_native::rest::Sharing::Private,
        Sharing::Shared => wd_native::rest::Sharing::Shared,
    });
    let patch = calls::AgentPatch { name: patch.name, lead: edit(patch.lead), order: patch.order, sharing, cross_owner: patch.cross_owner };
    calls::update_agent(&id, &patch).into()
}

#[uniffi::export(default(members = None))]
pub fn retire_agent_call(id: String, members: Option<RetireMembers>, expected_generation: i64) -> HttpCall {
    let members = members.map(|m| match m {
        RetireMembers::Release => calls::RetireMembers::Release,
        RetireMembers::Retire => calls::RetireMembers::Retire,
    });
    calls::retire_agent(&id, members, expected_generation).into()
}

#[uniffi::export]
pub fn retired_agents_call() -> HttpCall {
    calls::retired_agents().into()
}

#[uniffi::export(default(seed = None))]
pub fn reroll_avatar_call(id: String, seed: Option<String>) -> HttpCall {
    calls::reroll_avatar(&id, seed.as_deref()).into()
}

#[uniffi::export]
pub fn meta_call() -> HttpCall {
    calls::meta().into()
}

#[uniffi::export]
pub fn list_profiles_call() -> HttpCall {
    calls::list_profiles().into()
}

#[uniffi::export]
pub fn session_request_call(session_id: String, method: String, path: String, scoped: bool, generation: Option<i64>) -> HttpCall {
    HttpCall { method, path: calls::session_request_path(&session_id, &path, scoped), body: None, generation }
}

#[uniffi::export(default(dir = None, limit = None, offset = None, profile = None))]
pub fn list_sdk_sessions_call(dir: Option<String>, limit: Option<u32>, offset: Option<u32>, profile: Option<String>) -> HttpCall {
    calls::list_sdk_sessions(&calls::SdkSessionQuery { dir, limit, offset, profile }).into()
}

#[uniffi::export]
pub fn get_profile_call(name: String) -> HttpCall {
    calls::get_profile(&name).into()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum McpAction {
    Reconnect,
    Enable,
    Disable,
}

impl From<McpAction> for calls::McpAction {
    fn from(action: McpAction) -> Self {
        match action {
            McpAction::Reconnect => calls::McpAction::Reconnect,
            McpAction::Enable => calls::McpAction::Enable,
            McpAction::Disable => calls::McpAction::Disable,
        }
    }
}

impl From<calls::McpAction> for McpAction {
    fn from(action: calls::McpAction) -> Self {
        match action {
            calls::McpAction::Reconnect => McpAction::Reconnect,
            calls::McpAction::Enable => McpAction::Enable,
            calls::McpAction::Disable => McpAction::Disable,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ShellOutputView {
    Text,
    Raw,
    Screen,
}

// The platform sends the file's bytes as the body, under its own media type.
#[uniffi::export]
pub fn upload_attachment_call(session_id: String, name: String, generation: i64) -> HttpCall {
    calls::upload_attachment(&session_id, &name, generation).into()
}

#[uniffi::export]
pub fn attachment_call(session_id: String, attachment_id: String) -> HttpCall {
    calls::attachment(&session_id, &attachment_id).into()
}

#[uniffi::export]
pub fn mcp_servers_call(session_id: String) -> HttpCall {
    calls::mcp_servers(&session_id).into()
}

#[uniffi::export]
pub fn mcp_action_call(session_id: String, server: String, action: McpAction, generation: i64) -> HttpCall {
    calls::mcp_action(&session_id, &server, action.into(), generation).into()
}

#[uniffi::export]
pub fn list_shells_call(session_id: String) -> HttpCall {
    calls::list_shells(&session_id).into()
}

#[uniffi::export]
pub fn get_shell_call(session_id: String, shell_id: String) -> HttpCall {
    calls::get_shell(&session_id, &shell_id).into()
}

#[uniffi::export(default(tail = None))]
pub fn shell_output_call(session_id: String, shell_id: String, view: ShellOutputView, tail: Option<u32>) -> HttpCall {
    let view = match view {
        ShellOutputView::Text => calls::ShellOutputView::Text,
        ShellOutputView::Raw => calls::ShellOutputView::Raw,
        ShellOutputView::Screen => calls::ShellOutputView::Screen,
    };
    calls::shell_output(&session_id, &shell_id, view, tail).into()
}

#[uniffi::export(default(limit = None))]
pub fn find_host_files_call(directory: String, query: String, limit: Option<u32>) -> HttpCall {
    calls::find_host_files(&directory, &query, limit).into()
}

#[uniffi::export]
pub fn produced_file_call(session_id: String, file_id: String) -> HttpCall {
    calls::produced_file(&session_id, &file_id).into()
}

#[uniffi::export]
pub fn project_icon_call(session_id: String) -> HttpCall {
    calls::project_icon(&session_id).into()
}

#[uniffi::export]
pub fn tool_result_call(session_id: String, seq: i64, tool_use_id: String, image_refs: bool) -> HttpCall {
    calls::tool_result(&session_id, seq, &tool_use_id, image_refs).into()
}

#[uniffi::export]
pub fn tool_result_image_call(session_id: String, seq: i64, tool_use_id: String, part_index: i64) -> HttpCall {
    calls::tool_result_image(&session_id, seq, &tool_use_id, part_index).into()
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct HostFileMatch {
    pub path: String,
    pub relative: String,
}

// Decoders for a success body (`perform` already turned a refusal into an error); None is a body of another shape.
fn read<T: serde::de::DeserializeOwned>(body: &str) -> Option<T> {
    serde_json::from_str(body).ok()
}

// The upload's answer: the id the message that carries the file names.
#[uniffi::export]
pub fn uploaded_attachment_id(body: String) -> Option<String> {
    Some(read::<files::UploadedAttachment>(&body)?.attachment.id)
}

#[uniffi::export]
pub fn host_file_matches(body: String) -> Option<Vec<HostFileMatch>> {
    Some(read::<files::HostMatches>(&body)?.matches.into_iter().map(|m| HostFileMatch { path: m.path, relative: m.relative }).collect())
}

// What a create answer leads to: the session to open (none for an agent that has not started one) and its directory.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Created {
    pub session_id: Option<String>,
    pub cwd: Option<String>,
}

#[derive(serde::Deserialize)]
struct SessionBody {
    session: wd_native::rest::SessionInfo,
}

#[derive(serde::Deserialize)]
struct AgentBody {
    agent: AgentRecord,
    #[serde(default)]
    session: Option<wd_native::rest::SessionInfo>,
}

#[derive(serde::Deserialize)]
struct AgentRecord {
    #[serde(default)]
    config: Option<AgentRecordConfig>,
}

#[derive(serde::Deserialize)]
struct AgentRecordConfig {
    #[serde(default)]
    cwd: Option<String>,
}

// The answer to `CreateForm.call()` for a session.
#[uniffi::export]
pub fn created_session(body: String) -> Option<Created> {
    let session = read::<SessionBody>(&body)?.session;
    Some(Created { session_id: Some(session.id), cwd: Some(session.cwd) })
}

// The answer to `CreateForm.call()` for an agent: its first session when it started one.
#[uniffi::export]
pub fn created_agent(body: String) -> Option<Created> {
    let answer = read::<AgentBody>(&body)?;
    let cwd = answer.agent.config.and_then(|c| c.cwd).or_else(|| answer.session.as_ref().map(|s| s.cwd.clone()));
    Some(Created { session_id: answer.session.map(|s| s.id), cwd })
}

// A session's wire status from a `GET /v1/sessions/:id` body.
#[uniffi::export]
pub fn session_status(body: String) -> Option<String> {
    let status = read::<SessionBody>(&body)?.session.status;
    serde_json::to_value(status).ok()?.as_str().map(str::to_owned)
}

// A stored SDK session a new session can resume. `ago` is drawn against the clock passed to `sdk_sessions`.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct SdkSession {
    pub session_id: String,
    pub summary: String,
    pub last_modified: f64,
    pub custom_title: Option<String>,
    pub git_branch: Option<String>,
    pub cwd: Option<String>,
    pub cwd_name: Option<String>,
    pub ago: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SdkSessionsBody {
    sdk_sessions: Vec<SdkSessionWire>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SdkSessionWire {
    session_id: String,
    summary: String,
    last_modified: f64,
    #[serde(default)]
    custom_title: Option<String>,
    #[serde(default)]
    git_branch: Option<String>,
    #[serde(default)]
    cwd: Option<String>,
}

#[uniffi::export]
pub fn sdk_sessions(body: String, now_ms: f64) -> Option<Vec<SdkSession>> {
    Some(
        read::<SdkSessionsBody>(&body)?
            .sdk_sessions
            .into_iter()
            .map(|s| SdkSession {
                cwd_name: s.cwd.as_deref().map(|cwd| cwd.rsplit('/').find(|p| !p.is_empty()).unwrap_or(cwd).to_owned()),
                ago: wd_native::vm::fmt::ago(s.last_modified, now_ms),
                session_id: s.session_id,
                summary: s.summary,
                last_modified: s.last_modified,
                custom_title: s.custom_title,
                git_branch: s.git_branch,
                cwd: s.cwd,
            })
            .collect(),
    )
}

#[cfg(test)]
mod answer_tests {
    use super::*;

    const SESSION: &str = r#"{"id":"s1","status":"awaiting_approval","cwd":"/w/app","createdAt":1,"lastSeq":0,"pendingPermissionCount":1}"#;

    #[test]
    fn create_answers_name_the_session_and_its_directory() {
        assert_eq!(
            created_session(format!(r#"{{"session":{SESSION}}}"#)),
            Some(Created { session_id: Some("s1".into()), cwd: Some("/w/app".into()) })
        );
        assert_eq!(
            created_agent(r#"{"agent":{"id":"a","name":"Ada","config":{"cwd":"/w/agent"}}}"#.into()),
            Some(Created { session_id: None, cwd: Some("/w/agent".into()) })
        );
        assert_eq!(
            created_agent(format!(r#"{{"agent":{{"id":"a","name":"Ada"}},"session":{SESSION}}}"#)),
            Some(Created { session_id: Some("s1".into()), cwd: Some("/w/app".into()) })
        );
        assert_eq!(created_session("<html>".into()), None);
        assert_eq!(session_status(format!(r#"{{"session":{SESSION}}}"#)).as_deref(), Some("awaiting_approval"));
    }

    #[test]
    fn sdk_sessions_read_their_rows_with_an_age() {
        let body = r#"{"sdkSessions":[{"sessionId":"x","summary":"Fix it","lastModified":0,"cwd":"/w/app/","gitBranch":"main"}]}"#;
        let rows = sdk_sessions(body.into(), 7_200_000.0).unwrap();
        assert_eq!((rows[0].cwd_name.as_deref(), rows[0].ago.as_str(), rows[0].git_branch.as_deref()), (Some("app"), "2h", Some("main")));
        assert_eq!(sdk_sessions("{}".into(), 0.0), None);
    }
}
