use wdffi::{Effect, Metrics, PromptKind, Selection, Session, snapshot_version};

#[test]
fn a_session_opens_attaches_and_draws_through_the_ffi_surface() {
    let session = Session::new(0, true, "n".into(), Metrics { cell: 8.0, line: 16.0, width: 800.0, font_size: 13.0 });
    assert!(session.take_effects().contains(&Effect::Open { after_seq: 0 }));
    session.opened();
    let attached = r#"{"type":"attached","protocolVersion":2,"replayingFrom":0,"acks":true,"session":{"id":"s1","status":"running","cwd":"/r","createdAt":1,"lastSeq":0,"pendingPermissionCount":0}}"#;
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
    session.received(r#"{"type":"attached","protocolVersion":2,"replayingFrom":0,"session":{"id":"s1"}}"#.into(), 0.0);
    assert!(session.take_protocol_error().is_some_and(|message| message.contains("attached")));
}

fn attached_with(events: &[&str]) -> std::sync::Arc<Session> {
    let session = Session::new(0, true, "n".into(), Metrics { cell: 8.0, line: 16.0, width: 800.0, font_size: 13.0 });
    session.opened();
    let attached = r#"{"type":"attached","protocolVersion":2,"replayingFrom":0,"acks":true,"session":{"id":"s1","status":"awaiting_approval","cwd":"/r","createdAt":1,"lastSeq":0,"pendingPermissionCount":0}}"#;
    let mut batch = format!("{attached}\n");
    for (index, request) in events.iter().enumerate() {
        let seq = index + 1;
        batch.push_str(&format!(r#"{{"type":"event","event":{{"type":"permission_requested","request":{request},"seq":{seq},"ts":1}}}}"#));
        batch.push('\n');
    }
    let effects = session.received_batch(batch, 0.0);
    assert!(effects.iter().any(|effect| matches!(effect, Effect::Changed { changed } if changed.prompt)) == !events.is_empty());
    session
}

#[test]
fn the_head_of_the_approval_queue_is_the_prompt_and_answers_extend_its_input() {
    let question = r#"{"id":"r1","toolName":"AskUserQuestion","toolUseId":"t1","input":{"questions":[{"question":"Which?","header":"Pick","options":[{"label":"a"},{"label":"b"}]}]}}"#;
    let bash = r#"{"id":"r2","toolName":"Bash","toolUseId":"t2","input":{"command":"ls -la"},"title":"Claude wants to run ls"}"#;
    let session = attached_with(&[question, bash]);
    let prompt = session.prompt().unwrap();
    assert_eq!((prompt.kind, prompt.waiting, prompt.questions.len()), (PromptKind::Question, 2, 1));
    let sent = session.answer("r1".into(), vec![Selection { labels: vec!["b".into()], ..Selection::default() }]);
    let text = sent.iter().find_map(|effect| if let Effect::Send { text, .. } = effect { Some(text.clone()) } else { None }).unwrap();
    assert!(text.contains(r#""answers":{"Which?":"b"}"#) && text.contains(r#""behavior":"allow""#), "{text}");
    let resolved = r#"{"type":"event","event":{"type":"permission_resolved","requestId":"r1","seq":3,"ts":1}}"#;
    assert!(session.received(resolved.into(), 0.0).iter().any(|effect| matches!(effect, Effect::Changed { changed } if changed.prompt)));
    let prompt = session.prompt().unwrap();
    assert_eq!(
        (prompt.kind, prompt.subject.as_deref(), prompt.heading.as_str()),
        (PromptKind::Permission, Some("ls -la"), "Claude wants to run ls")
    );
}

#[test]
fn a_plan_prompt_lays_its_markdown_out_as_lines() {
    let plan = r##"{"id":"p1","toolName":"ExitPlanMode","toolUseId":"t1","input":{"plan":"# Steps\n\n1. one\n2. two"}}"##;
    let session = attached_with(&[plan]);
    assert_eq!(session.prompt().unwrap().kind, PromptKind::Plan);
    let bytes = session.prompt_plan_lines();
    assert_eq!(bytes[0], snapshot_version());
    assert!(bytes.len() > 20);
    assert!(attached_with(&[]).prompt().is_none());
}
