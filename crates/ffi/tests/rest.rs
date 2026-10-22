use wdffi::*;

fn call(method: &str, path: &str, body: Option<&str>) -> HttpCall {
    HttpCall { method: method.into(), path: path.into(), body: body.map(Into::into), generation: None }
}

fn at(method: &str, path: &str, body: Option<&str>, generation: i64) -> HttpCall {
    HttpCall { generation: Some(generation), ..call(method, path, body) }
}

#[test]
fn every_r1_call_names_its_route_and_its_conversation() {
    assert_eq!(list_sessions_call(), call("GET", "/sessions", None));
    assert_eq!(get_session_call("a b".into()), call("GET", "/sessions/a%20b", None));
    assert_eq!(sleep_session_call("s".into(), 2), at("POST", "/sessions/s/sleep", None, 2));
    assert_eq!(delete_session_call("s".into(), 1), at("DELETE", "/sessions/s", None, 1));
    assert_eq!(stop_task_call("s".into(), "tu".into(), 1), at("POST", "/sessions/s/tasks/tu/stop", None, 1));
    assert_eq!(background_task_call("s".into(), None, 1), at("POST", "/sessions/s/tasks/background", None, 1));
    assert_eq!(kill_shell_call("s".into(), "x".into(), 3), at("POST", "/sessions/s/shells/x/kill", None, 3));
    assert_eq!(list_agents_call(), call("GET", "/agents", None));
    assert_eq!(
        retire_agent_call("a".into(), Some(RetireMembers::Release), 2),
        call("DELETE", "/agents/a", Some(r#"{"members":"release","expectedGeneration":2}"#))
    );
    assert_eq!(reroll_avatar_call("a".into(), None), call("POST", "/agents/a/avatar", Some("{}")));
    assert_eq!(meta_call(), call("GET", "/meta", None));
    assert_eq!(list_profiles_call(), call("GET", "/profiles", None));
    assert_eq!(
        session_request_call("s 1".into(), "POST".into(), "/shells/x/kill".into(), true, Some(2)),
        at("POST", "/sessions/s%201/shells/x/kill", None, 2)
    );
    assert_eq!(new_conversation_call("s".into(), 2, None), call("POST", "/sessions/s/conversations", Some(r#"{"expectedGeneration":2}"#)));
    assert_eq!(conversations_call("s".into()), call("GET", "/sessions/s/conversations", None));
    assert_eq!(generation_header(), "x-workerdeck-generation");
}

#[test]
fn patches_cross_as_three_state_edits() {
    let patch = SessionPatch {
        title: Some(TextEdit::Clear),
        status_label: Some(StatusEdit::Set { text: "on it".into(), emoji: Some("x".into()) }),
    };
    assert_eq!(
        update_session_call("s".into(), patch, 1).body.as_deref(),
        Some(r#"{"title":null,"statusLabel":{"text":"on it","emoji":"x"}}"#)
    );
    let patch = AgentPatch { lead: Some(TextEdit::Set { value: "l".into() }), sharing: Some(Sharing::Private), ..Default::default() };
    assert_eq!(update_agent_call("a".into(), patch), call("PATCH", "/agents/a", Some(r#"{"lead":"l","sharing":"private"}"#)));
}

#[test]
fn a_permission_answer_parses_its_input_and_drops_a_non_object() {
    let allow = PermissionDecision::Allow { updated_input_json: Some(r#"{"answers":{"Q":"A"}}"#.into()) };
    assert_eq!(
        resolve_permission_call("s".into(), "r".into(), allow, 1).body.as_deref(),
        Some(r#"{"behavior":"allow","updatedInput":{"answers":{"Q":"A"}}}"#)
    );
    let junk = PermissionDecision::Allow { updated_input_json: Some("[1]".into()) };
    assert_eq!(resolve_permission_call("s".into(), "r".into(), junk, 1).body.as_deref(), Some(r#"{"behavior":"allow"}"#));
    let deny = PermissionDecision::Deny { message: Some("no".into()), interrupt: None };
    assert_eq!(resolve_permission_call("s".into(), "r".into(), deny, 1).body.as_deref(), Some(r#"{"behavior":"deny","message":"no"}"#));
}

#[test]
fn rest_error_classifies_the_answer() {
    assert_eq!(rest_error(200, Some("application/json".into()), "{}".into()), None);
    let parked = rest_error(409, Some("application/json".into()), r#"{"error":"parked"}"#.into());
    assert_eq!(parked, Some(RestError { status: 409, kind: RestErrorKind::Conflict, message: "parked".into() }));
    assert_eq!(rest_error(200, Some("text/html".into()), "".into()).map(|e| e.kind), Some(RestErrorKind::NotGateway));
    assert_eq!(rest_error(0, None, "".into()).map(|e| e.kind), Some(RestErrorKind::Transport));
}

#[test]
fn conversation_answers_read_into_sheet_rows() {
    let body = r#"{"conversation":2,"history":[{"n":1,"engine":"claude","cwd":"/w","startedAt":0,"endedAt":0,"title":"Old"}]}"#;
    let rows = wdffi::session_conversations(body.into(), None, 60_000.0, 0).unwrap();
    assert_eq!((rows[0].n, rows[0].current, rows[0].duration.as_deref()), (2, true, Some("1m")));
    assert_eq!(rows[0].title, "Untitled conversation");
    assert_eq!((rows[1].n, rows[1].title.as_str()), (1, "Old"));
    assert!(wdffi::session_conversations("{}".into(), None, 0.0, 0).is_none());
    let past =
        wdffi::past_agents(r#"{"retired":[{"id":"x","name":"Gone","retiredAt":0,"conversations":[{"n":1}]}]}"#.into(), 0.0, 0).unwrap();
    assert_eq!(past[0].detail, "Deleted Today 00:00 \u{00B7} 1 conversation");
    let stuck = r#"{"conversation":3,"history":[],"pendingPrompt":{"text":"go on","n":3,"state":"uncertain"}}"#;
    let notice = wdffi::conversation_notice(stuck.into()).unwrap();
    assert_eq!((notice.uncertain_prompt.as_deref(), notice.uncertain_n, notice.start_failed), (Some("go on"), Some(3), None));
    let failed = r#"{"conversation":3,"history":[],"startFailed":{"n":3,"error":"spawn ENOENT"}}"#;
    assert_eq!(wdffi::conversation_notice(failed.into()).unwrap().start_failed.as_deref(), Some("spawn ENOENT"));
    assert_eq!(wdffi::conversation_notice(r#"{"conversation":1,"history":[]}"#.into()), None);
    let refusal =
        r#"{"error":"e","code":"unconfirmed_input","conversation":2,"inputRevision":"r","pendingInput":1,"mayIncludePeer":false}"#;
    let confirm = wdffi::discard_confirmation(409, refusal.into()).unwrap();
    assert_eq!((confirm.conversation, confirm.input_revision.as_str(), confirm.confirm.as_str()), (2, "r", "Discard and start"));
    assert_eq!(
        wdffi::discard_and_cut_call("s".into(), 2, "r".into(), None).body.as_deref(),
        Some(r#"{"expectedGeneration":2,"inputRevision":"r"}"#)
    );
}
