use crate::{HttpAnswer, HttpCall, McpAction, Skill};
use std::sync::{Arc, Mutex, MutexGuard};
use wd_native::rest::calls;
use wd_native::vm::composer_lists;
use wd_native::vm::session_extras::{self as core, McpView};

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum McpStatus {
    Connected,
    Failed,
    NeedsAuth,
    Pending,
    Other,
}

impl From<core::McpStatus> for McpStatus {
    fn from(status: core::McpStatus) -> Self {
        match status {
            core::McpStatus::Connected => McpStatus::Connected,
            core::McpStatus::Failed => McpStatus::Failed,
            core::McpStatus::NeedsAuth => McpStatus::NeedsAuth,
            core::McpStatus::Pending => McpStatus::Pending,
            core::McpStatus::Other => McpStatus::Other,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct Fact {
    pub label: String,
    pub value: String,
    pub alert: bool,
}

fn facts(facts: Vec<core::Fact>) -> Vec<Fact> {
    facts.into_iter().map(|f| Fact { label: f.label, value: f.value, alert: f.alert }).collect()
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct McpServerRow {
    pub name: String,
    pub status: String,
    pub tint: McpStatus,
    pub tools: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct McpSection {
    pub scope: String,
    pub title: String,
    pub servers: Vec<McpServerRow>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct McpServerDetail {
    pub name: String,
    pub status: String,
    pub tint: McpStatus,
    pub facts: Vec<Fact>,
    pub tool_count: Option<u32>,
    pub actions: Vec<McpAction>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct McpToolRow {
    pub name: String,
    pub title: Option<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct McpToolDetail {
    pub name: String,
    pub facts: Vec<Fact>,
    pub description: Option<String>,
    pub behaviour: Vec<Fact>,
    pub parameters: Option<String>,
}

// The `/mcp` sheet for one session: `refresh_call` and `action_call` both answer with the whole list, which goes back
// to `answered`; every level of the stack then reads from here.
#[derive(uniffi::Object)]
pub struct McpServers {
    session_id: String,
    inner: Mutex<McpView>,
}

impl McpServers {
    fn lock(&self) -> MutexGuard<'_, McpView> {
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }
}

#[uniffi::export]
impl McpServers {
    #[uniffi::constructor]
    pub fn new(session_id: String, can_manage: bool) -> Arc<Self> {
        Arc::new(Self { session_id, inner: Mutex::new(McpView::new(can_manage)) })
    }

    pub fn refresh_call(&self) -> HttpCall {
        self.lock().refreshing();
        calls::mcp_servers(&self.session_id).into()
    }

    pub fn action_call(&self, server: String, action: McpAction) -> HttpCall {
        self.lock().acting();
        calls::mcp_action(&self.session_id, &server, action.into()).into()
    }

    // The action's answer; a refusal returns the refetch to make, whose answer goes to `answered`.
    pub fn action_answered(&self, answer: HttpAnswer) -> Option<HttpCall> {
        self.lock().action_answered(answer.core()).then(|| calls::mcp_servers(&self.session_id).into())
    }

    pub fn answered(&self, answer: HttpAnswer) {
        self.lock().answered(answer.core());
    }

    pub fn loading(&self) -> bool {
        self.lock().loading()
    }

    pub fn error(&self) -> Option<String> {
        self.lock().error().map(str::to_owned)
    }

    pub fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }

    pub fn sections(&self) -> Vec<McpSection> {
        self.lock()
            .sections()
            .into_iter()
            .map(|s| McpSection {
                scope: s.scope,
                title: s.title,
                servers: s
                    .servers
                    .into_iter()
                    .map(|r| McpServerRow { name: r.name, status: r.status, tint: r.tint.into(), tools: r.tools })
                    .collect(),
            })
            .collect()
    }

    pub fn server(&self, name: String) -> Option<McpServerDetail> {
        self.lock().server(&name).map(|d| McpServerDetail {
            name: d.name,
            status: d.status,
            tint: d.tint.into(),
            facts: facts(d.facts),
            tool_count: d.tool_count,
            actions: d.actions.into_iter().map(Into::into).collect(),
        })
    }

    pub fn tools_title(&self, server: String) -> String {
        self.lock().tools_title(&server)
    }

    pub fn tools(&self, server: String, query: String) -> Vec<McpToolRow> {
        self.lock()
            .tools(&server, &query)
            .into_iter()
            .map(|t| McpToolRow { name: t.name, title: t.title, description: t.description })
            .collect()
    }

    pub fn tool(&self, server: String, tool: String) -> Option<McpToolDetail> {
        self.lock().tool(&server, &tool).map(|t| McpToolDetail {
            name: t.name,
            facts: facts(t.facts),
            description: t.description,
            behaviour: facts(t.behaviour),
            parameters: t.parameters,
        })
    }
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct SkillRow {
    pub skill: Skill,
    pub title: String,
    pub summary: Option<String>,
    pub scope_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct SkillSection {
    pub scope: String,
    pub title: String,
    pub skills: Vec<SkillRow>,
}

#[uniffi::export]
pub fn skill_sections(skills: Vec<Skill>) -> Vec<SkillSection> {
    let skills: Vec<composer_lists::Skill> = skills
        .into_iter()
        .map(|s| composer_lists::Skill {
            name: s.name,
            description: s.description,
            short_description: s.short_description,
            display_name: s.display_name,
            default_prompt: s.default_prompt,
            scope: s.scope,
            enabled: s.enabled,
        })
        .collect();
    core::skill_sections(&skills)
        .into_iter()
        .map(|section| SkillSection {
            scope: section.scope,
            title: section.title,
            skills: section
                .skills
                .into_iter()
                .map(|row| SkillRow { skill: row.skill.into(), title: row.title, summary: row.summary, scope_label: row.scope_label })
                .collect(),
        })
        .collect()
}

// What the session menu offers and the info sheet shows. Before the session's record is read only the info sheet.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct SessionExtras {
    pub files: bool,
    pub mcp: bool,
    pub mcp_can_manage: bool,
    pub skills: bool,
    pub engine: String,
    pub profile: Option<String>,
    pub api_key_source: Option<String>,
    pub cwd: Option<String>,
    pub sdk_session_id: Option<String>,
}

impl From<core::SessionExtras> for SessionExtras {
    fn from(e: core::SessionExtras) -> Self {
        Self {
            files: e.files,
            mcp: e.mcp,
            mcp_can_manage: e.mcp_can_manage,
            skills: e.skills,
            engine: e.engine,
            profile: e.profile,
            api_key_source: e.api_key_source,
            cwd: e.cwd,
            sdk_session_id: e.sdk_session_id,
        }
    }
}

#[uniffi::export]
pub fn session_extras_unknown() -> SessionExtras {
    core::SessionExtras::unknown().into()
}

// `GET /sessions/:id`'s body; None when it is not a session record.
#[uniffi::export]
pub fn session_extras(body: String) -> Option<SessionExtras> {
    core::SessionExtras::read(&body).map(Into::into)
}
