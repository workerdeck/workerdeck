use serde_json::json;
use wd_native::vm::conversations::{ConversationSelection, Follow, follow_step, follow_target, selection_of};
use wd_native::vm::session_list::SessionRow;

fn row(host: &str, id: &str, agent: Option<&str>, archived: bool) -> SessionRow {
    let mut info = json!({"id": id, "status": "idle", "cwd": "/w", "createdAt": 1, "lastSeq": 0, "pendingPermissionCount": 0});
    if let Some(agent) = agent {
        info["agent"] = json!({"id": agent, "name": "WD-Test"});
    }
    if archived {
        info["archived"] = json!(true);
    }
    serde_json::from_value(
        json!({"hostId": host, "hostName": host, "local": false, "adapter": "claude", "state": "idle", "info": info, "unseen": 0}),
    )
    .unwrap()
}

fn agent() -> ConversationSelection {
    ConversationSelection::Agent { gateway: "g".into(), agent_id: "ag".into() }
}

#[test]
fn a_superseded_session_moves_to_its_successor_when_the_list_has_not_caught_up() {
    let mut follow = Follow::new(agent(), "a");
    let stale = [row("g", "a", Some("ag"), false)];
    assert_eq!(follow.superseded("b", &stale).as_deref(), Some("b"));
    assert_eq!(follow.current(), "b");
    assert_eq!(follow.listed(&stale), None);
    assert_eq!(follow.superseded("a", &stale), None);
}

#[test]
fn the_list_crosses_several_missed_rotations_in_one_move() {
    let mut follow = Follow::new(agent(), "a");
    let rows = [row("g", "a", Some("ag"), true), row("other", "x", Some("ag"), false), row("g", "d", Some("ag"), false)];
    assert_eq!(follow.superseded("b", &rows).as_deref(), Some("d"));
    assert_eq!(follow.listed(&rows), None);
    let later = [row("g", "e", Some("ag"), false)];
    assert_eq!(follow.listed(&later).as_deref(), Some("e"));
    assert_eq!(follow.superseded("d", &later), None);
}

#[test]
fn a_session_selection_never_moves() {
    let rows = [row("g", "c", Some("ag"), false)];
    let selection = ConversationSelection::Session { gateway: "g".into(), session_id: "a".into() };
    assert_eq!(follow_target(&selection, &rows).as_deref(), Some("a"));
    let mut follow = Follow::new(selection, "a");
    assert_eq!(follow.superseded("b", &rows), None);
    assert_eq!(follow.listed(&rows), None);
    assert_eq!(follow.current(), "a");
}

#[test]
fn a_deep_link_to_an_archived_conversation_is_a_session_selection() {
    let archived = row("g", "a", Some("ag"), true);
    assert_eq!(selection_of("g", &archived.info), ConversationSelection::Session { gateway: "g".into(), session_id: "a".into() });
    assert_eq!(selection_of("g", &row("g", "c", Some("ag"), false).info), agent());
}

#[test]
fn a_session_opened_before_the_list_held_it_resolves_on_the_first_list_that_does() {
    let mut follow = Follow::open("g", "a", &[]);
    assert!(!follow.follows());
    assert_eq!(follow.listed(&[row("g", "a", Some("ag"), false)]), None);
    assert!(follow.follows());
    assert_eq!(follow.superseded("b", &[]).as_deref(), Some("b"));
    let plain = Follow::open("g", "p", &[row("g", "p", None, false)]);
    assert!(!plain.follows());
}

fn left(ids: &[&str]) -> Vec<String> {
    ids.iter().map(|id| (*id).to_owned()).collect()
}

#[test]
fn follow_step_lands_on_the_current_conversation_after_two_missed_rotations() {
    let rows = [row("g", "c", Some("ag"), false)];
    assert_eq!(follow_step(Some(&agent()), "a", Some(&rows), Some("b"), &[]).as_deref(), Some("c"));
    assert_eq!(follow_step(Some(&agent()), "c", Some(&rows), None, &left(&["a"])), None);
}

#[test]
fn follow_step_takes_the_one_hop_successor_while_the_list_still_lags() {
    let stale = [row("g", "a", Some("ag"), false)];
    assert_eq!(follow_step(Some(&agent()), "a", Some(&stale), Some("b"), &[]).as_deref(), Some("b"));
    assert_eq!(follow_step(Some(&agent()), "a", Some(&[]), Some("b"), &[]).as_deref(), Some("b"));
    assert_eq!(follow_step(Some(&agent()), "b", Some(&stale), None, &left(&["a"])), None);
}

