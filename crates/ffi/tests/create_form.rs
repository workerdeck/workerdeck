use serde_json::{Value, json};
use wdffi::*;

const PROFILES: &str = r#"{"profiles":[
    {"name":"work","owner":"dan","engine":"claude","defaults":{"sharing":"private","permissionMode":"plan"}},
    {"name":"cx","engine":"codex","available":false}
]}"#;

fn body(call: &HttpCall) -> Value {
    serde_json::from_str(call.body.as_deref().unwrap()).unwrap()
}

fn list() -> std::sync::Arc<SessionList> {
    let list = SessionList::new(None, None);
    let lead = r#"{"id":"s2","status":"idle","cwd":"/w","createdAt":1,"lastSeq":1,"pendingPermissionCount":0,"owner":"tobias","agent":{"id":"a2","name":"Lead","leads":true}}"#;
    list.set_host("h1".into(), "mac".into(), true, format!(r#"{{"sessions":[{lead}]}}"#)).unwrap();
    list.set_meta("h1".into(), r#"{"agents":{"owner":"tobias","sharing":"shared","allowShared":true}}"#.into());
    list
}

#[test]
fn a_session_form_reads_profiles_and_builds_its_create() {
    let form = CreateForm::session("/repo".into(), None);
    assert!(form.state().needs_profiles);
    assert!(!form.set_profiles("<html>".into()));
    assert!(form.set_profiles(PROFILES.into()));
    let state = form.state();
    assert_eq!((state.title.as_str(), state.submit_label.as_str(), state.is_agent), ("New session", "Start", false));
    assert_eq!(state.profiles[1], FormProfile { name: "cx".into(), engine: "codex".into(), unavailable: true });
    assert!(state.shows_profile_picker && state.setting_sources && state.budgets && !state.needs_profiles);
    assert_eq!(form.fields().permission_mode, Mode::Plan);
    let mut fields = form.fields();
    fields.profile = Some("cx".into());
    let fields = form.update(fields);
    assert_eq!(fields.permission_mode, Mode::Default);
    assert!(!form.state().setting_sources);
    let call = form.call();
    assert_eq!((call.method.as_str(), call.path.as_str()), ("POST", "/sessions"));
    assert_eq!(body(&call)["profile"], json!("cx"));
    assert_eq!(form.mode_picker().rows.len(), 4);
    assert_eq!(form.resume_candidates_call().path, "/sdk-sessions?dir=%2Frepo&limit=20&profile=cx");
}

#[test]
fn an_agent_form_follows_the_list_and_feeds_it_profiles() {
    let list = list();
    let form = CreateForm::agent("/repo".into(), list.clone(), "h1".into(), None);
    let state = form.state();
    assert_eq!((state.title.as_str(), state.submit_label.as_str()), ("New agent", "Create"));
    assert_eq!(state.leads, [FormLead { agent_id: "a2".into(), name: "Lead".into() }]);
    assert_eq!(state.sharing, Sharing::Shared);
    form.set_profiles(PROFILES.into());
    assert_eq!(form.state().sharing, Sharing::Private);
    assert!(!list.agent_seed("h1".into(), None, Some("work".into())).unwrap().shared);
    let mut fields = form.fields();
    fields.lead = Some("a2".into());
    form.update(fields);
    let sent = body(&form.call());
    assert_eq!((sent["lead"].clone(), sent["crossOwner"].clone()), (json!("a2"), json!(true)));
    assert_eq!(form.call().path, "/agents");
}

#[test]
fn a_host_without_agents_gets_a_session_form() {
    let form = CreateForm::agent("/repo".into(), SessionList::new(None, None), "h1".into(), None);
    assert!(!form.state().is_agent);
}

#[test]
fn r2_calls_name_their_routes() {
    let adopt = create_agent_call(NewAgent { adopt: Some("s1".into()), ..Default::default() });
    assert_eq!((adopt.path.as_str(), adopt.body.as_deref()), ("/agents", Some(r#"{"adopt":"s1"}"#)));
    assert_eq!(list_sdk_sessions_call(None, Some(50), None, None).path, "/sdk-sessions?limit=50");
    assert_eq!(get_profile_call("a/b".into()).path, "/profiles/a%2Fb");
}
