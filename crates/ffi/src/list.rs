// The sessions list for a native app: every gateway's REST rollup, the read watermarks and the view config go in,
// display-ready groups come out. The rules are `wd_native::vm::session_list`; nothing here decides visibility.
use crate::avatar::AvatarFetch;
use std::sync::Mutex;
use wd_native::rest::{Entries, GatewayAgentDefaults, GatewayRelayMeta, ProfileEngine, ProfileInfo, SessionInfo, Sharing};
use wd_native::vm::agent_avatar::{AvatarLoads, avatar_key};
use wd_native::vm::agents::{new_agent_owner, new_agent_sharing};
use wd_native::vm::create_form::{AgentSeed as FormSeed, SeedLead};
use wd_native::vm::engine_mark::{EngineMark, engine_mark};
use wd_native::vm::session_list::{
    self as vm, GroupBy, GroupOptions, SessionRow, SessionState, SortBy, StepDisplay, ViewConfig, filter_rows, group_rows,
    normalize_view_config,
};
use wd_native::vm::steps;
use wd_native::vm::watermarks::{Seen, Watermark, Watermarks, unseen_count};

#[derive(Debug, uniffi::Error)]
pub enum ListError {
    NotASessionList,
}

impl std::fmt::Display for ListError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the gateway did not answer with a session list")
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum RowState {
    Attention,
    Working,
    Idle,
    Ended,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum StatusBadge {
    Attention,
    Working,
    Failed,
    Closed,
    Parked,
    Asleep,
}

impl From<vm::StatusBadge> for StatusBadge {
    fn from(badge: vm::StatusBadge) -> Self {
        match badge {
            vm::StatusBadge::Attention => StatusBadge::Attention,
            vm::StatusBadge::Working => StatusBadge::Working,
            vm::StatusBadge::Failed => StatusBadge::Failed,
            vm::StatusBadge::Closed => StatusBadge::Closed,
            vm::StatusBadge::Parked => StatusBadge::Parked,
            vm::StatusBadge::Asleep => StatusBadge::Asleep,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum StepKind {
    Agent,
    Task,
    Shell,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum StepState {
    Done,
    Running,
    Failed,
    Pending,
}

// A line under a card: an agent opens its takeover, a task its call's row (a checklist item just the session), a
// shell its screen. `killable` offers stop (a task, by `tool_use_id`) or kill (a shell, by `key`).
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ListStep {
    pub key: String,
    pub kind: StepKind,
    pub label: String,
    pub state: StepState,
    pub detail: Option<String>,
    pub title: String,
    pub killable: bool,
    pub tool_use_id: Option<String>,
}

impl From<steps::Step> for ListStep {
    fn from(step: steps::Step) -> Self {
        Self {
            key: step.key,
            kind: match step.kind {
                steps::StepKind::Agent => StepKind::Agent,
                steps::StepKind::Task => StepKind::Task,
                steps::StepKind::Shell => StepKind::Shell,
            },
            label: step.label,
            state: match step.state {
                steps::StepState::Done => StepState::Done,
                steps::StepState::Running => StepState::Running,
                steps::StepState::Failed => StepState::Failed,
                steps::StepState::Pending => StepState::Pending,
            },
            detail: step.detail,
            title: step.title,
            killable: step.killable,
            tool_use_id: step.tool_use_id,
        }
    }
}

impl From<SessionState> for RowState {
    fn from(state: SessionState) -> Self {
        match state {
            SessionState::Attention => RowState::Attention,
            SessionState::Working => RowState::Working,
            SessionState::Idle => RowState::Idle,
            SessionState::Ended => RowState::Ended,
        }
    }
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ListRow {
    pub key: String,
    pub host_id: String,
    pub session_id: String,
    pub depth: u8,
    pub title: String,
    pub project: String,
    pub host_name: String,
    pub show_gateway: bool,
    pub engine: String,
    pub mark: Option<Mark>,
    pub mark_tinted: bool,
    pub name_tinted: bool,
    pub state: RowState,
    pub state_label: String,
    pub badge: Option<StatusBadge>,
    pub team_state: Option<RowState>,
    pub context: bool,
    pub unseen: u32,
    pub status: Option<String>,
    pub model: Option<String>,
    pub model_label: Option<String>,
    pub agent: Option<String>,
    pub agent_id: Option<String>,
    pub avatar_key: Option<String>,
    pub avatar_busy: bool,
    pub asleep: bool,
    pub can_sleep: bool,
    pub members: u32,
    pub team_expanded: bool,
    pub tray: Vec<TrayMember>,
    pub tray_overflow: u32,
    pub steps: Vec<ListStep>,
    pub last_activity_at: f64,
}

// A Member the lead's tray holds in Auto: a picture to tap, which opens that Member.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct TrayMember {
    pub key: String,
    pub host_id: String,
    pub session_id: String,
    pub title: String,
    pub avatar_key: Option<String>,
    pub asleep: bool,
}

// The tray draws this many pictures; past it, one slot gives way to a `+n` count.
const TRAY_MAX: usize = 3;

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ListGroup {
    pub key: String,
    pub label: Option<String>,
    pub collapsed: bool,
    pub sessions: u32,
    pub working: u32,
    pub attention: u32,
    pub unseen: u32,
    pub rows: Vec<ListRow>,
}

struct Host {
    id: String,
    name: String,
    local: bool,
    sessions: Vec<SessionInfo>,
}

// The "you are seeing a subset" line: shown of total, and every cause.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Subset {
    pub shown: u32,
    pub total: u32,
    pub causes: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ProjectChoice {
    pub key: String,
    pub label: String,
}

// A session another row could join as a member, for the row menu's "Add to team".
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct TeamLead {
    pub session_id: String,
    pub agent_id: String,
    pub name: String,
}

// Where this phone had read a session to, and when: the catch-up seam's whole input.
#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct ReadMark {
    pub item_count: u32,
    pub seen_at: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ListGroupBy {
    None,
    State,
    Adapter,
    Project,
    Custom,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ListSortBy {
    Recent,
    Name,
    Gateway,
    Adapter,
    State,
    Project,
}

// How much of a card's agents, shells or tasks draws under it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum StepShow {
    All,
    Active,
    Hide,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ListFacet {
    Gateway,
    Adapter,
    Project,
}

// The filter menu's whole reading. `engaged` fills its funnel: a facet filters, or a card display is off its default.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ListFilter {
    pub search: String,
    pub states: Vec<RowState>,
    pub gateways: Vec<String>,
    pub adapters: Vec<String>,
    pub projects: Vec<String>,
    pub group_by: ListGroupBy,
    pub sort_by: ListSortBy,
    pub agents: StepShow,
    pub shells: StepShow,
    pub tasks: StepShow,
    pub engaged: bool,
}

// What the create form starts a new agent from on one gateway: the leads it could join, which one is chosen, and
// what the gateway stamps on an agent that asks for nothing.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct NewAgentSeed {
    pub leads: Vec<TeamLead>,
    pub lead: Option<String>,
    pub allow_shared: bool,
    pub shared: bool,
    pub owner: Option<String>,
}

fn group_by_of(value: GroupBy) -> ListGroupBy {
    match value {
        GroupBy::None => ListGroupBy::None,
        GroupBy::State => ListGroupBy::State,
        GroupBy::Adapter => ListGroupBy::Adapter,
        GroupBy::Project => ListGroupBy::Project,
        GroupBy::Custom => ListGroupBy::Custom,
    }
}

fn sort_by_of(value: SortBy) -> ListSortBy {
    match value {
        SortBy::Recent => ListSortBy::Recent,
        SortBy::Name => ListSortBy::Name,
        SortBy::Gateway => ListSortBy::Gateway,
        SortBy::Adapter => ListSortBy::Adapter,
        SortBy::State => ListSortBy::State,
        SortBy::Project => ListSortBy::Project,
    }
}

fn show_of(value: StepDisplay) -> StepShow {
    match value {
        StepDisplay::All => StepShow::All,
        StepDisplay::Active => StepShow::Active,
        StepDisplay::None => StepShow::Hide,
    }
}

fn display_of(value: StepShow) -> StepDisplay {
    match value {
        StepShow::All => StepDisplay::All,
        StepShow::Active => StepDisplay::Active,
        StepShow::Hide => StepDisplay::None,
    }
}

fn session_state_of(state: RowState) -> SessionState {
    match state {
        RowState::Attention => SessionState::Attention,
        RowState::Working => SessionState::Working,
        RowState::Idle => SessionState::Idle,
        RowState::Ended => SessionState::Ended,
    }
}

fn toggle<T: PartialEq>(values: &mut Vec<T>, value: T) {
    match values.iter().position(|v| *v == value) {
        Some(at) => {
            values.remove(at);
        }
        None => values.push(value),
    }
}

#[derive(serde::Deserialize)]
struct MetaResponse {
    #[serde(default)]
    relay: Option<serde_json::Value>,
    #[serde(default)]
    agents: Option<serde_json::Value>,
}

struct State {
    hosts: Vec<Host>,
    relay_hosts: Entries<String>,
    config: ViewConfig,
    marks: Watermarks,
    avatars: AvatarLoads,
    selected: Option<String>,
    linger_ends: Option<f64>,
    agent_defaults: Entries<GatewayAgentDefaults>,
    profiles: Entries<Vec<ProfileInfo>>,
}

impl State {
    fn rows(&self) -> Vec<SessionRow> {
        let mut out = Vec::new();
        for host in &self.hosts {
            for info in &host.sessions {
                let mark = self.marks.get(&host.id, &info.id);
                out.push(SessionRow {
                    host_id: host.id.clone(),
                    host_name: host.name.clone(),
                    local: host.local,
                    adapter: info.engine.map_or_else(|| "claude".to_owned(), engine_name),
                    state: vm::session_state(info),
                    info: info.clone(),
                    unseen: unseen_count(mark, info.prose_count.map(|n| n as f64)) as u64,
                    members: None,
                    team_state: None,
                    context: None,
                });
            }
        }
        out
    }

    fn row(&self, host_id: &str, session_id: &str) -> Option<SessionRow> {
        self.rows().into_iter().find(|r| r.host_id == host_id && r.info.id == session_id)
    }

    fn find(&self, host_id: &str, session_id: &str) -> Option<&SessionInfo> {
        self.hosts.iter().find(|h| h.id == host_id)?.sessions.iter().find(|s| s.id == session_id)
    }
}

pub(crate) fn engine_name(engine: ProfileEngine) -> String {
    serde_json::to_value(engine).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum Mark {
    Claude,
    Codex,
    Gemini,
    Deepseek,
    Moonshot,
}

impl From<EngineMark> for Mark {
    fn from(mark: EngineMark) -> Self {
        match mark {
            EngineMark::Claude => Mark::Claude,
            EngineMark::Codex => Mark::Codex,
            EngineMark::Gemini => Mark::Gemini,
            EngineMark::Deepseek => Mark::Deepseek,
            EngineMark::Moonshot => Mark::Moonshot,
        }
    }
}

fn tray_member(row: &SessionRow) -> TrayMember {
    let info = &row.info;
    TrayMember {
        key: vm::session_key(&row.host_id, &info.id),
        host_id: row.host_id.clone(),
        session_id: info.id.clone(),
        title: vm::display_name(info),
        avatar_key: info.agent.as_ref().and_then(|a| avatar_key(&row.host_id, a)),
        asleep: info.engine_asleep == Some(true),
    }
}

fn steps_of(row: &SessionRow, config: &ViewConfig, now_ms: f64) -> Vec<ListStep> {
    steps::session_steps(&row.info, config, now_ms).into_iter().map(Into::into).collect()
}

fn list_row(row: &SessionRow, depth: u8, show_gateway: bool, team: Option<&vm::TeamView>, steps: Vec<ListStep>) -> ListRow {
    let info = &row.info;
    let mark = engine_mark(&row.adapter, info.model.as_deref());
    let status = info.status_label.as_ref().map(|label| match &label.emoji {
        Some(emoji) => format!("{emoji} {}", label.text),
        None => label.text.clone(),
    });
    let state = row.state;
    let asleep = info.engine_asleep == Some(true);
    let tray = team.map_or(&[][..], |t| &t.tray[..]);
    let drawn = if tray.len() > TRAY_MAX { TRAY_MAX - 1 } else { tray.len() };
    ListRow {
        key: vm::session_key(&row.host_id, &info.id),
        host_id: row.host_id.clone(),
        session_id: info.id.clone(),
        depth,
        title: vm::display_name(info),
        project: vm::project_label(info),
        host_name: row.host_name.clone(),
        show_gateway,
        engine: row.adapter.clone(),
        mark: mark.map(Into::into),
        mark_tinted: mark.is_some_and(EngineMark::tints_mark),
        name_tinted: mark.is_some_and(EngineMark::tints_name),
        state: state.into(),
        state_label: state.label().to_owned(),
        badge: vm::status_badge(state, info).map(Into::into),
        team_state: row.team_state.map(Into::into),
        context: row.context == Some(true),
        unseen: row.unseen as u32,
        status,
        model: info.model.clone(),
        model_label: wd_native::vm::model_name::friendly_model(info.model.as_deref()),
        agent: info.agent.as_ref().map(|_| vm::session_label(info)),
        agent_id: info.agent.as_ref().map(|a| a.id.clone()),
        avatar_key: info.agent.as_ref().and_then(|a| avatar_key(&row.host_id, a)),
        avatar_busy: state == SessionState::Working && !asleep,
        asleep,
        can_sleep: vm::can_sleep(info),
        members: row.members.as_ref().map_or(0, |m| m.len() as u32),
        team_expanded: team.is_some_and(|t| t.expanded),
        tray: tray[..drawn].iter().map(tray_member).collect(),
        tray_overflow: (tray.len() - drawn) as u32,
        steps,
        last_activity_at: info.last_activity_at.unwrap_or(info.created_at),
    }
}

#[derive(serde::Deserialize)]
struct SessionsResponse {
    sessions: Vec<serde_json::Value>,
}

#[derive(uniffi::Object)]
pub struct SessionList {
    inner: Mutex<State>,
}

impl SessionList {
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    // `agent_seed` for the create form, each lead with its owner so a cross-owner join can say so.
    pub(crate) fn form_seed(&self, host_id: &str, profile: Option<&str>) -> Option<FormSeed> {
        let seed = self.agent_seed(host_id.to_owned(), None, profile.map(str::to_owned))?;
        let state = self.state();
        let leads = seed
            .leads
            .into_iter()
            .map(|lead| SeedLead {
                owner: state.find(host_id, &lead.session_id).and_then(|info| info.owner.clone()),
                agent_id: lead.agent_id,
                name: lead.name,
            })
            .collect();
        Some(FormSeed { leads, allow_shared: seed.allow_shared, shared: seed.shared, owner: seed.owner })
    }
}

#[uniffi::export]
impl SessionList {
    // Both inputs are what `config_json` / `marks_json` handed back last time; anything unreadable starts fresh.
    #[uniffi::constructor]
    pub fn new(config_json: Option<String>, marks_json: Option<String>) -> std::sync::Arc<Self> {
        let stored = config_json.and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok());
        let marks = marks_json.and_then(|json| serde_json::from_str::<Entries<Watermark>>(&json).ok()).unwrap_or_default();
        std::sync::Arc::new(SessionList {
            inner: Mutex::new(State {
                hosts: Vec::new(),
                relay_hosts: Entries::new(),
                config: normalize_view_config(stored.as_ref()),
                marks: Watermarks::new(marks),
                avatars: AvatarLoads::default(),
                selected: None,
                linger_ends: None,
                agent_defaults: Entries::new(),
                profiles: Entries::new(),
            }),
        })
    }

    // The body of `GET /v1/sessions`, as received. A wrong key falls through to the dashboard's HTML, which lands
    // here as `NotASessionList` and leaves the host's last reading in place. Answers how many sessions did not decode
    // and were left out, so the app can say so instead of losing them silently.
    pub fn set_host(&self, host_id: String, host_name: String, local: bool, body: String) -> Result<u32, ListError> {
        let raw = serde_json::from_str::<SessionsResponse>(&body).map_err(|_| ListError::NotASessionList)?.sessions;
        let total = raw.len();
        let sessions: Vec<SessionInfo> = raw.into_iter().filter_map(|s| serde_json::from_value(s).ok()).collect();
        let skipped = (total - sessions.len()) as u32;
        let mut state = self.state();
        match state.hosts.iter_mut().find(|h| h.id == host_id) {
            Some(host) => {
                host.name = host_name;
                host.local = local;
                host.sessions = sessions;
            }
            None => state.hosts.push(Host { id: host_id, name: host_name, local, sessions }),
        }
        Ok(skipped)
    }

    // Drops the host and its read marks; answers whether the marks changed, so the app knows to save them.
    pub fn remove_host(&self, host_id: String) -> bool {
        let mut state = self.state();
        state.hosts.retain(|h| h.id != host_id);
        state.relay_hosts.0.retain(|(_, host)| *host != host_id);
        state.agent_defaults.0.retain(|(host, _)| *host != host_id);
        state.profiles.0.retain(|(host, _)| *host != host_id);
        state.avatars.forget_host(&host_id);
        state.marks.forget_host(&host_id)
    }

    // `now_ms` drives Auto's linger window; `linger_ends` then says when to ask again.
    pub fn groups(&self, now_ms: f64) -> Vec<ListGroup> {
        let mut state = self.state();
        let rows = state.rows();
        let filtered = filter_rows(&rows, &state.config, None);
        let options =
            GroupOptions { gateway_count: Some(state.hosts.len()), all: Some(rows.clone()), relay_hosts: Some(state.relay_hosts.clone()) };
        let config = &state.config;
        let show_gateway = vm::shows_gateway(state.hosts.len(), config);
        let mut linger: Option<f64> = None;
        let groups = group_rows(&filtered, config, &options)
            .into_iter()
            .map(|group| {
                let summary = vm::group_summary(&group.rows);
                let collapsed = if group.earlier == Some(true) {
                    config.earlier_open != Some(true)
                } else {
                    vm::is_group_collapsed(config, &group.key)
                };
                let mut out = Vec::new();
                for row in &group.rows {
                    if row.members.is_none() {
                        out.push(list_row(row, 0, show_gateway, None, steps_of(row, config, now_ms)));
                        continue;
                    }
                    let team = vm::team_view(row, config, state.selected.as_deref(), now_ms);
                    if let Some(ends) = vm::team_linger_ends(&team, now_ms) {
                        linger = Some(linger.map_or(ends, |l| l.min(ends)));
                    }
                    out.push(list_row(row, 0, show_gateway, Some(&team), steps_of(row, config, now_ms)));
                    out.extend(team.shown.iter().map(|m| list_row(m, 1, show_gateway, None, Vec::new())));
                }
                ListGroup {
                    key: group.key,
                    label: group.label,
                    collapsed,
                    sessions: summary.sessions as u32,
                    working: summary.working as u32,
                    attention: summary.attention as u32,
                    unseen: summary.unseen as u32,
                    rows: out,
                }
            })
            .collect();
        state.linger_ends = linger;
        groups
    }

    // When the last `groups` call's soonest linger window closes, so the app redraws then; None when nothing lingers.
    pub fn linger_ends(&self) -> Option<f64> {
        self.state().linger_ends
    }

    // The Member a phone counts as selected: the one opened last, since nothing stays highlighted on a phone.
    pub fn select(&self, host_id: String, session_id: String) {
        self.state().selected = Some(vm::session_key(&host_id, &session_id));
    }

    // The agent pictures to fetch now, each marked in flight until `avatar_settled`; a failure is retried after a minute.
    pub fn avatar_fetches(&self, now_ms: f64) -> Vec<AvatarFetch> {
        let mut state = self.state();
        let State { hosts, avatars, .. } = &mut *state;
        let mut out = Vec::new();
        for host in hosts.iter() {
            for agent in host.sessions.iter().filter_map(|s| s.agent.as_ref()) {
                if let Some(fetch) = avatars.begin(&host.id, agent, now_ms) {
                    out.push(fetch.into());
                }
            }
        }
        out
    }

    pub fn avatar_settled(&self, key: String, loaded: bool, now_ms: f64) {
        self.state().avatars.settle(&key, loaded, now_ms);
    }

    pub fn unseen_total(&self) -> u32 {
        let state = self.state();
        filter_rows(&state.rows(), &state.config, None).iter().map(|r| r.unseen as u32).sum()
    }

    // Poll faster while anything is running or waiting on the reader.
    pub fn busy(&self) -> bool {
        self.state().rows().iter().any(|r| matches!(r.state, SessionState::Attention | SessionState::Working))
    }

    pub fn toggle_group(&self, key: String) {
        let mut state = self.state();
        state.config = if key == "earlier" {
            ViewConfig { earlier_open: Some(state.config.earlier_open != Some(true)), ..state.config.clone() }
        } else {
            vm::toggle_group_collapsed(&state.config, &key)
        };
    }

    pub fn toggle_team(&self, host_id: String, session_id: String) {
        let mut state = self.state();
        let Some(row) = state.rows().into_iter().find(|r| r.host_id == host_id && r.info.id == session_id) else { return };
        state.config = vm::toggle_team_expanded(&state.config, &row);
    }

    pub fn set_search(&self, search: String) {
        self.state().config.search = search;
    }

    // A whole config, as the filter menu edited it; normalized like a stored one, so an unknown value degrades.
    pub fn set_config_json(&self, json: String) {
        let value = serde_json::from_str::<serde_json::Value>(&json).ok();
        self.state().config = normalize_view_config(value.as_ref());
    }

    // Every filter off; the layout choices survive.
    pub fn clear_filters(&self) {
        let mut state = self.state();
        state.config = vm::clear_filters(&state.config);
    }

    // The relay gateway name `GET /v1/meta` reports for a host (None without a relay), so a member whose lead lives
    // on another configured gateway still draws under that lead. `relay_hosts_of`, one host at a time.
    pub fn set_relay(&self, host_id: String, gateway: Option<String>) {
        let mut state = self.state();
        state.relay_hosts.0.retain(|(_, host)| *host != host_id);
        if let Some(gateway) = gateway {
            state.relay_hosts.set(gateway, host_id);
        }
    }

    pub fn filter(&self) -> ListFilter {
        let config = &self.state().config;
        ListFilter {
            search: config.search.clone(),
            states: config.states.iter().map(|s| RowState::from(*s)).collect(),
            gateways: config.gateways.clone(),
            adapters: config.adapters.clone(),
            projects: config.projects.clone().unwrap_or_default(),
            group_by: group_by_of(config.group_by),
            sort_by: sort_by_of(config.sort_by),
            agents: show_of(config.subagents),
            shells: show_of(config.shells.unwrap_or(StepDisplay::Active)),
            tasks: show_of(config.tasks.unwrap_or(StepDisplay::Active)),
            engaged: vm::facet_filter_count(config) > 0 || vm::display_customized(config),
        }
    }

    pub fn toggle_state(&self, state: RowState) {
        toggle(&mut self.state().config.states, session_state_of(state));
    }

    pub fn toggle_facet(&self, facet: ListFacet, value: String) {
        let config = &mut self.state().config;
        match facet {
            ListFacet::Gateway => toggle(&mut config.gateways, value),
            ListFacet::Adapter => toggle(&mut config.adapters, value),
            ListFacet::Project => toggle(config.projects.get_or_insert_with(Vec::new), value),
        }
    }

    pub fn set_group_by(&self, group_by: ListGroupBy) {
        self.state().config.group_by = match group_by {
            ListGroupBy::None => GroupBy::None,
            ListGroupBy::State => GroupBy::State,
            ListGroupBy::Adapter => GroupBy::Adapter,
            ListGroupBy::Project => GroupBy::Project,
            ListGroupBy::Custom => GroupBy::Custom,
        };
    }

    pub fn set_sort_by(&self, sort_by: ListSortBy) {
        self.state().config.sort_by = match sort_by {
            ListSortBy::Recent => SortBy::Recent,
            ListSortBy::Name => SortBy::Name,
            ListSortBy::Gateway => SortBy::Gateway,
            ListSortBy::Adapter => SortBy::Adapter,
            ListSortBy::State => SortBy::State,
            ListSortBy::Project => SortBy::Project,
        };
    }

    pub fn set_step_display(&self, kind: StepKind, show: StepShow) {
        let config = &mut self.state().config;
        let display = display_of(show);
        match kind {
            StepKind::Agent => config.subagents = display,
            StepKind::Shell => config.shells = Some(display),
            StepKind::Task => config.tasks = Some(display),
        }
    }

    // The body of `GET /v1/meta`: the relay it names (see `set_relay`) and the new-agent defaults. False when the
    // body is not a meta answer, which leaves the host's last reading in place.
    pub fn set_meta(&self, host_id: String, body: String) -> bool {
        let Ok(meta) = serde_json::from_str::<MetaResponse>(&body) else { return false };
        let relay = meta.relay.and_then(|r| serde_json::from_value::<GatewayRelayMeta>(r).ok());
        let defaults = meta.agents.and_then(|a| serde_json::from_value::<GatewayAgentDefaults>(a).ok());
        self.set_relay(host_id.clone(), relay.map(|r| r.gateway));
        let mut state = self.state();
        state.agent_defaults.0.retain(|(host, _)| *host != host_id);
        if let Some(defaults) = defaults {
            state.agent_defaults.set(host_id, defaults);
        }
        true
    }

    // The body of `GET /v1/profiles`, so a new agent's sharing and owner follow the profile the create form picks.
    // False when the body is not a profiles answer, which leaves the host's last reading in place.
    pub fn set_profiles(&self, host_id: String, body: String) -> bool {
        let Some(rows) = crate::usage::profile_rows(&body) else { return false };
        let profiles = rows.into_iter().filter_map(|row| serde_json::from_value(row).ok()).collect();
        self.state().profiles.set(host_id, profiles);
        true
    }

    // None while the host has not said it runs agents (no meta yet, or one that predates them).
    pub fn agent_seed(&self, host_id: String, lead_session_id: Option<String>, profile: Option<String>) -> Option<NewAgentSeed> {
        let state = self.state();
        let defaults = state.agent_defaults.get(&host_id)?;
        let profile = profile.and_then(|name| state.profiles.get(&host_id)?.iter().find(|p| p.name == name));
        let rows = state.rows();
        let leads = vm::agent_leads(&rows, &host_id)
            .into_iter()
            .filter_map(|lead| {
                let agent = lead.info.agent.as_ref()?;
                Some(TeamLead { session_id: lead.info.id.clone(), agent_id: agent.id.clone(), name: agent.name.clone() })
            })
            .collect();
        let lead = lead_session_id.and_then(|id| state.find(&host_id, &id)?.agent.as_ref().map(|a| a.id.clone()));
        Some(NewAgentSeed {
            leads,
            lead,
            allow_shared: defaults.allow_shared,
            shared: new_agent_sharing(Some(defaults), profile) == Sharing::Shared,
            owner: new_agent_owner(Some(defaults), profile),
        })
    }

    pub fn subset(&self) -> Option<Subset> {
        let state = self.state();
        let rows = state.rows();
        let shown = filter_rows(&rows, &state.config, None).len() as u64;
        vm::subset_summary(&state.config, None, shown, rows.len() as u64).map(|s| Subset {
            shown: s.shown as u32,
            total: s.total as u32,
            causes: s.causes,
        })
    }

    // The engines and projects present, for the filter menu's chips.
    pub fn adapters(&self) -> Vec<String> {
        vm::adapters_of(&self.state().rows())
    }

    pub fn projects(&self) -> Vec<ProjectChoice> {
        vm::projects_of(&self.state().rows()).into_iter().map(|p| ProjectChoice { key: p.key, label: p.label }).collect()
    }

    pub fn team_leads(&self, host_id: String, session_id: String) -> Vec<TeamLead> {
        let state = self.state();
        let rows = state.rows();
        let Some(row) = rows.iter().find(|r| r.host_id == host_id && r.info.id == session_id) else { return Vec::new() };
        vm::team_leads(&rows, row)
            .into_iter()
            .filter_map(|lead| {
                let agent = lead.info.agent.as_ref()?;
                Some(TeamLead { session_id: lead.info.id.clone(), agent_id: agent.id.clone(), name: agent.name.clone() })
            })
            .collect()
    }

    // The agent ids of a lead's members, for dissolving the team.
    pub fn team_members(&self, host_id: String, session_id: String) -> Vec<String> {
        let state = self.state();
        let rows = state.rows();
        let Some(row) = state.row(&host_id, &session_id) else { return Vec::new() };
        vm::team_members(&row, &rows).into_iter().filter_map(|m| m.info.agent.as_ref().map(|a| a.id.clone())).collect()
    }

    // Marks the session read up to its rollup counters; true when the mark moved and `marks_json` is worth saving.
    pub fn mark_seen(&self, host_id: String, session_id: String, now_ms: f64) -> bool {
        let mut state = self.state();
        let Some(info) = state.find(&host_id, &session_id) else { return false };
        let seen = Seen {
            item_count: None,
            activity: info.activity_count.map(|n| n as f64),
            prose: info.prose_count.map(|n| n as f64),
            turns: info.num_turns.map(f64::from),
        };
        state.marks.mark(&host_id, &session_id, &seen, now_ms)
    }

    // A session screen's mark: rows it rendered plus the rollup counters it last read. True when the mark moved.
    #[allow(clippy::too_many_arguments)]
    pub fn mark(
        &self,
        host_id: String,
        session_id: String,
        item_count: Option<u32>,
        activity: Option<u32>,
        prose: Option<u32>,
        turns: Option<u32>,
        now_ms: f64,
    ) -> bool {
        let seen = Seen {
            item_count: item_count.map(f64::from),
            activity: activity.map(f64::from),
            prose: prose.map(f64::from),
            turns: turns.map(f64::from),
        };
        self.state().marks.mark(&host_id, &session_id, &seen, now_ms)
    }

    pub fn since(&self, host_id: String, session_id: String) -> Option<ReadMark> {
        let state = self.state();
        let mark = state.marks.get(&host_id, &session_id)?;
        Some(ReadMark { item_count: mark.item_count as u32, seen_at: mark.seen_at })
    }

    pub fn forget(&self, host_id: String, session_id: String) -> bool {
        self.state().marks.forget(&host_id, &session_id)
    }

    pub fn session_json(&self, host_id: String, session_id: String) -> Option<String> {
        serde_json::to_string(self.state().find(&host_id, &session_id)?).ok()
    }

    pub fn config_json(&self) -> String {
        serde_json::to_string(&self.state().config).unwrap_or_default()
    }

    pub fn marks_json(&self) -> String {
        serde_json::to_string(self.state().marks.all()).unwrap_or_default()
    }
}