#[test]
fn follow_step_never_moves_a_session_selection_or_an_unknown_one() {
    let rows = [row("g", "c", Some("ag"), false)];
    let session = ConversationSelection::Session { gateway: "g".into(), session_id: "a".into() };
    assert_eq!(follow_step(Some(&session), "a", Some(&rows), Some("b"), &[]), None);
    assert_eq!(follow_step(None, "a", Some(&rows), Some("b"), &[]), None);
}

mod history {
    use serde_json::json;
    use wd_native::rest::{AgentConversationsResponse, AgentInfo, RetiredAgentInfo};
    use wd_native::vm::conversations::{
        agent_conversations, conversation_items, date_label, delete_agent_message, duration_label, past_agent_items,
    };

    const DAY: f64 = 86_400_000.0;
    // 2026-10-18 12:00 UTC
    const NOW: f64 = 1_792_324_800_000.0;

    #[test]
    fn dates_read_in_local_time_relative_to_today() {
        assert_eq!(date_label(NOW, NOW, 0), "Today 12:00");
        assert_eq!(date_label(NOW - DAY, NOW, 0), "Yesterday 12:00");
        assert_eq!(date_label(NOW - 3.0 * DAY, NOW, 120), "Oct 15, 14:00");
        assert_eq!(date_label(NOW - 300.0 * DAY, NOW, 0), "Dec 22, 2025");
        assert_eq!(date_label(NOW - 13.0 * 3_600_000.0, NOW, 480), "Today 07:00");
    }

    #[test]
    fn durations_read_like_the_web() {
        assert_eq!(duration_label(20_000.0), "under a minute");
        assert_eq!(duration_label(45.0 * 60_000.0), "45m");
        assert_eq!(duration_label(125.0 * 60_000.0), "2h 5m");
        assert_eq!(duration_label(120.0 * 60_000.0), "2h");
        assert_eq!(duration_label(3.0 * DAY + 3.0 * 3_600_000.0), "3d");
    }

    #[test]
    fn legacy_past_sessions_come_before_recorded_conversations_and_the_newest_is_first() {
        let agent: AgentInfo = serde_json::from_value(json!({"id": "ag", "name": "A", "createdAt": 0, "updatedAt": 0, "sessionId": "c",
            "pastSessions": ["old", "b"], "config": {}, "conversations": [{"sessionId": "b", "startedAt": 1}, {"sessionId": "c", "startedAt": 2}]}))
        .unwrap();
        let rows = agent_conversations(&agent);
        let ids: Vec<_> = rows.iter().map(|row| (row.conversation.session_id.as_str(), row.current)).collect();
        assert_eq!(ids, [("c", true), ("b", false), ("old", false)]);
    }

    #[test]
    fn history_rows_carry_date_title_duration_and_the_current_marker() {
        let response: AgentConversationsResponse = serde_json::from_value(json!({"conversations": [
            {"sessionId": "c", "current": true, "startedAt": NOW - 3_600_000.0},
            {"sessionId": "b", "current": false, "startedAt": NOW - DAY, "endedAt": NOW - DAY + 600_000.0, "title": "Fix the build"},
            {"sessionId": "a", "current": false, "transcript": "unavailable"},
        ]}))
        .unwrap();
        let items = conversation_items(&response.conversations, NOW, 0);
        assert_eq!(items[0].title, "Untitled conversation");
        assert_eq!(items[0].duration.as_deref(), Some("1h"));
        assert!(items[0].current);
        assert_eq!(
            (items[1].date.as_str(), items[1].title.as_str(), items[1].duration.as_deref()),
            ("Yesterday 12:00", "Fix the build", Some("10m"))
        );
        assert_eq!((items[2].date.as_str(), items[2].duration.as_deref(), items[2].unavailable), ("Date unknown", None, true));
        assert_eq!(items[2].title, "Transcript unavailable");
    }

    #[test]
    fn past_agents_list_the_latest_deleted_first_with_a_count() {
        let retired: Vec<RetiredAgentInfo> = serde_json::from_value(json!([
            {"id": "a", "name": "Old", "retiredAt": NOW - 3.0 * DAY, "pastSessions": ["x"], "conversations": []},
            {"id": "b", "name": "New", "retiredAt": NOW, "pastSessions": [], "conversations": [{"sessionId": "y"}, {"sessionId": "z"}]},
        ]))
        .unwrap();
        let items = past_agent_items(&retired, NOW, 0);
        assert_eq!(items[0].name, "New");
        assert_eq!(items[0].detail, "Deleted Today 12:00 \u{00B7} 2 conversations");
        assert_eq!(items[1].detail, "Deleted Oct 15, 12:00 \u{00B7} 1 conversation");
        assert_eq!(
            delete_agent_message("Ada"),
            "Ada leaves your agents. Its conversations stay under Past agents. Team members are released."
        );
    }
}
