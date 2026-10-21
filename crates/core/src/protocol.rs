use crate::rest::{PermissionMode, SessionInfo, ShellInfo};
use serde::de::{self, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{Map, Value};
use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;

pub const PROTOCOL_VERSION: i64 = 2;
pub const SHELL_INPUT_MAX: usize = 4096;

pub enum Frame {
    Event(Event),
    ShellOutput { shell_id: String, data: String },
    Attached(Box<AttachedFrame>),
    ToolCallRequest(Box<ToolCallRequestFrame>),
    ToolCallCanceled { execution_id: String, reason: String },
    ProtocolError(String),
    ShellAttached(Box<ShellAttachedFrame>),
    ShellDetached { shell_id: String, reason: String },
    Ack { client_id: String },
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachedFrame {
    pub protocol_version: i64,
    pub session: SessionInfo,
    pub replaying_from: i64,
    #[serde(default)]
    pub shell: Option<bool>,
    #[serde(default)]
    pub pricing_overrides: Option<Value>,
    #[serde(default)]
    pub acks: Option<bool>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ToolCallRequestFrame {
    pub execution_id: String,
    pub tool_name: String,
    pub input: Value,
    pub vfs_seed: Option<BTreeMap<String, String>>,
    pub limits: Option<ToolCallLimits>,
    pub expires_at: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolCallLimits {
    #[serde(default)]
    pub timeout_ms: Option<f64>,
    #[serde(default)]
    pub memory_limit_bytes: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellAttachedFrame {
    pub shell_id: String,
    pub shell: ShellInfo,
    pub cols: i64,
    pub rows: i64,
    pub scrollback: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PermissionBehavior {
    Allow,
    Deny,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", rename_all_fields = "camelCase")]
pub enum ClientFrame {
    UserMessage {
        text: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        attachment_ids: Option<Vec<String>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        client_id: Option<String>,
    },
    PermissionDecision {
        request_id: String,
        behavior: PermissionBehavior,
        #[serde(skip_serializing_if = "Option::is_none")]
        updated_input: Option<Map<String, Value>>,
        #[serde(skip_serializing_if = "Option::is_none")]
        message: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        interrupt: Option<bool>,
    },
    Interrupt,
    ClearContext,
    Sleep,
    BackgroundTask {
        #[serde(skip_serializing_if = "Option::is_none")]
        tool_use_id: Option<String>,
    },
    SetPermissionMode {
        mode: PermissionMode,
    },
    SetModel {
        #[serde(skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
    SetEffort {
        #[serde(skip_serializing_if = "Option::is_none")]
        effort: Option<String>,
    },
    ToolCallResult {
        execution_id: String,
        output: Value,
        #[serde(skip_serializing_if = "Option::is_none")]
        logs: Option<Vec<String>>,
    },
    ToolCallError {
        execution_id: String,
        reason: String,
        error: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        logs: Option<Vec<String>>,
    },
    ShellCommand {
        command: String,
    },
    ShellAttach {
        shell_id: String,
        cols: u32,
        rows: u32,
    },
    ShellInput {
        shell_id: String,
        data: String,
    },
    ShellResize {
        shell_id: String,
        cols: u32,
        rows: u32,
    },
    ShellDetach {
        shell_id: String,
    },
    Close,
}

impl ClientFrame {
    pub fn encode(&self) -> String {
        serde_json::to_string(self).unwrap_or_default()
    }
}

pub struct Event {
    pub seq: i64,
    pub ts: f64,
    pub body: Body,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SessionStatus {
    Starting,
    Running,
    AwaitingApproval,
    Idle,
    Parked,
    Failed,
    Closed,
}

impl SessionStatus {
    pub fn parse(s: &str) -> Option<Self> {
        Some(match s {
            "starting" => Self::Starting,
            "running" => Self::Running,
            "awaiting_approval" => Self::AwaitingApproval,
            "idle" => Self::Idle,
            "parked" => Self::Parked,
            "failed" => Self::Failed,
            "closed" => Self::Closed,
            _ => return None,
        })
    }

    pub fn raw(self) -> &'static str {
        match self {
            Self::Starting => "starting",
            Self::Running => "running",
            Self::AwaitingApproval => "awaiting_approval",
            Self::Idle => "idle",
            Self::Parked => "parked",
            Self::Failed => "failed",
            Self::Closed => "closed",
        }
    }
}

#[derive(Clone)]
pub struct ContextUsage {
    pub total_tokens: i64,
    pub max_tokens: i64,
    pub percentage: f64,
    pub model: Option<String>,
    pub categories: Vec<(String, i64, String)>,
}

pub enum ToolResultContent {
    Text(String),
    Parts(Vec<ToolResultPart>),
}

impl ToolResultContent {
    pub fn joined_text(&self) -> String {
        match self {
            ToolResultContent::Text(t) => t.clone(),
            ToolResultContent::Parts(parts) => {
                let mut out = String::new();
                let mut first = true;
                for part in parts {
                    if let Some(t) = &part.text {
                        if t.is_empty() {
                            continue;
                        }
                        if !first {
                            out.push('\n');
                        }
                        first = false;
                        out.push_str(t);
                    }
                }
                out
            }
        }
    }
}

#[derive(Deserialize)]
pub struct ToolResultPart {
    #[serde(rename = "type")]
    pub ty: String,
    pub text: Option<String>,
    pub media_type: Option<String>,
    pub bytes: Option<i64>,
    pub part_index: Option<i64>,
}

pub struct ToolResultBlock {
    pub tool_use_id: String,
    pub content: Option<ToolResultContent>,
    pub is_error: Option<bool>,
    pub truncated: Option<bool>,
    pub total_chars: Option<i64>,
}

pub enum ContentBlock {
    Text(String),
    Thinking { text: String, addressed: bool },
    ToolUse { id: String, name: String, input: Arc<Value> },
    ToolResult(ToolResultBlock),
    Unknown,
}

pub struct UserMessage {
    pub content: Vec<ContentBlock>,
    pub parent_tool_use_id: Option<String>,
    pub synthetic: Option<bool>,
    pub replay: bool,
    pub uuid: Option<String>,
    pub attachments: Option<Arc<Value>>,
    pub origin: Option<Arc<Value>>,
    pub shell: Option<Arc<Value>>,
    pub patch: Option<Arc<Value>>,
}

pub struct AssistantMessage {
    pub content: Vec<ContentBlock>,
    pub parent_tool_use_id: Option<String>,
    pub uuid: String,
}

pub struct StreamDelta {
    pub event_type: String,
    pub delta_type: Option<String>,
    pub text: Option<String>,
    pub thinking: Option<String>,
    pub parent_tool_use_id: Option<String>,
}

pub struct TurnResult {
    pub subtype: String,
    pub is_error: bool,
    pub duration_ms: f64,
    pub total_cost_usd: f64,
    pub cost_usd: Option<f64>,
    pub errors: Option<Vec<String>>,
    pub usage_by_model: Option<Arc<Value>>,
}

pub struct Compaction {
    pub uuid: String,
    pub parent_tool_use_id: Option<String>,
    pub pending: Option<bool>,
    pub trigger: Option<String>,
    pub pre_tokens: Option<f64>,
    pub post_tokens: Option<f64>,
    pub error: Option<String>,
}

pub enum Body {
    SystemInit { model: String, cwd: String, sdk_session_id: String, permission_mode: String },
    StatusChanged { status: SessionStatus, detail: Option<String> },
    ContextUsage(ContextUsage),
    UserMessage(UserMessage),
    AssistantMessage(AssistantMessage),
    StreamDelta(StreamDelta),
    TurnResult(TurnResult),
    EngineSleep(bool),
    Capabilities { models: Option<Arc<Value>>, commands: Option<Arc<Value>>, default_model: Option<String> },
    Skills(Arc<Value>),
    Checklist(Vec<Value>),
    ToolTitles(Vec<(String, String)>),
    FileProduced { path: String, file_id: String, media_type: Option<String>, bytes: Option<f64> },
    ModelChanged(Option<String>),
    EffortChanged(Option<String>),
    PermissionModeChanged(String),
    RateLimit(Arc<Value>),
    PlanInfo(Option<String>),
    ConversationReset { agent_reason: Option<String>, sdk_session_id: Option<String> },
    ContextCompacted(Compaction),
    PermissionRequested(Arc<Value>),
    PermissionResolved(String),
    ToolOutput { tool_use_id: String, tail: String },
    ExecutionDispatched { execution_id: String, deferred: bool, backend: Option<String> },
    ExecutionResult { execution_id: String, text: String, logs: Option<Vec<String>> },
    ExecutionFailed { execution_id: String, text: String, logs: Option<Vec<String>> },
    FileDelivered { path: String, bytes: f64, description: Option<String> },
    SessionError(String),
    SessionClosed(String),
    SessionSuperseded(String),
    Unknown,
}

#[derive(Default)]
struct LStr(Option<String>);
#[derive(Default)]
struct LBool(Option<bool>);
#[derive(Default)]
struct LNum(Option<f64>);
#[derive(Default)]
struct LInt(Option<i64>);

macro_rules! lenient {
    ($name:ident, $t:ty, $($method:ident($arg:ty) => $conv:expr),*) => {
        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                struct V;
                impl<'de> Visitor<'de> for V {
                    type Value = Option<$t>;
                    fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result { f.write_str("any") }
                    $(fn $method<E: de::Error>(self, v: $arg) -> Result<Self::Value, E> { Ok($conv(v)) })*
                    fn visit_unit<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }
                    fn visit_none<E: de::Error>(self) -> Result<Self::Value, E> { Ok(None) }
                    fn visit_bool<E: de::Error>(self, _v: bool) -> Result<Self::Value, E> { lenient!(@bool $name _v) }
                    fn visit_seq<A: SeqAccess<'de>>(self, mut a: A) -> Result<Self::Value, A::Error> {
                        while a.next_element::<IgnoredAny>()?.is_some() {}
                        Ok(None)
                    }
                    fn visit_map<A: MapAccess<'de>>(self, mut a: A) -> Result<Self::Value, A::Error> {
                        while a.next_entry::<IgnoredAny, IgnoredAny>()?.is_some() {}
                        Ok(None)
                    }
                    fn visit_str<E: de::Error>(self, _v: &str) -> Result<Self::Value, E> { lenient!(@str $name _v) }
                    fn visit_string<E: de::Error>(self, _v: String) -> Result<Self::Value, E> { lenient!(@string $name _v) }
                    fn visit_i64<E: de::Error>(self, _v: i64) -> Result<Self::Value, E> { lenient!(@i64 $name _v) }
                    fn visit_u64<E: de::Error>(self, _v: u64) -> Result<Self::Value, E> { lenient!(@u64 $name _v) }
                    fn visit_f64<E: de::Error>(self, _v: f64) -> Result<Self::Value, E> { lenient!(@f64 $name _v) }
                }
                d.deserialize_any(V).map($name)
            }
        }
    };
    (@bool LBool $v:ident) => { Ok(Some($v)) };
    (@bool $n:ident $v:ident) => { Ok(None) };
    (@str LStr $v:ident) => { Ok(Some($v.to_owned())) };
    (@str $n:ident $v:ident) => { Ok(None) };
    (@string LStr $v:ident) => { Ok(Some($v)) };
    (@string $n:ident $v:ident) => { Ok(None) };
    (@i64 LNum $v:ident) => { Ok(Some($v as f64)) };
    (@i64 LInt $v:ident) => { Ok(Some($v)) };
    (@i64 $n:ident $v:ident) => { Ok(None) };
    (@u64 LNum $v:ident) => { Ok(Some($v as f64)) };
    (@u64 LInt $v:ident) => { Ok(i64::try_from($v).ok()) };
    (@u64 $n:ident $v:ident) => { Ok(None) };
    (@f64 LNum $v:ident) => { Ok(Some($v)) };
    (@f64 LInt $v:ident) => { Ok(if $v.fract() == 0.0 && $v.abs() < 9.2e18 { Some($v as i64) } else { None }) };
    (@f64 $n:ident $v:ident) => { Ok(None) };
}

lenient!(LStr, String,);
lenient!(LBool, bool,);
lenient!(LNum, f64,);
lenient!(LInt, i64,);

#[derive(Deserialize)]
struct RawFrame<'a> {
    #[serde(rename = "type", default)]
    ty: LStr,
    #[serde(borrow, default)]
    event: Option<&'a RawValue>,
    #[serde(rename = "shellId", default)]
    shell_id: LStr,
    #[serde(default)]
    data: LStr,
}

#[derive(Deserialize)]
struct RawEvent<'a> {
    #[serde(default)]
    seq: LInt,
    #[serde(default)]
    ts: LNum,
    #[serde(rename = "type", default)]
    ty: LStr,
    #[serde(default)]
    status: LStr,
    #[serde(default)]
    detail: LStr,
    #[serde(borrow, default)]
    message: Option<&'a RawValue>,
    #[serde(borrow, default)]
    event: Option<&'a RawValue>,
    #[serde(borrow, default)]
    usage: Option<&'a RawValue>,
    #[serde(rename = "parentToolUseId", default)]
    parent_tool_use_id: LStr,
    #[serde(default)]
    uuid: LStr,
    #[serde(default)]
    synthetic: LBool,
    #[serde(default)]
    replay: LBool,
    #[serde(rename = "sdkSessionId", default)]
    sdk_session_id: LStr,
    #[serde(default)]
    model: LStr,
    #[serde(default)]
    cwd: LStr,
    #[serde(rename = "apiKeySource", default)]
    api_key_source: LStr,
    #[serde(rename = "permissionMode", default)]
    permission_mode: LStr,
    #[serde(rename = "claudeCodeVersion", default)]
    claude_code_version: LStr,
    #[serde(borrow, default)]
    tools: Option<&'a RawValue>,
    #[serde(borrow, default)]
    skills: Option<&'a RawValue>,
    #[serde(rename = "slashCommands", borrow, default)]
    slash_commands: Option<&'a RawValue>,
    #[serde(rename = "mcpServers", borrow, default)]
    mcp_servers: Option<&'a RawValue>,
    #[serde(default)]
    subtype: LStr,
    #[serde(rename = "isError", default)]
    is_error: LBool,
    #[serde(rename = "durationMs", default)]
    duration_ms: LNum,
    #[serde(rename = "numTurns", default)]
    num_turns: LInt,
    #[serde(rename = "totalCostUsd", default)]
    total_cost_usd: LNum,
    #[serde(rename = "costUsd", default)]
    cost_usd: LNum,
    #[serde(borrow, default)]
    errors: Option<&'a RawValue>,
    #[serde(borrow, default)]
    attachments: Option<&'a RawValue>,
    #[serde(borrow, default)]
    origin: Option<&'a RawValue>,
    #[serde(borrow, default)]
    shell: Option<&'a RawValue>,
    #[serde(borrow, default)]
    patch: Option<&'a RawValue>,
    #[serde(rename = "usageByModel", borrow, default)]
    usage_by_model: Option<&'a RawValue>,
}

#[derive(Deserialize)]
struct RawMessage<'a> {
    #[serde(default)]
    role: LStr,
    #[serde(borrow, default)]
    content: Option<&'a RawValue>,
}

