use super::{AgentConfig, PermissionMode, Sharing, encode_component};
use serde::Serialize;
use serde_json::{Map, Value, json};

// One REST request under the API base (`.../v1`): the core names it, the platform moves the bytes. A `body` is JSON
// and rides with `content-type: application/json`; a non-GET without one goes out with an empty body.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpCall {
    pub method: &'static str,
    pub path: String,
    pub body: Option<String>,
}

impl HttpCall {
    fn get(path: String) -> Self {
        Self { method: "GET", path, body: None }
    }

    fn post(path: String) -> Self {
        Self { method: "POST", path, body: None }
    }

    fn with(method: &'static str, path: String, body: Value) -> Self {
        Self { method, path, body: Some(body.to_string()) }
    }
}

// A three-state wire field: a value sets it, `Clear` sends an explicit `null`, absent (`None` around it) leaves it.
#[derive(Debug, Clone, PartialEq)]
pub enum Edit<T> {
    Set(T),
    Clear,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StatusInput {
    pub text: String,
    pub emoji: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct SessionPatch {
    pub title: Option<Edit<String>>,
    pub status_label: Option<Edit<StatusInput>>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct AgentPatch {
    pub name: Option<String>,
    pub lead: Option<Edit<String>>,
    pub order: Option<f64>,
    pub sharing: Option<Sharing>,
    pub cross_owner: Option<bool>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum PermissionDecision {
    Allow { updated_input: Option<Map<String, Value>> },
    Deny { message: Option<String>, interrupt: Option<bool> },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SettingSource {
    User,
    Project,
    Local,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSession {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allow_dangerously_skip_permissions: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub setting_sources: Option<Vec<SettingSource>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_turns: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_budget_usd: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub resume: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fork_session: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub include_partial_messages: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub meta: Option<Map<String, Value>>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct NewAgent {
    pub name: Option<String>,
    pub config: Option<AgentConfig>,
    pub prompt: Option<String>,
    pub lead: Option<String>,
    pub adopt: Option<String>,
    pub sharing: Option<Sharing>,
    pub cross_owner: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SdkSessionQuery {
    pub dir: Option<String>,
    pub limit: Option<u32>,
    pub offset: Option<u32>,
    pub profile: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RetireMembers {
    Release,
    Retire,
}

fn session(id: &str) -> String {
    format!("/sessions/{}", encode_component(id))
}

fn agent(id: &str) -> String {
    format!("/agents/{}", encode_component(id))
}

fn put_edit<T>(body: &mut Map<String, Value>, key: &str, edit: &Option<Edit<T>>, value: impl Fn(&T) -> Value) {
    match edit {
        Some(Edit::Set(v)) => _ = body.insert(key.to_owned(), value(v)),
        Some(Edit::Clear) => _ = body.insert(key.to_owned(), Value::Null),
        None => {}
    }
}

fn put<T: Into<Value> + Clone>(body: &mut Map<String, Value>, key: &str, value: &Option<T>) {
    if let Some(v) = value {
        body.insert(key.to_owned(), v.clone().into());
    }
}

pub fn create_session(request: &NewSession) -> HttpCall {
    HttpCall::with("POST", "/sessions".to_owned(), serde_json::to_value(request).unwrap_or_else(|_| json!({})))
}

pub fn create_agent(request: &NewAgent) -> HttpCall {
    let mut body = Map::new();
    put(&mut body, "name", &request.name);
    if let Some(config) = &request.config {
        body.insert("config".to_owned(), serde_json::to_value(config).unwrap_or_else(|_| json!({})));
    }
    put(&mut body, "prompt", &request.prompt);
    put(&mut body, "lead", &request.lead);
    put(&mut body, "adopt", &request.adopt);
    if let Some(sharing) = request.sharing.and_then(sharing_name) {
        body.insert("sharing".to_owned(), json!(sharing));
    }
    put(&mut body, "crossOwner", &request.cross_owner);
    HttpCall::with("POST", "/agents".to_owned(), Value::Object(body))
}

pub fn list_sdk_sessions(query: &SdkSessionQuery) -> HttpCall {
    let mut pairs = Vec::new();
    if let Some(dir) = &query.dir {
        pairs.push(format!("dir={}", encode_component(dir)));
    }
    if let Some(limit) = query.limit {
        pairs.push(format!("limit={limit}"));
    }
    if let Some(offset) = query.offset {
        pairs.push(format!("offset={offset}"));
    }
    if let Some(profile) = &query.profile {
        pairs.push(format!("profile={}", encode_component(profile)));
    }
    let suffix = if pairs.is_empty() { String::new() } else { format!("?{}", pairs.join("&")) };
    HttpCall::get(format!("/sdk-sessions{suffix}"))
}

pub fn get_profile(name: &str) -> HttpCall {
    HttpCall::get(format!("/profiles/{}", encode_component(name)))
}

pub fn list_sessions() -> HttpCall {
    HttpCall::get("/sessions".to_owned())
}

pub fn get_session(id: &str) -> HttpCall {
    HttpCall::get(session(id))
}

pub fn update_session(id: &str, patch: &SessionPatch) -> HttpCall {
    let mut body = Map::new();
    put_edit(&mut body, "title", &patch.title, |title| json!(title));
    put_edit(&mut body, "statusLabel", &patch.status_label, |label| match &label.emoji {
        Some(emoji) => json!({ "text": label.text, "emoji": emoji }),
        None => json!({ "text": label.text }),
    });
    HttpCall::with("PATCH", session(id), Value::Object(body))
}

pub fn sleep_session(id: &str) -> HttpCall {
    HttpCall::post(format!("{}/sleep", session(id)))
}

pub fn delete_session(id: &str) -> HttpCall {
    HttpCall { method: "DELETE", path: session(id), body: None }
}

pub fn stop_task(session_id: &str, tool_use_id: &str) -> HttpCall {
    HttpCall::post(format!("{}/tasks/{}/stop", session(session_id), encode_component(tool_use_id)))
}

// No id moves every running foreground call.
pub fn background_task(session_id: &str, tool_use_id: Option<&str>) -> HttpCall {
    match tool_use_id {
        Some(id) => HttpCall::post(format!("{}/tasks/{}/background", session(session_id), encode_component(id))),
        None => HttpCall::post(format!("{}/tasks/background", session(session_id))),
    }
}

pub fn kill_shell(session_id: &str, shell_id: &str) -> HttpCall {
    HttpCall::post(format!("{}/shells/{}/kill", session(session_id), encode_component(shell_id)))
}

pub fn resolve_permission(session_id: &str, request_id: &str, decision: &PermissionDecision) -> HttpCall {
    let mut body = Map::new();
    match decision {
        PermissionDecision::Allow { updated_input } => {
            body.insert("behavior".to_owned(), json!("allow"));
            if let Some(input) = updated_input {
                body.insert("updatedInput".to_owned(), Value::Object(input.clone()));
            }
        }
        PermissionDecision::Deny { message, interrupt } => {
            body.insert("behavior".to_owned(), json!("deny"));
            put(&mut body, "message", message);
            put(&mut body, "interrupt", interrupt);
        }
    }
    HttpCall::with("POST", format!("{}/permissions/{}", session(session_id), encode_component(request_id)), Value::Object(body))
}

pub fn list_agents() -> HttpCall {
    HttpCall::get("/agents".to_owned())
}

pub fn update_agent(id: &str, patch: &AgentPatch) -> HttpCall {
    let mut body = Map::new();
    put(&mut body, "name", &patch.name);
    put_edit(&mut body, "lead", &patch.lead, |lead| json!(lead));
    put(&mut body, "order", &patch.order);
    if let Some(sharing) = patch.sharing.and_then(sharing_name) {
        body.insert("sharing".to_owned(), json!(sharing));
    }
    put(&mut body, "crossOwner", &patch.cross_owner);
    HttpCall::with("PATCH", agent(id), Value::Object(body))
}

fn sharing_name(sharing: Sharing) -> Option<&'static str> {
    match sharing {
        Sharing::Private => Some("private"),
        Sharing::Shared => Some("shared"),
        Sharing::Unknown => None,
    }
}

pub fn restart_agent(id: &str, prompt: Option<&str>) -> HttpCall {
    let body = prompt.map_or_else(|| json!({}), |prompt| json!({ "prompt": prompt }));
    HttpCall::with("POST", format!("{}/restart", agent(id)), body)
}

pub fn retire_agent(id: &str, members: Option<RetireMembers>) -> HttpCall {
    let body = match members {
        Some(RetireMembers::Release) => json!({ "members": "release" }),
        Some(RetireMembers::Retire) => json!({ "members": "retire" }),
        None => json!({}),
    };
    HttpCall::with("DELETE", agent(id), body)
}

pub fn reroll_avatar(id: &str, seed: Option<&str>) -> HttpCall {
    let body = seed.map_or_else(|| json!({}), |seed| json!({ "seed": seed }));
    HttpCall::with("POST", format!("{}/avatar", agent(id)), body)
}

pub fn meta() -> HttpCall {
    HttpCall::get("/meta".to_owned())
}

pub fn list_profiles() -> HttpCall {
    HttpCall::get("/profiles".to_owned())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpAction {
    Reconnect,
    Enable,
    Disable,
}

impl McpAction {
    pub fn name(self) -> &'static str {
        match self {
            McpAction::Reconnect => "reconnect",
            McpAction::Enable => "enable",
            McpAction::Disable => "disable",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellOutputView {
    Text,
    Raw,
    Screen,
}

// `PUT /fs/write` is always conditional: `expected_hash` is the read the edit started from, absent only to create.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HostWrite {
    pub path: String,
    pub content: String,
    pub base64: bool,
    pub expected_hash: Option<String>,
}

fn query(pairs: &[(&str, Option<String>)]) -> String {
    let set: Vec<String> =
        pairs.iter().filter_map(|(name, value)| value.as_ref().map(|v| format!("{name}={}", encode_component(v)))).collect();
    if set.is_empty() { String::new() } else { format!("?{}", set.join("&")) }
}

// The body is the file's raw bytes under its own media type, which the platform sends; the answer is `{attachment}`.
pub fn upload_attachment(session_id: &str, name: &str) -> HttpCall {
    HttpCall::post(format!("{}/attachments{}", session(session_id), query(&[("name", Some(name.to_owned()))])))
}

pub fn attachment(session_id: &str, attachment_id: &str) -> HttpCall {
    HttpCall::get(format!("{}/attachments/{}", session(session_id), encode_component(attachment_id)))
}

pub fn mcp_servers(session_id: &str) -> HttpCall {
    HttpCall::get(format!("{}/mcp", session(session_id)))
}

pub fn mcp_action(session_id: &str, server: &str, action: McpAction) -> HttpCall {
    HttpCall::with("POST", format!("{}/mcp/{}", session(session_id), encode_component(server)), json!({ "action": action.name() }))
}

fn shell(session_id: &str, shell_id: &str) -> String {
    format!("{}/shells/{}", session(session_id), encode_component(shell_id))
}

pub fn list_shells(session_id: &str) -> HttpCall {
    HttpCall::get(format!("{}/shells", session(session_id)))
}

pub fn get_shell(session_id: &str, shell_id: &str) -> HttpCall {
    HttpCall::get(shell(session_id, shell_id))
}

pub fn shell_output(session_id: &str, shell_id: &str, view: ShellOutputView, tail: Option<u32>) -> HttpCall {
    let view = match view {
        ShellOutputView::Text => "text",
        ShellOutputView::Raw => "raw",
        ShellOutputView::Screen => "screen",
    };
    let suffix = query(&[("view", Some(view.to_owned())), ("tail", tail.map(|t| t.to_string()))]);
    HttpCall::get(format!("{}/output{suffix}", shell(session_id, shell_id)))
}

pub fn host_roots() -> HttpCall {
    HttpCall::get("/fs/roots".to_owned())
}

pub fn host_dir(path: &str) -> HttpCall {
    HttpCall::get(format!("/fs/list{}", query(&[("path", Some(path.to_owned()))])))
}

pub fn find_host_files(directory: &str, q: &str, limit: Option<u32>) -> HttpCall {
    let suffix = query(&[("path", Some(directory.to_owned())), ("q", Some(q.to_owned())), ("limit", limit.map(|l| l.to_string()))]);
    HttpCall::get(format!("/fs/find{suffix}"))
}

pub fn read_host_file(path: &str) -> HttpCall {
    HttpCall::get(format!("/fs/read{}", query(&[("path", Some(path.to_owned()))])))
}

pub fn write_host_file(write: &HostWrite) -> HttpCall {
    let mut body = Map::new();
    body.insert("path".to_owned(), json!(write.path));
    body.insert("content".to_owned(), json!(write.content));
    body.insert("encoding".to_owned(), json!(if write.base64 { "base64" } else { "utf8" }));
    put(&mut body, "expectedHash", &write.expected_hash);
    HttpCall::with("PUT", "/fs/write".to_owned(), Value::Object(body))
}

// Bytes the session's engine reported writing (codex's generated images): no host-file root, no byte cap.
pub fn produced_file(session_id: &str, file_id: &str) -> HttpCall {
    HttpCall::get(format!("{}/produced/{}", session(session_id), encode_component(file_id)))
}

// A 404 is the uniform "no icon"; cache the bytes by the icon's hash, never by session.
pub fn project_icon(session_id: &str) -> HttpCall {
    HttpCall::get(format!("{}/project/icon", session(session_id)))
}

pub fn agent_avatar(agent_id: &str, busy: bool) -> HttpCall {
    HttpCall::get(agent_avatar_path(agent_id, busy))
}

pub fn agent_avatar_path(agent_id: &str, busy: bool) -> String {
    format!("{}/{}", agent(agent_id), if busy { "avatar-busy.png" } else { "avatar.png" })
}

// A stale seq 404s rather than serving another call's result: ask again after a fresh attach.
pub fn tool_result(session_id: &str, seq: i64, tool_use_id: &str, image_refs: bool) -> HttpCall {
    let suffix = query(&[("toolUseId", Some(tool_use_id.to_owned())), ("imageRefs", image_refs.then(|| "1".to_owned()))]);
    HttpCall::get(format!("{}/events/{seq}/result{suffix}", session(session_id)))
}

pub fn tool_result_image(session_id: &str, seq: i64, tool_use_id: &str, part_index: i64) -> HttpCall {
    let suffix = query(&[("toolUseId", Some(tool_use_id.to_owned())), ("part", Some(part_index.to_string()))]);
    HttpCall::get(format!("{}/events/{seq}/result{suffix}", session(session_id)))
}

// A live session's `Request` effect names its path under the session when `scoped`.
pub fn session_request_path(session_id: &str, path: &str, scoped: bool) -> String {
    if scoped { format!("{}{path}", session(session_id)) } else { path.to_owned() }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn call(method: &'static str, path: &str, body: Option<&str>) -> HttpCall {
        HttpCall { method, path: path.to_owned(), body: body.map(str::to_owned) }
    }

    #[test]
    fn session_calls_encode_their_ids() {
        assert_eq!(list_sessions(), call("GET", "/sessions", None));
        assert_eq!(get_session("a/b c"), call("GET", "/sessions/a%2Fb%20c", None));
        assert_eq!(sleep_session("s 1"), call("POST", "/sessions/s%201/sleep", None));
        assert_eq!(delete_session("s?1"), call("DELETE", "/sessions/s%3F1", None));
        assert_eq!(stop_task("s", "tu/1"), call("POST", "/sessions/s/tasks/tu%2F1/stop", None));
        assert_eq!(kill_shell("s", "sh#1"), call("POST", "/sessions/s/shells/sh%231/kill", None));
    }

    #[test]
    fn background_moves_one_call_or_every_call() {
        assert_eq!(background_task("s", Some("tu 1")), call("POST", "/sessions/s/tasks/tu%201/background", None));
        assert_eq!(background_task("s", None), call("POST", "/sessions/s/tasks/background", None));
    }

    #[test]
    fn a_session_patch_keeps_all_three_states() {
        let rename = SessionPatch { title: Some(Edit::Set("Named".into())), ..Default::default() };
        assert_eq!(update_session("s", &rename), call("PATCH", "/sessions/s", Some(r#"{"title":"Named"}"#)));
        let clear = SessionPatch { title: Some(Edit::Clear), status_label: Some(Edit::Clear) };
        assert_eq!(update_session("s", &clear).body.as_deref(), Some(r#"{"title":null,"statusLabel":null}"#));
        let status = SessionPatch { status_label: Some(Edit::Set(StatusInput { text: "busy".into(), emoji: None })), ..Default::default() };
        assert_eq!(update_session("s", &status).body.as_deref(), Some(r#"{"statusLabel":{"text":"busy"}}"#));
        assert_eq!(update_session("s", &SessionPatch::default()).body.as_deref(), Some("{}"));
    }

    #[test]
    fn a_permission_answer_carries_only_what_was_said() {
        let allow = PermissionDecision::Allow { updated_input: None };
        assert_eq!(resolve_permission("s", "r/1", &allow), call("POST", "/sessions/s/permissions/r%2F1", Some(r#"{"behavior":"allow"}"#)));
        let input = json!({ "answers": { "Q": "A" } }).as_object().cloned();
        let answered = resolve_permission("s", "r", &PermissionDecision::Allow { updated_input: input }).body;
        assert_eq!(answered.as_deref(), Some(r#"{"behavior":"allow","updatedInput":{"answers":{"Q":"A"}}}"#));
        let deny = PermissionDecision::Deny { message: Some("no".into()), interrupt: Some(false) };
        assert_eq!(resolve_permission("s", "r", &deny).body.as_deref(), Some(r#"{"behavior":"deny","message":"no","interrupt":false}"#));
        let bare = PermissionDecision::Deny { message: None, interrupt: None };
        assert_eq!(resolve_permission("s", "r", &bare).body.as_deref(), Some(r#"{"behavior":"deny"}"#));
    }

    #[test]
    fn an_agent_patch_leaves_a_team_with_null() {
        let leave = AgentPatch { lead: Some(Edit::Clear), ..Default::default() };
        assert_eq!(update_agent("a 1", &leave), call("PATCH", "/agents/a%201", Some(r#"{"lead":null}"#)));
        let join = AgentPatch { lead: Some(Edit::Set("lead".into())), cross_owner: Some(true), ..Default::default() };
        assert_eq!(update_agent("a", &join).body.as_deref(), Some(r#"{"lead":"lead","crossOwner":true}"#));
        let edit = AgentPatch { name: Some("Ada".into()), order: Some(2.5), sharing: Some(Sharing::Shared), ..Default::default() };
        assert_eq!(update_agent("a", &edit).body.as_deref(), Some(r#"{"name":"Ada","order":2.5,"sharing":"shared"}"#));
    }

    #[test]
    fn agent_actions_always_send_an_object() {
        assert_eq!(list_agents(), call("GET", "/agents", None));
        assert_eq!(restart_agent("a", None), call("POST", "/agents/a/restart", Some("{}")));
        assert_eq!(restart_agent("a", Some("go")).body.as_deref(), Some(r#"{"prompt":"go"}"#));
        assert_eq!(retire_agent("a/1", None), call("DELETE", "/agents/a%2F1", Some("{}")));
        assert_eq!(retire_agent("a", Some(RetireMembers::Release)).body.as_deref(), Some(r#"{"members":"release"}"#));
        assert_eq!(retire_agent("a", Some(RetireMembers::Retire)).body.as_deref(), Some(r#"{"members":"retire"}"#));
        assert_eq!(reroll_avatar("a", None), call("POST", "/agents/a/avatar", Some("{}")));
        assert_eq!(reroll_avatar("a", Some("x")).body.as_deref(), Some(r#"{"seed":"x"}"#));
    }

    #[test]
    fn a_new_session_omits_every_unset_field() {
        assert_eq!(create_session(&NewSession::default()), call("POST", "/sessions", Some("{}")));
        let request = NewSession {
            cwd: Some("/w".into()),
            permission_mode: Some(PermissionMode::BypassPermissions),
            allow_dangerously_skip_permissions: Some(true),
            setting_sources: Some(vec![SettingSource::User, SettingSource::Local]),
            max_turns: Some(3),
            ..Default::default()
        };
        assert_eq!(
            create_session(&request).body.as_deref(),
            Some(
                r#"{"cwd":"/w","permissionMode":"bypassPermissions","allowDangerouslySkipPermissions":true,"settingSources":["user","local"],"maxTurns":3}"#
            )
        );
    }

    #[test]
    fn a_new_agent_carries_its_config_and_team() {
        let adopt = NewAgent { adopt: Some("s1".into()), lead: Some("a2".into()), cross_owner: Some(true), ..Default::default() };
        assert_eq!(create_agent(&adopt), call("POST", "/agents", Some(r#"{"lead":"a2","adopt":"s1","crossOwner":true}"#)));
        let config = AgentConfig { cwd: Some("/w".into()), brief: Some("b".into()), ..Default::default() };
        let named = NewAgent { name: Some("Ada".into()), config: Some(config), sharing: Some(Sharing::Shared), ..Default::default() };
        assert_eq!(create_agent(&named).body.as_deref(), Some(r#"{"name":"Ada","config":{"cwd":"/w","brief":"b"},"sharing":"shared"}"#));
    }

    #[test]
    fn sdk_sessions_and_profile_detail() {
        assert_eq!(list_sdk_sessions(&SdkSessionQuery::default()), call("GET", "/sdk-sessions", None));
        let query = SdkSessionQuery { dir: Some("/a b".into()), limit: Some(20), offset: None, profile: Some("p&q".into()) };
        assert_eq!(list_sdk_sessions(&query), call("GET", "/sdk-sessions?dir=%2Fa%20b&limit=20&profile=p%26q", None));
        assert_eq!(get_profile("my profile"), call("GET", "/profiles/my%20profile", None));
    }

    #[test]
    fn session_asset_routes_encode_ids_and_names() {
        assert_eq!(upload_attachment("s", "a+b c.png"), call("POST", "/sessions/s/attachments?name=a%2Bb%20c.png", None));
        assert_eq!(attachment("s", "at/1"), call("GET", "/sessions/s/attachments/at%2F1", None));
        assert_eq!(produced_file("s", "f 1"), call("GET", "/sessions/s/produced/f%201", None));
        assert_eq!(project_icon("s/1"), call("GET", "/sessions/s%2F1/project/icon", None));
        assert_eq!(agent_avatar("a b", false), call("GET", "/agents/a%20b/avatar.png", None));
        assert_eq!(agent_avatar("a", true), call("GET", "/agents/a/avatar-busy.png", None));
    }

    #[test]
    fn mcp_and_shell_routes() {
        assert_eq!(mcp_servers("s"), call("GET", "/sessions/s/mcp", None));
        assert_eq!(
            mcp_action("s", "my server", McpAction::Disable),
            call("POST", "/sessions/s/mcp/my%20server", Some(r#"{"action":"disable"}"#))
        );
        assert_eq!(mcp_action("s", "x", McpAction::Reconnect).body.as_deref(), Some(r#"{"action":"reconnect"}"#));
        assert_eq!(list_shells("s"), call("GET", "/sessions/s/shells", None));
        assert_eq!(get_shell("s", "sh 1"), call("GET", "/sessions/s/shells/sh%201", None));
        assert_eq!(shell_output("s", "x", ShellOutputView::Text, None), call("GET", "/sessions/s/shells/x/output?view=text", None));
        assert_eq!(
            shell_output("s", "x", ShellOutputView::Raw, Some(4096)),
            call("GET", "/sessions/s/shells/x/output?view=raw&tail=4096", None)
        );
    }

    #[test]
    fn host_file_routes_carry_their_query_encoded() {
        assert_eq!(host_roots(), call("GET", "/fs/roots", None));
        assert_eq!(host_dir("/repo/my src"), call("GET", "/fs/list?path=%2Frepo%2Fmy%20src", None));
        assert_eq!(find_host_files("/repo", "a t", Some(8)), call("GET", "/fs/find?path=%2Frepo&q=a%20t&limit=8", None));
        assert_eq!(find_host_files("/repo", "", None), call("GET", "/fs/find?path=%2Frepo&q=", None));
        assert_eq!(read_host_file("/a&b"), call("GET", "/fs/read?path=%2Fa%26b", None));
        let create = HostWrite { path: "/n".into(), content: "aGk=".into(), base64: true, expected_hash: None };
        assert_eq!(write_host_file(&create), call("PUT", "/fs/write", Some(r#"{"path":"/n","content":"aGk=","encoding":"base64"}"#)));
    }

    #[test]
    fn tool_result_routes_verify_the_call_they_name() {
        assert_eq!(tool_result("s", 12, "tu/1", false), call("GET", "/sessions/s/events/12/result?toolUseId=tu%2F1", None));
        assert_eq!(tool_result("s", 12, "tu", true).path, "/sessions/s/events/12/result?toolUseId=tu&imageRefs=1");
        assert_eq!(tool_result_image("a b", 12, "toolu/1", 0).path, "/sessions/a%20b/events/12/result?toolUseId=toolu%2F1&part=0");
    }

    #[test]
    fn gateway_reads_and_session_requests() {
        assert_eq!(meta(), call("GET", "/meta", None));
        assert_eq!(list_profiles(), call("GET", "/profiles", None));
        assert_eq!(session_request_path("s 1", "/shells/x/kill", true), "/sessions/s%201/shells/x/kill");
        assert_eq!(session_request_path("s 1", "/profiles", false), "/profiles");
    }
}
