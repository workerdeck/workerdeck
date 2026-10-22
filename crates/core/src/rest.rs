use serde::de::{Deserializer, MapAccess, Visitor};
use serde::ser::{SerializeMap, Serializer};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fmt;
use std::marker::PhantomData;

pub mod calls;
pub mod error;
pub mod files;
pub mod mcp;

#[derive(Debug, Clone, PartialEq)]
pub struct Entries<V>(pub Vec<(String, V)>);

impl<V> Default for Entries<V> {
    fn default() -> Self {
        Entries(Vec::new())
    }
}

impl<V> Entries<V> {
    pub fn new() -> Self {
        Entries(Vec::new())
    }

    pub fn get(&self, key: &str) -> Option<&V> {
        self.0.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn set(&mut self, key: String, value: V) {
        match self.0.iter_mut().find(|(k, _)| *k == key) {
            Some(slot) => slot.1 = value,
            None => self.0.push((key, value)),
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = (&String, &V)> {
        self.0.iter().map(|(k, v)| (k, v))
    }

    pub fn keys(&self) -> impl Iterator<Item = &String> {
        self.0.iter().map(|(k, _)| k)
    }

    pub fn values(&self) -> impl Iterator<Item = &V> {
        self.0.iter().map(|(_, v)| v)
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

impl<V: Serialize> Serialize for Entries<V> {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(self.0.len()))?;
        for (key, value) in &self.0 {
            map.serialize_entry(key, value)?;
        }
        map.end()
    }
}

impl<'de, V: Deserialize<'de>> Deserialize<'de> for Entries<V> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct EntriesVisitor<V>(PhantomData<V>);
        impl<'de, V: Deserialize<'de>> Visitor<'de> for EntriesVisitor<V> {
            type Value = Entries<V>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("an object")
            }
            fn visit_map<A: MapAccess<'de>>(self, mut access: A) -> Result<Self::Value, A::Error> {
                let mut out = Entries::new();
                while let Some((key, value)) = access.next_entry::<String, V>()? {
                    out.set(key, value);
                }
                Ok(out)
            }
        }
        deserializer.deserialize_map(EntriesVisitor(PhantomData))
    }
}

