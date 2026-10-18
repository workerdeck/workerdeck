use crate::list::SessionList;
use std::sync::{Arc, Mutex, MutexGuard};
use wd_native::rest::{AgentConversationsResponse, AgentInfo, RetiredAgentsResponse};
use wd_native::vm::conversations::{self as vm, AgentBinding, Follow};

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Enum)]
pub enum ConversationSelection {
    Agent { gateway: String, agent_id: String },
    Session { gateway: String, session_id: String },
}

impl From<vm::ConversationSelection> for ConversationSelection {
    fn from(selection: vm::ConversationSelection) -> Self {
        match selection {
            vm::ConversationSelection::Agent { gateway, agent_id } => ConversationSelection::Agent { gateway, agent_id },
            vm::ConversationSelection::Session { gateway, session_id } => ConversationSelection::Session { gateway, session_id },
        }
    }
}

impl From<ConversationSelection> for vm::ConversationSelection {
    fn from(selection: ConversationSelection) -> Self {
        match selection {
            ConversationSelection::Agent { gateway, agent_id } => vm::ConversationSelection::Agent { gateway, agent_id },
            ConversationSelection::Session { gateway, session_id } => vm::ConversationSelection::Session { gateway, session_id },
        }
    }
}

// What opening a list row selects: its agent while the row is that agent's current conversation, else the session.
// A session the list does not hold (a push, a deep link, a history row) is a session selection.
#[uniffi::export]
pub fn selection_of(list: Arc<SessionList>, host_id: String, session_id: String) -> ConversationSelection {
    match list.info(&host_id, &session_id) {
        Some(info) => vm::selection_of(&host_id, &info).into(),
        None => ConversationSelection::Session { gateway: host_id, session_id },
    }
}

// One session screen's selection. Each call answers the session to show instead, or None to stay.
#[derive(uniffi::Object)]
pub struct ConversationFollow {
    inner: Mutex<Follow>,
}

impl ConversationFollow {
    fn lock(&self) -> MutexGuard<'_, Follow> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[uniffi::export]
impl ConversationFollow {
    #[uniffi::constructor]
    pub fn new(selection: ConversationSelection, current: String) -> Arc<Self> {
        Arc::new(Self { inner: Mutex::new(Follow::new(selection.into(), &current)) })
    }

    // A session opened from the list, a push or a create: `selection_of` once the list holds it.
    #[uniffi::constructor]
    pub fn open(list: Arc<SessionList>, host_id: String, session_id: String) -> Arc<Self> {
        Arc::new(Self { inner: Mutex::new(Follow::open(&host_id, &session_id, &list.rows())) })
    }

    pub fn selection(&self) -> ConversationSelection {
        self.lock().selection().clone().into()
    }

    pub fn current(&self) -> String {
        self.lock().current().to_owned()
    }

    pub fn follows(&self) -> bool {
        self.lock().follows()
    }

    pub fn superseded(&self, by: String, list: Arc<SessionList>) -> Option<String> {
        let rows = list.rows();
        self.lock().superseded(&by, &rows)
    }

    pub fn listed(&self, list: Arc<SessionList>) -> Option<String> {
        let rows = list.rows();
        self.lock().listed(&rows)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ArchivedKind {
    Past,
    Deleted,
}

// `banner` is "Past conversation · <date>", `note` adds "Agent deleted" and/or "Transcript unavailable" (the web's
// `archivedBannerText`); `current` is Go to current's target while the agent lives on.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ArchivedView {
    pub kind: ArchivedKind,
    pub banner: String,
    pub note: Option<String>,
    pub at_ms: f64,
    pub current: Option<String>,
    pub unavailable: bool,
}

impl ArchivedView {
    pub(crate) fn of(view: &vm::ArchivedView, now_ms: f64, offset_minutes: i32) -> Self {
        let (banner, note) = vm::archived_banner(view, now_ms, offset_minutes);
        ArchivedView {
            kind: match view.kind {
                vm::ArchivedKind::Past => ArchivedKind::Past,
                vm::ArchivedKind::Deleted => ArchivedKind::Deleted,
            },
            banner,
            note,
            at_ms: view.at,
            current: view.current.clone(),
            unavailable: view.unavailable,
        }
    }
}

#[derive(serde::Deserialize)]
struct AgentsBody {
    agents: Vec<AgentInfo>,
}

fn agents_of(body: &str) -> Option<Vec<AgentInfo>> {
    serde_json::from_str::<AgentsBody>(body).ok().map(|body| body.agents)
}

pub(crate) fn agent_bindings(body: &str) -> Option<Vec<AgentBinding>> {
    agents_of(body).map(|agents| agents.iter().map(AgentBinding::from).collect())
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ConversationItem {
    pub session_id: String,
    pub date: String,
    pub title: String,
    pub duration: Option<String>,
    pub current: bool,
    pub unavailable: bool,
}

// A `GET /agents/:id/conversations` answer as the sheet's rows, newest first. `offset_minutes` is the platform's
// current UTC offset, for local dates.
#[uniffi::export]
pub fn agent_conversations(body: String, now_ms: f64, offset_minutes: i32) -> Option<Vec<ConversationItem>> {
    let response: AgentConversationsResponse = serde_json::from_str(&body).ok()?;
    let items = vm::conversation_items(&response.conversations, now_ms, offset_minutes);
    Some(
        items
            .into_iter()
            .map(|item| ConversationItem {
                session_id: item.session_id,
                date: item.date,
                title: item.title,
                duration: item.duration,
                current: item.current,
                unavailable: item.unavailable,
            })
            .collect(),
    )
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct PastAgent {
    pub id: String,
    pub name: String,
    pub avatar: Option<String>,
    pub detail: String,
}

// A `GET /agents?retired=1` answer, most recently deleted first.
#[uniffi::export]
pub fn past_agents(body: String, now_ms: f64, offset_minutes: i32) -> Option<Vec<PastAgent>> {
    let response: RetiredAgentsResponse = serde_json::from_str(&body).ok()?;
    Some(
        vm::past_agent_items(&response.retired, now_ms, offset_minutes)
            .into_iter()
            .map(|item| PastAgent { id: item.id, name: item.name, avatar: item.avatar, detail: item.detail })
            .collect(),
    )
}

// What a live agent asks of the user: `undelivered` is the first message a crash may have kept from the engine (Send
// again or Dismiss), `start_failed` why a committed new conversation did not start (Retry start). None when neither.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct AgentNotice {
    pub agent_id: String,
    pub undelivered: Option<String>,
    pub start_failed: Option<String>,
}

#[uniffi::export]
pub fn agent_notice(agents_body: String, agent_id: String) -> Option<AgentNotice> {
    let agent = agents_of(&agents_body)?.into_iter().find(|agent| agent.id == agent_id)?;
    if agent.undelivered.is_none() && agent.start_failed.is_none() {
        return None;
    }
    Some(AgentNotice { agent_id, undelivered: agent.undelivered, start_failed: agent.start_failed })
}

#[uniffi::export]
pub fn new_conversation_hint() -> String {
    vm::NEW_CONVERSATION_HINT.to_owned()
}

#[uniffi::export]
pub fn delete_agent_title(name: String) -> String {
    vm::delete_agent_title(&name)
}

#[uniffi::export]
pub fn delete_agent_message(name: String) -> String {
    vm::delete_agent_message(&name)
}
