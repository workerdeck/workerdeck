use wd_native::rest::{ConversationsResponse, RetiredAgentsResponse};
use wd_native::vm::conversations::{self as vm, CurrentConversation};

// Where a screen points: a session by its stable id, and a past conversation of it by `n`. None is the current one.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct SessionAddress {
    pub id: String,
    pub conversation: Option<i64>,
}

impl From<vm::SessionAddress> for SessionAddress {
    fn from(address: vm::SessionAddress) -> Self {
        SessionAddress { id: address.id, conversation: address.conversation }
    }
}

// The current conversation's own number reads as the current address: a list row, a bookmark or a notification for
// it opens the live screen, any other n the past conversation read-only.
#[uniffi::export]
pub fn address_of(id: String, conversation: Option<i64>, current: Option<i64>) -> SessionAddress {
    vm::address_of(&id, conversation, current).into()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum ArchivedKind {
    Past,
    Deleted,
}

// `banner` is "Past conversation · <date>", `note` adds "Closed" and/or "Transcript unavailable" (the web's
// `archivedBannerText`); `current` is the session's current conversation, Go to current's target, while it lives on.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ArchivedView {
    pub kind: ArchivedKind,
    pub banner: String,
    pub note: Option<String>,
    pub at_ms: f64,
    pub current: Option<i64>,
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
            current: view.current,
            unavailable: view.unavailable,
        }
    }
}

pub(crate) fn current_conversation(body: &str) -> Option<CurrentConversation> {
    serde_json::from_str::<ConversationsResponse>(body).ok().map(|response| CurrentConversation::of(&response))
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ConversationItem {
    pub n: i64,
    pub date: String,
    pub title: String,
    pub duration: Option<String>,
    pub current: bool,
    pub unavailable: bool,
}

// A `GET /sessions/:id/conversations` answer as the sheet's rows, newest first, the current one on top. `current_title`
// names the current row (the session's title); `offset_minutes` is the platform's current UTC offset, for local dates.
#[uniffi::export]
pub fn session_conversations(
    body: String,
    current_title: Option<String>,
    now_ms: f64,
    offset_minutes: i32,
) -> Option<Vec<ConversationItem>> {
    let response: ConversationsResponse = serde_json::from_str(&body).ok()?;
    let rows = vm::conversation_list(&response, current_title.as_deref());
    Some(
        vm::conversation_items(&rows, now_ms, offset_minutes)
            .into_iter()
            .map(|item| ConversationItem {
                n: item.n,
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

// What a session asks of the user before its next cut: `uncertain_prompt` is a first message whose delivery is unknown
// (Send again or Dismiss, bound to `uncertain_n`), `start_failed` why a committed conversation did not start (Retry
// start, bound to `start_failed_n`). None when neither, or for a body of another shape.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ConversationNotice {
    pub uncertain_prompt: Option<String>,
    pub uncertain_n: Option<i64>,
    pub start_failed: Option<String>,
    pub start_failed_n: Option<i64>,
}

#[uniffi::export]
pub fn conversation_notice(body: String) -> Option<ConversationNotice> {
    let response: ConversationsResponse = serde_json::from_str(&body).ok()?;
    let recovery = vm::conversation_recovery(&response);
    if recovery.start_failed.is_none() && recovery.uncertain_prompt.is_none() {
        return None;
    }
    let (uncertain_n, uncertain_prompt) = recovery.uncertain_prompt.unzip();
    let (start_failed_n, start_failed) = recovery.start_failed.unzip();
    Some(ConversationNotice { uncertain_prompt, uncertain_n, start_failed, start_failed_n })
}

// The 409 a New conversation answers while queued input is unconfirmed (or, from a discard, changed since): the
// confirmation to show and what `discard_and_cut_call` binds. None for any other answer.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct DiscardConfirmation {
    pub title: String,
    pub detail: String,
    pub confirm: String,
    pub conversation: i64,
    pub input_revision: String,
}

#[uniffi::export]
pub fn discard_confirmation(status: u16, body: String) -> Option<DiscardConfirmation> {
    let refusal = vm::unconfirmed_input_of(status, &body)?;
    let text = vm::discard_confirm_text(&refusal);
    Some(DiscardConfirmation {
        title: text.title,
        detail: text.detail,
        confirm: text.confirm,
        conversation: refusal.conversation,
        input_revision: refusal.input_revision,
    })
}

// A cut refused until a person settles a first message of unknown delivery: the n Send again and Dismiss bind to.
#[uniffi::export]
pub fn uncertain_prompt_conversation(status: u16, body: String) -> Option<i64> {
    vm::uncertain_prompt_of(status, &body)
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
