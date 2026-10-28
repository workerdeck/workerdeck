use crate::rest::{AgentInfo, AgentRef, GatewayAgentDefaults, ProfileInfo, Sharing};
use serde::{Deserialize, Serialize};

pub const AGENT_SLEEP_AFTER_MS_DEFAULT: f64 = 15.0 * 60_000.0;

pub const PROJECT_ACCENTS: [&str; 8] = ["#497eae", "#8a6bb8", "#3f8f6b", "#b0794a", "#a85a6e", "#4f8f96", "#7c8a3f", "#6b72b8"];

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamContext {
    #[serde(default)]
    pub lead_name: Option<String>,
    #[serde(default)]
    pub lead_gateway: Option<String>,
    #[serde(default)]
    pub leads: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TeamRole {
    Lead,
    Member,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PeerParty {
    #[serde(default)]
    pub owner: Option<String>,
    #[serde(default)]
    pub agent: Option<AgentRef>,
    #[serde(default)]
    pub permission_mode: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct PeerOps {
    pub list: bool,
    pub send: bool,
    pub peek: bool,
}

const NO_OPS: PeerOps = PeerOps { list: false, send: false, peek: false };
const ALL_OPS: PeerOps = PeerOps { list: true, send: true, peek: true };

pub fn is_sharing(value: &str) -> bool {
    value == "private" || value == "shared"
}

pub fn agent_ref(agent: &AgentInfo, team: &TeamContext) -> AgentRef {
    let mut out = AgentRef { id: agent.id.clone(), name: agent.name.clone(), ..AgentRef::default() };
    if agent.lead.is_some() {
        out.lead = agent.lead.clone();
        out.lead_gateway = team.lead_gateway.clone();
        out.team = team.lead_name.clone();
    }
    if team.leads == Some(true) {
        out.leads = Some(true);
    }
    if agent.sharing == Some(Sharing::Shared) && agent.lead.is_none() {
        out.shared = Some(true);
    }
    out.order = agent.order;
    out
}

pub fn team_role(agent: Option<&AgentRef>) -> Option<TeamRole> {
    let agent = agent?;
    if agent.lead.is_some() {
        Some(TeamRole::Member)
    } else if agent.leads == Some(true) {
        Some(TeamRole::Lead)
    } else {
        None
    }
}

pub fn team_reaches(from: Option<&AgentRef>, to: Option<&AgentRef>) -> bool {
    if let Some(lead) = to.and_then(|to| to.lead.as_ref()) {
        return from.is_some_and(|from| &from.id == lead || from.lead.as_ref() == Some(lead));
    }
    if let Some(lead) = from.and_then(|from| from.lead.as_ref()) {
        return to.is_some_and(|to| &to.id == lead);
    }
    true
}

pub fn is_owner_name(value: &str) -> bool {
    (1..=32).contains(&value.len()) && value.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}

pub fn team_related(a: Option<&AgentRef>, b: Option<&AgentRef>) -> bool {
    let (Some(a), Some(b)) = (a, b) else {
        return false;
    };
    a.lead.as_ref() == Some(&b.id) || b.lead.as_ref() == Some(&a.id) || (a.lead.is_some() && a.lead == b.lead)
}

fn shared_lead(agent: Option<&AgentRef>) -> bool {
    agent.is_some_and(|agent| agent.shared == Some(true) && agent.lead.is_none())
}

fn unprompted(party: &PeerParty) -> bool {
    matches!(party.permission_mode.as_deref(), Some("bypassPermissions") | Some("dontAsk"))
}

pub fn peer_ops(from: &PeerParty, to: &PeerParty, multi_owner: bool) -> PeerOps {
    if !team_reaches(from.agent.as_ref(), to.agent.as_ref()) {
        return NO_OPS;
    }
    if from.owner == to.owner && (from.owner.is_some() || !multi_owner) {
        return ALL_OPS;
    }
    if team_related(from.agent.as_ref(), to.agent.as_ref()) {
        return PeerOps { list: true, send: !unprompted(to), peek: true };
    }
    let owned = from.owner.is_some() && to.owner.is_some();
    if owned && shared_lead(from.agent.as_ref()) && shared_lead(to.agent.as_ref()) && !unprompted(to) {
        return PeerOps { list: true, send: true, peek: false };
    }
    NO_OPS
}

pub fn peer_reaches(from: &PeerParty, to: &PeerParty, multi_owner: bool) -> bool {
    peer_ops(from, to, multi_owner).list
}

pub fn qualify_agent(agent: Option<&AgentRef>, gateway: &str) -> Option<AgentRef> {
    let agent = agent?;
    let qualify = |id: &str| if id.contains(':') { id.to_owned() } else { format!("{gateway}:{id}") };
    Some(AgentRef { id: qualify(&agent.id), lead: agent.lead.as_deref().map(qualify), ..agent.clone() })
}

pub fn project_accent(key: &str) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    for unit in key.encode_utf16() {
        hash = (hash ^ unit as u32).wrapping_mul(0x0100_0193);
    }
    PROJECT_ACCENTS[(hash as usize) % PROJECT_ACCENTS.len()].to_owned()
}

pub fn new_agent_owner(defaults: Option<&GatewayAgentDefaults>, profile: Option<&ProfileInfo>) -> Option<String> {
    profile.and_then(|p| p.owner.clone()).or_else(|| defaults.and_then(|d| d.owner.clone()))
}

pub fn new_agent_sharing(defaults: Option<&GatewayAgentDefaults>, profile: Option<&ProfileInfo>) -> Sharing {
    if defaults.is_some_and(|d| !d.allow_shared) {
        return Sharing::Private;
    }
    let chosen = profile.and_then(|p| p.defaults.as_ref()).and_then(|d| d.sharing).or_else(|| defaults.map(|d| d.sharing));
    if chosen == Some(Sharing::Shared) { Sharing::Shared } else { Sharing::Private }
}
