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
