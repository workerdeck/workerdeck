use wd_native::rest::calls::{self, Edit};
use wd_native::rest::error::{self, RestErrorKind as CoreKind};

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
        };
        Self { status: e.status, kind, message: e.message }
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
