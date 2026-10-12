use serde::de::{Deserializer, MapAccess, Visitor};
use serde::ser::{SerializeMap, Serializer};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fmt;
use std::marker::PhantomData;

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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PermissionMode {
    Default,
    AcceptEdits,
    BypassPermissions,
    Plan,
    DontAsk,
    Auto,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProfileEngine {
    Claude,
    Codex,
    Provider,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ToolFilters {
    All,
    Mcp,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StreamingMode {
    Token,
    Item,
    None,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AttachmentKind {
    Image,
    Pdf,
    Text,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
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
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellStatus {
    Running,
    Exited,
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
pub struct ProfileInfo {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine: Option<ProfileEngine>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
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
    pub session_id: Option<String>,
    pub past_sessions: Vec<String>,
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
