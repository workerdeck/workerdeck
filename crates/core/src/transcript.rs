use crate::protocol::{Body, ContentBlock, ContextUsage, Event, SessionStatus, ToolResultContent};
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
    FileDelivered,
    Compaction,
    Shell,
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
            ItemKind::FileDelivered => "fileDelivered",
            ItemKind::Compaction => "compaction",
            ItemKind::Shell => "shell",
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
    pub images: Option<Arc<Vec<ImageRef>>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ImageRef {
    pub part_index: f64,
    pub media_type: Str,
    pub bytes: f64,
    pub source_seq: i64,
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
    pub patch: Option<Arc<Value>>,
    pub execution_id: Option<Str>,
    pub backend: Option<Str>,
    pub logs: Option<Arc<Vec<String>>>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct CompactionItem {
    pub id: Str,
    pub parent_tool_use_id: Option<Str>,
    pub pending: Option<bool>,
    pub trigger: Option<Str>,
    pub pre_tokens: Option<f64>,
    pub post_tokens: Option<f64>,
    pub error: Option<Str>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ShellItem {
    pub id: Str,
    pub shell: Arc<Value>,
    pub text: Str,
    pub truncated: bool,
    pub expanded: Option<Str>,
    pub missing: bool,
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
        attachments: Option<Arc<Value>>,
        origin: Option<Arc<Value>>,
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
        addressed: bool,
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
    FileDelivered {
        id: Str,
        path: Str,
        bytes: f64,
        description: Option<Str>,
    },
    Compaction(Arc<CompactionItem>),
    Shell(Arc<ShellItem>),
}

impl Item {
    pub fn id(&self) -> &str {
        match self {
            Item::User { id, .. }
            | Item::AssistantText { id, .. }
            | Item::Thinking { id, .. }
            | Item::TurnResult { id, .. }
            | Item::Notice { id, .. }
            | Item::FileDelivered { id, .. } => id,
            Item::ToolCall(call) => &call.id,
            Item::Compaction(item) => &item.id,
            Item::Shell(item) => &item.id,
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
            Item::FileDelivered { .. } => ItemKind::FileDelivered,
            Item::Compaction(_) => ItemKind::Compaction,
            Item::Shell(_) => ItemKind::Shell,
        }
    }

    pub fn parent_tool_use_id(&self) -> Option<&Str> {
        match self {
            Item::User { parent_tool_use_id, .. }
            | Item::AssistantText { parent_tool_use_id, .. }
            | Item::Thinking { parent_tool_use_id, .. } => parent_tool_use_id.as_ref(),
            Item::ToolCall(call) => call.parent_tool_use_id.as_ref(),
            Item::Compaction(item) => item.parent_tool_use_id.as_ref(),
            Item::TurnResult { .. } | Item::Notice { .. } | Item::FileDelivered { .. } | Item::Shell(_) => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct ProducedFile {
    pub file_id: String,
    pub media_type: Option<String>,
    pub bytes: Option<f64>,
}

#[derive(Default)]
pub struct TranscriptState {
    pub status: Option<SessionStatus>,
    pub status_detail: Option<String>,
    pub engine_asleep: bool,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub cwd: Option<String>,
    pub sdk_session_id: Option<String>,
    pub models: Option<Arc<Value>>,
    pub commands: Option<Arc<Value>>,
    pub skills: Option<Arc<Value>>,
    pub checklist: Option<Vec<Value>>,
    pub tool_titles: Vec<(String, String)>,
    pub produced_files: Vec<(String, ProducedFile)>,
    pub default_model: Option<String>,
    pub permission_mode: Option<String>,
    pub context_usage: Option<ContextUsage>,
    pub rate_limits: Vec<(String, Arc<Value>)>,
    pub rate_limits_updated_at: Option<f64>,
    pub subscription_type: Option<String>,
    pub items: Vec<Item>,
    pub pending_approvals: Vec<Arc<Value>>,
    pub total_cost_usd: f64,
    pub cost_usd: Option<f64>,
    pub usage_by_model: Option<Arc<Value>>,
    pub last_seq: i64,
}

fn set<V>(entries: &mut Vec<(String, V)>, key: String, value: V) {
    match entries.iter_mut().find(|(k, _)| *k == key) {
        Some(entry) => entry.1 = value,
        None => entries.push((key, value)),
    }
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

fn local_command_elements(text: &str) -> Vec<(&'static str, &str)> {
    let mut out = Vec::new();
    let mut from = 0;
    while let Some(at) = text[from..].find("<local-command-").map(|at| from + at) {
        let rest = &text[at + "<local-command-".len()..];
        let stream = ["stdout", "stderr"].into_iter().find(|stream| rest.starts_with(stream) && rest[stream.len()..].starts_with('>'));
        let Some(stream) = stream else {
            from = at + 1;
            continue;
        };
        let body_at = at + "<local-command-".len() + stream.len() + 1;
        let close = format!("</local-command-{stream}>");
        match text[body_at..].find(&close) {
            Some(end) => {
                out.push((stream, &text[body_at..body_at + end]));
                from = body_at + end + close.len();
            }
            None => from = at + 1,
        }
    }
    out
}

fn tag<'a>(text: &'a str, name: &str) -> Option<&'a str> {
    let open = format!("<{name}>");
    let close = format!("</{name}>");
    let start = text.find(&open)? + open.len();
    let end = text[start..].find(&close)?;
    Some(&text[start..start + end])
}

fn slash_command_text(text: &str) -> Option<String> {
    let name = tag(text, "command-name")?.trim();
    if name.is_empty() {
        return None;
    }
    match tag(text, "command-args").map(str::trim) {
        Some(args) if !args.is_empty() => Some(format!("{name} {args}")),
        _ => Some(name.to_owned()),
    }
}

fn is_shell_end_line(line: &str) -> bool {
    let Some(inner) = line.strip_prefix('[').and_then(|l| l.strip_suffix(']')) else {
        return false;
    };
    if inner.contains(']') {
        return false;
    }
    if let Some(code) = inner.strip_prefix("exit ") {
        let digits = code.strip_prefix('-').unwrap_or(code);
        return digits.starts_with(|c: char| c.is_ascii_digit());
    }
    ["killed", "timed out", "ended", "failed to start"].iter().any(|word| inner.starts_with(word))
}

pub fn shell_row_text(shell: &Value, text: &str) -> (String, bool) {
    let trimmed = text.trim();
    let body = match_local_command_output(trimmed).map_or(text, |(_, body)| body);
    let mut lines: Vec<&str> = body.split('\n').collect();
    if lines.first().is_some_and(|line| line.starts_with("$ ")) {
        lines.remove(0);
    }
    if shell.get("status").and_then(Value::as_str) == Some("exited") && lines.last().is_some_and(|line| is_shell_end_line(line)) {
        lines.pop();
    }
    let mut truncated = false;
    lines.retain(|line| {
        if *line == "[... more output ...]" {
            truncated = true;
            return false;
        }
        true
    });
    (lines.join("\n").trim_end().to_owned(), truncated)
}

fn image_refs(content: &Option<ToolResultContent>, seq: i64) -> Option<Arc<Vec<ImageRef>>> {
    let Some(ToolResultContent::Parts(parts)) = content else {
        return None;
    };
    let refs: Vec<ImageRef> = parts
        .iter()
        .filter(|part| part.ty == "image_ref")
        .map(|part| ImageRef {
            part_index: part.part_index.map_or(f64::NAN, |index| index as f64),
            media_type: Str::from(part.media_type.as_deref().unwrap_or("application/octet-stream")),
            bytes: part.bytes.unwrap_or(0) as f64,
            source_seq: seq,
        })
        .collect();
    (!refs.is_empty()).then(|| Arc::new(refs))
}

fn update_call(items: &mut [Item], id: &str, update: impl Fn(&mut ToolCall)) {
    for item in items.iter_mut() {
        if let Item::ToolCall(call) = item
            && *call.id == *id
        {
            update(Arc::make_mut(call));
        }
    }
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
        Body::EngineSleep(asleep) => state.engine_asleep = asleep,
        Body::Capabilities { models, commands, default_model } => {
            state.models = models;
            state.commands = commands;
            if default_model.is_some() {
                state.default_model = default_model;
            }
        }
        Body::Skills(skills) => state.skills = Some(skills),
        Body::Checklist(items) => state.checklist = (!items.is_empty()).then_some(items),
        Body::ToolTitles(titles) => {
            for (name, title) in titles {
                set(&mut state.tool_titles, name, title);
            }
        }
        Body::FileProduced { path, file_id, media_type, bytes } => {
            let media_type = media_type.filter(|m| !m.is_empty());
            set(&mut state.produced_files, path, ProducedFile { file_id, media_type, bytes });
        }
        Body::ModelChanged(model) => {
            if model.is_some() {
                state.model = model;
            }
        }
        Body::EffortChanged(effort) => state.effort = effort,
        Body::PermissionModeChanged(mode) => state.permission_mode = Some(mode),
        Body::ContextUsage(usage) => state.context_usage = Some(usage),
        Body::RateLimit(info) => {
            let Some(key) = info.get("rateLimitType").and_then(Value::as_str).filter(|key| !key.is_empty()).map(str::to_owned) else {
                return;
            };
            set(&mut state.rate_limits, key, info);
            state.rate_limits_updated_at = Some(event.ts);
        }
        Body::PlanInfo(subscription_type) => state.subscription_type = subscription_type,
        Body::ConversationReset { agent_reason, sdk_session_id } => {
            state.items.clear();
            if let Some(reason) = agent_reason {
                state.items.push(Item::Notice {
                    id: Str::from(format!("reset-{seq}")),
                    level: NoticeLevel::Info,
                    text: Str::from(format!("The agent cleared its context: {reason}")),
                });
            }
            state.context_usage = None;
            state.checklist = None;
            if sdk_session_id.is_some() {
                state.sdk_session_id = sdk_session_id;
            }
        }
        Body::ContextCompacted(c) => {
            let item = CompactionItem {
                id: Str::from(c.uuid),
                parent_tool_use_id: c.parent_tool_use_id.map(Str::from),
                pending: c.pending,
                trigger: c.trigger.map(Str::from),
                pre_tokens: c.pre_tokens,
                post_tokens: c.post_tokens,
                error: c.error.map(Str::from),
            };
            upsert(&mut state.items, Item::Compaction(Arc::new(item)));
        }
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
                        let images = image_refs(&result.content, seq);
                        update_call(&mut state.items, &result.tool_use_id, |call| {
                            call.status = if is_error { ToolCallStatus::Failed } else { ToolCallStatus::Settled };
                            call.live_tail = None;
                            call.result = Some(ToolCallResult {
                                text: text.clone(),
                                is_error,
                                truncated,
                                total_chars: if truncated { result.total_chars } else { None },
                                source_seq: if truncated { Some(seq) } else { None },
                                images: images.clone(),
                            });
                            if payload.patch.is_some() {
                                call.patch = payload.patch.clone();
                            }
                        });
                    }
                    ContentBlock::Text(text) => {
                        let id: Str = match &payload.uuid {
                            Some(u) => Str::from(u.as_str()),
                            None => Str::from(format!("user-{seq}")),
                        };
                        if let Some(shell) = &payload.shell {
                            let expanded = state.items.iter().find_map(|item| match item {
                                Item::Shell(existing) if existing.id == id => existing.expanded.clone(),
                                _ => None,
                            });
                            let (text, truncated) = shell_row_text(shell, &text);
                            let item = ShellItem { id, shell: shell.clone(), text: Str::from(text), truncated, expanded, missing: false };
                            upsert(&mut state.items, Item::Shell(Arc::new(item)));
                        } else if let Some((stream, body)) = match_local_command_output(text.trim()) {
                            let level = if stream == "stderr" { NoticeLevel::Error } else { NoticeLevel::Info };
                            let item = Item::Notice { id, level, text: Str::from(body.trim()) };
                            upsert(&mut state.items, item);
                        } else if text.trim_start().starts_with(LOCAL_COMMAND_CAVEAT) {
                            for (index, (stream, body)) in local_command_elements(&text).into_iter().enumerate() {
                                let level = if stream == "stderr" { NoticeLevel::Error } else { NoticeLevel::Info };
                                let item = Item::Notice { id: Str::from(format!("{id}#{index}")), level, text: Str::from(body.trim()) };
                                upsert(&mut state.items, item);
                            }
                        } else if !synthetic || carries_caveat {
                            let text = slash_command_text(&text).unwrap_or(text);
                            let item = Item::User {
                                id,
                                text: Str::from(text),
                                parent_tool_use_id: payload.parent_tool_use_id.as_deref().map(Str::from),
                                attachments: payload.attachments.clone(),
                                origin: payload.origin.clone(),
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
                    ContentBlock::Thinking { text: thinking, addressed } => {
                        let text: Str = if thinking.is_empty() { streamed_thinking.clone() } else { Str::from(thinking) };
                        streamed_thinking = Str::from("");
                        if text.trim().is_empty() {
                            continue;
                        }
                        let item = Item::Thinking { id: id(), text, parent_tool_use_id: parent_str.clone(), addressed };
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
                            patch: None,
                            execution_id: None,
                            backend: None,
                            logs: None,
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
                    let item = Item::Thinking { id: Str::from(id), text, parent_tool_use_id: parent.map(Str::from), addressed: false };
                    upsert(&mut state.items, item);
                }
                _ => {}
            }
        }
        Body::TurnResult(payload) => {
            state.total_cost_usd = payload.total_cost_usd;
            state.cost_usd = payload.cost_usd.or(state.cost_usd);
            if payload.usage_by_model.is_some() {
                state.usage_by_model = payload.usage_by_model;
            }
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
                    Item::Thinking { id, text, parent_tool_use_id, addressed } if is_streaming(id, STREAMING_THINKING_ID) => {
                        let suffix = parent_tool_use_id.as_ref().map(|p| format!("-{p}")).unwrap_or_default();
                        *item = Item::Thinking {
                            id: Str::from(format!("thinking-{seq}{suffix}")),
                            text: text.clone(),
                            parent_tool_use_id: parent_tool_use_id.clone(),
                            addressed: *addressed,
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
        Body::PermissionRequested(request) => state.pending_approvals.push(request),
        Body::PermissionResolved(id) => {
            state.pending_approvals.retain(|request| request.get("id").and_then(Value::as_str) != Some(id.as_str()));
        }
        Body::ToolOutput { tool_use_id, tail } => {
            let target = state.items.iter_mut().find(|item| matches!(item, Item::ToolCall(call) if *call.id == *tool_use_id));
            if let Some(Item::ToolCall(call)) = target
                && matches!(call.status, ToolCallStatus::Running | ToolCallStatus::Pending)
                && call.live_tail.as_deref() != Some(tail.as_str())
            {
                Arc::make_mut(call).live_tail = Some(Str::from(tail));
            }
        }
        Body::ExecutionDispatched { execution_id, deferred, backend } => {
            update_call(&mut state.items, &execution_id, |call| {
                call.status = if deferred { ToolCallStatus::Deferred } else { ToolCallStatus::Pending };
                call.execution_id = Some(Str::from(execution_id.as_str()));
                call.backend = backend.as_deref().map(Str::from);
            });
        }
        Body::ExecutionResult { execution_id, text, logs } => settle(&mut state.items, &execution_id, text, logs, false),
        Body::ExecutionFailed { execution_id, text, logs } => settle(&mut state.items, &execution_id, text, logs, true),
        Body::FileDelivered { path, bytes, description } => state.items.push(Item::FileDelivered {
            id: Str::from(format!("file-{seq}")),
            path: Str::from(path),
            bytes,
            description: description.map(Str::from),
        }),
        Body::SessionError(message) => {
            state.items.push(Item::Notice { id: Str::from(format!("err-{seq}")), level: NoticeLevel::Error, text: Str::from(message) })
        }
        Body::SessionClosed(reason) => state.items.push(Item::Notice {
            id: Str::from(format!("closed-{seq}")),
            level: NoticeLevel::Info,
            text: Str::from(format!("Session closed ({reason})")),
        }),
        Body::Unknown => {}
    }
}

fn settle(items: &mut [Item], execution_id: &str, text: String, logs: Option<Vec<String>>, failed: bool) {
    let text = Str::from(text);
    let logs = logs.map(Arc::new);
    update_call(items, execution_id, |call| {
        call.status = if failed { ToolCallStatus::Failed } else { ToolCallStatus::Settled };
        call.execution_id = Some(Str::from(execution_id));
        call.result = Some(ToolCallResult {
            text: text.clone(),
            is_error: failed,
            truncated: false,
            total_chars: None,
            source_seq: None,
            images: None,
        });
        if logs.is_some() {
            call.logs = logs.clone();
        }
    });
}