#[derive(Deserialize)]
struct RawBlock<'a> {
    #[serde(rename = "type", default)]
    ty: LStr,
    #[serde(default)]
    text: LStr,
    #[serde(default)]
    thinking: LStr,
    #[serde(default)]
    addressed: LBool,
    #[serde(default)]
    id: LStr,
    #[serde(default)]
    name: LStr,
    #[serde(default)]
    input: Option<Value>,
    #[serde(default)]
    tool_use_id: LStr,
    #[serde(borrow, default)]
    content: Option<&'a RawValue>,
    #[serde(default)]
    is_error: LBool,
    #[serde(default)]
    truncated: LBool,
    #[serde(default)]
    total_chars: LInt,
}

#[derive(Deserialize)]
struct RawStreamBody {
    #[serde(rename = "type", default)]
    ty: LStr,
    #[serde(default)]
    delta: Option<RawDelta>,
}

#[derive(Deserialize)]
struct RawDelta {
    #[serde(rename = "type", default)]
    ty: LStr,
    #[serde(default)]
    text: LStr,
    #[serde(default)]
    thinking: LStr,
}

#[derive(Deserialize)]
struct RawUsage {
    #[serde(default)]
    categories: Option<Vec<RawCategory>>,
    #[serde(rename = "totalTokens", default)]
    total_tokens: LInt,
    #[serde(rename = "maxTokens", default)]
    max_tokens: LInt,
    #[serde(default)]
    percentage: LNum,
    #[serde(default)]
    model: LStr,
}

