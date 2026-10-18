use crate::list::SessionList;
use std::sync::{Arc, Mutex, MutexGuard};
use wd_native::vm::conversations::{self as vm, Follow};

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
