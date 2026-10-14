// The reader's bookmarks for the native apps: the platform keeps `to_json` wherever it keeps preferences and hands it
// back to `new`; every rule (order, emptied sessions, damaged stores) is the core's `vm::bookmarks`.
use std::sync::{Arc, Mutex, MutexGuard};
use wd_native::row_menu;
use wd_native::vm::bookmarks;

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct RowMenu {
    pub bookmark_item_id: Option<String>,
    pub copy_text: Option<String>,
    pub background_call_id: Option<String>,
}

impl From<row_menu::RowMenu> for RowMenu {
    fn from(menu: row_menu::RowMenu) -> Self {
        RowMenu { bookmark_item_id: menu.bookmark_item_id, copy_text: menu.copy_text, background_call_id: menu.background_call_id }
    }
}

#[derive(uniffi::Object)]
pub struct Bookmarks {
    inner: Mutex<bookmarks::Bookmarks>,
}

impl Bookmarks {
    fn marks(&self) -> MutexGuard<'_, bookmarks::Bookmarks> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

#[uniffi::export]
impl Bookmarks {
    #[uniffi::constructor]
    pub fn new(json: Option<String>) -> Arc<Self> {
        Arc::new(Bookmarks { inner: Mutex::new(bookmarks::Bookmarks::from_json(json.as_deref())) })
    }

    pub fn for_session(&self, host_id: String, session_id: String) -> Vec<String> {
        self.marks().for_session(&host_id, &session_id).to_vec()
    }

    pub fn contains(&self, host_id: String, session_id: String, item_id: String) -> bool {
        self.marks().contains(&host_id, &session_id, &item_id)
    }

    pub fn toggle(&self, host_id: String, session_id: String, item_id: String) -> bool {
        self.marks().toggle(&host_id, &session_id, &item_id)
    }

    pub fn remove_host(&self, host_id: String) -> bool {
        self.marks().remove_host(&host_id)
    }

    pub fn to_json(&self) -> String {
        self.marks().to_json()
    }
}