#[derive(Deserialize)]
struct RawCategory {
    name: String,
    tokens: i64,
    color: String,
}

pub fn decode_frame(line: &[u8]) -> Option<Frame> {
    let raw: RawFrame = serde_json::from_slice(line).ok()?;
    let ty = raw.ty.0?;
    match ty.as_str() {
        "event" => {
            let event = decode_event(raw.event?.get())?;
            Some(Frame::Event(event))
        }
        "shell_output" => match (raw.shell_id.0, raw.data.0) {
            (Some(shell_id), Some(data)) => Some(Frame::ShellOutput { shell_id, data }),
            _ => Some(Frame::Unknown),
        },
        _ => Some(decode_cold_frame(&ty, line).unwrap_or(Frame::Unknown)),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawToolCallRequest<'a> {
    execution_id: String,
    tool_name: String,
    #[serde(borrow, default)]
    input: Option<&'a RawValue>,
    #[serde(default)]
    vfs_seed: Option<BTreeMap<String, String>>,
    #[serde(default)]
    limits: Option<ToolCallLimits>,
    #[serde(default)]
    expires_at: Option<f64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawCanceled {
    execution_id: String,
    reason: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawAck {
    client_id: String,
}

#[derive(Deserialize)]
struct RawProtocolError {
    message: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RawShellDetached {
    shell_id: String,
    reason: String,
}

fn decode_cold_frame(ty: &str, line: &[u8]) -> Option<Frame> {
    Some(match ty {
        // An attach this reader cannot follow would otherwise leave the session connecting forever; say why instead.
        "attached" => match serde_json::from_slice(line) {
            Ok(attached) => Frame::Attached(Box::new(attached)),
            Err(error) => Frame::ProtocolError(format!("unreadable attached frame: {error}")),
        },
        "tool_call_request" => {
            let raw: RawToolCallRequest = serde_json::from_slice(line).ok()?;
            Frame::ToolCallRequest(Box::new(ToolCallRequestFrame {
                execution_id: raw.execution_id,
                tool_name: raw.tool_name,
                input: serde_json::from_str(raw.input?.get()).ok()?,
                vfs_seed: raw.vfs_seed,
                limits: raw.limits,
                expires_at: raw.expires_at,
            }))
        }
        "tool_call_canceled" => {
            let raw: RawCanceled = serde_json::from_slice(line).ok()?;
            Frame::ToolCallCanceled { execution_id: raw.execution_id, reason: raw.reason }
        }
        "protocol_error" => Frame::ProtocolError(serde_json::from_slice::<RawProtocolError>(line).ok()?.message),
        "ack" => Frame::Ack { client_id: serde_json::from_slice::<RawAck>(line).ok()?.client_id },
        "shell_attached" => Frame::ShellAttached(Box::new(serde_json::from_slice(line).ok()?)),
        "shell_detached" => {
            let raw: RawShellDetached = serde_json::from_slice(line).ok()?;
            Frame::ShellDetached { shell_id: raw.shell_id, reason: raw.reason }
        }
        _ => return None,
    })
}

fn decode_event(json: &str) -> Option<Event> {
    let raw: RawEvent = serde_json::from_str(json).ok()?;
    let seq = raw.seq.0?;
    let ts = raw.ts.0?;
    let ty = raw.ty.0.clone()?;
    let body = match ty.as_str() {
        "system_init" | "status_changed" | "context_usage" | "user_message" | "assistant_message" | "stream_delta" | "turn_result" => {
            decode_body(&ty, raw)
        }
        _ => serde_json::from_str::<Value>(json).ok().and_then(|value| decode_cold(&ty, &value)),
    }
    .unwrap_or(Body::Unknown);
    Some(Event { seq, ts, body })
}

fn string_list(raw: Option<&RawValue>) -> Option<()> {
    let _: Vec<String> = serde_json::from_str(raw?.get()).ok()?;
    Some(())
}

fn decode_body(ty: &str, raw: RawEvent) -> Option<Body> {
    match ty {
        "system_init" => {
            string_list(raw.tools)?;
            string_list(raw.skills)?;
            string_list(raw.slash_commands)?;
            raw.api_key_source.0.as_ref()?;
            raw.claude_code_version.0.as_ref()?;
            let _: Vec<IgnoredAny> = serde_json::from_str(raw.mcp_servers?.get()).ok()?;
            let mode = raw.permission_mode.0?;
            match mode.as_str() {
                "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk" | "auto" => {}
                _ => return None,
            }
            Some(Body::SystemInit { model: raw.model.0?, cwd: raw.cwd.0?, sdk_session_id: raw.sdk_session_id.0?, permission_mode: mode })
        }
        "status_changed" => Some(Body::StatusChanged { status: SessionStatus::parse(raw.status.0.as_deref()?)?, detail: raw.detail.0 }),
        "context_usage" => {
            let u: RawUsage = serde_json::from_str(raw.usage?.get()).ok()?;
            Some(Body::ContextUsage(ContextUsage {
                categories: u.categories?.into_iter().map(|c| (c.name, c.tokens, c.color)).collect(),
                total_tokens: u.total_tokens.0?,
                max_tokens: u.max_tokens.0?,
                percentage: u.percentage.0?,
                model: u.model.0,
            }))
        }
        "user_message" => {
            let content = decode_message(raw.message?)?;
            Some(Body::UserMessage(UserMessage {
                content,
                parent_tool_use_id: raw.parent_tool_use_id.0,
                synthetic: raw.synthetic.0,
                replay: raw.replay.0 == Some(true),
                uuid: raw.uuid.0,
                attachments: object(raw.attachments),
                origin: object(raw.origin),
                shell: object(raw.shell),
                patch: object(raw.patch),
            }))
        }
        "assistant_message" => {
            let content = decode_message(raw.message?)?;
            Some(Body::AssistantMessage(AssistantMessage { content, parent_tool_use_id: raw.parent_tool_use_id.0, uuid: raw.uuid.0? }))
        }
        "stream_delta" => {
            let body: RawStreamBody = serde_json::from_str(raw.event?.get()).ok()?;
            let (delta_type, text, thinking) = match body.delta {
                Some(d) => (d.ty.0, d.text.0, d.thinking.0),
                None => (None, None, None),
            };
            raw.uuid.0.as_ref()?;
            Some(Body::StreamDelta(StreamDelta {
                event_type: body.ty.0?,
                delta_type,
                text,
                thinking,
                parent_tool_use_id: raw.parent_tool_use_id.0,
            }))
        }
        "turn_result" => {
            raw.num_turns.0?;
            let errors = match raw.errors {
                Some(e) => serde_json::from_str::<Option<Vec<String>>>(e.get()).ok()?,
                None => None,
            };
            Some(Body::TurnResult(TurnResult {
                subtype: raw.subtype.0?,
                is_error: raw.is_error.0?,
                duration_ms: raw.duration_ms.0?,
                total_cost_usd: raw.total_cost_usd.0?,
                cost_usd: raw.cost_usd.0,
                errors,
                usage_by_model: object(raw.usage_by_model),
            }))
        }
        _ => Some(Body::Unknown),
    }
}

fn decode_message(raw: &RawValue) -> Option<Vec<ContentBlock>> {
    let message: RawMessage = serde_json::from_str(raw.get()).ok()?;
    message.role.0.as_ref()?;
    let content = message.content?.get();
    if content.starts_with('"') {
        let text: String = serde_json::from_str(content).ok()?;
        return Some(vec![ContentBlock::Text(text)]);
    }
    let blocks: Vec<RawBlock> = serde_json::from_str(content).ok()?;
    let mut out = Vec::with_capacity(blocks.len());
    for block in blocks {
        out.push(decode_block(block).unwrap_or(ContentBlock::Unknown));
    }
    Some(out)
}

fn decode_block(b: RawBlock) -> Option<ContentBlock> {
    let ty = b.ty.0?;
    match ty.as_str() {
        "text" => Some(ContentBlock::Text(b.text.0?)),
        "thinking" => Some(ContentBlock::Thinking { text: b.thinking.0.unwrap_or_default(), addressed: b.addressed.0 == Some(true) }),
        "tool_use" => Some(ContentBlock::ToolUse { id: b.id.0?, name: b.name.0?, input: Arc::new(b.input.unwrap_or(Value::Null)) }),
        "tool_result" => {
            let content = match b.content {
                None => None,
                Some(raw) => {
                    let s = raw.get();
                    if s == "null" {
                        None
                    } else if s.starts_with('"') {
                        Some(ToolResultContent::Text(serde_json::from_str(s).ok()?))
                    } else {
                        Some(ToolResultContent::Parts(serde_json::from_str(s).ok()?))
                    }
                }
            };
            Some(ContentBlock::ToolResult(ToolResultBlock {
                tool_use_id: b.tool_use_id.0?,
                content,
                is_error: b.is_error.0,
                truncated: b.truncated.0,
                total_chars: b.total_chars.0,
            }))
        }
        _ => Some(ContentBlock::Unknown),
    }
}

fn object(raw: Option<&RawValue>) -> Option<Arc<Value>> {
    match serde_json::from_str::<Value>(raw?.get()).ok()? {
        Value::Null => None,
        value => Some(Arc::new(value)),
    }
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key)?.as_str().map(str::to_owned)
}

fn present(value: &Value, key: &str) -> Option<Arc<Value>> {
    match value.get(key)? {
        Value::Null => None,
        other => Some(Arc::new(other.clone())),
    }
}

fn logs(value: &Value) -> Option<Vec<String>> {
    value.get("logs")?.as_array()?.iter().map(|line| line.as_str().map(str::to_owned)).collect()
}

fn decode_cold(ty: &str, e: &Value) -> Option<Body> {
    Some(match ty {
        "engine_sleep" => Body::EngineSleep(e.get("asleep")?.as_bool()?),
        "capabilities" => {
            Body::Capabilities { models: present(e, "models"), commands: present(e, "commands"), default_model: text(e, "defaultModel") }
        }
        "skills" => Body::Skills(present(e, "skills")?),
        "checklist" => Body::Checklist(e.get("items")?.as_array()?.clone()),
        "tool_titles" => Body::ToolTitles(
            e.get("titles")?.as_object()?.iter().filter_map(|(name, title)| Some((name.clone(), title.as_str()?.to_owned()))).collect(),
        ),
        "file_produced" => Body::FileProduced {
            path: text(e, "path")?,
            file_id: text(e, "fileId")?,
            media_type: text(e, "mediaType"),
            bytes: e.get("bytes").and_then(Value::as_f64),
        },
        "model_changed" => Body::ModelChanged(text(e, "model")),
        "effort_changed" => Body::EffortChanged(text(e, "effort")),
        "permission_mode_changed" => Body::PermissionModeChanged(text(e, "mode")?),
        "rate_limit" => Body::RateLimit(present(e, "info")?),
        "plan_info" => Body::PlanInfo(text(e, "subscriptionType")),
        "conversation_reset" => Body::ConversationReset { agent_reason: text(e, "agentReason"), sdk_session_id: text(e, "sdkSessionId") },
        "context_compacted" => Body::ContextCompacted(Compaction {
            uuid: text(e, "uuid")?,
            parent_tool_use_id: text(e, "parentToolUseId"),
            pending: e.get("pending").and_then(Value::as_bool),
            trigger: text(e, "trigger"),
            pre_tokens: e.get("preTokens").and_then(Value::as_f64),
            post_tokens: e.get("postTokens").and_then(Value::as_f64),
            error: text(e, "error"),
        }),
        "permission_requested" => {
            let request = present(e, "request")?;
            request.get("id")?.as_str()?;
            Body::PermissionRequested(request)
        }
        "permission_resolved" => Body::PermissionResolved(text(e, "requestId")?),
        "tool_output" => Body::ToolOutput { tool_use_id: text(e, "toolUseId")?, tail: text(e, "tail")? },
        "execution_dispatched" => Body::ExecutionDispatched {
            execution_id: text(e, "executionId")?,
            deferred: e.get("deferred").and_then(Value::as_bool) == Some(true),
            backend: text(e, "backend"),
        },
        "execution_result" => {
            let output = e.get("output")?;
            let value = output.get("value").unwrap_or(&Value::Null);
            let text = match (output.get("type").and_then(Value::as_str), value) {
                (Some("text"), Value::String(s)) => s.clone(),
                _ => serde_json::to_string(value).ok()?,
            };
            Body::ExecutionResult { execution_id: self::text(e, "executionId")?, text, logs: logs(e) }
        }
        "execution_failed" => Body::ExecutionFailed {
            execution_id: text(e, "executionId")?,
            text: format!("{}: {}", text(e, "reason")?, text(e, "error")?),
            logs: logs(e),
        },
        "file_delivered" => {
            Body::FileDelivered { path: text(e, "path")?, bytes: e.get("bytes")?.as_f64()?, description: text(e, "description") }
        }
        "session_error" => Body::SessionError(text(e, "message")?),
        "session_closed" => Body::SessionClosed(text(e, "reason")?),
        "session_superseded" => Body::SessionSuperseded(text(e, "successor")?),
        _ => Body::Unknown,
    })
}
