use serde::Deserialize;
use serde::de::{self, Deserializer, IgnoredAny, MapAccess, SeqAccess, Visitor};
use serde_json::Value;
use serde_json::value::RawValue;
use std::fmt;
use std::sync::Arc;

pub enum Frame {
    Event(Event),
    ShellOutput { shell_id: String, data: String },
    Unknown,
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
    fn parse(s: &str) -> Option<Self> {
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
}

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
    Thinking(String),
    ToolUse { id: String, name: String, input: Arc<Value> },
    ToolResult(ToolResultBlock),
    Unknown,
}

pub struct UserMessage {
    pub content: Vec<ContentBlock>,
    pub parent_tool_use_id: Option<String>,
    pub synthetic: Option<bool>,
    pub uuid: Option<String>,
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
}

pub enum Body {
    SystemInit {
        model: String,
        cwd: String,
        sdk_session_id: String,
        permission_mode: String,
    },
    StatusChanged {
        status: SessionStatus,
        detail: Option<String>,
    },
    ContextUsage(ContextUsage),
    UserMessage(UserMessage),
    AssistantMessage(AssistantMessage),
    StreamDelta(StreamDelta),
    TurnResult(TurnResult),
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
        _ => Some(Frame::Unknown),
    }
}

fn decode_event(json: &str) -> Option<Event> {
    let raw: RawEvent = serde_json::from_str(json).ok()?;
    let seq = raw.seq.0?;
    let ts = raw.ts.0?;
    let ty = raw.ty.0.clone()?;
    let body = decode_body(&ty, raw).unwrap_or(Body::Unknown);
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
            Some(Body::SystemInit {
                model: raw.model.0?,
                cwd: raw.cwd.0?,
                sdk_session_id: raw.sdk_session_id.0?,
                permission_mode: mode,
            })
        }
        "status_changed" => Some(Body::StatusChanged {
            status: SessionStatus::parse(raw.status.0.as_deref()?)?,
            detail: raw.detail.0,
        }),
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
                uuid: raw.uuid.0,
            }))
        }
        "assistant_message" => {
            let content = decode_message(raw.message?)?;
            Some(Body::AssistantMessage(AssistantMessage {
                content,
                parent_tool_use_id: raw.parent_tool_use_id.0,
                uuid: raw.uuid.0?,
            }))
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
        "thinking" => {
            let thinking = b.thinking.0.unwrap_or_default();
            let addressed = b.addressed.0.unwrap_or(false);
            let trimmed = thinking.trim();
            if addressed && !trimmed.is_empty() {
                Some(ContentBlock::Text(trimmed.to_owned()))
            } else {
                Some(ContentBlock::Thinking(thinking))
            }
        }
        "tool_use" => Some(ContentBlock::ToolUse {
            id: b.id.0?,
            name: b.name.0?,
            input: Arc::new(b.input.unwrap_or(Value::Null)),
        }),
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
