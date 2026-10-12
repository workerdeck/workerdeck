use crate::transcript::{Item, NoticeLevel, ToolCallStatus, TranscriptState};
use serde_json::{Map, Value, json};

pub fn project(state: &TranscriptState) -> Value {
    let mut out = Map::new();
    out.insert("status".into(), json!(state.status.map_or("starting", |s| s.raw())));
    put(&mut out, "statusDetail", state.status_detail.as_deref().map(Value::from));
    put(&mut out, "model", state.model.as_deref().map(Value::from));
    put(&mut out, "cwd", state.cwd.as_deref().map(Value::from));
    put(&mut out, "sdkSessionId", state.sdk_session_id.as_deref().map(Value::from));
    put(&mut out, "permissionMode", state.permission_mode.as_deref().map(Value::from));
    put(
        &mut out,
        "contextUsage",
        state.context_usage.as_ref().map(|usage| {
            let mut value = json!({
                "categories": usage.categories.iter().map(|(name, tokens, color)| json!({ "name": name, "tokens": tokens, "color": color })).collect::<Vec<_>>(),
                "totalTokens": usage.total_tokens,
                "maxTokens": usage.max_tokens,
                "percentage": usage.percentage,
            });
            if let Some(model) = &usage.model {
                value["model"] = json!(model);
            }
            value
        }),
    );
    out.insert("items".into(), Value::Array(state.items.iter().map(item).collect()));
    out.insert("pendingApprovals".into(), json!([]));
    out.insert("totalCostUsd".into(), json!(state.total_cost_usd));
    put(&mut out, "costUsd", state.cost_usd.map(Value::from));
    out.insert("lastSeq".into(), json!(state.last_seq));
    Value::Object(out)
}

fn item(item: &Item) -> Value {
    let mut out = Map::new();
    match item {
        Item::User { id, text, parent_tool_use_id } => {
            out.insert("kind".into(), json!("user"));
            out.insert("id".into(), json!(id.as_ref()));
            out.insert("text".into(), json!(text.as_ref()));
            put(&mut out, "parentToolUseId", parent_tool_use_id.as_deref().map(Value::from));
        }
        Item::AssistantText { id, text, streaming, parent_tool_use_id } => {
            out.insert("kind".into(), json!("assistant_text"));
            out.insert("id".into(), json!(id.as_ref()));
            out.insert("text".into(), json!(text.as_ref()));
            out.insert("streaming".into(), json!(streaming));
            put(&mut out, "parentToolUseId", parent_tool_use_id.as_deref().map(Value::from));
        }
        Item::Thinking { id, text, parent_tool_use_id } => {
            out.insert("kind".into(), json!("thinking"));
            out.insert("id".into(), json!(id.as_ref()));
            out.insert("text".into(), json!(text.as_ref()));
            put(&mut out, "parentToolUseId", parent_tool_use_id.as_deref().map(Value::from));
        }
        Item::ToolCall(call) => {
            out.insert("kind".into(), json!("tool_call"));
            out.insert("id".into(), json!(call.id.as_ref()));
            out.insert("name".into(), json!(call.name.as_ref()));
            out.insert("input".into(), (*call.input).clone());
            put(&mut out, "parentToolUseId", call.parent_tool_use_id.as_deref().map(Value::from));
            put(&mut out, "ts", call.ts.map(Value::from));
            out.insert("status".into(), json!(status(call.status)));
            put(
                &mut out,
                "result",
                call.result.as_ref().map(|result| {
                    let mut value = json!({ "text": result.text.as_ref(), "isError": result.is_error });
                    if result.truncated {
                        value["truncated"] = json!(true);
                        if let Some(total) = result.total_chars {
                            value["totalChars"] = json!(total);
                        }
                        if let Some(seq) = result.source_seq {
                            value["sourceSeq"] = json!(seq);
                        }
                    }
                    value
                }),
            );
            put(&mut out, "liveTail", call.live_tail.as_deref().map(Value::from));
        }
        Item::TurnResult { id, subtype, is_error, duration_ms, total_cost_usd, cost_usd, errors } => {
            out.insert("kind".into(), json!("turn_result"));
            out.insert("id".into(), json!(id.as_ref()));
            out.insert("subtype".into(), json!(subtype.as_ref()));
            out.insert("isError".into(), json!(is_error));
            out.insert("durationMs".into(), json!(duration_ms));
            out.insert("totalCostUsd".into(), json!(total_cost_usd));
            put(&mut out, "costUsd", cost_usd.map(Value::from));
            put(&mut out, "errors", errors.as_ref().map(|errors| json!(errors.as_ref())));
        }
        Item::Notice { id, level, text } => {
            out.insert("kind".into(), json!("notice"));
            out.insert("id".into(), json!(id.as_ref()));
            out.insert("level".into(), json!(if *level == NoticeLevel::Error { "error" } else { "info" }));
            out.insert("text".into(), json!(text.as_ref()));
        }
    }
    Value::Object(out)
}

fn status(status: ToolCallStatus) -> &'static str {
    match status {
        ToolCallStatus::Pending => "pending",
        ToolCallStatus::Running => "running",
        ToolCallStatus::Deferred => "deferred",
        ToolCallStatus::Settled => "settled",
        ToolCallStatus::Failed => "failed",
    }
}

fn put(out: &mut Map<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        out.insert(key.into(), value);
    }
}
