use wdffi::{ListError, RowState, SessionList};

fn session(id: &str, status: &str, extra: &str) -> String {
    format!(r#"{{"id":"{id}","status":"{status}","cwd":"/work/app","createdAt":1000,"lastSeq":4{extra}}}"#)
}

fn idle(id: &str, extra: &str) -> String {
    session(id, "idle", &format!(r#","pendingPermissionCount":0{extra}"#))
}

fn body(sessions: &[String]) -> String {
    format!(r#"{{"sessions":[{}]}}"#, sessions.join(","))
}

#[test]
fn a_rollup_becomes_display_rows() {
    let list = SessionList::new(None, None);
    let sessions = [
        session("aaaaaaaa1", "running", r#","pendingPermissionCount":0,"title":"Build","proseCount":3,"lastActivityAt":5000"#),
        session("bbbbbbbb2", "idle", r#","pendingPermissionCount":1"#),
    ];
    list.set_host("h1".into(), "mac".into(), true, body(&sessions)).unwrap();
    let rows: Vec<_> = list.groups().into_iter().flat_map(|g| g.rows).collect();
    let build = rows.iter().find(|r| r.session_id == "aaaaaaaa1").unwrap();
    assert_eq!(build.title, "Build");
    assert_eq!(build.state, RowState::Working);
    assert_eq!(build.engine, "claude");
    let waiting = rows.iter().find(|r| r.session_id == "bbbbbbbb2").unwrap();
    assert_eq!(waiting.title, "bbbbbbbb");
    assert_eq!(waiting.state, RowState::Attention);
    assert!(list.busy());
}

#[test]
fn a_mark_counts_prose_after_it_as_unseen() {
    let list = SessionList::new(None, None);
    list.set_host("h1".into(), "mac".into(), true, body(&[idle("s1", r#","proseCount":2"#)])).unwrap();
    assert_eq!(list.unseen_total(), 0);
    assert!(list.mark_seen("h1".into(), "s1".into(), 10_000.0));
    list.set_host("h1".into(), "mac".into(), true, body(&[idle("s1", r#","proseCount":5"#)])).unwrap();
    assert_eq!(list.unseen_total(), 3);
    let restored = SessionList::new(Some(list.config_json()), Some(list.marks_json()));
    restored.set_host("h1".into(), "mac".into(), true, body(&[idle("s1", r#","proseCount":5"#)])).unwrap();
    assert_eq!(restored.unseen_total(), 3);
}

#[test]
fn html_from_a_wrong_key_keeps_the_last_reading() {
    let list = SessionList::new(None, None);
    list.set_host("h1".into(), "mac".into(), true, body(&[idle("s1", "")])).unwrap();
    let err = list.set_host("h1".into(), "mac".into(), true, "<!doctype html>".into());
    assert!(matches!(err, Err(ListError::NotASessionList)));
    assert_eq!(list.groups().iter().map(|g| g.rows.len()).sum::<usize>(), 1);
}

#[test]
fn a_toggled_group_stays_collapsed_across_a_restore() {
    let list = SessionList::new(None, None);
    list.set_host("h1".into(), "mac".into(), true, body(&[idle("s1", "")])).unwrap();
    let key = list.groups()[0].key.clone();
    list.toggle_group(key.clone());
    let restored = SessionList::new(Some(list.config_json()), None);
    restored.set_host("h1".into(), "mac".into(), true, body(&[idle("s1", "")])).unwrap();
    assert!(restored.groups().iter().find(|g| g.key == key).unwrap().collapsed);
}

#[test]
fn a_session_from_an_older_record_still_lists() {
    let list = SessionList::new(None, None);
    let stale = idle("old", r#","capabilities":{"interactiveApprovals":true}"#);
    let skipped = list.set_host("h1".into(), "mac".into(), true, body(&[stale, r#"{"id":"broken"}"#.into(), idle("s2", "")])).unwrap();
    assert_eq!(skipped, 1);
    let ids: Vec<_> = list.groups().into_iter().flat_map(|g| g.rows).map(|r| r.session_id).collect();
    assert_eq!(ids.len(), 2, "{ids:?}");
    assert!(ids.contains(&"old".to_owned()));
}

#[test]
fn values_from_a_newer_gateway_read_as_unknown() {
    let list = SessionList::new(None, None);
    let newer = session(
        "new",
        "hibernating",
        r#","pendingPermissionCount":0,"engine":"gemini","permissionMode":"yolo","capabilities":{"resume":true,"toolFilters":"some"},"subagents":[{"toolUseId":"t","status":"paused","startedAt":1,"toolCount":0}]"#,
    );
    list.set_host("h1".into(), "mac".into(), true, body(&[newer])).unwrap();
    let rows: Vec<_> = list.groups().into_iter().flat_map(|g| g.rows).collect();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].engine, "unknown");
}
