use crate::rest::{
    AgentConversation, ConversationRow, ConversationsResponse, PendingPromptState, RetiredAgentInfo, SessionInfo, SessionStatus,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const NEW_CONVERSATION_HINT: &str = "Previous chat context is not carried over";
pub const TRANSCRIPT_UNAVAILABLE: &str = "Transcript unavailable";
pub const CLOSED: &str = "Closed";
pub const UNCONFIRMED_INPUT_CODE: &str = "unconfirmed_input";
pub const INPUT_CHANGED_CODE: &str = "input_changed";
pub const UNCERTAIN_PROMPT_CODE: &str = "uncertain_prompt";
const TURN_REASON: &str = "Finish or stop the current turn first";
const NEW_REASON: &str = "This conversation is still new";
const REQUEST_REASON: &str = "Answer the pending request first";
const MONTHS: [&str; 12] = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// Where a view points: a session by its stable id, and a past conversation of it by `n`. Absent `conversation` is the
// current one, which a cut moves on under the same address.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct SessionAddress {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation: Option<i64>,
}

impl SessionAddress {
    pub fn current(id: &str) -> Self {
        SessionAddress { id: id.to_owned(), conversation: None }
    }

    pub fn key(&self) -> String {
        address_key(self)
    }

    pub fn is_historical(&self) -> bool {
        self.conversation.is_some()
    }
}

pub fn address_key(address: &SessionAddress) -> String {
    match address.conversation {
        None => address.id.clone(),
        Some(n) => format!("{}#{n}", address.id),
    }
}

pub fn same_address(a: Option<&SessionAddress>, b: Option<&SessionAddress>) -> bool {
    a.map(|a| &a.id) == b.map(|b| &b.id) && a.and_then(|a| a.conversation) == b.and_then(|b| b.conversation)
}

// The current conversation's own number reads as the current address, so a row for it never opens a read-only view.
pub fn address_of(id: &str, conversation: Option<i64>, current: Option<i64>) -> SessionAddress {
    match conversation {
        Some(n) if Some(n) != current => SessionAddress { id: id.to_owned(), conversation: Some(n) },
        _ => SessionAddress::current(id),
    }
}

pub fn is_historical(address: Option<&SessionAddress>) -> bool {
    address.is_some_and(SessionAddress::is_historical)
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
    pub current: Option<i64>,
    pub unavailable: bool,
}

// What the session's own conversations list says now: its current n, or `retired` once it has none.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct CurrentConversation {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub conversation: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retired: Option<bool>,
}

impl CurrentConversation {
    pub fn of(response: &ConversationsResponse) -> Self {
        match response.conversation.filter(|_| response.closed != Some(true)) {
            Some(n) => CurrentConversation { conversation: Some(n), retired: None },
            None => CurrentConversation { conversation: None, retired: Some(true) },
        }
    }
}

pub fn archived_view(address: &SessionAddress, info: Option<&SessionInfo>, current: Option<&CurrentConversation>) -> Option<ArchivedView> {
    let n = address.conversation?;
    let info = info?;
    let retired = current.and_then(|c| c.retired) == Some(true);
    let now = if retired { None } else { current.and_then(|c| c.conversation) };
    Some(ArchivedView {
        kind: if retired { ArchivedKind::Deleted } else { ArchivedKind::Past },
        at: info.created_at,
        current: now.filter(|now| *now != n),
        unavailable: info.transcript.as_deref() == Some("unavailable"),
    })
}

// The web's `archivedBannerText`: the headline always dates the conversation; the note says what else is true.
pub fn archived_banner(view: &ArchivedView, now_ms: f64, offset_minutes: i32) -> (String, Option<String>) {
    let headline = format!("Past conversation \u{00B7} {}", date_label(view.at, now_ms, offset_minutes));
    let notes: Vec<&str> = [(view.kind == ArchivedKind::Deleted).then_some(CLOSED), view.unavailable.then_some(TRANSCRIPT_UNAVAILABLE)]
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
    let reason = info.and_then(|info| match info.status {
        SessionStatus::Running | SessionStatus::Starting | SessionStatus::Parked => Some(TURN_REASON),
        SessionStatus::AwaitingApproval => Some(REQUEST_REASON),
        SessionStatus::Idle if info.sdk_session_id.is_none() && info.num_turns.unwrap_or(0) == 0 => Some(NEW_REASON),
        _ => None,
    });
    NewConversationGate { enabled: reason.is_none(), reason: reason.map(str::to_owned) }
}

// Clear context is a cut on a gateway, named or not; a past conversation's view (status `closed`) has nothing to clear.
pub fn clear_context_offered(info: &SessionInfo) -> bool {
    !matches!(info.status, SessionStatus::Closed | SessionStatus::Failed)
}

