use crate::rest::{Entries, GatewayRelayMeta, SessionInfo, SessionStatus, ShellInfo, ShellStatus, SubagentInfo, SubagentStatus};
use crate::vm::agents::project_accent;
use crate::vm::collate::{locale_compare, locale_compare_base};
use crate::vm::text::{js_trim, utf16_len};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::cmp::Ordering;
use std::collections::HashSet;

pub const SHELL_PROMOTE_MS: f64 = 3000.0;
pub const SHELL_LINGER_MS: f64 = 60_000.0;
pub const CUSTOM_GROUP_ICON_MAX: usize = 48_000;
pub const UNGROUPED_KEY: &str = "custom:ungrouped";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionState {
    Attention,
    Working,
    Idle,
    Ended,
}

pub const STATE_ORDER: [SessionState; 4] = [SessionState::Attention, SessionState::Working, SessionState::Idle, SessionState::Ended];

impl SessionState {
    pub fn label(self) -> &'static str {
        match self {
            SessionState::Attention => "Needs attention",
            SessionState::Working => "Working",
            SessionState::Idle => "Idle",
            SessionState::Ended => "Ended",
        }
    }

    pub fn rank(self) -> usize {
        self as usize
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Facet {
    Gateway,
    Adapter,
    State,
    Project,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GroupBy {
    None,
    State,
    Adapter,
    Project,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SortBy {
    Recent,
    Name,
    Gateway,
    Adapter,
    State,
    Project,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum StepDisplay {
    All,
    Active,
    None,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct CustomGroup {
    pub id: String,
    pub name: String,
    pub members: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ViewConfig {
    pub search: String,
    pub gateways: Vec<String>,
    pub adapters: Vec<String>,
    pub states: Vec<SessionState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub projects: Option<Vec<String>>,
    pub scoped: bool,
    pub group_by: GroupBy,
    pub sort_by: SortBy,
    pub subagents: StepDisplay,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub shells: Option<StepDisplay>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tasks: Option<StepDisplay>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom_groups: Option<Vec<CustomGroup>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expanded_teams: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub collapsed_groups: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub earlier_open: Option<bool>,
}

impl Default for ViewConfig {
    fn default() -> Self {
        ViewConfig {
            search: String::new(),
            gateways: Vec::new(),
            adapters: Vec::new(),
            states: Vec::new(),
            projects: Some(Vec::new()),
            scoped: true,
            group_by: GroupBy::State,
            sort_by: SortBy::Recent,
            subagents: StepDisplay::Active,
            shells: Some(StepDisplay::Active),
            tasks: Some(StepDisplay::Active),
            custom_groups: None,
            expanded_teams: None,
            collapsed_groups: None,
            earlier_open: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeRoot {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct WorkspaceScope {
    pub label: String,
    pub roots: Vec<ScopeRoot>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRow {
    pub host_id: String,
    pub host_name: String,
    pub local: bool,
    pub adapter: String,
    pub state: SessionState,
    pub info: SessionInfo,
    pub unseen: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub members: Option<Vec<SessionRow>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub team_state: Option<SessionState>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionGroup {
    pub key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gateway: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    pub rows: Vec<SessionRow>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub custom: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub earlier: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupOptions {
    #[serde(default)]
    pub gateway_count: Option<usize>,
    #[serde(default)]
    pub all: Option<Vec<SessionRow>>,
    #[serde(default)]
    pub relay_hosts: Option<Entries<String>>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ProjectOption {
    pub key: String,
    pub label: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct GroupSummary {
    pub sessions: u64,
    pub working: u64,
    pub attention: u64,
    pub unseen: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TeamSummary {
    pub members: u64,
    pub working: u64,
    pub attention: u64,
    pub unseen: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SubsetSummary {
    pub shown: u64,
    pub total: u64,
    pub causes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
pub struct CustomGroupLook {
    #[serde(default, deserialize_with = "present")]
    pub color: Option<Option<String>>,
    #[serde(default, deserialize_with = "present")]
    pub icon: Option<Option<String>>,
}

fn present<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<Option<Option<String>>, D::Error> {
    Option::<String>::deserialize(deserializer).map(Some)
}

pub fn session_state(info: &SessionInfo) -> SessionState {
    if info.pending_permission_count > 0 || info.status == SessionStatus::AwaitingApproval {
        return SessionState::Attention;
    }
    if matches!(info.status, SessionStatus::Failed | SessionStatus::Closed) {
        return SessionState::Ended;
    }
    if matches!(info.status, SessionStatus::Running | SessionStatus::Starting) {
        return SessionState::Working;
    }
    if !running_subagents(info).is_empty() {
        return SessionState::Working;
    }
    SessionState::Idle
}

fn subagents_of(info: &SessionInfo) -> &[SubagentInfo] {
    info.subagents.as_deref().unwrap_or_default()
}

fn shells_of(info: &SessionInfo) -> &[ShellInfo] {
    info.shells.as_deref().unwrap_or_default()
}

pub fn running_subagents(info: &SessionInfo) -> Vec<SubagentInfo> {
    subagents_of(info).iter().filter(|sub| sub.status == SubagentStatus::Running).cloned().collect()
}

pub fn visible_subagents(info: &SessionInfo, show: StepDisplay) -> Vec<SubagentInfo> {
    match show {
        StepDisplay::None => Vec::new(),
        StepDisplay::All => subagents_of(info).to_vec(),
        StepDisplay::Active => running_subagents(info),
    }
}

fn trimmed(value: Option<&String>) -> &str {
    value.map(|v| js_trim(v)).unwrap_or("")
}

pub fn is_agent_record(sub: &SubagentInfo) -> bool {
    sub.is_agent == Some(true) || !trimmed(sub.agent_type.as_ref()).is_empty()
}

pub fn subagent_label(sub: &SubagentInfo) -> String {
    let agent = trimmed(sub.agent_type.as_ref());
    let description = trimmed(sub.description.as_ref());
    if !agent.is_empty() && !description.is_empty() {
        return format!("{agent} · {description}");
    }
    [agent, description].into_iter().find(|s| !s.is_empty()).unwrap_or("Sub-agent").to_owned()
}

pub fn relay_hosts_of(relays: &Entries<Option<GatewayRelayMeta>>) -> Entries<String> {
    let mut hosts = Entries::new();
    for (host_id, relay) in relays.iter() {
        if let Some(relay) = relay {
            hosts.set(relay.gateway.clone(), host_id.clone());
        }
    }
    hosts
}

pub fn session_key(host_id: &str, session_id: &str) -> String {
    format!("{host_id}:{session_id}")
}

fn row_key(row: &SessionRow) -> String {
    session_key(&row.host_id, &row.info.id)
}

fn parse_enum<T: for<'de> Deserialize<'de>>(stored: &Value, key: &str) -> Option<T> {
    stored.get(key).and_then(|value| serde_json::from_value(value.clone()).ok())
}

pub fn normalize_view_config(stored: Option<&Value>) -> ViewConfig {
    let mut config = ViewConfig::default();
    let Some(stored) = stored.filter(|s| s.is_object()) else {
        return config;
    };
    if let Some(search) = parse_enum(stored, "search") {
        config.search = search;
    }
    if let Some(gateways) = parse_enum(stored, "gateways") {
        config.gateways = gateways;
    }
    if let Some(adapters) = parse_enum(stored, "adapters") {
        config.adapters = adapters;
    }
    if let Some(states) = parse_enum(stored, "states") {
        config.states = states;
    }
    if let Some(projects) = parse_enum(stored, "projects") {
        config.projects = Some(projects);
    }
    if let Some(scoped) = parse_enum(stored, "scoped") {
        config.scoped = scoped;
    }
    if let Some(sort_by) = parse_enum(stored, "sortBy") {
        config.sort_by = sort_by;
    }
    if let Some(subagents) = parse_enum(stored, "subagents") {
        config.subagents = subagents;
    }
    if let Some(shells) = parse_enum(stored, "shells") {
        config.shells = Some(shells);
    }
    if let Some(tasks) = parse_enum(stored, "tasks") {
        config.tasks = Some(tasks);
    }
    config.custom_groups = parse_enum(stored, "customGroups");
    config.expanded_teams = parse_enum(stored, "expandedTeams");
    config.collapsed_groups = parse_enum(stored, "collapsedGroups");
    config.earlier_open = parse_enum(stored, "earlierOpen");
    if let Some(group_by) = stored.get("groupBy").and_then(Value::as_str) {
        config.group_by = match parse_enum::<GroupBy>(stored, "groupBy") {
            Some(valid) => valid,
            None if group_by == "gateway" => GroupBy::Project,
            None => GroupBy::State,
        };
    }
    config
}

pub fn adapters_of(rows: &[SessionRow]) -> Vec<String> {
    let mut out: Vec<String> = rows.iter().map(|r| r.adapter.clone()).collect::<HashSet<_>>().into_iter().collect();
    out.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
    out
}

pub fn projects_of(rows: &[SessionRow]) -> Vec<ProjectOption> {
    let mut by_key: Entries<String> = Entries::new();
    for row in rows {
        by_key.set(project_key(row), project_label(&row.info));
    }
    let mut out: Vec<ProjectOption> = by_key.0.into_iter().map(|(key, label)| ProjectOption { key, label }).collect();
    out.sort_by(|a, b| locale_compare(&a.label.to_lowercase(), &b.label.to_lowercase()));
    out
}

pub fn session_label(info: &SessionInfo) -> String {
    info.title.clone().unwrap_or_else(|| info.id.chars().take(8).collect())
}

// What a row and a session header call the session: an agent by its name, anything else by its label.
pub fn display_name(info: &SessionInfo) -> String {
    info.agent.as_ref().map(|a| a.name.clone()).unwrap_or_else(|| session_label(info))
}

fn normalize_path(path: &str) -> String {
    path.replace('\\', "/").trim_end_matches('/').to_owned()
}

pub fn project_key(row: &SessionRow) -> String {
    let root = row.info.project.as_ref().map(|p| p.root.as_str()).unwrap_or(&row.info.cwd);
    format!("{}:{}", row.host_id, normalize_path(root))
}

pub fn project_label(info: &SessionInfo) -> String {
    match info.project.as_ref().and_then(|p| p.shortcode.as_ref()) {
        Some(shortcode) if !shortcode.is_empty() => shortcode.clone(),
        _ => project_name(info),
    }
}

pub fn project_name(info: &SessionInfo) -> String {
    if let Some(project) = info.project.as_ref().filter(|p| !p.name.is_empty()) {
        return project.name.clone();
    }
    let dir = normalize_path(&info.cwd);
    let base = dir.rsplit('/').next().unwrap_or("");
    if base.is_empty() { "No project".to_owned() } else { base.to_owned() }
}

pub fn project_subpath(info: &SessionInfo) -> Option<String> {
    let root = &info.project.as_ref()?.root;
    if info.cwd.is_empty() {
        return None;
    }
    let base = normalize_path(root);
    let dir = normalize_path(&info.cwd);
    if dir == base {
        return None;
    }
    let rest = dir.strip_prefix(&format!("{base}/"))?;
    if rest.is_empty() { None } else { Some(rest.to_owned()) }
}

pub fn is_job_run(info: &SessionInfo) -> bool {
    info.meta.as_ref().and_then(|meta| meta.get("jobId")).is_some_and(Value::is_string)
}

pub fn promoted_shells(info: &SessionInfo, now: f64) -> Vec<ShellInfo> {
    shells_of(info)
        .iter()
        .filter(|shell| {
            if shell.status == ShellStatus::Running {
                return now - shell.started_at >= SHELL_PROMOTE_MS;
            }
            match (shell.ended_at, shell.exit_code) {
                (Some(ended), Some(code)) if code != 0 => ended - shell.started_at >= SHELL_PROMOTE_MS && now - ended < SHELL_LINGER_MS,
                _ => false,
            }
        })
        .cloned()
        .collect()
}

pub fn visible_shells(info: &SessionInfo, show: StepDisplay, now: f64) -> Vec<ShellInfo> {
    if show == StepDisplay::None {
        return Vec::new();
    }
    shells_of(info)
        .iter()
        .filter(|shell| shell.status != ShellStatus::Running || now - shell.started_at >= SHELL_PROMOTE_MS)
        .filter(|shell| show == StepDisplay::All || shell.status == ShellStatus::Running)
        .cloned()
        .collect()
}

fn contains_lower(value: Option<&String>, needle: &str) -> bool {
    value.is_some_and(|v| v.to_lowercase().contains(needle))
}

fn matches_search(row: &SessionRow, needle: &str) -> bool {
    if needle.is_empty() {
        return true;
    }
    let info = &row.info;
    let project = info.project.as_ref();
    session_label(info).to_lowercase().contains(needle)
        || contains_lower(info.agent.as_ref().map(|a| &a.name), needle)
        || info.cwd.to_lowercase().contains(needle)
        || contains_lower(project.map(|p| &p.name), needle)
        || contains_lower(project.and_then(|p| p.shortcode.as_ref()), needle)
        || row.host_name.to_lowercase().contains(needle)
        || row.adapter.to_lowercase().contains(needle)
        || info.id.starts_with(needle)
}

fn is_within(root: &str, path: &str) -> bool {
    let base = normalize_path(root);
    let dir = normalize_path(path);
    dir == base || dir.starts_with(&format!("{base}/"))
}

pub fn in_scope(row: &SessionRow, scope: &WorkspaceScope) -> bool {
    scope.roots.iter().any(|root| {
        let host = match &root.host_id {
            Some(host) => host.to_lowercase() == row.host_id.to_lowercase(),
            None => row.local,
        };
        host && is_within(&root.path, &row.info.cwd)
    })
}

pub fn scope_active(config: &ViewConfig, scope: Option<&WorkspaceScope>) -> bool {
    config.scoped && scope.is_some()
}

fn projects_filter(config: &ViewConfig) -> &[String] {
    config.projects.as_deref().unwrap_or_default()
}

pub fn filter_rows(rows: &[SessionRow], config: &ViewConfig, scope: Option<&WorkspaceScope>) -> Vec<SessionRow> {
    let needle = js_trim(&config.search).to_lowercase();
    let scoping = if scope_active(config, scope) { scope } else { None };
    let projects = projects_filter(config);
    rows.iter()
        .filter(|row| {
            (config.gateways.is_empty() || config.gateways.contains(&row.host_id))
                && (config.adapters.is_empty() || config.adapters.contains(&row.adapter))
                && (config.states.is_empty() || config.states.contains(&row.state))
                && (projects.is_empty() || projects.contains(&project_key(row)))
                && scoping.is_none_or(|scope| in_scope(row, scope))
                && matches_search(row, &needle)
        })
        .cloned()
        .collect()
}

fn unit_state(row: &SessionRow) -> SessionState {
    row.team_state.unwrap_or(row.state)
}

fn facet_key(row: &SessionRow, facet: Facet) -> String {
    match facet {
        Facet::Gateway => row.host_id.clone(),
        Facet::Adapter => row.adapter.clone(),
        Facet::Project => project_key(row),
        Facet::State => serde_json::to_value(unit_state(row)).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default(),
    }
}

fn facet_label(row: &SessionRow, facet: Facet, multi_gateway: bool) -> String {
    match facet {
        Facet::Project if multi_gateway => format!("{} {}", row.host_name, project_label(&row.info)),
        Facet::Project => project_label(&row.info),
        Facet::Gateway => row.host_name.clone(),
        Facet::Adapter => row.adapter.clone(),
        Facet::State => unit_state(row).label().to_owned(),
    }
}

fn facet_rank(row: &SessionRow, facet: Facet, multi_gateway: bool) -> String {
    match facet {
        Facet::State => unit_state(row).rank().to_string(),
        Facet::Project if multi_gateway => format!("{}\u{0}{}", row.host_name.to_lowercase(), project_label(&row.info).to_lowercase()),
        _ => facet_label(row, facet, false).to_lowercase(),
    }
}

fn recency(row: &SessionRow) -> f64 {
    row.info.last_activity_at.unwrap_or(row.info.created_at)
}

fn by_recency(a: &SessionRow, b: &SessionRow) -> Ordering {
    sign(recency(b) - recency(a))
}

fn sign(delta: f64) -> Ordering {
    delta.partial_cmp(&0.0).unwrap_or(Ordering::Equal)
}

fn sort_facet(sort_by: SortBy) -> Option<Facet> {
    match sort_by {
        SortBy::Gateway => Some(Facet::Gateway),
        SortBy::Adapter => Some(Facet::Adapter),
        SortBy::State => Some(Facet::State),
        SortBy::Project => Some(Facet::Project),
        SortBy::Recent | SortBy::Name => None,
    }
}

fn compare(a: &SessionRow, b: &SessionRow, sort_by: SortBy) -> Ordering {
    match (sort_by, sort_facet(sort_by)) {
        (SortBy::Name, _) => locale_compare_base(&session_label(&a.info), &session_label(&b.info)).then_with(|| by_recency(a, b)),
        (_, Some(facet)) => locale_compare(&facet_rank(a, facet, false), &facet_rank(b, facet, false)).then_with(|| by_recency(a, b)),
        _ => by_recency(a, b),
    }
}

fn is_earlier(row: &SessionRow) -> bool {
    row.info.agent.is_none() && row.state == SessionState::Ended
}

fn project_target(row: &SessionRow, group: &mut SessionGroup) {
    group.host_id = Some(row.host_id.clone());
    let cwd = row.info.project.as_ref().map(|p| p.root.as_str()).unwrap_or(&row.info.cwd);
    if !cwd.is_empty() {
        group.cwd = Some(cwd.to_owned());
    }
}

pub fn group_rows(rows: &[SessionRow], config: &ViewConfig, options: &GroupOptions) -> Vec<SessionGroup> {
    let empty = Entries::new();
    let relay_hosts = options.relay_hosts.as_ref().unwrap_or(&empty);
    let mut units = team_units(rows, options.all.as_deref().unwrap_or(rows), relay_hosts);
    units.sort_by(|a, b| compare(a, b, config.sort_by));
    let folds_earlier = !matches!(config.group_by, GroupBy::State | GroupBy::Custom);
    let (earlier, sorted): (Vec<SessionRow>, Vec<SessionRow>) =
        if folds_earlier { units.into_iter().partition(is_earlier) } else { (Vec::new(), units) };
    let trailing: Vec<SessionGroup> = if earlier.is_empty() {
        Vec::new()
    } else {
        vec![SessionGroup {
            key: "earlier".into(),
            label: Some("Earlier".into()),
            rows: earlier,
            earlier: Some(true),
            ..SessionGroup::default()
        }]
    };
    let facet = match config.group_by {
        GroupBy::None => {
            let mut out = Vec::new();
            if !sorted.is_empty() {
                out.push(SessionGroup { key: "all".into(), rows: sorted, ..SessionGroup::default() });
            }
            out.extend(trailing);
            return out;
        }
        GroupBy::Custom => return custom_group_rows(sorted, config.custom_groups.as_deref().unwrap_or_default()),
        GroupBy::State => Facet::State,
        GroupBy::Adapter => Facet::Adapter,
        GroupBy::Project => Facet::Project,
    };
    let gateway_count = options.gateway_count.unwrap_or_else(|| rows.iter().map(|r| &r.host_id).collect::<HashSet<_>>().len());
    let multi_gateway = gateway_count > 1;
    let mut groups: Vec<(String, SessionGroup)> = Vec::new();
    for row in sorted {
        let key = facet_key(&row, facet);
        if let Some((_, group)) = groups.iter_mut().find(|(_, g)| g.key == key) {
            group.rows.push(row);
            continue;
        }
        let rank = facet_rank(&row, facet, multi_gateway);
        let mut group = SessionGroup { key: key.clone(), label: Some(facet_label(&row, facet, multi_gateway)), ..SessionGroup::default() };
        if facet == Facet::Project {
            project_target(&row, &mut group);
            if multi_gateway {
                group.gateway = Some(row.host_name.clone());
                group.project = Some(project_label(&row.info));
            }
        }
        group.rows.push(row);
        groups.push((rank, group));
    }
    groups.sort_by(|a, b| locale_compare(&a.0, &b.0));
    groups.into_iter().map(|(_, g)| g).chain(trailing).collect()
}

pub fn team_key(row: &SessionRow) -> Option<String> {
    row.info.agent.as_ref().map(|agent| format!("{}:{}", row.host_id, agent.id))
}

fn lead_key_of(row: &SessionRow, relay_hosts: &Entries<String>) -> Option<String> {
    let agent = row.info.agent.as_ref()?;
    let lead = agent.lead.as_ref()?;
    let Some(gateway) = &agent.lead_gateway else {
        return Some(format!("{}:{lead}", row.host_id));
    };
    let host = relay_hosts.get(gateway)?;
    let skip = utf16_len(gateway) + 1;
    let local: String = String::from_utf16_lossy(&lead.encode_utf16().skip(skip).collect::<Vec<_>>());
    Some(format!("{host}:{local}"))
}

fn team_units(rows: &[SessionRow], all: &[SessionRow], relay_hosts: &Entries<String>) -> Vec<SessionRow> {
    let mut leads: Entries<&SessionRow> = Entries::new();
    for row in all {
        if let Some(key) = team_key(row).filter(|_| row.info.agent.as_ref().is_some_and(|a| a.lead.is_none())) {
            leads.set(key, row);
        }
    }
    let shown: HashSet<String> = rows.iter().map(row_key).collect();
    let mut members: Entries<Vec<SessionRow>> = Entries::new();
    let mut top: Vec<SessionRow> = Vec::new();
    for row in rows {
        match lead_key_of(row, relay_hosts).filter(|lead| leads.get(lead).is_some()) {
            Some(lead) => match members.0.iter_mut().find(|(k, _)| *k == lead) {
                Some((_, crew)) => crew.push(row.clone()),
                None => members.0.push((lead, vec![row.clone()])),
            },
            None => top.push(row.clone()),
        }
    }
    for lead in members.keys() {
        if let Some(lead_row) = leads.get(lead).filter(|r| !shown.contains(&row_key(r))) {
            top.push(SessionRow { context: Some(true), ..(*lead_row).clone() });
        }
    }
    top.into_iter()
        .map(|row| {
            let Some(crew) = team_key(&row).and_then(|key| members.get(&key)) else {
                return row;
            };
            let mut ordered = crew.clone();
            ordered.sort_by(by_team_order);
            let state = team_state(&std::iter::once(&row).chain(&ordered).cloned().collect::<Vec<_>>());
            SessionRow { members: Some(ordered), team_state: Some(state), ..row }
        })
        .collect()
}

fn by_team_order(a: &SessionRow, b: &SessionRow) -> Ordering {
    let order = |row: &SessionRow| row.info.agent.as_ref().and_then(|agent| agent.order).unwrap_or(9_007_199_254_740_991);
    order(a).cmp(&order(b)).then_with(|| sign(a.info.created_at - b.info.created_at))
}

pub fn team_state(rows: &[SessionRow]) -> SessionState {
    rows.iter().map(|row| row.state).min_by_key(|state| state.rank()).unwrap_or(SessionState::Ended)
}

pub fn is_team_expanded(config: &ViewConfig, row: &SessionRow) -> bool {
    team_key(row).is_some_and(|key| config.expanded_teams.as_deref().unwrap_or_default().contains(&key))
}

fn toggled(held: Option<&Vec<String>>, key: &str) -> Vec<String> {
    let held = held.cloned().unwrap_or_default();
    if held.iter().any(|k| k == key) {
        held.into_iter().filter(|k| k != key).collect()
    } else {
        held.into_iter().chain(std::iter::once(key.to_owned())).collect()
    }
}

pub fn toggle_team_expanded(config: &ViewConfig, row: &SessionRow) -> ViewConfig {
    match team_key(row) {
        Some(key) => ViewConfig { expanded_teams: Some(toggled(config.expanded_teams.as_ref(), &key)), ..config.clone() },
        None => config.clone(),
    }
}

pub const TEAM_LINGER_MS: f64 = 5_000.0;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TeamView {
    pub expanded: bool,
    pub shown: Vec<SessionRow>,
    pub tray: Vec<SessionRow>,
}

fn lingering(member: &SessionRow, now: f64) -> Option<f64> {
    member.info.last_activity_at.filter(|at| now - at < TEAM_LINGER_MS)
}

// Auto draws a member that is busy, selected, unread, or idle for under `TEAM_LINGER_MS` by `lastActivityAt`; the rest
// sit in the lead's tray. An expanded team, or one under a search or facet filter, draws every member.
pub fn team_view(lead: &SessionRow, config: &ViewConfig, selected: Option<&str>, now: f64) -> TeamView {
    let members = lead.members.clone().unwrap_or_default();
    let expanded = is_team_expanded(config, lead);
    if expanded || has_facet_filter(config) {
        return TeamView { expanded, shown: members, tray: Vec::new() };
    }
    let (shown, tray) = members.into_iter().partition(|member| {
        matches!(member.state, SessionState::Working | SessionState::Attention)
            || member.unseen > 0
            || selected == Some(session_key(&member.host_id, &member.info.id).as_str())
            || lingering(member, now).is_some()
    });
    TeamView { expanded, shown, tray }
}

// When the next lingering member's window closes, so a host can redraw then; None when none is lingering.
pub fn team_linger_ends(view: &TeamView, now: f64) -> Option<f64> {
    view.shown.iter().filter_map(|member| lingering(member, now)).map(|at| at + TEAM_LINGER_MS).min_by(f64::total_cmp)
}

// `SessionBrowser`'s `showGateway`: a row names its gateway only when there is more than one and the list is not
// grouped by project (a project group's label already carries it).
pub fn shows_gateway(gateway_count: usize, config: &ViewConfig) -> bool {
    gateway_count > 1 && config.group_by != GroupBy::Project
}

pub fn is_group_collapsed(config: &ViewConfig, group_key: &str) -> bool {
    config.collapsed_groups.as_deref().unwrap_or_default().iter().any(|k| k == group_key)
}

pub fn toggle_group_collapsed(config: &ViewConfig, group_key: &str) -> ViewConfig {
    ViewConfig { collapsed_groups: Some(toggled(config.collapsed_groups.as_ref(), group_key)), ..config.clone() }
}

fn count_state(rows: &[&SessionRow], state: SessionState) -> u64 {
    rows.iter().filter(|row| row.state == state).count() as u64
}

pub fn group_summary(rows: &[SessionRow]) -> GroupSummary {
    let all: Vec<&SessionRow> = rows.iter().flat_map(|row| std::iter::once(row).chain(row.members.iter().flatten())).collect();
    GroupSummary {
        sessions: all.len() as u64,
        working: count_state(&all, SessionState::Working),
        attention: count_state(&all, SessionState::Attention),
        unseen: all.iter().map(|row| row.unseen).sum(),
    }
}

pub fn team_summary(lead: &SessionRow) -> TeamSummary {
    let members: Vec<&SessionRow> = lead.members.iter().flatten().collect();
    TeamSummary {
        members: members.len() as u64,
        working: count_state(&members, SessionState::Working),
        attention: count_state(&members, SessionState::Attention),
        unseen: members.iter().map(|row| row.unseen).sum(),
    }
}

fn custom_group_rows(sorted: Vec<SessionRow>, custom: &[CustomGroup]) -> Vec<SessionGroup> {
    let mut placed: HashSet<String> = HashSet::new();
    let mut groups: Vec<SessionGroup> = custom
        .iter()
        .map(|group| {
            let mut rows = Vec::new();
            for member in &group.members {
                if let Some(row) = sorted.iter().find(|row| &row_key(row) == member)
                    && placed.insert(member.clone())
                {
                    rows.push(row.clone());
                }
            }
            SessionGroup {
                key: format!("custom:{}", group.id),
                label: Some(group.name.clone()),
                rows,
                custom: Some(group.id.clone()),
                ..SessionGroup::default()
            }
        })
        .collect();
    let rest: Vec<SessionRow> = sorted.into_iter().filter(|row| !placed.contains(&row_key(row))).collect();
    if !rest.is_empty() {
        groups.push(SessionGroup { key: UNGROUPED_KEY.into(), label: Some("Ungrouped".into()), rows: rest, ..SessionGroup::default() });
    }
    groups
}

pub fn add_custom_group(groups: &[CustomGroup], name: &str, id: &str) -> Vec<CustomGroup> {
    let mut out = groups.to_vec();
    out.push(CustomGroup { id: id.to_owned(), name: name.to_owned(), members: Vec::new(), color: None, icon: None });
    out
}

pub fn rename_custom_group(groups: &[CustomGroup], id: &str, name: &str) -> Vec<CustomGroup> {
    groups.iter().map(|g| if g.id == id { CustomGroup { name: name.to_owned(), ..g.clone() } } else { g.clone() }).collect()
}

pub fn custom_group_color(group: &CustomGroup) -> String {
    group.color.clone().unwrap_or_else(|| project_accent(&format!("group:{}", group.id)))
}

pub fn style_custom_group(groups: &[CustomGroup], id: &str, look: &CustomGroupLook) -> Vec<CustomGroup> {
    groups
        .iter()
        .map(|group| {
            if group.id != id {
                return group.clone();
            }
            let mut next = group.clone();
            match &look.color {
                Some(None) => next.color = None,
                Some(Some(color)) => next.color = Some(color.clone()),
                None => {}
            }
            match &look.icon {
                Some(None) => next.icon = None,
                Some(Some(icon)) if icon.starts_with("data:image/") && utf16_len(icon) <= CUSTOM_GROUP_ICON_MAX => {
                    next.icon = Some(icon.clone())
                }
                _ => {}
            }
            next
        })
        .collect()
}

pub fn remove_custom_group(groups: &[CustomGroup], id: &str) -> Vec<CustomGroup> {
    groups.iter().filter(|g| g.id != id).cloned().collect()
}

pub fn move_to_custom_group(groups: &[CustomGroup], key: &str, target: Option<&str>, before: Option<&str>) -> Vec<CustomGroup> {
    groups
        .iter()
        .map(|group| {
            let mut members: Vec<String> = group.members.iter().filter(|m| *m != key).cloned().collect();
            if Some(group.id.as_str()) != target {
                return CustomGroup { members, ..group.clone() };
            }
            match before.and_then(|b| members.iter().position(|m| m == b)) {
                Some(at) => members.insert(at, key.to_owned()),
                None => members.push(key.to_owned()),
            }
            CustomGroup { members, ..group.clone() }
        })
        .collect()
}

pub fn move_custom_group(groups: &[CustomGroup], id: &str, before: Option<&str>) -> Vec<CustomGroup> {
    let Some(moving) = groups.iter().find(|g| g.id == id).filter(|_| before != Some(id)) else {
        return groups.to_vec();
    };
    let mut rest: Vec<CustomGroup> = groups.iter().filter(|g| g.id != id).cloned().collect();
    match before.and_then(|b| rest.iter().position(|g| g.id == b)) {
        Some(at) => rest.insert(at, moving.clone()),
        None => rest.push(moving.clone()),
    }
    rest
}

pub fn subset_summary(config: &ViewConfig, scope: Option<&WorkspaceScope>, shown: u64, total: u64) -> Option<SubsetSummary> {
    if shown >= total {
        return None;
    }
    let mut causes = Vec::new();
    if let Some(scope) = scope.filter(|s| scope_active(config, Some(s))) {
        causes.push(scope.label.clone());
    }
    let facets = facet_filter_count(config);
    if facets > 0 {
        causes.push(format!("{facets} filter{}", if facets == 1 { "" } else { "s" }));
    }
    if !js_trim(&config.search).is_empty() {
        causes.push("search".to_owned());
    }
    Some(SubsetSummary { shown, total, causes })
}

pub fn has_facet_filter(config: &ViewConfig) -> bool {
    !js_trim(&config.search).is_empty() || facet_filter_count(config) > 0
}

pub fn facet_filter_count(config: &ViewConfig) -> u32 {
    [config.gateways.is_empty(), config.adapters.is_empty(), config.states.is_empty(), projects_filter(config).is_empty()]
        .iter()
        .filter(|empty| !**empty)
        .count() as u32
}

pub fn display_customized(config: &ViewConfig) -> bool {
    config.subagents != StepDisplay::Active
        || config.shells.unwrap_or(StepDisplay::Active) != StepDisplay::Active
        || config.tasks.unwrap_or(StepDisplay::Active) != StepDisplay::Active
}

pub fn clear_filters(config: &ViewConfig) -> ViewConfig {
    ViewConfig {
        scoped: false,
        group_by: config.group_by,
        sort_by: config.sort_by,
        subagents: config.subagents,
        shells: config.shells,
        tasks: config.tasks,
        custom_groups: config.custom_groups.clone(),
        expanded_teams: config.expanded_teams.clone(),
        collapsed_groups: config.collapsed_groups.clone(),
        earlier_open: config.earlier_open,
        ..ViewConfig::default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shows_gateway_only_for_several_outside_project_grouping() {
        let state = ViewConfig { group_by: GroupBy::State, ..ViewConfig::default() };
        let project = ViewConfig { group_by: GroupBy::Project, ..ViewConfig::default() };
        assert!(!shows_gateway(1, &state));
        assert!(shows_gateway(2, &state));
        assert!(!shows_gateway(2, &project));
    }
}
