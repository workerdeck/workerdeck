use crate::protocol::{Body, ContentBlock, ContextUsage, Event, SessionStatus};
use serde_json::Value;
use std::sync::Arc;

pub type Str = Arc<str>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ItemKind {
    User,
    AssistantText,
    Thinking,
    ToolCall,
    TurnResult,
    Notice,
}

impl ItemKind {
    pub fn raw(self) -> &'static str {
        match self {
            ItemKind::User => "user",
            ItemKind::AssistantText => "assistantText",
            ItemKind::Thinking => "thinking",
            ItemKind::ToolCall => "toolCall",
            ItemKind::TurnResult => "turnResult",
            ItemKind::Notice => "notice",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToolCallStatus {
    Pending,
    Running,
    Deferred,
    Settled,
    Failed,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolCallResult {
    pub text: Str,
    pub is_error: bool,
    pub truncated: bool,
    pub total_chars: Option<i64>,
    pub source_seq: Option<i64>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolCall {
    pub id: Str,
    pub name: Str,
    pub title: Option<Str>,
    pub input: Arc<Value>,
    pub parent_tool_use_id: Option<Str>,
    pub status: ToolCallStatus,
    pub result: Option<ToolCallResult>,
    pub ts: Option<f64>,
    pub live_tail: Option<Str>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum NoticeLevel {
    Info,
    Error,
}

#[derive(Debug, Clone, PartialEq)]
pub enum Item {
    User {
        id: Str,
        text: Str,
        parent_tool_use_id: Option<Str>,
    },
    AssistantText {
        id: Str,
        text: Str,
        streaming: bool,
        parent_tool_use_id: Option<Str>,
    },
    Thinking {
        id: Str,
        text: Str,
        parent_tool_use_id: Option<Str>,
    },
    ToolCall(Arc<ToolCall>),
    TurnResult {
        id: Str,
        subtype: Str,
        is_error: bool,
        duration_ms: f64,
        total_cost_usd: f64,
        cost_usd: Option<f64>,
        errors: Option<Arc<Vec<String>>>,
    },
    Notice {
        id: Str,
        level: NoticeLevel,
        text: Str,
    },
}

impl Item {
    pub fn id(&self) -> &str {
        match self {
            Item::User { id, .. }
            | Item::AssistantText { id, .. }
            | Item::Thinking { id, .. }
            | Item::TurnResult { id, .. }
            | Item::Notice { id, .. } => id,
            Item::ToolCall(call) => &call.id,
        }
    }

    pub fn kind(&self) -> ItemKind {
        match self {
            Item::User { .. } => ItemKind::User,
            Item::AssistantText { .. } => ItemKind::AssistantText,
            Item::Thinking { .. } => ItemKind::Thinking,
            Item::ToolCall(_) => ItemKind::ToolCall,
            Item::TurnResult { .. } => ItemKind::TurnResult,
            Item::Notice { .. } => ItemKind::Notice,
        }
    }

    pub fn parent_tool_use_id(&self) -> Option<&Str> {
        match self {
            Item::User { parent_tool_use_id, .. }
            | Item::AssistantText { parent_tool_use_id, .. }
            | Item::Thinking { parent_tool_use_id, .. } => parent_tool_use_id.as_ref(),
            Item::ToolCall(call) => call.parent_tool_use_id.as_ref(),
            Item::TurnResult { .. } | Item::Notice { .. } => None,
        }
    }
}

#[derive(Default)]
pub struct TranscriptState {
    pub status: Option<SessionStatus>,
    pub status_detail: Option<String>,
    pub model: Option<String>,
    pub cwd: Option<String>,
    pub sdk_session_id: Option<String>,
    pub permission_mode: Option<String>,
    pub context_usage: Option<ContextUsage>,
    pub items: Vec<Item>,
    pub total_cost_usd: f64,
    pub cost_usd: Option<f64>,
    pub last_seq: i64,
}

const STREAMING_ID: &str = "streaming";
const STREAMING_THINKING_ID: &str = "streaming-thinking";
const LOCAL_COMMAND_CAVEAT: &str = "<local-command-caveat>";

fn stream_id(base: &str, parent: Option<&str>) -> String {
    match parent {
        None => base.to_owned(),
        Some(p) => format!("{base}:{p}"),
    }
}

fn is_streaming(id: &str, base: &str) -> bool {
    id == base || (id.len() > base.len() && id.starts_with(base) && id.as_bytes()[base.len()] == b':')
}

fn upsert(items: &mut Vec<Item>, item: Item) {
    let (id, kind) = (item.id(), item.kind());
    if let Some(index) = items.iter().position(|it| it.id() == id && it.kind() == kind) {
        items[index] = item;
    } else {
        items.push(item);
    }
}

fn streamed_text(items: &[Item], kind: ItemKind, id: &str) -> Str {
    for item in items {
        if item.id() == id && item.kind() == kind {
            return match item {
                Item::AssistantText { text, .. } | Item::Thinking { text, .. } => text.clone(),
                _ => Str::from(""),
            };
        }
    }
    Str::from("")
}

fn concat(a: &str, b: &str) -> Str {
    let mut s = String::with_capacity(a.len() + b.len());
    s.push_str(a);
    s.push_str(b);
    Str::from(s)
}

// `^<local-command-(stdout|stderr)>([\s\S]*?)</local-command-\1>$` over trimmed text.
fn match_local_command_output(text: &str) -> Option<(&'static str, &str)> {
    for stream in ["stdout", "stderr"] {
        let open = format!("<local-command-{stream}>");
        let close = format!("</local-command-{stream}>");
        if text.starts_with(&open) && text.ends_with(&close) && text.len() >= open.len() + close.len() {
            return Some((stream, &text[open.len()..text.len() - close.len()]));
        }
    }
    None
}

pub fn tool_title(name: &str) -> Option<Str> {
    let title = match name {
        "fs_read" => "Reading a file",
        "fs_write" => "Writing a file",
        "fs_list" => "Listing files",
        "eval_script" => "Running a script",
        "web_fetch" => "Fetching a web page",
        "web_search" => "Searching the web",
        "deliver_file" => "Delivering a file",
        "download" => "Downloading a file",
        "CodexCommand" => "Running a command",
        "CodexFileChange" => "Editing a file",
        "CodexWebSearch" => "Searching the web",
        "CodexImageGeneration" => "Generating an image",
        "CodexImageView" => "Viewing an image",
        "peers_list" | "mcp__workerdeck__peers_list" => "Listing peer sessions",
        "peers_peek" | "mcp__workerdeck__peers_peek" => "Peeking at a peer session",
        "peers_send" | "mcp__workerdeck__peers_send" => "Messaging a peer session",
        "session_info" | "mcp__workerdeck__session_info" => "Checking session info",
        _ => return None,
    };
    if title == name {
        return None;
    }
    Some(Str::from(title))
}

pub fn apply_event(state: &mut TranscriptState, event: Event) {
    if event.seq <= state.last_seq {
        return;
    }
    state.last_seq = event.seq;
    let seq = event.seq;

    match event.body {
        Body::SystemInit { model, cwd, sdk_session_id, permission_mode } => {
            state.model = Some(model);
            state.cwd = Some(cwd);
            state.sdk_session_id = Some(sdk_session_id);
            state.permission_mode = Some(permission_mode);
        }
        Body::StatusChanged { status, detail } => {
            state.status = Some(status);
            state.status_detail = detail;
        }
        Body::ContextUsage(usage) => state.context_usage = Some(usage),
        Body::UserMessage(payload) => {
            let synthetic = payload.synthetic == Some(true);
            let carries_caveat = payload.content.iter().any(|b| match b {
                ContentBlock::Text(t) => t.trim_start().starts_with(LOCAL_COMMAND_CAVEAT),
                _ => false,
            });
            for block in payload.content {
                match block {
                    ContentBlock::ToolResult(result) => {
                        let is_error = result.is_error == Some(true);
                        let truncated = result.truncated == Some(true);
                        let text: Str = Str::from(result.content.as_ref().map(|c| c.joined_text()).unwrap_or_default());
                        for item in state.items.iter_mut() {
                            if let Item::ToolCall(call) = item
                                && *call.id == *result.tool_use_id
                            {
                                let updated = Arc::make_mut(call);
                                updated.status = if is_error { ToolCallStatus::Failed } else { ToolCallStatus::Settled };
                                updated.live_tail = None;
                                updated.result = Some(ToolCallResult {
                                    text: text.clone(),
                                    is_error,
                                    truncated,
                                    total_chars: if truncated { result.total_chars } else { None },
                                    source_seq: if truncated { Some(seq) } else { None },
                                });
                            }
                        }
                    }
                    ContentBlock::Text(text) => {
                        let id: Str = match &payload.uuid {
                            Some(u) => Str::from(u.as_str()),
                            None => Str::from(format!("user-{seq}")),
                        };
                        if let Some((stream, body)) = match_local_command_output(text.trim()) {
                            let level = if stream == "stderr" { NoticeLevel::Error } else { NoticeLevel::Info };
                            let item = Item::Notice { id, level, text: Str::from(body.trim()) };
                            upsert(&mut state.items, item);
                        } else if text.trim_start().starts_with(LOCAL_COMMAND_CAVEAT) {
                            // TODO(P2): the deferred `!` flush.
                        } else if !synthetic || carries_caveat {
                            let item = Item::User {
                                id,
                                text: Str::from(text),
                                parent_tool_use_id: payload.parent_tool_use_id.as_deref().map(Str::from),
                            };
                            upsert(&mut state.items, item);
                        }
                    }
                    _ => {}
                }
            }
        }
        Body::AssistantMessage(payload) => {
            let parent = payload.parent_tool_use_id.as_deref();
            let streaming_text = stream_id(STREAMING_ID, parent);
            let streaming_thought = stream_id(STREAMING_THINKING_ID, parent);
            let mut streamed_thinking = streamed_text(&state.items, ItemKind::Thinking, &streaming_thought);
            state.items.retain(|item| {
                !(item.kind() == ItemKind::AssistantText && item.id() == streaming_text)
                    && !(item.kind() == ItemKind::Thinking && item.id() == streaming_thought)
            });
            let parent_str: Option<Str> = parent.map(Str::from);
            for (index, block) in payload.content.into_iter().enumerate() {
                let id = || Str::from(format!("{}-{}", payload.uuid, index));
                match block {
                    ContentBlock::Text(text) => {
                        let item = Item::AssistantText {
                            id: id(),
                            text: Str::from(text),
                            streaming: false,
                            parent_tool_use_id: parent_str.clone(),
                        };
                        upsert(&mut state.items, item);
                    }
                    ContentBlock::Thinking(thinking) => {
                        let text: Str = if thinking.is_empty() { streamed_thinking.clone() } else { Str::from(thinking) };
                        streamed_thinking = Str::from("");
                        if text.trim().is_empty() {
                            continue;
                        }
                        let item = Item::Thinking { id: id(), text, parent_tool_use_id: parent_str.clone() };
                        upsert(&mut state.items, item);
                    }
                    ContentBlock::ToolUse { id: tool_id, name, input } => {
                        let item = Item::ToolCall(Arc::new(ToolCall {
                            title: tool_title(&name),
                            id: Str::from(tool_id),
                            name: Str::from(name),
                            input,
                            parent_tool_use_id: parent_str.clone(),
                            status: ToolCallStatus::Running,
                            result: None,
                            ts: Some(event.ts),
                            live_tail: None,
                        }));
                        upsert(&mut state.items, item);
                    }
                    _ => {}
                }
            }
        }
        Body::StreamDelta(payload) => {
            if payload.event_type != "content_block_delta" || payload.delta_type.is_none() {
                return;
            }
            let parent = payload.parent_tool_use_id.as_deref();
            match payload.delta_type.as_deref() {
                Some("text_delta") => {
                    let id = stream_id(STREAMING_ID, parent);
                    let existing = streamed_text(&state.items, ItemKind::AssistantText, &id);
                    let text = concat(&existing, payload.text.as_deref().unwrap_or(""));
                    let item = Item::AssistantText { id: Str::from(id), text, streaming: true, parent_tool_use_id: parent.map(Str::from) };
                    upsert(&mut state.items, item);
                }
                Some("thinking_delta") => {
                    let id = stream_id(STREAMING_THINKING_ID, parent);
                    let existing = streamed_text(&state.items, ItemKind::Thinking, &id);
                    let text = concat(&existing, payload.thinking.as_deref().unwrap_or(""));
                    if text.trim().is_empty() {
                        return;
                    }
                    let item = Item::Thinking { id: Str::from(id), text, parent_tool_use_id: parent.map(Str::from) };
                    upsert(&mut state.items, item);
                }
                _ => {}
            }
        }
        Body::TurnResult(payload) => {
            state.total_cost_usd = payload.total_cost_usd;
            state.cost_usd = payload.cost_usd.or(state.cost_usd);
            for item in state.items.iter_mut() {
                match item {
                    Item::AssistantText { id, text, parent_tool_use_id, .. } if is_streaming(id, STREAMING_ID) => {
                        let suffix = parent_tool_use_id.as_ref().map(|p| format!("-{p}")).unwrap_or_default();
                        *item = Item::AssistantText {
                            id: Str::from(format!("text-{seq}{suffix}")),
                            text: text.clone(),
                            streaming: false,
                            parent_tool_use_id: parent_tool_use_id.clone(),
                        };
                    }
                    Item::Thinking { id, text, parent_tool_use_id } if is_streaming(id, STREAMING_THINKING_ID) => {
                        let suffix = parent_tool_use_id.as_ref().map(|p| format!("-{p}")).unwrap_or_default();
                        *item = Item::Thinking {
                            id: Str::from(format!("thinking-{seq}{suffix}")),
                            text: text.clone(),
                            parent_tool_use_id: parent_tool_use_id.clone(),
                        };
                    }
                    _ => {}
                }
            }
            state.items.push(Item::TurnResult {
                id: Str::from(format!("turn-{seq}")),
                subtype: Str::from(payload.subtype),
                is_error: payload.is_error,
                duration_ms: payload.duration_ms,
                total_cost_usd: payload.total_cost_usd,
                cost_usd: payload.cost_usd,
                errors: payload.errors.map(Arc::new),
            });
        }
        Body::Unknown => {}
    }
}
