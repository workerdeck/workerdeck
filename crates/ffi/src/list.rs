// The sessions list for a native app: every gateway's REST rollup, the read watermarks and the view config go in,
// display-ready groups come out. The rules are `wd_native::vm::session_list`; nothing here decides visibility.
use std::sync::Mutex;
use wd_native::rest::{Entries, ProfileEngine, SessionInfo};
use wd_native::vm::engine_mark::{EngineMark, engine_mark};
use wd_native::vm::session_list::{
    self as vm, GroupOptions, SessionRow, SessionState, ViewConfig, filter_rows, group_rows, normalize_view_config,
};
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
    pub engine: String,
    pub mark: Option<Mark>,
    pub mark_tinted: bool,
    pub name_tinted: bool,
    pub state: RowState,
    pub state_label: String,
    pub unseen: u32,
    pub status: Option<String>,
    pub model: Option<String>,
    pub model_label: Option<String>,
    pub agent: Option<String>,
    pub members: u32,
    pub team_collapsed: bool,
    pub last_activity_at: f64,
}

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

struct State {
    hosts: Vec<Host>,
    config: ViewConfig,
    marks: Watermarks,
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

    fn find(&self, host_id: &str, session_id: &str) -> Option<&SessionInfo> {
        self.hosts.iter().find(|h| h.id == host_id)?.sessions.iter().find(|s| s.id == session_id)
    }
}

fn engine_name(engine: ProfileEngine) -> String {
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

fn list_row(row: &SessionRow, depth: u8, config: &ViewConfig) -> ListRow {
    let info = &row.info;
    let mark = engine_mark(&row.adapter, info.model.as_deref());
    let status = info.status_label.as_ref().map(|label| match &label.emoji {
        Some(emoji) => format!("{emoji} {}", label.text),
        None => label.text.clone(),
    });
    let state = row.team_state.unwrap_or(row.state);
    ListRow {
        key: vm::session_key(&row.host_id, &info.id),
        host_id: row.host_id.clone(),
        session_id: info.id.clone(),
        depth,
        title: vm::display_name(info),
        project: vm::project_label(info),
        host_name: row.host_name.clone(),
        engine: row.adapter.clone(),
        mark: mark.map(Into::into),
        mark_tinted: mark.is_some_and(EngineMark::tints_mark),
        name_tinted: mark.is_some_and(EngineMark::tints_name),
        state: state.into(),
        state_label: state.label().to_owned(),
        unseen: row.unseen as u32,
        status,
        model: info.model.clone(),
        model_label: wd_native::vm::model_name::friendly_model(info.model.as_deref()),
        agent: info.agent.as_ref().map(|_| vm::session_label(info)),
        members: row.members.as_ref().map_or(0, |m| m.len() as u32),
        team_collapsed: row.members.is_some() && vm::is_team_collapsed(config, row),
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
}

#[uniffi::export]
impl SessionList {
    // Both inputs are what `config_json` / `marks_json` handed back last time; anything unreadable starts fresh.
    #[uniffi::constructor]
    pub fn new(config_json: Option<String>, marks_json: Option<String>) -> std::sync::Arc<Self> {
        let stored = config_json.and_then(|json| serde_json::from_str::<serde_json::Value>(&json).ok());
        let marks = marks_json.and_then(|json| serde_json::from_str::<Entries<Watermark>>(&json).ok()).unwrap_or_default();
        std::sync::Arc::new(SessionList {
            inner: Mutex::new(State { hosts: Vec::new(), config: normalize_view_config(stored.as_ref()), marks: Watermarks::new(marks) }),
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
        state.marks.forget_host(&host_id)
    }

    pub fn groups(&self) -> Vec<ListGroup> {
        let state = self.state();
        let rows = state.rows();
        let filtered = filter_rows(&rows, &state.config, None);
        let options = GroupOptions { gateway_count: Some(state.hosts.len()), all: Some(rows.clone()), relay_hosts: None };
        let config = &state.config;
        group_rows(&filtered, config, &options)
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
                    out.push(list_row(row, 0, config));
                    if let Some(members) = &row.members
                        && !vm::is_team_collapsed(config, row)
                    {
                        out.extend(members.iter().map(|m| list_row(m, 1, config)));
                    }
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
            .collect()
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
        state.config = vm::toggle_team_collapsed(&state.config, &row);
    }

    pub fn set_search(&self, search: String) {
        self.state().config.search = search;
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
