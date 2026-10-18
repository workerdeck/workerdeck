use crate::rest::SessionInfo;
use crate::vm::session_list::SessionRow;
use serde::{Deserialize, Serialize};

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
