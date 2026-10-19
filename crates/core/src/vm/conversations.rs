use crate::rest::{AgentConversation, AgentInfo, ConversationRow, RetiredAgentInfo, SessionInfo, SessionStatus};
use crate::vm::session_list::SessionRow;
use serde::{Deserialize, Serialize};

pub const NEW_CONVERSATION_HINT: &str = "Previous chat context is not carried over";
pub const TRANSCRIPT_UNAVAILABLE: &str = "Transcript unavailable";
pub const AGENT_DELETED: &str = "Agent deleted";
const TURN_REASON: &str = "Finish or stop the current turn first";
const NEW_REASON: &str = "This conversation is still new";
const REQUEST_REASON: &str = "Answer the pending request first";
const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ConversationSelection {
    Agent { gateway: String, agent_id: String },
    Session { gateway: String, session_id: String },
}

pub fn session_listed(info: &SessionInfo) -> bool {
    info.archived != Some(true)
}

pub fn selection_of(gateway: &str, info: &SessionInfo) -> ConversationSelection {
    match &info.agent {
        Some(agent) if session_listed(info) => ConversationSelection::Agent { gateway: gateway.to_owned(), agent_id: agent.id.clone() },
        _ => ConversationSelection::Session { gateway: gateway.to_owned(), session_id: info.id.clone() },
    }
}

pub fn follow_target(selection: &ConversationSelection, rows: &[SessionRow]) -> Option<String> {
    match selection {
        ConversationSelection::Session { session_id, .. } => Some(session_id.clone()),
        ConversationSelection::Agent { gateway, agent_id } => rows
            .iter()
            .find(|row| &row.host_id == gateway && session_listed(&row.info) && row.info.agent.as_ref().is_some_and(|a| &a.id == agent_id))
            .map(|row| row.info.id.clone()),
    }
}

// The list wins because it resolves every rotation the view missed; the one-hop successor covers a list that lags.
pub fn follow_step(
    selection: Option<&ConversationSelection>,
    shown: &str,
    rows: Option<&[SessionRow]>,
    successor: Option<&str>,
    left: &[String],
) -> Option<String> {
    let selection @ ConversationSelection::Agent { .. } = selection? else { return None };
    let listed = rows.and_then(|rows| follow_target(selection, rows));
    [listed, successor.map(str::to_owned)].into_iter().flatten().find(|id| id != shown && !left.contains(id))
}

// `left` keeps a list read before the rotation landed, which still names a left conversation, from sending the
// screen back. An unresolved follow was opened on a session the list did not hold yet (a push, a fresh create).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Follow {
    selection: ConversationSelection,
    current: String,
    left: Vec<String>,
    resolved: bool,
}

impl Follow {
    pub fn new(selection: ConversationSelection, current: &str) -> Self {
        Follow { selection, current: current.to_owned(), left: Vec::new(), resolved: true }
    }

    pub fn open(gateway: &str, current: &str, rows: &[SessionRow]) -> Self {
        let selection = ConversationSelection::Session { gateway: gateway.to_owned(), session_id: current.to_owned() };
        let mut follow = Follow { resolved: false, ..Follow::new(selection, current) };
        follow.resolve(rows);
        follow
    }

    fn resolve(&mut self, rows: &[SessionRow]) {
        if self.resolved {
            return;
        }
        let ConversationSelection::Session { gateway, session_id } = &self.selection else { return };
        if let Some(row) = rows.iter().find(|row| &row.host_id == gateway && &row.info.id == session_id) {
            self.selection = selection_of(gateway, &row.info);
            self.resolved = true;
        }
    }

    pub fn selection(&self) -> &ConversationSelection {
        &self.selection
    }

    pub fn current(&self) -> &str {
        &self.current
    }

    pub fn follows(&self) -> bool {
        matches!(self.selection, ConversationSelection::Agent { .. })
    }

    pub fn superseded(&mut self, by: &str, rows: &[SessionRow]) -> Option<String> {
        self.resolve(rows);
        let target = follow_step(Some(&self.selection), &self.current, Some(rows), Some(by), &self.left)?;
        self.move_to(target)
    }

    pub fn listed(&mut self, rows: &[SessionRow]) -> Option<String> {
        self.resolve(rows);
        let target = follow_step(Some(&self.selection), &self.current, Some(rows), None, &self.left)?;
        self.move_to(target)
    }

