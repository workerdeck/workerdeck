use wdffi::{Metrics, Session, Severity};

const NOW: f64 = 1_800_000_000_000.0;

fn attached(session_extra: &str, events: &[&str]) -> std::sync::Arc<Session> {
    let session = Session::new(0, true, "n".into(), Metrics { cell: 8.0, line: 16.0, width: 800.0, font_size: 13.0 }, None);
    session.opened();
    let attached = format!(
        r#"{{"type":"attached","protocolVersion":2,"replayingFrom":0,"acks":true,"session":{{"id":"s1","status":"idle","cwd":"/r","createdAt":1,"lastSeq":0,"pendingPermissionCount":0{session_extra}}}}}"#
    );
    let mut batch = format!("{attached}\n");
    for (index, body) in events.iter().enumerate() {
        batch.push_str(&format!(r#"{{"type":"event","event":{{{body},"seq":{},"ts":{}}}}}"#, index + 1, NOW - 60_000.0));
        batch.push('\n');
    }
    session.received_batch(batch, NOW);
    session
}

const CONTEXT: &str = r##""type":"context_usage","usage":{"totalTokens":170000,"maxTokens":200000,"percentage":85,"model":"claude-opus-4-6","categories":[{"name":"Messages","tokens":150000,"color":"#ff0000"}]}"##;

fn limit(key: &str, utilization: f64) -> String {
    format!(
        r#""type":"rate_limit","info":{{"status":"allowed","rateLimitType":"{key}","utilization":{utilization},"resetsAt":1800003600}}"#
    )
}

#[test]
fn a_fresh_session_has_no_meters_and_claude_capabilities() {
    let usage = attached("", &[]).usage(NOW);
    assert_eq!(usage.engine, "claude");
    assert!(usage.rate_limits && usage.context_usage);
    assert!(usage.context.is_none() && usage.windows.is_empty());
    assert_eq!(usage.cost.display_usd, None);
    assert!(usage.pricing_note.contains("List rates"));
}

#[test]
fn the_transcript_reading_orders_its_windows_and_rates_the_context() {
    let weekly = limit("seven_day", 96.0);
    let session = limit("five_hour", 20.0);
    let usage = attached("", &[CONTEXT, &weekly, &session]).usage(NOW);
    let context = usage.context.expect("context");
    assert_eq!((context.total_tokens, context.severity, context.categories.len()), (170_000, Severity::Warning, 1));
    let keys: Vec<_> = usage.windows.iter().map(|w| w.key.as_str()).collect();
    assert_eq!(keys, ["five_hour", "seven_day"]);
    assert_eq!(usage.windows[1].severity, Severity::Error);
    assert_eq!(usage.windows[0].updated_at, Some(NOW - 60_000.0));
    assert!(!usage.windows[0].stale);
    assert!(usage.windows[0].resets_at.is_some());
}

#[test]
fn the_account_reading_wins_every_window_it_holds_and_brings_the_spend() {
    let session = limit("five_hour", 20.0);
    let s = attached(r#","profile":"max""#, &[&session]);
    let old = NOW - 3_600_000.0;
    let profiles = format!(
        r#"{{"profiles":[{{"name":"other"}},{{"name":"max","usage":{{"five_hour":{{"info":{{"status":"allowed","utilization":55}},"updatedAt":{old}}},"seven_day_opus":{{"info":{{"status":"allowed","utilization":10}},"updatedAt":{old}}}}},"spend":{{"weekUsd":40,"monthUsd":160,"weekByModel":{{}},"unpricedShare":0,"subscription":{{"weeklyUsd":40,"monthlyUsd":200,"weeklyShareUsd":46.15,"ratio":0.87}}}}}}]}}"#
    );
    assert!(s.set_profiles(profiles));
    assert!(!s.set_profiles("<html>".into()));
    let usage = s.usage(NOW);
    assert_eq!(usage.profile.as_deref(), Some("max"));
    let keys: Vec<_> = usage.windows.iter().map(|w| (w.key.as_str(), w.utilization, w.stale)).collect();
    assert_eq!(keys, [("five_hour", 55.0, true), ("seven_day_opus", 10.0, true)]);
    let spend = usage.spend.expect("spend");
    assert_eq!((spend.week_usd, spend.ratio), (40.0, Some(0.87)));
}

#[test]
fn the_cost_is_ours_when_the_gateway_priced_it_and_the_rows_carry_the_models() {
    let extra = r#","totalCostUsd":2.5,"costUsd":2.0,"usageByModel":{"claude-opus-4-6":{"input":100000,"output":10000,"cacheWrite5m":0,"cacheWrite1h":0,"cacheRead":0}}"#;
    let usage = attached(extra, &[]).usage(NOW);
    assert_eq!((usage.cost.display_usd, usage.cost.reported_usd), (Some(2.0), Some(2.5)));
    assert_eq!(usage.cost.rows.len(), 1);
    assert!(usage.cost.rows[0].cost_usd.is_some());
    assert_eq!(usage.cost.gap_usd, Some(0.5));
}

#[test]
fn a_provider_engine_without_capabilities_reports_no_plan_windows() {
    let usage = attached(r#","engine":"provider""#, &[]).usage(NOW);
    assert_eq!(usage.engine, "provider");
    assert!(!usage.rate_limits);
}

#[test]
fn a_rate_limit_event_alone_tells_the_platform_to_reread_the_meters() {
    let s = attached("", &[]);
    let event = format!(r#"{{"type":"event","event":{{{},"seq":1,"ts":{NOW}}}}}"#, limit("five_hour", 30.0));
    let effects = s.received(event, NOW);
    assert!(effects.iter().any(|effect| matches!(effect, wdffi::Effect::Changed { changed } if changed.chrome)));
    assert_eq!(s.usage(NOW).windows.len(), 1);
}
