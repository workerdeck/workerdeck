use wdffi::*;

fn json(body: &str) -> HttpAnswer {
    HttpAnswer { status: 200, content_type: Some("application/json".into()), body: body.into() }
}

fn refused(status: u16) -> HttpAnswer {
    HttpAnswer { status, content_type: Some("application/json".into()), body: r#"{"error":"nope"}"#.into() }
}

#[test]
fn r3_calls_name_their_routes() {
    let get = |path: &str| HttpCall { method: "GET".into(), path: path.into(), body: None };
    assert_eq!(upload_attachment_call("s".into(), "a.png".into()).path, "/sessions/s/attachments?name=a.png");
    assert_eq!(attachment_call("s".into(), "at".into()), get("/sessions/s/attachments/at"));
    assert_eq!(mcp_action_call("s".into(), "x".into(), McpAction::Enable).body.as_deref(), Some(r#"{"action":"enable"}"#));
    assert_eq!(list_shells_call("s".into()), get("/sessions/s/shells"));
    assert_eq!(get_shell_call("s".into(), "x".into()), get("/sessions/s/shells/x"));
    assert_eq!(
        shell_output_call("s".into(), "x".into(), ShellOutputView::Text, Some(10)),
        get("/sessions/s/shells/x/output?view=text&tail=10")
    );
    assert_eq!(find_host_files_call("/r".into(), "q".into(), Some(8)), get("/fs/find?path=%2Fr&q=q&limit=8"));
    assert_eq!(produced_file_call("s".into(), "f".into()), get("/sessions/s/produced/f"));
    assert_eq!(project_icon_call("s".into()), get("/sessions/s/project/icon"));
    assert_eq!(agent_avatar_call("a".into(), true), get("/agents/a/avatar-busy.png"));
    assert_eq!(tool_result_call("s".into(), 3, "t".into(), true), get("/sessions/s/events/3/result?toolUseId=t&imageRefs=1"));
    assert_eq!(tool_result_image_call("s".into(), 3, "t".into(), 1), get("/sessions/s/events/3/result?toolUseId=t&part=1"));
}

#[test]
fn bodies_decode_or_say_none() {
    assert_eq!(uploaded_attachment_id(r#"{"attachment":{"id":"at1","name":"a.png"}}"#.into()).as_deref(), Some("at1"));
    assert_eq!(
        host_file_matches(r#"{"base":"/r","matches":[{"path":"/r/a","relative":"a"}],"truncated":false}"#.into()).map(|m| m.len()),
        Some(1)
    );
    assert_eq!(uploaded_attachment_id("<html>".into()), None);
}

#[test]
fn host_files_walk_roots_then_the_cwd() {
    let files = HostFiles::session("/r".into());
    let roots = files.load_call().unwrap();
    assert_eq!(roots.path, "/fs/roots");
    let next = files.roots_answered(json(r#"{"roots":[{"path":"/r","name":"r"}],"canWrite":false}"#)).unwrap();
    files.cwd_answered(json(r#"{"path":"/r","entries":[{"name":"d","path":"/r/d","type":"dir"}]}"#));
    assert_eq!(next.path, "/fs/list?path=%2Fr");
    assert_eq!(files.availability(), HostFilesAvailability::Ready { can_write: false });
    assert_eq!(files.listing("/r".into()).unwrap().entries[0].kind, HostEntryKind::Dir);
    let outside = HostFiles::session("/x".into());
    outside.load_call();
    outside.roots_answered(json(r#"{"roots":[],"canWrite":true}"#));
    outside.cwd_answered(refused(404));
    assert_eq!(outside.availability(), HostFilesAvailability::OutsideRoots);
}

#[test]
fn the_editor_saves_and_reports_a_conflict() {
    let editor = HostFileEditor::new("/r/a".into());
    editor.load_call();
    editor.read_answered(json(r#"{"path":"/r/a","content":"hi","encoding":"utf8","bytes":2,"hash":"h","modifiedAt":1}"#));
    editor.set_draft("ho".into());
    assert!(editor.state().dirty);
    assert!(editor.save_call().unwrap().body.unwrap().contains(r#""expectedHash":"h""#));
    editor.save_answered(refused(409));
    let state = editor.state();
    assert!(state.conflict && !state.saving);
    assert_eq!(state.error.as_deref(), Some("nope"));
}

#[test]
fn mcp_servers_draw_from_the_last_answer() {
    let mcp = McpServers::new("s".into(), false);
    assert!(mcp.loading());
    assert_eq!(mcp.refresh_call().path, "/sessions/s/mcp");
    mcp.answered(json(r#"{"servers":[{"name":"a","status":"connected","scope":"user","tools":[{"name":"t"}]}]}"#));
    assert_eq!(mcp.sections()[0].title, "User MCPs");
    assert!(mcp.server("a".into()).unwrap().actions.is_empty());
    assert_eq!(mcp.tool("a".into(), "t".into()).unwrap().facts[1].value, "mcp__a__t");
}

#[test]
fn skills_and_the_session_menu() {
    let skill = Skill {
        name: "s".into(),
        description: None,
        short_description: None,
        display_name: Some("S".into()),
        default_prompt: None,
        scope: Some("repo".into()),
        enabled: true,
    };
    let sections = skill_sections(vec![skill]);
    assert_eq!((sections[0].title.as_str(), sections[0].skills[0].title.as_str()), ("This project", "S"));
    assert!(!session_extras_unknown().files);
    let extras = session_extras(
        r#"{"session":{"id":"s","status":"idle","cwd":"/w","createdAt":1,"lastSeq":0,"pendingPermissionCount":0,"engine":"codex"}}"#.into(),
    )
    .unwrap();
    assert!(extras.files && extras.skills && !extras.mcp_can_manage);
}
