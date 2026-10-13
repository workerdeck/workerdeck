use wdffi::{Effect, Metrics, Session, snapshot_version};

#[test]
fn a_session_opens_attaches_and_draws_through_the_ffi_surface() {
    let session = Session::new(0, true, "n".into(), Metrics { cell: 8.0, line: 16.0, width: 800.0, font_size: 13.0 });
    assert!(session.take_effects().contains(&Effect::Open { after_seq: 0 }));
    session.opened();
    let attached = r#"{"type":"attached","protocolVersion":1,"replayingFrom":0,"acks":true,"session":{"id":"s1","status":"running","cwd":"/r","createdAt":1,"lastSeq":0,"pendingPermissionCount":0}}"#;
    let event = r#"{"type":"event","event":{"type":"user_message","message":{"role":"user","content":"hi"},"parentToolUseId":null,"uuid":"u1","seq":1,"ts":1}}"#;
    let effects = session.received_batch(format!("{attached}\n{event}\n"), 0.0);
    assert!(effects.iter().any(|effect| matches!(effect, Effect::Changed { changed } if changed.transcript)));
    let frame = session.transcript_frame(0, 10);
    assert_eq!(frame[0], snapshot_version());
    let sent = session.send("hello".into(), Vec::new());
    assert!(sent.iter().any(|effect| matches!(effect, Effect::Send { text, .. } if text.contains("hello"))));
}

#[test]
fn an_attach_the_reader_cannot_follow_surfaces_as_a_protocol_error() {
    let session = Session::new(0, true, "n".into(), Metrics { cell: 8.0, line: 16.0, width: 800.0, font_size: 13.0 });
    session.opened();
    session.received(r#"{"type":"attached","protocolVersion":1,"replayingFrom":0,"session":{"id":"s1"}}"#.into(), 0.0);
    assert!(session.take_protocol_error().is_some_and(|message| message.contains("attached")));
}
