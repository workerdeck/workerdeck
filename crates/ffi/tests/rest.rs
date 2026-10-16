use wdffi::*;

fn call(method: &str, path: &str, body: Option<&str>) -> HttpCall {
    HttpCall { method: method.into(), path: path.into(), body: body.map(Into::into) }
}

#[test]
fn every_r1_call_names_its_route() {
    assert_eq!(list_sessions_call(), call("GET", "/sessions", None));
    assert_eq!(get_session_call("a b".into()), call("GET", "/sessions/a%20b", None));
    assert_eq!(sleep_session_call("s".into()), call("POST", "/sessions/s/sleep", None));
    assert_eq!(delete_session_call("s".into()), call("DELETE", "/sessions/s", None));
    assert_eq!(stop_task_call("s".into(), "tu".into()), call("POST", "/sessions/s/tasks/tu/stop", None));
    assert_eq!(background_task_call("s".into(), None), call("POST", "/sessions/s/tasks/background", None));
    assert_eq!(kill_shell_call("s".into(), "x".into()), call("POST", "/sessions/s/shells/x/kill", None));
    assert_eq!(list_agents_call(), call("GET", "/agents", None));
    assert_eq!(restart_agent_call("a".into(), None), call("POST", "/agents/a/restart", Some("{}")));
    assert_eq!(retire_agent_call("a".into(), Some(RetireMembers::Release)), call("DELETE", "/agents/a", Some(r#"{"members":"release"}"#)));
    assert_eq!(reroll_avatar_call("a".into(), None), call("POST", "/agents/a/avatar", Some("{}")));
    assert_eq!(meta_call(), call("GET", "/meta", None));
    assert_eq!(list_profiles_call(), call("GET", "/profiles", None));
    assert_eq!(
        session_request_call("s 1".into(), "POST".into(), "/shells/x/kill".into(), true),
        call("POST", "/sessions/s%201/shells/x/kill", None)
    );
}

#[test]
fn patches_cross_as_three_state_edits() {
    let patch = SessionPatch {
        title: Some(TextEdit::Clear),
        status_label: Some(StatusEdit::Set { text: "on it".into(), emoji: Some("x".into()) }),
    };
    assert_eq!(
        update_session_call("s".into(), patch).body.as_deref(),
        Some(r#"{"title":null,"statusLabel":{"text":"on it","emoji":"x"}}"#)
    );
    let patch = AgentPatch { lead: Some(TextEdit::Set { value: "l".into() }), sharing: Some(Sharing::Private), ..Default::default() };
    assert_eq!(update_agent_call("a".into(), patch), call("PATCH", "/agents/a", Some(r#"{"lead":"l","sharing":"private"}"#)));
}

#[test]
fn a_permission_answer_parses_its_input_and_drops_a_non_object() {
    let allow = PermissionDecision::Allow { updated_input_json: Some(r#"{"answers":{"Q":"A"}}"#.into()) };
    assert_eq!(
        resolve_permission_call("s".into(), "r".into(), allow).body.as_deref(),
        Some(r#"{"behavior":"allow","updatedInput":{"answers":{"Q":"A"}}}"#)
    );
    let junk = PermissionDecision::Allow { updated_input_json: Some("[1]".into()) };
    assert_eq!(resolve_permission_call("s".into(), "r".into(), junk).body.as_deref(), Some(r#"{"behavior":"allow"}"#));
    let deny = PermissionDecision::Deny { message: Some("no".into()), interrupt: None };
    assert_eq!(resolve_permission_call("s".into(), "r".into(), deny).body.as_deref(), Some(r#"{"behavior":"deny","message":"no"}"#));
}

#[test]
fn rest_error_classifies_the_answer() {
    assert_eq!(rest_error(200, Some("application/json".into()), "{}".into()), None);
    let parked = rest_error(409, Some("application/json".into()), r#"{"error":"parked"}"#.into());
    assert_eq!(parked, Some(RestError { status: 409, kind: RestErrorKind::Conflict, message: "parked".into() }));
    assert_eq!(rest_error(200, Some("text/html".into()), "".into()).map(|e| e.kind), Some(RestErrorKind::NotGateway));
    assert_eq!(rest_error(0, None, "".into()).map(|e| e.kind), Some(RestErrorKind::Transport));
}
