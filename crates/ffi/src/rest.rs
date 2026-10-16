use wd_native::rest::calls::{self, Edit};
use wd_native::rest::error::{self, Answer, RestErrorKind as CoreKind};
use wd_native::rest::files;

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct HttpCall {
    pub method: String,
    pub path: String,
    pub body: Option<String>,
}

impl From<calls::HttpCall> for HttpCall {
    fn from(call: calls::HttpCall) -> Self {
        Self { method: call.method.to_owned(), path: call.path, body: call.body }
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

#[uniffi::export]
pub fn update_session_call(id: String, patch: SessionPatch) -> HttpCall {
    let status_label = patch.status_label.map(|e| match e {
        StatusEdit::Set { text, emoji } => Edit::Set(calls::StatusInput { text, emoji }),
        StatusEdit::Clear => Edit::Clear,
    });
    calls::update_session(&id, &calls::SessionPatch { title: edit(patch.title), status_label }).into()
}

#[uniffi::export]
pub fn sleep_session_call(id: String) -> HttpCall {
    calls::sleep_session(&id).into()
}

#[uniffi::export]
pub fn delete_session_call(id: String) -> HttpCall {
    calls::delete_session(&id).into()
}

#[uniffi::export]
pub fn stop_task_call(session_id: String, tool_use_id: String) -> HttpCall {
    calls::stop_task(&session_id, &tool_use_id).into()
}

#[uniffi::export(default(tool_use_id = None))]
pub fn background_task_call(session_id: String, tool_use_id: Option<String>) -> HttpCall {
    calls::background_task(&session_id, tool_use_id.as_deref()).into()
}

#[uniffi::export]
pub fn kill_shell_call(session_id: String, shell_id: String) -> HttpCall {
    calls::kill_shell(&session_id, &shell_id).into()
}

#[uniffi::export]
pub fn resolve_permission_call(session_id: String, request_id: String, decision: PermissionDecision) -> HttpCall {
    let decision = match decision {
        PermissionDecision::Allow { updated_input_json } => {
            calls::PermissionDecision::Allow { updated_input: updated_input_json.and_then(|json| serde_json::from_str(&json).ok()) }
        }
        PermissionDecision::Deny { message, interrupt } => calls::PermissionDecision::Deny { message, interrupt },
    };
    calls::resolve_permission(&session_id, &request_id, &decision).into()
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

#[uniffi::export(default(prompt = None))]
pub fn restart_agent_call(id: String, prompt: Option<String>) -> HttpCall {
    calls::restart_agent(&id, prompt.as_deref()).into()
}

#[uniffi::export(default(members = None))]
pub fn retire_agent_call(id: String, members: Option<RetireMembers>) -> HttpCall {
    let members = members.map(|m| match m {
        RetireMembers::Release => calls::RetireMembers::Release,
        RetireMembers::Retire => calls::RetireMembers::Retire,
    });
    calls::retire_agent(&id, members).into()
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
pub fn session_request_call(session_id: String, method: String, path: String, scoped: bool) -> HttpCall {
    HttpCall { method, path: calls::session_request_path(&session_id, &path, scoped), body: None }
}

// An agent made from what already exists (`adopt` a session, join a `lead`); a configured new agent comes from
// `CreateForm.call`.
#[derive(Debug, Clone, PartialEq, Eq, Default, uniffi::Record)]
pub struct NewAgent {
    #[uniffi(default)]
    pub name: Option<String>,
    #[uniffi(default)]
    pub prompt: Option<String>,
    #[uniffi(default)]
    pub lead: Option<String>,
    #[uniffi(default)]
    pub adopt: Option<String>,
    #[uniffi(default)]
    pub sharing: Option<Sharing>,
    #[uniffi(default)]
    pub cross_owner: Option<bool>,
}

#[uniffi::export]
pub fn create_agent_call(request: NewAgent) -> HttpCall {
    let sharing = request.sharing.map(|s| match s {
        Sharing::Private => wd_native::rest::Sharing::Private,
        Sharing::Shared => wd_native::rest::Sharing::Shared,
    });
    let request = calls::NewAgent {
        name: request.name,
        config: None,
        prompt: request.prompt,
        lead: request.lead,
        adopt: request.adopt,
        sharing,
        cross_owner: request.cross_owner,
    };
    calls::create_agent(&request).into()
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

#[uniffi::export]
pub fn session_files_call(session_id: String) -> HttpCall {
    calls::session_files(&session_id).into()
}

#[uniffi::export]
pub fn session_file_call(session_id: String, path: String) -> HttpCall {
    calls::session_file(&session_id, &path).into()
}

// The platform sends the file's bytes as the body, under its own media type.
#[uniffi::export]
pub fn upload_attachment_call(session_id: String, name: String) -> HttpCall {
    calls::upload_attachment(&session_id, &name).into()
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
pub fn mcp_action_call(session_id: String, server: String, action: McpAction) -> HttpCall {
    calls::mcp_action(&session_id, &server, action.into()).into()
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
pub fn agent_avatar_call(agent_id: String, busy: bool) -> HttpCall {
    calls::agent_avatar(&agent_id, busy).into()
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
pub struct SessionFile {
    pub path: String,
    pub bytes: u64,
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

#[uniffi::export]
pub fn session_files(body: String) -> Option<Vec<SessionFile>> {
    Some(read::<files::SessionFiles>(&body)?.files.into_iter().map(|f| SessionFile { path: f.path, bytes: f.bytes }).collect())
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
