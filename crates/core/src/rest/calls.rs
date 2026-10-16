use super::{Sharing, encode_component};
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
    fn gateway_reads_and_session_requests() {
        assert_eq!(meta(), call("GET", "/meta", None));
        assert_eq!(list_profiles(), call("GET", "/profiles", None));
        assert_eq!(session_request_path("s 1", "/shells/x/kill", true), "/sessions/s%201/shells/x/kill");
        assert_eq!(session_request_path("s 1", "/profiles", false), "/profiles");
    }
}