// Newest first, the current conversation on top (its start is the previous one's end).
pub fn conversation_list(response: &ConversationsResponse, current_title: Option<&str>) -> Vec<ConversationRow> {
    let mut history: Vec<_> = response.history.iter().collect();
    history.sort_by_key(|entry| std::cmp::Reverse(entry.n));
    let mut rows = Vec::new();
    if let Some(n) = response.conversation.filter(|_| response.closed != Some(true)) {
        rows.push(ConversationRow {
            conversation: AgentConversation {
                n,
                started_at: history.first().map(|entry| entry.ended_at),
                title: current_title.filter(|title| !title.is_empty()).map(str::to_owned),
                ..AgentConversation::default()
            },
            current: true,
        });
    }
    rows.extend(history.into_iter().map(|entry| ConversationRow {
        conversation: AgentConversation {
            n: entry.n,
            started_at: entry.started_at,
            ended_at: Some(entry.ended_at),
            title: entry.title.clone().filter(|title| !title.is_empty()),
            transcript: entry.transcript.clone(),
        },
        current: false,
    }));
    rows
}

// What a session asks of a person before anything else: Retry start for a committed conversation that did not start,
// Send again or Dismiss for a first message whose delivery is unknown.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ConversationRecovery {
    pub start_failed: Option<(i64, String)>,
    pub uncertain_prompt: Option<(i64, String)>,
}

pub fn conversation_recovery(response: &ConversationsResponse) -> ConversationRecovery {
    ConversationRecovery {
        start_failed: response.start_failed.as_ref().map(|failed| (failed.n, failed.error.clone())),
        uncertain_prompt: response
            .pending_prompt
            .as_ref()
            .filter(|prompt| prompt.state == PendingPromptState::Uncertain)
            .map(|prompt| (response.conversation.unwrap_or(prompt.n), prompt.text.clone())),
    }
}

// The 409 a cut answers while the engine cannot confirm its queued input was consumed (`unconfirmed_input`), or a
// discard's when input arrived since (`input_changed`): what the confirmation shows and binds.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UnconfirmedInput {
    pub error: String,
    pub changed: bool,
    pub conversation: i64,
    pub input_revision: String,
    pub pending_input: i64,
    pub may_include_peer: bool,
}

pub fn unconfirmed_input_of(status: u16, body: &str) -> Option<UnconfirmedInput> {
    let body: Value = serde_json::from_str(body).ok().filter(|_| status == 409)?;
    let changed = match body.get("code")?.as_str()? {
        UNCONFIRMED_INPUT_CODE => false,
        INPUT_CHANGED_CODE => true,
        _ => return None,
    };
    Some(UnconfirmedInput {
        error: body.get("error").and_then(Value::as_str).unwrap_or_default().to_owned(),
        changed,
        conversation: body.get("conversation")?.as_i64()?,
        input_revision: body.get("inputRevision")?.as_str()?.to_owned(),
        pending_input: body.get("pendingInput").and_then(Value::as_i64).unwrap_or(0),
        may_include_peer: body.get("mayIncludePeer").and_then(Value::as_bool) != Some(false),
    })
}

// A cut refused until a person decides on a prompt that may not have reached the engine: Send again or Dismiss, both
// bound to the conversation it names.
pub fn uncertain_prompt_of(status: u16, body: &str) -> Option<i64> {
    let body: Value = serde_json::from_str(body).ok().filter(|_| status == 409)?;
    (body.get("code")?.as_str()? == UNCERTAIN_PROMPT_CODE).then_some(())?;
    body.get("promptConversation")?.as_i64()
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscardConfirmText {
    pub title: String,
    pub detail: String,
    pub confirm: String,
}

// The web's `discardConfirmText`.
pub fn discard_confirm_text(refusal: &UnconfirmedInput) -> DiscardConfirmText {
    let count = refusal.pending_input;
    let what = if count > 0 { format!("{count} message{}", if count == 1 { "" } else { "s" }) } else { "queued input".to_owned() };
    let unanswered = format!("{} no answer yet", if count <= 1 { "has" } else { "have" });
    let lead = if refusal.changed {
        format!("More input arrived: {what} {unanswered}.")
    } else {
        format!("{} sent to this session {unanswered}.", capital(&what))
    };
    let peer = if refusal.may_include_peer { " Some of it may come from peer agents, who will not get a reply." } else { "" };
    DiscardConfirmText {
        title: format!("Discard {what} and start a new conversation?"),
        detail: format!("{lead} A new conversation drops it for good; none of it is carried over.{peer}"),
        confirm: "Discard and start".to_owned(),
    }
}

fn capital(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map_or_else(String::new, |first| first.to_uppercase().chain(chars).collect())
}

// One line of a session's Conversations sheet. The current row opens the live view; a past row opens `(id, n)` read-only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ConversationItem {
    pub n: i64,
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
                n: entry.n,
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
            let count = agent.conversations.len();
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
