use wd_native::vm::conversations::{SessionAddress, address_key, address_of, archived_banner, archived_view, same_address};

#[test]
fn an_address_names_the_current_conversation_by_id_and_a_past_one_by_n() {
    let current = SessionAddress::current("s");
    let past = SessionAddress { id: "s".into(), conversation: Some(2) };
    assert_eq!((address_key(&current), address_key(&past)), ("s".to_owned(), "s#2".to_owned()));
    assert_eq!(address_of("s", Some(3), Some(3)), current);
    assert_eq!(address_of("s", Some(2), Some(3)), past);
    assert_eq!(address_of("s", None, Some(3)), current);
    assert!(same_address(Some(&past), Some(&past.clone())));
    assert!(!same_address(Some(&past), Some(&current)));
    assert!(past.is_historical() && !current.is_historical());
}

#[test]
fn a_past_conversation_dates_its_banner_and_names_a_closed_session() {
    let info = serde_json::from_value(serde_json::json!({"id": "s", "status": "closed", "cwd": "/w", "createdAt": 1_792_324_800_000.0,
        "lastSeq": 0, "pendingPermissionCount": 0, "transcript": "unavailable"}))
    .unwrap();
    let past = SessionAddress { id: "s".into(), conversation: Some(1) };
    let current = wd_native::vm::conversations::CurrentConversation { conversation: None, retired: Some(true) };
    let view = archived_view(&past, Some(&info), Some(&current)).unwrap();
    let (banner, note) = archived_banner(&view, 1_792_324_800_000.0, 0);
    assert_eq!(banner, "Past conversation \u{00B7} Today 12:00");
    assert_eq!(note.as_deref(), Some("Closed \u{00B7} Transcript unavailable"));
    assert_eq!(archived_view(&SessionAddress::current("s"), Some(&info), None), None);
}

mod history {
    use serde_json::json;
    use wd_native::rest::{ConversationsResponse, RetiredAgentInfo};
    use wd_native::vm::conversations::{
        ConversationRecovery, conversation_items, conversation_list, conversation_recovery, date_label, delete_agent_message,
        discard_confirm_text, duration_label, past_agent_items, uncertain_prompt_of, unconfirmed_input_of,
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

    fn response(value: serde_json::Value) -> ConversationsResponse {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn the_current_conversation_leads_and_starts_where_the_last_one_ended() {
        let listed = response(json!({"conversation": 3, "history": [
            {"n": 1, "engine": "claude", "cwd": "/w", "endedAt": 10},
            {"n": 2, "engine": "claude", "cwd": "/w", "startedAt": 10, "endedAt": 20, "title": "Fix the build"},
        ]}));
        let rows = conversation_list(&listed, Some("Now"));
        let shown: Vec<_> = rows.iter().map(|row| (row.conversation.n, row.current, row.conversation.started_at)).collect();
        assert_eq!(shown, [(3, true, Some(20.0)), (2, false, Some(10.0)), (1, false, None)]);
        assert_eq!(rows[0].conversation.title.as_deref(), Some("Now"));
        let closed =
            response(json!({"conversation": 2, "closed": true, "history": [{"n": 1, "engine": "codex", "cwd": "/w", "endedAt": 5}]}));
        assert_eq!(conversation_list(&closed, None).iter().map(|row| row.current).collect::<Vec<_>>(), [false]);
    }

    #[test]
    fn recovery_names_a_failed_start_and_an_uncertain_first_message() {
        let quiet = response(json!({"conversation": 2, "history": [], "pendingPrompt": {"text": "hi", "n": 2, "state": "sending"}}));
        assert_eq!(conversation_recovery(&quiet), ConversationRecovery::default());
        let stuck = response(json!({"conversation": 3, "history": [], "pendingPrompt": {"text": "hi", "n": 2, "state": "uncertain"},
            "startFailed": {"n": 3, "error": "spawn failed"}}));
        let recovery = conversation_recovery(&stuck);
        assert_eq!(recovery.start_failed, Some((3, "spawn failed".to_owned())));
        assert_eq!(recovery.uncertain_prompt, Some((3, "hi".to_owned())));
    }

    #[test]
    fn an_unconfirmed_input_refusal_reads_into_the_confirmation() {
        let body =
            r#"{"error":"e","code":"unconfirmed_input","conversation":2,"inputRevision":"r.3","pendingInput":2,"mayIncludePeer":false}"#;
        let refusal = unconfirmed_input_of(409, body).unwrap();
        assert_eq!((refusal.conversation, refusal.input_revision.as_str(), refusal.changed), (2, "r.3", false));
        let text = discard_confirm_text(&refusal);
        assert_eq!(text.title, "Discard 2 messages and start a new conversation?");
        assert_eq!(
            text.detail,
            "2 messages sent to this session have no answer yet. A new conversation drops it for good; none of it is carried over."
        );
        assert_eq!(text.confirm, "Discard and start");
        let changed = r#"{"error":"e","code":"input_changed","conversation":2,"inputRevision":"r.4","pendingInput":1}"#;
        let again = discard_confirm_text(&unconfirmed_input_of(409, changed).unwrap());
        assert!(again.detail.starts_with("More input arrived: 1 message has no answer yet."));
        assert!(again.detail.ends_with("who will not get a reply."));
        assert_eq!(unconfirmed_input_of(400, body), None);
        assert_eq!(unconfirmed_input_of(409, r#"{"error":"busy"}"#), None);
        assert_eq!(uncertain_prompt_of(409, r#"{"error":"e","code":"uncertain_prompt","conversation":3,"promptConversation":2}"#), Some(2));
        assert_eq!(uncertain_prompt_of(409, body), None);
    }

    #[test]
    fn history_rows_carry_date_title_duration_and_the_current_marker() {
        let listed = response(json!({"conversation": 3, "history": [
            {"n": 2, "engine": "claude", "cwd": "/w", "startedAt": NOW - DAY, "endedAt": NOW - DAY + 600_000.0, "title": "Fix the build"},
            {"n": 1, "engine": "claude", "cwd": "/w", "endedAt": NOW - 3_600_000.0, "transcript": "unavailable"},
        ]}));
        let mut rows = conversation_list(&listed, None);
        rows[0].conversation.started_at = Some(NOW - 3_600_000.0);
        rows[2].conversation.ended_at = None;
        let items = conversation_items(&rows, NOW, 0);
        assert_eq!((items[0].n, items[0].title.as_str(), items[0].duration.as_deref()), (3, "Untitled conversation", Some("1h")));
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
            {"id": "a", "name": "Old", "retiredAt": NOW - 3.0 * DAY, "conversations": [{"n": 1}]},
            {"id": "b", "name": "New", "retiredAt": NOW, "conversations": [{"n": 1}, {"n": 2}]},
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