fn double_option<'de, D, T>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer).map(Some)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SessionStatus {
    Starting,
    Running,
    AwaitingApproval,
    Idle,
    Parked,
    Failed,
    Closed,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    #[default]
    Default,
    AcceptEdits,
    BypassPermissions,
    Plan,
    DontAsk,
    Auto,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProfileEngine {
    Claude,
    Codex,
    Provider,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolFilters {
    All,
    Mcp,
    #[default]
    None,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StreamingMode {
    Token,
    Item,
    #[default]
    None,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AttachmentKind {
    Image,
    Pdf,
    Text,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineCapabilities {
    pub interactive_approvals: bool,
    pub permission_modes: Vec<PermissionMode>,
    pub default_permission_mode: PermissionMode,
    pub resume: bool,
    pub resume_backfill: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fork_session: Option<bool>,
    pub list_sessions: bool,
    pub context_usage: bool,
    pub rate_limits: bool,
    pub mcp_status: bool,
    pub mcp_server_actions: bool,
    pub session_mcp_servers: bool,
    pub tool_filters: ToolFilters,
    pub slash_commands: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clear_context: Option<bool>,
    pub skills_list: bool,
    pub setting_sources: bool,
    pub budgets: bool,
    pub attachments: Vec<AttachmentKind>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_efforts: Option<Vec<String>>,
    pub vfs: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_cwd: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub system_instructions: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_sleep: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_tasks: Option<bool>,
    pub streaming: StreamingMode,
}

impl ProfileEngine {
    // The protocol's `ENGINE_CAPABILITIES`: the record for a profile or session that carries none of its own.
    pub fn capabilities(self) -> EngineCapabilities {
        use PermissionMode::*;
        let modes = |modes: &[PermissionMode]| modes.to_vec();
        let efforts = |efforts: &[&str]| Some(efforts.iter().map(|e| (*e).to_owned()).collect());
        match self {
            ProfileEngine::Codex => EngineCapabilities {
                interactive_approvals: true,
                permission_modes: modes(&[Default, AcceptEdits, BypassPermissions, Auto]),
                default_permission_mode: Default,
                resume: true,
                resume_backfill: true,
                fork_session: Some(false),
                list_sessions: true,
                context_usage: true,
                rate_limits: true,
                mcp_status: true,
                mcp_server_actions: false,
                session_mcp_servers: true,
                tool_filters: ToolFilters::Mcp,
                slash_commands: false,
                clear_context: Some(true),
                skills_list: true,
                setting_sources: false,
                budgets: false,
                attachments: vec![AttachmentKind::Image, AttachmentKind::Text],
                reasoning_efforts: efforts(&["minimal", "low", "medium", "high", "xhigh"]),
                vfs: false,
                host_cwd: Some(true),
                system_instructions: Some(true),
                engine_sleep: Some(true),
                background_tasks: None,
                streaming: StreamingMode::Token,
            },
            ProfileEngine::Provider => EngineCapabilities {
                interactive_approvals: false,
                permission_modes: modes(&[Default, BypassPermissions, DontAsk]),
                default_permission_mode: Default,
                resume: false,
                resume_backfill: false,
                fork_session: Some(false),
                list_sessions: false,
                context_usage: false,
                rate_limits: false,
                mcp_status: true,
                mcp_server_actions: false,
                session_mcp_servers: false,
                tool_filters: ToolFilters::None,
                slash_commands: false,
                clear_context: Some(true),
                skills_list: false,
                setting_sources: false,
                budgets: false,
                attachments: vec![AttachmentKind::Image, AttachmentKind::Pdf, AttachmentKind::Text],
                reasoning_efforts: None,
                vfs: true,
                host_cwd: Some(false),
                system_instructions: Some(true),
                engine_sleep: Some(false),
                background_tasks: None,
                streaming: StreamingMode::Token,
            },
            ProfileEngine::Claude | ProfileEngine::Unknown => EngineCapabilities {
                interactive_approvals: true,
                permission_modes: modes(&[Default, AcceptEdits, BypassPermissions, Plan, DontAsk, Auto]),
                default_permission_mode: Default,
                resume: true,
                resume_backfill: true,
                fork_session: Some(true),
                list_sessions: true,
                context_usage: true,
                rate_limits: true,
                mcp_status: true,
                mcp_server_actions: true,
                session_mcp_servers: true,
                tool_filters: ToolFilters::All,
                slash_commands: true,
                clear_context: Some(true),
                skills_list: false,
                setting_sources: true,
                budgets: true,
                attachments: vec![AttachmentKind::Image, AttachmentKind::Pdf, AttachmentKind::Text],
                reasoning_efforts: efforts(&["low", "medium", "high", "xhigh", "max"]),
                vfs: false,
                host_cwd: Some(true),
                system_instructions: Some(true),
                engine_sleep: Some(true),
                background_tasks: Some(true),
                streaming: StreamingMode::Token,
            },
        }
    }
}

impl ProfileInfo {
    pub fn resolved_engine(&self) -> ProfileEngine {
        match self.engine {
            Some(ProfileEngine::Codex) => ProfileEngine::Codex,
            Some(ProfileEngine::Provider) => ProfileEngine::Provider,
            _ => ProfileEngine::Claude,
        }
    }

    // The wire copy when the gateway stamped one, else the engine's static record.
    pub fn resolved_capabilities(&self) -> EngineCapabilities {
        self.capabilities.clone().unwrap_or_else(|| self.resolved_engine().capabilities())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    pub value: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resolved_model: Option<String>,
    pub display_name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub primary: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_efforts: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContextReading {
    pub total_tokens: f64,
    pub max_tokens: f64,
    pub percentage: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RateLimitInfo {
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rate_limit_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub utilization: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resets_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_using_overage: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileUsageWindow {
    pub info: RateLimitInfo,
    pub updated_at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inferred_reset: Option<bool>,
}

pub type ProfileUsage = Entries<ProfileUsageWindow>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CostBasis {
    List,
    Managed,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TokenUsage {
    pub input: f64,
    pub output: f64,
    pub cache_write5m: f64,
    pub cache_write1h: f64,
    pub cache_read: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_basis: Option<CostBasis>,
}

pub type ByModel = Entries<TokenUsage>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SubagentStatus {
    Running,
    Done,
    Failed,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubagentInfo {
    pub tool_use_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub is_agent: Option<bool>,
    pub status: SubagentStatus,
    pub started_at: f64,
    pub tool_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stoppable: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ChecklistStatus {
    Pending,
    InProgress,
    Completed,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ChecklistItem {
    pub text: String,
    pub status: ChecklistStatus,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ProjectIcon {
    Glyph {
        name: String,
    },
    Image {
        #[serde(rename = "mediaType")]
        media_type: String,
        hash: String,
    },
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectInfo {
    pub name: String,
    pub root: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<ProjectIcon>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shortcode: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellOwner {
    User,
    Agent,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellStatus {
    Running,
    Exited,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ShellEndReason {
    Exit,
    Killed,
    Timeout,
    ServerStopped,
    ServerRestarted,
    SpawnFailed,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    pub id: String,
    pub session_id: String,
    pub ordinal: u32,
    pub command: String,
    pub label: String,
    pub cwd: String,
    pub owner: ShellOwner,
    pub status: ShellStatus,
    pub started_at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub signal: Option<i32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub end_reason: Option<ShellEndReason>,
    pub bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capped: Option<bool>,
    pub cols: u32,
    pub rows: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_write: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub interactive: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellAgentWrite {
    Gated,
    Allow,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRef {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lead: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lead_gateway: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leads: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shared: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation: Option<u32>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusLabel {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
    pub set_at: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sdk_session_id: Option<String>,
    pub status: SessionStatus,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<ProfileEngine>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<EngineCapabilities>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, deserialize_with = "double_option", skip_serializing_if = "Option::is_none")]
    pub effort: Option<Option<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub can_bypass_permissions: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub api_key_source: Option<String>,
    pub created_at: f64,
    pub last_seq: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub epoch: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation: Option<i64>,
    pub pending_permission_count: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub subagents: Option<Vec<SubagentInfo>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub checklist: Option<Vec<ChecklistItem>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<Map<String, Value>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub total_cost_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage_by_model: Option<ByModel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub num_turns: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prose_count: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_activity_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_usage: Option<ContextReading>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<Entries<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<ProjectInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shells: Option<Vec<ShellInfo>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shell_agent_write: Option<ShellAgentWrite>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_asleep: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_context_reset: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent: Option<AgentRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status_label: Option<StatusLabel>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayRelayMeta {
    pub gateway: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owners: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owners_defaulted: Option<bool>,
    pub online: bool,
    pub features: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Sharing {
    Private,
    Shared,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GatewayAgentDefaults {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub multi_owner: Option<bool>,
    pub sharing: Sharing,
    pub allow_shared: bool,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileDefaults {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub efforts: Option<Entries<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_context_reset: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sharing: Option<Sharing>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<String>>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInfo {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<ProfileEngine>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider: Option<ProviderConfig>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub defaults: Option<ProfileDefaults>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<ModelOption>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capabilities: Option<EngineCapabilities>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub available: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unavailable_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<ProfileUsage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub managed: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub connectors: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reasoning_effort: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub permission_mode: Option<PermissionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub brief: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_context_reset: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sleep_after_ms: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RemoteLeadState {
    Joined,
    Unreachable,
    Unconfirmed,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct RemoteLead {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    pub state: RemoteLeadState,
    pub since: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub op: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum RemoteMemberState {
    Invited,
    Accepted,
    Unconfirmed,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteMember {
    pub agent: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    pub state: RemoteMemberState,
    pub at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub unreachable_since: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub op: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub invite: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sharing: Option<Sharing>,
    pub created_at: f64,
    pub updated_at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub undelivered: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_failed: Option<String>,
    pub config: AgentConfig,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lead: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub order: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_lead: Option<RemoteLead>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_members: Option<Vec<RemoteMember>>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConversation {
    pub n: i64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationRow {
    #[serde(flatten)]
    pub conversation: AgentConversation,
    pub current: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PendingPromptState {
    Pending,
    Sending,
    Uncertain,
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingPromptInfo {
    pub text: String,
    pub n: i64,
    pub state: PendingPromptState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConversationStartFailure {
    pub n: i64,
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationSummary {
    pub n: i64,
    pub engine: ProfileEngine,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub profile: Option<String>,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_session_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub title: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cost_usd: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub started_at: Option<f64>,
    pub ended_at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transcript: Option<String>,
}

// `GET /sessions/:id/conversations`: `conversation` is the current one, absent (or `closed`) once the session ended.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationsResponse {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub closed: Option<bool>,
    pub history: Vec<ConversationSummary>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pending_prompt: Option<PendingPromptInfo>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub start_failed: Option<ConversationStartFailure>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct NewConversationResponse {
    pub session: SessionInfo,
    pub conversation: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetiredAgentInfo {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub avatar: Option<String>,
    pub retired_at: f64,
    pub conversations: Vec<AgentConversation>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetiredAgentsResponse {
    pub retired: Vec<RetiredAgentInfo>,
}

// `GET /sessions/:id/events/:seq/result`: the whole result as one string, folded by the reducer's rule.
pub fn tool_result_text(body: &str) -> Option<String> {
    let value: Value = serde_json::from_str(body).ok()?;
    let content = match value.get("content") {
        None | Some(Value::Null) => return Some(String::new()),
        Some(Value::String(text)) => crate::protocol::ToolResultContent::Text(text.clone()),
        Some(parts) => crate::protocol::ToolResultContent::Parts(serde_json::from_value(parts.clone()).ok()?),
    };
    Some(content.joined_text())
}

// `GET /sessions/:id/shells/:shellId` and its `kill`: the record under `shell`.
pub fn shell_record(body: &str) -> Option<Value> {
    let mut value: Value = serde_json::from_str(body).ok()?;
    value.get_mut("shell").map(Value::take).filter(Value::is_object)
}

pub fn encode_component(part: &str) -> String {
    let mut out = String::with_capacity(part.len());
    for byte in part.bytes() {
        if byte.is_ascii_alphanumeric() || b"-._~".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}
