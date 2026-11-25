use wdffi::{DragFrame, FleetRetry, ListDrop, ListError, ListFacet, ListGroupBy, ListSortBy, ReasonChip, RowState, SessionList, StepFold};

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
fn an_agent_row_is_named_by_the_agent_not_its_session_title() {
    let list = SessionList::new(None, None);
    let lead = idle("s1", r#","title":"ok great, let's wrap up","agent":{"id":"L","name":"WD-Lead","leads":true}"#);
    list.set_host("h1".into(), "mac".into(), true, body(&[lead])).unwrap();
    let row = list.groups(0.0).into_iter().flat_map(|g| g.rows).next().unwrap();
    assert_eq!(row.agent.as_deref(), Some("WD-Lead"));
}

#[test]
fn a_row_names_its_model_by_the_gateways_name_then_the_id() {
    let list = SessionList::new(None, None);
    let named = idle("s1", r#","model":"claude-opus-5-5","modelName":"Opus 5.5 (1M)""#);
    let bare = idle("s2", r#","model":"claude-sonnet-5""#);
    list.set_host("h1".into(), "mac".into(), true, body(&[named, bare])).unwrap();
    let rows: Vec<_> = list.groups(0.0).into_iter().flat_map(|g| g.rows).collect();
    let label = |id: &str| rows.iter().find(|r| r.session_id == id).and_then(|r| r.model_label.clone());
    assert_eq!(label("s1").as_deref(), Some("Opus 5.5 (1M)"));
    assert_eq!(label("s2").as_deref(), Some("Sonnet 5"));
}

#[test]
fn a_row_carries_its_model_badge_and_card_status() {
    let list = SessionList::new(None, None);
    let labelled =
        idle("s1", r#","model":"gpt-6.1-sol","modelName":"GPT-6.1 Sol","statusLabel":{"text":"Porting","emoji":"🦀","setAt":1}"#);
    let titled = idle("s2", r#","model":"claude-opus-5-5","title":"  Fix the list  ""#);
    let starting = session("s3", "starting", r#","pendingPermissionCount":0"#);
    list.set_host("h1".into(), "mac".into(), true, body(&[labelled, titled, starting])).unwrap();
    let rows: Vec<_> = list.groups(0.0).into_iter().flat_map(|g| g.rows).collect();
    let row = |id: &str| rows.iter().find(|r| r.session_id == id).unwrap();
    let badge = row("s1").model_badge.clone().unwrap();
    assert_eq!((badge.letter.as_str(), badge.version.as_deref()), ("S", Some("6.1")));
    assert_eq!((row("s1").card_status.as_str(), row("s1").card_status_is_label), ("Porting", true));
    assert_eq!(row("s2").model_badge.as_ref().map(|b| b.letter.as_str()), Some("O"));
    assert_eq!((row("s2").card_status.as_str(), row("s2").card_status_is_label), ("Fix the list", false));
    assert_eq!(row("s3").card_status, "Starting…");
    assert!(row("s3").model_badge.is_none());
}

#[test]
fn a_mark_counts_a_members_prose_after_it_as_unseen() {
    let list = SessionList::new(None, None);
    let member = |n: u32| idle("s1", &format!(r#","proseCount":{n},"agent":{{"id":"a1","name":"Docs","lead":"Lead"}}"#));
    let solo = |n: u32| idle("s2", &format!(r#","proseCount":{n}"#));
    list.set_host("h1".into(), "mac".into(), true, body(&[member(2), solo(2)])).unwrap();
    assert_eq!(list.unseen_total(), 0);
    assert!(list.mark_seen("h1".into(), "s1".into(), 10_000.0));
    assert!(list.mark_seen("h1".into(), "s2".into(), 10_000.0));
    list.set_host("h1".into(), "mac".into(), true, body(&[member(5), solo(9)])).unwrap();
    assert_eq!(list.unseen_total(), 3);
    let restored = SessionList::new(Some(list.config_json()), Some(list.marks_json()));
    restored.set_host("h1".into(), "mac".into(), true, body(&[member(5), solo(9)])).unwrap();
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
fn a_session_of_another_shape_is_skipped_and_counted() {
    let list = SessionList::new(None, None);
    let partial = idle("old", r#","capabilities":{"interactiveApprovals":true}"#);
    let skipped = list.set_host("h1".into(), "mac".into(), true, body(&[partial, r#"{"id":"broken"}"#.into(), idle("s2", "")])).unwrap();
    assert_eq!(skipped, 2);
    let ids: Vec<_> = list.groups(0.0).into_iter().flat_map(|g| g.rows).map(|r| r.session_id).collect();
    assert_eq!(ids, ["s2"]);
}

#[test]
fn values_from_a_newer_gateway_read_as_unknown() {
    let list = SessionList::new(None, None);
    let newer = session(
        "new",
        "hibernating",
        r#","pendingPermissionCount":0,"engine":"gemini","permissionMode":"yolo","subagents":[{"toolUseId":"t","status":"paused","startedAt":1,"toolCount":0}]"#,
    );
    list.set_host("h1".into(), "mac".into(), true, body(&[newer])).unwrap();
    let rows: Vec<_> = list.groups(0.0).into_iter().flat_map(|g| g.rows).collect();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].engine, "unknown");
}

#[test]
fn auto_shows_members_that_need_a_person_and_the_selected_one_and_trays_the_rest() {
    let list = SessionList::new(None, None);
    let agent = |id: &str, lead: &str| format!(r#","agent":{{"id":"{id}","name":"{id}"{lead}}}"#);
    let member = |id: &str, order: u32| agent(id, &format!(r#","lead":"L","order":{order}"#));
    let sessions = [
        idle("lead", &agent("L", "")),
        session("busy", "running", &format!(r#","pendingPermissionCount":0{}"#, member("M1", 1))),
        idle("quiet", &member("M2", 2)),
        session(
            "failed",
            "closed",
            &format!(r#","pendingPermissionCount":0,"failure":{{"message":"engine exited","at":1}}{}"#, member("M3", 3)),
        ),
        idle("blocked", &format!(r#","statusLabel":{{"text":"Need the key","waitingOn":"human","setAt":1}}{}"#, member("M4", 4))),
    ];
    list.set_host("h1".into(), "mac".into(), true, body(&sessions)).unwrap();
    let rows = |list: &SessionList| list.groups(0.0).into_iter().flat_map(|g| g.rows).collect::<Vec<_>>();
    let drawn = rows(&list);
    let ids: Vec<_> = drawn.iter().map(|r| r.session_id.as_str()).collect();
    assert_eq!(ids, ["lead", "failed", "blocked"]);
    let lead = drawn.iter().find(|r| r.session_id == "lead").unwrap();
    assert_eq!(lead.tray.iter().map(|t| t.session_id.as_str()).collect::<Vec<_>>(), ["busy", "quiet"]);
    assert!(!lead.team_expanded && !lead.needs_you);
    assert_eq!(lead.team_attention, 2);
    assert_eq!(lead.team_summary.as_deref(), Some("2 need you \u{00B7} 1 working \u{00B7} 1 idle"));
    let failed = drawn.iter().find(|r| r.session_id == "failed").unwrap();
    assert!(failed.needs_you);
    assert_eq!(failed.reasons, [ReasonChip { label: "Failed".into(), title: "engine exited".into(), danger: true }]);
    let blocked = drawn.iter().find(|r| r.session_id == "blocked").unwrap();
    assert_eq!(blocked.reasons[0].title, "Waiting on you: Need the key");

    list.select("h1".into(), "quiet".into());
    let drawn = rows(&list);
    assert!(drawn.iter().any(|r| r.session_id == "quiet" && r.selected));
    assert!(drawn.iter().filter(|r| r.selected).count() == 1);

    list.toggle_team("h1".into(), "lead".into());
    let drawn = rows(&list);
    assert!(drawn.iter().any(|r| r.session_id == "busy"));
    assert!(drawn.iter().find(|r| r.session_id == "lead").unwrap().team_expanded);
}

#[test]
fn a_leads_fleet_lists_members_that_need_a_person_whatever_the_filters() {
    let list = SessionList::new(None, None);
    let member = |id: &str, order: u32| format!(r#","agent":{{"id":"{id}","name":"{id}","lead":"L","order":{order}}}"#);
    let sessions = [
        idle("lead", r#","agent":{"id":"L","name":"Lead","leads":true}"#),
        session("busy", "running", &format!(r#","pendingPermissionCount":0{}"#, member("M1", 1))),
        session(
            "unstarted",
            "closed",
            &format!(
                r#","pendingPermissionCount":0,"failure":{{"message":"could not start","at":1,"conversation":3,"start":true}}{}"#,
                member("M2", 2)
            ),
        ),
        idle("asking", &format!(r#","pendingPermissionCount":2{}"#, member("M3", 3))),
    ];
    list.set_host("h1".into(), "mac".into(), true, body(&sessions)).unwrap();
    list.set_search("nothing matches this".into());
    let fleet = list.fleet("h1".into(), "lead".into());
    assert_eq!(fleet.iter().map(|m| m.session_id.as_str()).collect::<Vec<_>>(), ["unstarted", "asking"]);
    assert_eq!(
        (fleet[0].name.as_str(), fleet[0].text.as_str(), fleet[0].retry.clone()),
        ("M2", "could not start", Some(FleetRetry { n: 3, at: 1 }))
    );
    assert!(fleet[0].reasons[0].danger && fleet[0].face.is_some());
    assert_eq!((fleet[1].text.as_str(), fleet[1].retry.clone()), ("2 approvals waiting", None));
    assert!(list.fleet("h1".into(), "busy".into()).is_empty());
    assert!(list.may_lead("h1".into(), "lead".into()) && list.may_lead("h1".into(), "unread".into()));
    assert!(!list.may_lead("h1".into(), "busy".into()));
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
    assert_eq!(stored["groupBy"], "state");
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
    assert!(list.mark("h1".into(), "s1".into(), Some(40), Some(1), Some(5), Some(2), 1_000.0));
    let mark = list.since("h1".into(), "s1".into()).unwrap();
    assert_eq!((mark.item_count, mark.conversation, mark.seen_at), (40, Some(1), 1_000.0));
    assert!(!list.mark("h1".into(), "s1".into(), Some(30), Some(1), Some(5), Some(2), 2_000.0));
}

#[test]
fn a_mark_after_a_cut_keeps_the_new_conversations_count() {
    let list = SessionList::new(None, None);
    assert!(list.mark("h1".into(), "s1".into(), Some(200), Some(1), Some(400), Some(100), 1_000.0));
    assert!(list.mark("h1".into(), "s1".into(), Some(5), Some(2), Some(410), Some(102), 2_000.0));
    let late = format!(r#"{{"session":{}}}"#, idle("s1", r#","conversation":2,"activityCount":411,"proseCount":103"#));
    assert!(!list.mark_session("h1".into(), "s1".into(), Some(200), Some(1), late, 3_000.0));
    let mark = list.since("h1".into(), "s1".into()).unwrap();
    assert_eq!((mark.item_count, mark.conversation), (5, Some(2)));
}

#[test]
fn leaving_after_an_unseen_cut_marks_none_of_the_next_conversations_prose() {
    let list = SessionList::new(None, None);
    let before = format!(r#"{{"sessions":[{}]}}"#, idle("s1", r#","conversation":1,"proseCount":10"#));
    list.set_host("h1".into(), "mac".into(), true, before).unwrap();
    assert!(list.mark("h1".into(), "s1".into(), Some(20), Some(1), Some(30), Some(10), 1_000.0));
    let after = format!(r#"{{"session":{}}}"#, idle("s1", r#","conversation":2,"activityCount":50,"proseCount":14"#));
    list.mark_session("h1".into(), "s1".into(), Some(22), Some(1), after, 2_000.0);
    let mark: serde_json::Value = serde_json::from_str(&list.marks_json()).unwrap();
    assert_eq!((mark["h1:s1"]["prose"].as_f64(), mark["h1:s1"]["activity"].as_f64()), (Some(10.0), Some(30.0)));
    assert_eq!(list.since("h1".into(), "s1".into()).unwrap().item_count, 22);
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
    list.groups(0.0).into_iter().flat_map(|g| g.rows).flat_map(|r| r.chips).map(|c| c.count as usize).sum()
}

#[test]
fn a_chip_unfolds_its_kind_under_the_card() {
    let agents = r#","pendingPermissionCount":0,"subagents":[{"toolUseId":"a","agentType":"Explore","description":"d","status":"running","startedAt":0,"toolCount":1}]"#;
    let list = SessionList::new(None, None);
    list.set_host("h1".into(), "mac".into(), true, body(&[session("s1", "running", agents)])).unwrap();
    let row = |list: &SessionList| list.groups(0.0).into_iter().flat_map(|g| g.rows).next().unwrap();
    let folded = row(&list);
    assert_eq!((folded.steps.len(), folded.chips.len()), (0, 1));
    assert_eq!((folded.chips[0].kind, folded.chips[0].running, folded.chips[0].open), (StepFold::Agent, 1, false));
    list.toggle_steps("h1".into(), "s1".into(), StepFold::Agent);
    let open = row(&list);
    assert_eq!((open.steps.len(), open.chips[0].open), (1, true));
    assert!(list.config_json().contains(r#""expandedSteps":{"h1:s1":["agent"]}"#));
}

#[test]
fn headings_reorder_by_drop_and_reset() {
    let list = SessionList::new(None, None);
    list.set_host("h1".into(), "mac".into(), true, body(&[session("w", "running", r#","pendingPermissionCount":0"#), idle("i", "")]))
        .unwrap();
    let keys = |list: &SessionList| list.groups(0.0).into_iter().map(|g| g.key).collect::<Vec<_>>();
    let before = keys(&list);
    assert_eq!(before.len(), 2);
    assert!(list.groups(0.0).iter().all(|g| g.reorderable && g.caps));
    list.move_group(before[0].clone(), before[1].clone());
    assert_eq!(keys(&list), vec![before[1].clone(), before[0].clone()]);
    assert!(list.group_order_customized());
    list.reset_group_order();
    assert_eq!(keys(&list), before);
}

#[test]
fn the_filter_menu_drives_the_list_directly() {
    let agents = r#","subagents":[{"toolUseId":"a","agentType":"Explore","description":"d","status":"done","startedAt":0,"toolCount":1},{"toolUseId":"b","agentType":"Explore","description":"d","status":"running","startedAt":0,"toolCount":1}]"#;
    let stored = r#"{"groupBy":"state","subagents":"none","shells":"all","tasks":"none"}"#;
    let list = SessionList::new(Some(stored.into()), None);
    list.set_host("h1".into(), "mac".into(), true, body(&[session("s1", "running", &format!(r#","pendingPermissionCount":0{agents}"#))]))
        .unwrap();
    assert!(!list.filter().engaged);
    assert_eq!(steps_of(&list), 1);
    assert!(!list.config_json().contains("subagents"));
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
fn a_new_agent_seed_waits_for_the_meta_lists_leads_first_and_follows_the_profile() {
    let list = SessionList::new(None, None);
    let solo = idle("s1", r#","agent":{"id":"a1","name":"Solo"}"#);
    let lead = idle("s2", r#","agent":{"id":"a2","name":"Lead","leads":true}"#);
    let member = idle("s3", r#","agent":{"id":"a3","name":"Member","lead":"a2"}"#);
    list.set_host("h1".into(), "mac".into(), true, body(&[solo, lead, member])).unwrap();
    assert!(list.agent_seed("h1".into(), None, None).is_none());
    assert!(!list.set_meta("h1".into(), "<html>".into()));
    assert!(
        list.set_meta("h1".into(), r#"{"protocolVersion":2,"agents":{"owner":"tobias","sharing":"shared","allowShared":true}}"#.into())
    );
    let seed = list.agent_seed("h1".into(), Some("s1".into()), None).unwrap();
    let names: Vec<_> = seed.leads.iter().map(|l| l.name.as_str()).collect();
    assert_eq!(names, ["Lead", "Solo"]);
    assert_eq!((seed.lead.as_deref(), seed.shared, seed.allow_shared, seed.owner.as_deref()), (Some("a1"), true, true, Some("tobias")));
    assert!(!list.set_profiles("h1".into(), "<html>".into()));
    assert!(list.set_profiles(
        "h1".into(),
        r#"{"profiles":[{"name":"work","owner":"dan","defaults":{"sharing":"private"}},{"name":"plain"}]}"#.into()
    ));
    let work = list.agent_seed("h1".into(), None, Some("work".into())).unwrap();
    assert_eq!((work.shared, work.owner.as_deref()), (false, Some("dan")));
    let plain = list.agent_seed("h1".into(), None, Some("plain".into())).unwrap();
    assert_eq!((plain.shared, plain.owner.as_deref()), (true, Some("tobias")));
    list.set_meta("h1".into(), r#"{"agents":{"sharing":"shared","allowShared":false}}"#.into());
    assert!(!list.agent_seed("h1".into(), None, None).unwrap().shared);
    list.remove_host("h1".into());
    assert!(list.agent_seed("h1".into(), None, None).is_none());
}

#[test]
fn a_row_carries_its_conversation_and_every_live_session_offers_a_cut() {
    let list = SessionList::new(None, None);
    let named = r#","agent":{"id":"c","name":"WD-Test"},"conversation":3,"sdkSessionId":"sdk""#;
    list.set_host("h1".into(), "mac".into(), true, body(&[idle("c", named), idle("p", "")])).unwrap();
    let rows: Vec<_> = list.groups(0.0).into_iter().flat_map(|g| g.rows).collect();
    let agent = rows.iter().find(|r| r.session_id == "c").unwrap();
    assert_eq!(agent.conversation, 3);
    assert_eq!(agent.agent_detail.as_deref(), Some("conversation 3"));
    assert!(agent.can_new_conversation && agent.new_conversation_blocked.is_none());
    let plain = rows.iter().find(|r| r.session_id == "p").unwrap();
    assert_eq!(plain.conversation, 1);
    assert_eq!(plain.new_conversation_blocked.as_deref(), Some("This conversation is still new"));
    assert_eq!(wdffi::address_of("c".into(), Some(3), Some(agent.conversation)).conversation, None);
    assert_eq!(wdffi::address_of("c".into(), Some(2), Some(agent.conversation)).conversation, Some(2));
}

#[test]
fn a_drag_reorders_a_member_inside_its_team_and_joins_another() {
    let list = SessionList::new(Some(r#"{"groupBy":"none"}"#.into()), None);
    let agent = |id: &str, lead: &str| format!(r#","agent":{{"id":"{id}","name":"{id}"{lead}}}"#);
    let member = |id: &str, order: u32| agent(id, &format!(r#","lead":"L","order":{order}"#));
    let sessions = [
        idle("lead", &agent("L", "")),
        idle("a", &member("A", 0)),
        idle("b", &member("B", 1)),
        idle("c", &member("C", 2)),
        idle("solo", &agent("S", "")),
    ];
    list.set_host("h1".into(), "mac".into(), true, body(&sessions)).unwrap();
    let frame = |key: &str, top: f64| DragFrame { key: format!("h1:{key}"), top, height: 36.0 };

    list.begin_drag("h1:a".into());
    let drawn: Vec<_> = list.groups(0.0).into_iter().flat_map(|g| g.rows).map(|r| r.session_id).collect();
    assert_eq!(drawn, ["lead", "a", "b", "c", "solo"], "the dragged member's team draws every member");
    let frames = vec![frame("lead", 0.0), frame("a", 40.0), frame("b", 80.0), frame("c", 120.0), frame("solo", 160.0)];
    let target = list.drag_move(frames.clone(), 150.0).unwrap();
    assert_eq!((target.lane.as_str(), target.before.as_deref()), ("team:h1:lead", None));
    let ListDrop::Team { lead_agent_id, order, siblings, confirm_owner, .. } = list.end_drag(true) else { panic!("no team move") };
    assert_eq!((lead_agent_id.as_str(), order, confirm_owner), ("L", 2.0, None));
    assert_eq!(siblings.iter().map(|s| (s.agent_id.as_str(), s.order)).collect::<Vec<_>>(), [("B", 0.0), ("C", 1.0)]);

    list.begin_drag("h1:solo".into());
    let target = list.drag_move(frames, 18.0).unwrap();
    assert_eq!(target.join.as_deref(), Some("h1:lead"));
    let ListDrop::Team { order, siblings, .. } = list.end_drag(true) else { panic!("no join") };
    assert_eq!((order, siblings.len()), (3.0, 0));
    let drawn: Vec<_> = list.groups(0.0).into_iter().flat_map(|g| g.rows).map(|r| r.session_id).collect();
    assert!(!drawn.contains(&"b".to_owned()), "the teams fold back to Auto once the drag ends");
}

#[test]
fn a_plain_session_dropped_on_a_solo_agent_joins_it() {
    let list = SessionList::new(Some(r#"{"groupBy":"none"}"#.into()), None);
    let sessions = [idle("solo", r#","agent":{"id":"S","name":"S"}"#), idle("plain", "")];
    list.set_host("h1".into(), "mac".into(), true, body(&sessions)).unwrap();
    let frame = |key: &str, top: f64| DragFrame { key: format!("h1:{key}"), top, height: 36.0 };
    list.begin_drag("h1:plain".into());
    let target = list.drag_move(vec![frame("solo", 0.0), frame("plain", 40.0)], 58.0).unwrap();
    assert_eq!(target.join, None);
    let target = list.drag_move(vec![frame("solo", 0.0), frame("plain", 40.0)], 18.0).unwrap();
    assert_eq!(target.join.as_deref(), Some("h1:solo"));
    assert!(matches!(list.end_drag(true), ListDrop::Team { order: 0.0, .. }));
}

#[test]
fn custom_groups_are_made_styled_filled_reordered_and_removed() {
    let list = SessionList::new(Some(r#"{"groupBy":"custom"}"#.into()), None);
    list.set_host("h1".into(), "mac".into(), true, body(&[idle("a", ""), idle("b", "")])).unwrap();
    let heads = |list: &SessionList| list.groups(0.0).into_iter().map(|g| (g.label.unwrap_or_default(), g.rows.len())).collect::<Vec<_>>();
    assert_eq!(heads(&list), [("Ungrouped".to_owned(), 2)]);

    let one = list.add_custom_group("  ".into());
    let two = list.add_custom_group("Two".into());
    assert_ne!(one, two);
    list.rename_custom_group(one.clone(), "One".into());
    list.rename_custom_group(one.clone(), " ".into());
    list.move_to_custom_group("h1:a".into(), Some(two.clone()));
    assert_eq!(list.custom_group_of("h1:a".into()), Some(two.clone()));
    assert_eq!(heads(&list), [("One".to_owned(), 0), ("Two".to_owned(), 1), ("Ungrouped".to_owned(), 1)]);

    let groups = list.groups(0.0);
    assert!(groups[0].reorderable && !groups[0].caps && groups[0].color.is_some());
    assert!(!groups[2].reorderable && groups[2].color.is_none());
    let color = list.group_colors()[3].clone();
    list.set_custom_group_icon(one.clone(), Some("data:image/png;base64,AA".into()));
    assert_eq!(list.groups(0.0)[0].icon.as_deref(), Some("data:image/png;base64,AA"));
    list.set_custom_group_color(one.clone(), color.clone());
    assert_eq!((list.groups(0.0)[0].color.clone(), list.groups(0.0)[0].icon.clone()), (Some(color), None));

    list.move_group(groups[0].key.clone(), groups[1].key.clone());
    assert_eq!(list.custom_groups().iter().map(|g| g.name.as_str()).collect::<Vec<_>>(), ["Two", "One"]);

    list.begin_drag("h1:b".into());
    let frames = vec![
        DragFrame { key: "h1:b".into(), top: 80.0, height: 36.0 },
        DragFrame { key: "head:custom:".to_owned() + &two, top: 0.0, height: 20.0 },
        DragFrame { key: "h1:a".into(), top: 20.0, height: 36.0 },
        DragFrame { key: "head:custom:".to_owned() + &one, top: 56.0, height: 20.0 },
        DragFrame { key: "empty:custom:".to_owned() + &one, top: 76.0, height: 36.0 },
    ];
    let target = list.drag_move(frames, 94.0).unwrap();
    assert_eq!(target.lane, format!("custom:{one}"));
    assert!(matches!(list.end_drag(true), ListDrop::Placed));
    assert_eq!(list.custom_group_of("h1:b".into()), Some(one.clone()));

    list.move_to_custom_group("h1:b".into(), None);
    list.remove_custom_group(two);
    assert_eq!(heads(&list), [("One".to_owned(), 0), ("Ungrouped".to_owned(), 2)]);
}