    fn move_to(&mut self, target: String) -> Option<String> {
        let left = std::mem::replace(&mut self.current, target);
        self.left.push(left);
        Some(self.current.clone())
    }
}

// What `archived_view` needs of an agent: the gateway's `GET /agents` rows parse into it as they are.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentBinding {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

impl From<&AgentInfo> for AgentBinding {
    fn from(agent: &AgentInfo) -> Self {
        AgentBinding { id: agent.id.clone(), session_id: agent.session_id.clone() }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ArchivedKind {
    Past,
    Deleted,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ArchivedView {
    pub kind: ArchivedKind,
    pub at: f64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current: Option<String>,
    pub unavailable: bool,
}

// `agents` is None until the gateway's agent list has loaded: a missing agent is not yet a deleted one.
pub fn archived_view(info: &SessionInfo, agents: Option<&[AgentBinding]>) -> Option<ArchivedView> {
    if info.archived != Some(true) {
        return None;
    }
    let agent = info.agent.as_ref().and_then(|of| agents?.iter().find(|entry| entry.id == of.id));
    let deleted = info.agent.is_some() && agents.is_some() && agent.is_none();
    let current = agent.and_then(|agent| agent.session_id.clone()).filter(|id| *id != info.id);
    Some(ArchivedView {
        kind: if deleted { ArchivedKind::Deleted } else { ArchivedKind::Past },
        at: info.created_at,
        current,
        unavailable: info.transcript.as_deref() == Some("unavailable"),
    })
}

// The web's `archivedBannerText`: the headline always dates the conversation; the note says what else is true.
pub fn archived_banner(view: &ArchivedView, now_ms: f64, offset_minutes: i32) -> (String, Option<String>) {
    let headline = format!("Past conversation \u{00B7} {}", date_label(view.at, now_ms, offset_minutes));
    let notes: Vec<&str> =
        [(view.kind == ArchivedKind::Deleted).then_some(AGENT_DELETED), view.unavailable.then_some(TRANSCRIPT_UNAVAILABLE)]
            .into_iter()
            .flatten()
            .collect();
    (headline, (!notes.is_empty()).then(|| notes.join(" \u{00B7} ")))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NewConversationGate {
    pub enabled: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

pub fn new_conversation_gate(info: Option<&SessionInfo>) -> NewConversationGate {
    let reason = info.filter(|info| info.archived != Some(true)).and_then(|info| match info.status {
        SessionStatus::Running | SessionStatus::Starting | SessionStatus::Parked => Some(TURN_REASON),
        SessionStatus::AwaitingApproval => Some(REQUEST_REASON),
        SessionStatus::Idle if info.sdk_session_id.is_none() && info.num_turns.unwrap_or(0) == 0 => Some(NEW_REASON),
        _ => None,
    });
    NewConversationGate { enabled: reason.is_none(), reason: reason.map(str::to_owned) }
}

// An agent rotates instead (New conversation); a typed `/clear` still clears within the current conversation.
pub fn clear_context_offered(info: &SessionInfo) -> bool {
    info.agent.is_none() && info.archived != Some(true)
}

pub fn conversations_of(session_id: Option<&str>, past_sessions: &[String], conversations: &[AgentConversation]) -> Vec<ConversationRow> {
    let legacy = past_sessions
        .iter()
        .map(String::as_str)
        .chain(session_id)
        .filter(|id| !conversations.iter().any(|entry| entry.session_id == *id))
        .map(|id| AgentConversation { session_id: id.to_owned(), ..AgentConversation::default() });
    let ordered: Vec<AgentConversation> = legacy.chain(conversations.iter().cloned()).collect();
    ordered
        .into_iter()
        .rev()
        .map(|conversation| ConversationRow { current: Some(conversation.session_id.as_str()) == session_id, conversation, session: None })
        .collect()
}

pub fn agent_conversations(agent: &AgentInfo) -> Vec<ConversationRow> {
    conversations_of(agent.session_id.as_deref(), &agent.past_sessions, agent.conversations.as_deref().unwrap_or_default())
}

pub fn retired_conversations(agent: &RetiredAgentInfo) -> Vec<ConversationRow> {
    conversations_of(None, &agent.past_sessions, &agent.conversations)
}

// One line of an agent's Conversations sheet. The current row opens the agent view; a past row opens read-only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationItem {
    pub session_id: String,
    pub date: String,
    pub title: String,
    pub duration: Option<String>,
    pub current: bool,
    pub unavailable: bool,
}

// The web's `conversationRowText`: the current conversation has no end yet, so its duration runs to `now`.
pub fn conversation_items(rows: &[ConversationRow], now_ms: f64, offset_minutes: i32) -> Vec<ConversationItem> {
    rows.iter()
        .map(|row| {
            let entry = &row.conversation;
            let unavailable = entry.transcript.as_deref() == Some("unavailable");
            let end = entry.ended_at.or(row.current.then_some(now_ms));
            let title = entry.title.as_deref().map(str::trim).filter(|title| !title.is_empty());
            ConversationItem {
                session_id: entry.session_id.clone(),
                date: entry
                    .started_at
                    .or(entry.ended_at)
                    .map_or_else(|| "Date unknown".to_owned(), |at| date_label(at, now_ms, offset_minutes)),
                title: title
                    .map_or_else(|| if unavailable { TRANSCRIPT_UNAVAILABLE } else { "Untitled conversation" }.to_owned(), str::to_owned),
                duration: entry.started_at.zip(end).filter(|(start, end)| end >= start).map(|(start, end)| duration_label(end - start)),
                current: row.current,
                unavailable,
            }
        })
        .collect()
}

// One row of the Past agents list: a deleted agent whose conversations are still readable.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PastAgentItem {
    pub id: String,
    pub name: String,
    pub avatar: Option<String>,
    pub detail: String,
}

pub fn past_agent_items(retired: &[RetiredAgentInfo], now_ms: f64, offset_minutes: i32) -> Vec<PastAgentItem> {
    let mut sorted: Vec<&RetiredAgentInfo> = retired.iter().collect();
    sorted.sort_by(|a, b| b.retired_at.total_cmp(&a.retired_at));
    sorted
        .into_iter()
        .map(|agent| {
            let count = retired_conversations(agent).len();
            let plural = if count == 1 { "" } else { "s" };
            PastAgentItem {
                id: agent.id.clone(),
                name: agent.name.clone(),
                avatar: agent.avatar.clone(),
                detail: format!("Deleted {} \u{00B7} {count} conversation{plural}", date_label(agent.retired_at, now_ms, offset_minutes)),
            }
        })
        .collect()
}

pub fn delete_agent_title(name: &str) -> String {
    format!("Delete {name}?")
}

pub fn delete_agent_message(name: &str) -> String {
    format!("{name} leaves your agents. Its conversations stay under Past agents. Team members are released.")
}

fn civil(epoch_ms: f64, offset_minutes: i32) -> (i64, usize, i64, i64, i64) {
    let local = (epoch_ms / 1000.0).floor() as i64 + i64::from(offset_minutes) * 60;
    let days = local.div_euclid(86_400);
    let seconds = local.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + i64::from(month <= 2);
    (year, (month - 1) as usize, day, seconds / 3600, seconds % 3600 / 60)
}

fn local_day(epoch_ms: f64, offset_minutes: i32) -> i64 {
    ((epoch_ms / 1000.0).floor() as i64 + i64::from(offset_minutes) * 60).div_euclid(86_400)
}

// Local wall time from the platform's UTC offset: "Today 14:05", "Yesterday 09:30", "Oct 3, 18:12", "Dec 30, 2025".
pub fn date_label(epoch_ms: f64, now_ms: f64, offset_minutes: i32) -> String {
    let (year, month, day, hour, minute) = civil(epoch_ms, offset_minutes);
    let time = format!("{hour:02}:{minute:02}");
    match local_day(now_ms, offset_minutes) - local_day(epoch_ms, offset_minutes) {
        0 => format!("Today {time}"),
        1 => format!("Yesterday {time}"),
        _ if civil(now_ms, offset_minutes).0 == year => format!("{} {day}, {time}", MONTHS[month]),
        _ => format!("{} {day}, {year}", MONTHS[month]),
    }
}

pub fn duration_label(ms: f64) -> String {
    let minutes = (ms / 60_000.0).round() as i64;
    let hours = minutes / 60;
    match minutes {
        ..1 => "under a minute".to_owned(),
        1..60 => format!("{minutes}m"),
        _ if hours < 48 && minutes % 60 == 0 => format!("{hours}h"),
        _ if hours < 48 => format!("{hours}h {}m", minutes % 60),
        _ => format!("{}d", (hours as f64 / 24.0).round() as i64),
    }
}
