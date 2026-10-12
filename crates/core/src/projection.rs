use crate::transcript::{Item, NoticeLevel, ToolCallStatus, TranscriptState};
use serde_json::{Map, Value, json};

pub fn project(state: &TranscriptState) -> Value {
    let mut out = Map::new();
    out.insert("status".into(), json!(state.status.map_or("starting", |s| s.raw())));
    put(&mut out, "statusDetail", state.status_detail.as_deref().map(Value::from));
    put(&mut out, "engineAsleep", state.engine_asleep.then_some(Value::Bool(true)));
    put(&mut out, "model", state.model.as_deref().map(Value::from));
    put(&mut out, "effort", state.effort.as_deref().map(Value::from));
    put(&mut out, "cwd", state.cwd.as_deref().map(Value::from));
    put(&mut out, "sdkSessionId", state.sdk_session_id.as_deref().map(Value::from));
    put(&mut out, "checklist", state.checklist.as_ref().and_then(|items| canonical(&Value::Array(items.clone()))));
    put(&mut out, "toolTitles", pairs(&state.tool_titles, |title| json!(title)));
    put(
        &mut out,
        "producedFiles",
        pairs(&state.produced_files, |file| {
            let mut value = json!({ "fileId": file.file_id });
            if let Some(media_type) = &file.media_type {
                value["mediaType"] = json!(media_type);
            }
            if let Some(bytes) = file.bytes {
                value["bytes"] = json!(bytes);
            }
            value
        }),
    );
    put(&mut out, "defaultModel", state.default_model.as_deref().map(Value::from));
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
    put(&mut out, "rateLimits", pairs(&state.rate_limits, |info| canonical(info).unwrap_or(Value::Null)));
    put(&mut out, "rateLimitsUpdatedAt", state.rate_limits_updated_at.map(Value::from));
    put(&mut out, "subscriptionType", state.subscription_type.as_deref().map(Value::from));
    out.insert("items".into(), Value::Array(state.items.iter().map(item).collect()));
    out.insert(
        "pendingApprovals".into(),
        Value::Array(state.pending_approvals.iter().map(|request| canonical(request).unwrap_or(Value::Null)).collect()),
    );
    out.insert("totalCostUsd".into(), json!(state.total_cost_usd));
    put(&mut out, "costUsd", state.cost_usd.map(Value::from));
    put(&mut out, "usageByModel", state.usage_by_model.as_deref().and_then(canonical));
    out.insert("lastSeq".into(), json!(state.last_seq));
    Value::Object(out)
}

fn pairs<V>(entries: &[(String, V)], value: impl Fn(&V) -> Value) -> Option<Value> {
    (!entries.is_empty()).then(|| Value::Object(entries.iter().map(|(key, entry)| (key.clone(), value(entry))).collect()))
}

pub fn canonical(value: &Value) -> Option<Value> {
    match value {
        Value::Null => None,
        Value::Array(entries) => Some(Value::Array(entries.iter().map(|entry| canonical(entry).unwrap_or(Value::Null)).collect())),
        Value::Object(map) => Some(Value::Object(map.iter().filter_map(|(key, entry)| Some((key.clone(), canonical(entry)?))).collect())),
        other => Some(other.clone()),
    }
}

fn item(item: &Item) -> Value {
    let mut out = Map::new();
    match item {
        Item::User { id, text, parent_tool_use_id, attachments, origin } => {
            out.insert("kind".into(), json!("user"));
            out.insert("id".into(), json!(id.as_ref()));
            out.insert("text".into(), json!(text.as_ref()));
            put(&mut out, "attachments", attachments.as_deref().and_then(canonical));
            put(&mut out, "origin", origin.as_deref().and_then(canonical));
            put(&mut out, "parentToolUseId", parent_tool_use_id.as_deref().map(Value::from));
        }
        Item::AssistantText { id, text, streaming, parent_tool_use_id } => {
            out.insert("kind".into(), json!("assistant_text"));
            out.insert("id".into(), json!(id.as_ref()));
            out.insert("text".into(), json!(text.as_ref()));
            out.insert("streaming".into(), json!(streaming));
            put(&mut out, "parentToolUseId", parent_tool_use_id.as_deref().map(Value::from));
        }
        Item::Thinking { id, text, parent_tool_use_id, addressed } => {
            out.insert("kind".into(), json!("thinking"));
            out.insert("id".into(), json!(id.as_ref()));
            out.insert("text".into(), json!(text.as_ref()));
            put(&mut out, "parentToolUseId", parent_tool_use_id.as_deref().map(Value::from));
            put(&mut out, "addressed", addressed.then_some(Value::Bool(true)));
        }
        Item::ToolCall(call) => {
            out.insert("kind".into(), json!("tool_call"));
            out.insert("id".into(), json!(call.id.as_ref()));
            out.insert("name".into(), json!(call.name.as_ref()));
            put(&mut out, "input", canonical(&call.input));
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
                    if let Some(images) = &result.images {
                        value["images"] = images
                            .iter()
                            .map(|image| {
                                json!({ "partIndex": image.part_index, "mediaType": image.media_type.as_ref(), "bytes": image.bytes, "sourceSeq": image.source_seq })
                            })
                            .collect();
                    }
                    value
                }),
            );
            put(&mut out, "patch", call.patch.as_deref().and_then(canonical));
            put(&mut out, "executionId", call.execution_id.as_deref().map(Value::from));
            put(&mut out, "backend", call.backend.as_deref().map(Value::from));
            put(&mut out, "logs", call.logs.as_ref().map(|logs| json!(logs.as_ref())));
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
        Item::FileDelivered { id, path, bytes, description } => {
            out.insert("kind".into(), json!("file_delivered"));
            out.insert("id".into(), json!(id.as_ref()));
            out.insert("path".into(), json!(path.as_ref()));
            out.insert("bytes".into(), json!(bytes));
            put(&mut out, "description", description.as_deref().map(Value::from));
        }
        Item::Compaction(c) => {
            out.insert("kind".into(), json!("compaction"));
            out.insert("id".into(), json!(c.id.as_ref()));
            put(&mut out, "parentToolUseId", c.parent_tool_use_id.as_deref().map(Value::from));
            put(&mut out, "pending", c.pending.map(Value::from));
            put(&mut out, "trigger", c.trigger.as_deref().map(Value::from));
            put(&mut out, "preTokens", c.pre_tokens.map(Value::from));
            put(&mut out, "postTokens", c.post_tokens.map(Value::from));
            put(&mut out, "error", c.error.as_deref().map(Value::from));
        }
        Item::Shell(shell) => {
            out.insert("kind".into(), json!("shell"));
            out.insert("id".into(), json!(shell.id.as_ref()));
            put(&mut out, "shell", canonical(&shell.shell));
            out.insert("text".into(), json!(shell.text.as_ref()));
            out.insert("truncated".into(), json!(shell.truncated));
            put(&mut out, "expanded", shell.expanded.as_deref().map(Value::from));
            put(&mut out, "missing", shell.missing.then_some(Value::Bool(true)));
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
