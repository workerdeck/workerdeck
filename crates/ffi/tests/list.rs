use wdffi::{ListError, ListFacet, ListGroupBy, ListSortBy, RowState, SessionList, StepKind, StepShow};

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
    let rows: Vec<_> = list.groups(0.0).into_iter().flat_map(|g| g.rows).collect();
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
    assert_eq!(list.groups(0.0).iter().map(|g| g.rows.len()).sum::<usize>(), 1);
}

#[test]
fn a_toggled_group_stays_collapsed_across_a_restore() {
    let list = SessionList::new(None, None);
    list.set_host("h1".into(), "mac".into(), true, body(&[idle("s1", "")])).unwrap();
    let key = list.groups(0.0)[0].key.clone();
    list.toggle_group(key.clone());
    let restored = SessionList::new(Some(list.config_json()), None);
    restored.set_host("h1".into(), "mac".into(), true, body(&[idle("s1", "")])).unwrap();
    assert!(restored.groups(0.0).iter().find(|g| g.key == key).unwrap().collapsed);
}

#[test]
fn a_session_from_an_older_record_still_lists() {
    let list = SessionList::new(None, None);
    let stale = idle("old", r#","capabilities":{"interactiveApprovals":true}"#);
    let skipped = list.set_host("h1".into(), "mac".into(), true, body(&[stale, r#"{"id":"broken"}"#.into(), idle("s2", "")])).unwrap();
    assert_eq!(skipped, 1);
    let ids: Vec<_> = list.groups(0.0).into_iter().flat_map(|g| g.rows).map(|r| r.session_id).collect();
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
    let rows: Vec<_> = list.groups(0.0).into_iter().flat_map(|g| g.rows).collect();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].engine, "unknown");
}

#[test]
fn auto_shows_busy_and_selected_members_and_trays_the_rest() {
    let list = SessionList::new(None, None);
    let agent = |id: &str, lead: &str| format!(r#","agent":{{"id":"{id}","name":"{id}"{lead}}}"#);
    let member = |id: &str, order: u32| agent(id, &format!(r#","lead":"L","order":{order}"#));
    let sessions = [
        idle("lead", &agent("L", "")),
        session("busy", "running", &format!(r#","pendingPermissionCount":0{}"#, member("M1", 1))),
        idle("quiet1", &format!(r#","lastActivityAt":1000{}"#, member("M2", 2))),
        idle("quiet2", &format!(r#","lastActivityAt":1000{}"#, member("M3", 3))),
        idle("recent", &format!(r#","lastActivityAt":98000{}"#, member("M4", 4))),
    ];
    list.set_host("h1".into(), "mac".into(), true, body(&sessions)).unwrap();
    let rows = |list: &SessionList| list.groups(100_000.0).into_iter().flat_map(|g| g.rows).collect::<Vec<_>>();
    let drawn = rows(&list);
    let ids: Vec<_> = drawn.iter().map(|r| r.session_id.as_str()).collect();
    assert!(ids.contains(&"busy") && ids.contains(&"recent") && !ids.contains(&"quiet1"), "{ids:?}");
    let lead = drawn.iter().find(|r| r.session_id == "lead").unwrap();
    assert_eq!(lead.tray.iter().map(|t| t.session_id.as_str()).collect::<Vec<_>>(), ["quiet1", "quiet2"]);
    assert!(!lead.team_expanded);
    assert_eq!(list.linger_ends(), Some(103_000.0));

    list.select("h1".into(), "quiet2".into());
    let ids: Vec<_> = rows(&list).into_iter().map(|r| r.session_id).collect();
    assert!(ids.contains(&"quiet2".to_owned()));

    list.toggle_team("h1".into(), "lead".into());
    let drawn = rows(&list);
    assert!(drawn.iter().any(|r| r.session_id == "quiet1"));
    assert!(drawn.iter().find(|r| r.session_id == "lead").unwrap().team_expanded);
}

#[test]
fn a_search_reports_the_subset_and_clearing_shows_all() {
    let list = SessionList::new(None, None);
    let sessions = [idle("s1", r#","title":"Alpha""#), idle("s2", r#","title":"Beta""#)];
    list.set_host("h1".into(), "mac".into(), true, body(&sessions)).unwrap();
    assert!(list.subset().is_none());
    list.set_search("alpha".into());
    let subset = list.subset().unwrap();
    assert_eq!((subset.shown, subset.total), (1, 2));
    assert_eq!(subset.causes, ["search"]);
    list.clear_filters();
    assert!(list.subset().is_none());
    assert_eq!(list.adapters(), ["claude"]);
    assert_eq!(list.projects().len(), 1);
}

#[test]
fn a_config_set_whole_is_normalized_and_kept() {
    let list = SessionList::new(None, None);
    list.set_config_json(r#"{"groupBy":"gateway","adapters":["codex"],"search":"x"}"#.into());
    let stored: serde_json::Value = serde_json::from_str(&list.config_json()).unwrap();
    assert_eq!(stored["groupBy"], "project");
    assert_eq!(stored["adapters"], serde_json::json!(["codex"]));
    list.set_config_json("not json".into());
    let stored: serde_json::Value = serde_json::from_str(&list.config_json()).unwrap();
    assert_eq!(stored["search"], "");
}

#[test]
fn a_lead_pulled_in_by_a_filter_is_a_context_row() {
    let list = SessionList::new(None, None);
    let sessions = [
        idle("lead", r#","title":"Lead","agent":{"id":"L","name":"Lead","leads":true}"#),
        session("m", "running", r#","pendingPermissionCount":0,"title":"Worker","agent":{"id":"M","name":"Worker","lead":"L"}"#),
    ];
    list.set_host("h1".into(), "mac".into(), true, body(&sessions)).unwrap();
    list.set_search("worker".into());
    let rows: Vec<_> = list.groups(0.0).into_iter().flat_map(|g| g.rows).collect();
    let lead = rows.iter().find(|r| r.session_id == "lead").unwrap();
    assert!(lead.context);
    assert_eq!(lead.team_state, Some(RowState::Working));
    assert_eq!(list.team_members("h1".into(), "lead".into()), ["M"]);
}

#[test]
fn a_member_whose_lead_is_behind_a_relay_draws_under_it() {
    let list = SessionList::new(None, None);
    list.set_host("h1".into(), "mac".into(), true, body(&[idle("lead", r#","agent":{"id":"L","name":"Lead","leads":true}"#)])).unwrap();
    let member = idle("m", r#","agent":{"id":"M","name":"M","lead":"mac/L","leadGateway":"mac"}"#);
    list.set_host("h2".into(), "box".into(), false, body(&[member])).unwrap();
    let depth = |list: &SessionList| list.groups(0.0).into_iter().flat_map(|g| g.rows).find(|r| r.session_id == "m").map(|r| r.depth);
    list.toggle_team("h1".into(), "lead".into());
    assert_eq!(depth(&list), Some(0));
    list.set_relay("h1".into(), Some("mac".into()));
    assert_eq!(depth(&list), Some(1));
}

#[test]
fn a_session_screen_mark_keeps_rows_for_the_catch_up_seam() {
    let list = SessionList::new(None, None);
    assert!(list.since("h1".into(), "s1".into()).is_none());
    assert!(list.mark("h1".into(), "s1".into(), Some(40), Some(40), Some(5), Some(2), 1_000.0));
    let mark = list.since("h1".into(), "s1".into()).unwrap();
    assert_eq!((mark.item_count, mark.seen_at), (40, 1_000.0));
    assert!(!list.mark("h1".into(), "s1".into(), Some(30), Some(30), Some(5), Some(2), 2_000.0));
}

#[test]
fn team_leads_name_the_agents_a_row_could_join() {
    let list = SessionList::new(None, None);
    let sessions = [idle("plain", ""), idle("lead", r#","agent":{"id":"L","name":"Lead","leads":true}"#)];
    list.set_host("h1".into(), "mac".into(), true, body(&sessions)).unwrap();
    let leads = list.team_leads("h1".into(), "plain".into());
    assert_eq!(leads.len(), 1);
    assert_eq!((leads[0].session_id.as_str(), leads[0].agent_id.as_str(), leads[0].name.as_str()), ("lead", "L", "Lead"));
}

fn steps_of(list: &SessionList) -> usize {
    list.groups(0.0).into_iter().flat_map(|g| g.rows).map(|r| r.steps.len()).sum()
}

#[test]
fn the_filter_menu_drives_the_list_directly() {
    let agents = r#","subagents":[{"toolUseId":"a","agentType":"Explore","description":"d","status":"done","startedAt":0,"toolCount":1},{"toolUseId":"b","agentType":"Explore","description":"d","status":"running","startedAt":0,"toolCount":1}]"#;
    let list = SessionList::new(None, None);
    list.set_host("h1".into(), "mac".into(), true, body(&[session("s1", "running", &format!(r#","pendingPermissionCount":0{agents}"#))]))
        .unwrap();
    let start = list.filter();
    assert_eq!((start.agents, start.engaged), (StepShow::Active, false));
    assert_eq!(steps_of(&list), 1);
    list.set_step_display(StepKind::Agent, StepShow::All);
    assert_eq!(steps_of(&list), 2);
    list.set_step_display(StepKind::Agent, StepShow::Hide);
    assert_eq!(steps_of(&list), 0);
    assert!(list.filter().engaged);
    assert!(list.config_json().contains(r#""subagents":"none""#));
    list.toggle_state(RowState::Idle);
    assert!(list.groups(0.0).iter().all(|g| g.rows.is_empty()));
    list.toggle_state(RowState::Idle);
    list.toggle_facet(ListFacet::Adapter, "codex".into());
    assert_eq!(list.filter().adapters, ["codex"]);
    list.toggle_facet(ListFacet::Adapter, "codex".into());
    list.set_group_by(ListGroupBy::None);
    list.set_sort_by(ListSortBy::Name);
    let filter = list.filter();
    assert_eq!((filter.group_by, filter.sort_by, filter.adapters.len()), (ListGroupBy::None, ListSortBy::Name, 0));
}

#[test]
fn a_new_agent_seed_waits_for_the_meta_and_lists_leads_first() {
    let list = SessionList::new(None, None);
    let solo = idle("s1", r#","agent":{"id":"a1","name":"Solo"}"#);
    let lead = idle("s2", r#","agent":{"id":"a2","name":"Lead","leads":true}"#);
    let member = idle("s3", r#","agent":{"id":"a3","name":"Member","lead":"a2"}"#);
    list.set_host("h1".into(), "mac".into(), true, body(&[solo, lead, member])).unwrap();
    assert!(list.agent_seed("h1".into(), None).is_none());
    assert!(!list.set_meta("h1".into(), "<html>".into()));
    assert!(
        list.set_meta("h1".into(), r#"{"protocolVersion":1,"agents":{"owner":"tobias","sharing":"shared","allowShared":true}}"#.into())
    );
    let seed = list.agent_seed("h1".into(), Some("s1".into())).unwrap();
    let names: Vec<_> = seed.leads.iter().map(|l| l.name.as_str()).collect();
    assert_eq!(names, ["Lead", "Solo"]);
    assert_eq!((seed.lead.as_deref(), seed.shared, seed.allow_shared, seed.owner.as_deref()), (Some("a1"), true, true, Some("tobias")));
    list.set_meta("h1".into(), r#"{"agents":{"sharing":"shared","allowShared":false}}"#.into());
    assert!(!list.agent_seed("h1".into(), None).unwrap().shared);
    list.remove_host("h1".into());
    assert!(list.agent_seed("h1".into(), None).is_none());
}
