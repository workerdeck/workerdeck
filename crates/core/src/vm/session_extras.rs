use crate::rest::calls::McpAction;
use crate::rest::error::Answer;
use crate::rest::mcp::{McpServer, McpServers, McpTool};
use crate::rest::{ProfileEngine, SessionInfo};
use crate::vm::composer_lists::Skill;
use serde::Deserialize;
use serde_json::Value;

const MCP_SCOPES: [&str; 6] = ["project", "local", "user", "dynamic", "managed", "claudeai"];
const SKILL_SCOPES: [&str; 4] = ["repo", "user", "system", "admin"];

// Claude Code's own order: closest first, then whatever else the engine names, alphabetically. No scope is "other".
fn scope_order<'a>(order: &[&str], present: impl Iterator<Item = &'a str>) -> Vec<String> {
    let mut present: Vec<&str> = present.collect();
    present.sort_unstable();
    present.dedup();
    let mut out: Vec<String> = order.iter().filter(|s| present.contains(s)).map(|s| (*s).to_owned()).collect();
    out.extend(present.into_iter().filter(|s| !order.contains(s)).map(str::to_owned));
    out
}

pub fn capitalized(text: &str) -> String {
    text.split(' ')
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().chain(chars.flat_map(char::to_lowercase)).collect(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

fn mcp_scope_title(scope: &str) -> &'static str {
    match scope {
        "project" => "Project MCPs",
        "local" => "Local MCPs",
        "user" => "User MCPs",
        "dynamic" => "Session MCPs",
        "managed" => "Managed MCPs",
        "claudeai" => "Connectors",
        _ => "Other MCPs",
    }
}

fn skill_scope_title(scope: &str) -> String {
    match scope {
        "repo" => "This project".to_owned(),
        "user" => "Personal".to_owned(),
        "system" => "System".to_owned(),
        "admin" => "Managed".to_owned(),
        other => capitalized(other),
    }
}

fn non_empty(text: &Option<String>) -> Option<String> {
    text.as_ref().filter(|t| !t.is_empty()).cloned()
}

fn plural(count: usize, noun: &str) -> String {
    format!("{count} {noun}{}", if count == 1 { "" } else { "s" })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum McpStatus {
    Connected,
    Failed,
    NeedsAuth,
    Pending,
    Other,
}

impl McpStatus {
    pub fn of(status: &str) -> Self {
        match status {
            "connected" => McpStatus::Connected,
            "failed" => McpStatus::Failed,
            "needs-auth" => McpStatus::NeedsAuth,
            "pending" => McpStatus::Pending,
            _ => McpStatus::Other,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpServerRow {
    pub name: String,
    pub status: String,
    pub tint: McpStatus,
    pub tools: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpSection {
    pub scope: String,
    pub title: String,
    pub servers: Vec<McpServerRow>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fact {
    pub label: String,
    pub value: String,
    pub alert: bool,
}

fn fact(label: &str, value: impl Into<String>) -> Fact {
    Fact { label: label.to_owned(), value: value.into(), alert: false }
}

// One server's screen. `tool_count` only for a connected server; `actions` only where the engine has them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpServerDetail {
    pub name: String,
    pub status: String,
    pub tint: McpStatus,
    pub facts: Vec<Fact>,
    pub tool_count: Option<u32>,
    pub actions: Vec<McpAction>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpToolRow {
    pub name: String,
    pub title: Option<String>,
    pub description: Option<String>,
}

// A tool's full name is what an `allowedTools` entry or a permission rule has to spell.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct McpToolDetail {
    pub name: String,
    pub facts: Vec<Fact>,
    pub description: Option<String>,
    pub behaviour: Vec<Fact>,
    pub parameters: Option<String>,
}

pub fn full_tool_name(server: &str, tool: &str) -> String {
    format!("mcp__{server}__{tool}")
}

fn sorted(value: &Value) -> Value {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<&String> = map.keys().collect();
            keys.sort();
            Value::Object(keys.into_iter().map(|k| (k.clone(), sorted(&map[k]))).collect())
        }
        Value::Array(items) => Value::Array(items.iter().map(sorted).collect()),
        other => other.clone(),
    }
}

// The `/mcp` screens: the session's servers as the last answer left them. An action answers with the whole refreshed
// list, so one call updates every level of the stack.
#[derive(Debug, Default)]
pub struct McpView {
    servers: Vec<McpServer>,
    error: Option<String>,
    action_error: Option<String>,
    loading: bool,
    can_manage: bool,
}

impl McpView {
    pub fn new(can_manage: bool) -> Self {
        Self { can_manage, loading: true, ..Default::default() }
    }

    pub fn refreshing(&mut self) {
        self.loading = true;
        self.action_error = None;
    }

    pub fn acting(&mut self) {
        self.action_error = None;
    }

    // A refused action may still have moved the server (an Enable whose connect fails answers 400 with that error,
    // the server now `failed`), so the list is stale: true asks for a refetch, and the refusal stays shown across it.
    pub fn action_answered(&mut self, answer: Answer) -> bool {
        match answer.read::<McpServers>() {
            Ok(list) => {
                self.servers = list.servers;
                self.error = None;
                self.action_error = None;
                false
            }
            Err(error) => {
                self.action_error = Some(error.message);
                true
            }
        }
    }

    pub fn answered(&mut self, answer: Answer) {
        self.loading = false;
        match answer.read::<McpServers>() {
            Ok(list) => {
                self.servers = list.servers;
                self.error = None;
            }
            Err(error) => self.error = Some(error.message),
        }
    }

    pub fn loading(&self) -> bool {
        self.loading && self.servers.is_empty()
    }

    pub fn error(&self) -> Option<&str> {
        self.action_error.as_deref().or(self.error.as_deref())
    }

    pub fn is_empty(&self) -> bool {
        self.servers.is_empty()
    }

    pub fn sections(&self) -> Vec<McpSection> {
        let scope = |s: &McpServer| s.scope.clone().unwrap_or_else(|| "other".to_owned());
        let scopes = scope_order(&MCP_SCOPES, self.servers.iter().map(|s| s.scope.as_deref().unwrap_or("other")));
        scopes
            .into_iter()
            .map(|key| McpSection {
                title: mcp_scope_title(&key).to_owned(),
                scope: key.clone(),
                servers: self
                    .servers
                    .iter()
                    .filter(|s| scope(s) == key)
                    .map(|s| McpServerRow {
                        name: s.name.clone(),
                        status: s.status.clone(),
                        tint: McpStatus::of(&s.status),
                        tools: s.is_connected().then(|| plural(s.tool_count(), "tool")),
                    })
                    .collect(),
            })
            .collect()
    }

    fn find(&self, name: &str) -> Option<&McpServer> {
        self.servers.iter().find(|s| s.name == name)
    }

    pub fn server(&self, name: &str) -> Option<McpServerDetail> {
        let server = self.find(name)?;
        let mut facts = Vec::new();
        if let Some(error) = &server.error {
            facts.push(Fact { alert: true, ..fact("Error", error.clone()) });
        }
        if let Some(transport) = &server.transport {
            facts.push(fact("Transport", transport.clone()));
        }
        if let Some(command) = &server.command {
            facts.push(fact("Command", command.clone()));
        }
        if let Some(args) = server.args.as_ref().filter(|a| !a.is_empty()) {
            facts.push(fact("Args", args.join(" ")));
        }
        if let Some(url) = &server.url {
            facts.push(fact("URL", url.clone()));
        }
        if let Some(scope) = &server.scope {
            facts.push(fact("Scope", scope.clone()));
        }
        if let Some(info) = &server.server_info {
            facts.push(fact("Version", format!("{} {}", info.name, info.version)));
        }
        let actions = if !self.can_manage {
            Vec::new()
        } else if server.is_disabled() {
            vec![McpAction::Reconnect, McpAction::Enable]
        } else {
            vec![McpAction::Reconnect, McpAction::Disable]
        };
        Some(McpServerDetail {
            name: server.name.clone(),
            status: server.status.clone(),
            tint: McpStatus::of(&server.status),
            facts,
            tool_count: server.is_connected().then_some(server.tool_count() as u32),
            actions,
        })
    }

    pub fn tools_title(&self, server: &str) -> String {
        plural(self.find(server).map_or(0, McpServer::tool_count), "tool")
    }

    // The search field's rule: trimmed, case-folded, a hit in the name, title or description.
    pub fn tools(&self, server: &str, query: &str) -> Vec<McpToolRow> {
        let needle = query.trim().to_lowercase();
        let tools = self.find(server).and_then(|s| s.tools.as_ref()).map_or(&[][..], Vec::as_slice);
        let hit = |t: &McpTool| {
            needle.is_empty()
                || t.name.to_lowercase().contains(&needle)
                || t.title.as_deref().unwrap_or_default().to_lowercase().contains(&needle)
                || t.description.as_deref().unwrap_or_default().to_lowercase().contains(&needle)
        };
        tools
            .iter()
            .filter(|t| hit(t))
            .map(|t| McpToolRow { name: t.name.clone(), title: non_empty(&t.title), description: non_empty(&t.description) })
            .collect()
    }

    pub fn tool(&self, server: &str, tool: &str) -> Option<McpToolDetail> {
        let found = self.find(server)?.tools.as_ref()?.iter().find(|t| t.name == tool)?;
        let mut facts = vec![fact("Tool name", found.name.clone())];
        if let Some(title) = non_empty(&found.title) {
            facts.push(fact("Title", title));
        }
        facts.push(fact("Full name", full_tool_name(server, &found.name)));
        facts.push(fact("Server", server));
        let yes_no = |v: bool| if v { "yes" } else { "no" };
        let mut behaviour = Vec::new();
        if let Some(a) = &found.annotations {
            for (label, value) in [("Read only", a.read_only), ("Destructive", a.destructive), ("Open world", a.open_world)] {
                if let Some(v) = value {
                    behaviour.push(fact(label, yes_no(v)));
                }
            }
        }
        Some(McpToolDetail {
            name: found.name.clone(),
            facts,
            description: non_empty(&found.description),
            behaviour,
            parameters: found.input_schema.as_ref().map(|s| serde_json::to_string_pretty(&sorted(s)).unwrap_or_default()),
        })
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct SkillRow {
    pub skill: Skill,
    pub title: String,
    pub summary: Option<String>,
    pub scope_label: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SkillSection {
    pub scope: String,
    pub title: String,
    pub skills: Vec<SkillRow>,
}

pub fn skill_sections(skills: &[Skill]) -> Vec<SkillSection> {
    let scopes = scope_order(&SKILL_SCOPES, skills.iter().map(|s| s.scope.as_deref().unwrap_or("other")));
    scopes
        .into_iter()
        .map(|key| SkillSection {
            title: skill_scope_title(&key),
            scope: key.clone(),
            skills: skills
                .iter()
                .filter(|s| s.scope.as_deref().unwrap_or("other") == key)
                .map(|s| SkillRow {
                    skill: s.clone(),
                    title: s.display_name.clone().unwrap_or_else(|| s.name.clone()),
                    summary: s.short_description.clone().or_else(|| s.description.clone()).filter(|t| !t.is_empty()),
                    scope_label: s.scope.as_deref().map(capitalized),
                })
                .collect(),
        })
        .collect()
}

#[derive(Deserialize)]
struct SessionAnswer {
    session: SessionInfo,
}

// What the session menu offers and the info sheet says, from `GET /sessions/:id`. Before an answer only the info
// sheet is offered.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
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

impl SessionExtras {
    pub fn unknown() -> Self {
        Self { engine: "claude".to_owned(), ..Default::default() }
    }

    pub fn read(body: &str) -> Option<Self> {
        let info = serde_json::from_str::<SessionAnswer>(body).ok()?.session;
        let engine = info.engine.unwrap_or(ProfileEngine::Claude);
        let capabilities = info.capabilities.clone().unwrap_or_else(|| engine.capabilities());
        Some(Self {
            files: true,
            mcp: capabilities.mcp_status,
            mcp_can_manage: capabilities.mcp_server_actions,
            skills: capabilities.skills_list,
            engine: serde_json::to_value(engine).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_default(),
            profile: info.profile,
            api_key_source: info.api_key_source,
            cwd: Some(info.cwd),
            sdk_session_id: info.sdk_session_id,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const JSON: Option<&str> = Some("application/json");

    fn view(body: &str, can_manage: bool) -> McpView {
        let mut view = McpView::new(can_manage);
        view.answered(Answer::new(200, JSON, body));
        view
    }

    const SERVERS: &str = r#"{"servers":[
        {"name":"z","status":"connected","scope":"zeta","tools":[{"name":"t"}]},
        {"name":"w","status":"connected","scope":"user","transport":"stdio","command":"wd","args":["--mcp","x"],
         "serverInfo":{"name":"wd","version":"1.2"},"error":"boom",
         "tools":[{"name":"read_file","title":"Read","description":"Reads a FILE"},{"name":"write","title":""},
                  {"name":"ls","annotations":{"readOnly":true,"openWorld":false},"inputSchema":{"type":"object","properties":{"b":1,"a":2}}}]},
        {"name":"f","status":"needs-auth","scope":"project","url":"https://x"},
        {"name":"n","status":"disabled"},
        {"name":"c","status":"failed","scope":"claudeai"}]}"#;

    #[test]
    fn servers_group_by_scope_in_the_clis_order() {
        let sections = view(SERVERS, true).sections();
        let titles: Vec<&str> = sections.iter().map(|s| s.title.as_str()).collect();
        assert_eq!(titles, ["Project MCPs", "User MCPs", "Connectors", "Other MCPs", "Other MCPs"]);
        assert_eq!(sections[3].servers[0].name, "n");
        assert_eq!(sections[4].servers[0].name, "z");
        assert_eq!(sections[1].servers[0].tools.as_deref(), Some("3 tools"));
        assert_eq!(sections[4].servers[0].tools.as_deref(), Some("1 tool"));
        assert_eq!(sections[0].servers[0].tools, None);
        assert_eq!(sections[0].servers[0].tint, McpStatus::NeedsAuth);
        assert_eq!(sections[2].servers[0].tint, McpStatus::Failed);
    }

    #[test]
    fn a_server_lists_its_facts_and_the_engines_actions() {
        let managed = view(SERVERS, true);
        let detail = managed.server("w").unwrap();
        let labels: Vec<&str> = detail.facts.iter().map(|f| f.label.as_str()).collect();
        assert_eq!(labels, ["Error", "Transport", "Command", "Args", "Scope", "Version"]);
        assert!(detail.facts[0].alert);
        assert_eq!(detail.facts[3].value, "--mcp x");
        assert_eq!(detail.facts[5].value, "wd 1.2");
        assert_eq!(detail.tool_count, Some(3));
        assert_eq!(detail.actions, [McpAction::Reconnect, McpAction::Disable]);
        assert_eq!(managed.server("n").unwrap().actions, [McpAction::Reconnect, McpAction::Enable]);
        assert_eq!(managed.server("f").unwrap().tool_count, None);
        assert!(view(SERVERS, false).server("w").unwrap().actions.is_empty());
        assert_eq!(managed.server("nope"), None);
    }

    #[test]
    fn tools_filter_on_name_title_and_description() {
        let v = view(SERVERS, true);
        assert_eq!(v.tools_title("w"), "3 tools");
        assert_eq!(v.tools("w", "").len(), 3);
        assert_eq!(v.tools("w", "  file ").iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["read_file"]);
        assert_eq!(v.tools("w", "READ")[0].title.as_deref(), Some("Read"));
        assert_eq!(v.tools("w", "write")[0].title, None);
    }

    #[test]
    fn a_tool_spells_its_full_name_and_sorted_schema() {
        let v = view(SERVERS, true);
        let tool = v.tool("w", "ls").unwrap();
        assert_eq!(tool.facts.iter().map(|f| f.value.as_str()).collect::<Vec<_>>(), ["ls", "mcp__w__ls", "w"]);
        assert_eq!(
            tool.behaviour.iter().map(|f| (f.label.as_str(), f.value.as_str())).collect::<Vec<_>>(),
            [("Read only", "yes"), ("Open world", "no")]
        );
        let parameters = tool.parameters.unwrap();
        assert!(parameters.find("\"a\"").unwrap() < parameters.find("\"b\"").unwrap());
        assert_eq!(v.tool("w", "read_file").unwrap().parameters, None);
    }

    #[test]
    fn a_refusal_keeps_the_last_list_and_says_why() {
        let mut v = view(SERVERS, true);
        assert!(!v.loading());
        v.refreshing();
        v.answered(Answer::new(409, JSON, r#"{"error":"parked"}"#));
        assert_eq!(v.error(), Some("parked"));
        assert_eq!(v.sections().len(), 5);
        let mut empty = McpView::new(false);
        assert!(empty.loading());
        empty.answered(Answer::new(501, JSON, r#"{"error":"no MCP here"}"#));
        assert!(!empty.loading() && empty.is_empty());
        assert_eq!(empty.error(), Some("no MCP here"));
    }

    #[test]
    fn a_refused_action_asks_for_a_refetch_and_keeps_saying_why() {
        let mut v = view(SERVERS, true);
        v.acting();
        assert!(v.action_answered(Answer::new(400, JSON, r#"{"error":"connect failed"}"#)));
        assert_eq!(v.server("n").unwrap().status, "disabled");
        v.answered(Answer::new(200, JSON, &SERVERS.replace(r#""name":"n","status":"disabled""#, r#""name":"n","status":"failed""#)));
        assert_eq!(v.server("n").unwrap().status, "failed");
        assert_eq!(v.error(), Some("connect failed"));
        v.acting();
        assert!(!v.action_answered(Answer::new(200, JSON, SERVERS)));
        assert_eq!(v.error(), None);
        v.action_answered(Answer::new(400, JSON, r#"{"error":"again"}"#));
        v.refreshing();
        assert_eq!(v.error(), None);
    }

    fn skill(name: &str, scope: Option<&str>) -> Skill {
        Skill {
            name: name.to_owned(),
            description: Some("long".to_owned()),
            short_description: None,
            display_name: None,
            default_prompt: None,
            scope: scope.map(str::to_owned),
            enabled: true,
        }
    }

    #[test]
    fn skills_group_closest_first() {
        let skills = [
            skill("a", Some("admin")),
            skill("b", None),
            skill("c", Some("repo")),
            skill("d", Some("team space")),
            skill("e", Some("user")),
        ];
        let sections = skill_sections(&skills);
        let titles: Vec<&str> = sections.iter().map(|s| s.title.as_str()).collect();
        assert_eq!(titles, ["This project", "Personal", "Managed", "Other", "Team Space"]);
        assert_eq!(sections[0].skills[0].title, "c");
        assert_eq!(sections[0].skills[0].summary.as_deref(), Some("long"));
        assert_eq!(sections[0].skills[0].scope_label.as_deref(), Some("Repo"));
        assert_eq!(sections[3].skills[0].scope_label, None);
    }

    #[test]
    fn the_menu_follows_the_sessions_capabilities() {
        assert!(!SessionExtras::unknown().files);
        let claude = SessionExtras::read(
            r#"{"session":{"id":"s","status":"idle","cwd":"/w","createdAt":1,"lastSeq":0,"pendingPermissionCount":0}}"#,
        )
        .unwrap();
        assert!(claude.files && claude.mcp && claude.mcp_can_manage && !claude.skills);
        assert_eq!(claude.engine, "claude");
        assert_eq!(claude.cwd.as_deref(), Some("/w"));
        let mut capabilities = crate::rest::ProfileEngine::Claude.capabilities();
        (capabilities.mcp_status, capabilities.mcp_server_actions, capabilities.skills_list) = (true, false, false);
        let session = serde_json::json!({"id": "s", "status": "idle", "cwd": "/w", "createdAt": 1, "lastSeq": 0, "pendingPermissionCount": 0,
            "engine": "codex", "profile": "p", "capabilities": capabilities});
        let reported = SessionExtras::read(&serde_json::json!({ "session": session }).to_string()).unwrap();
        assert!(reported.mcp && !reported.mcp_can_manage && !reported.skills);
        assert_eq!((reported.engine.as_str(), reported.profile.as_deref()), ("codex", Some("p")));
        assert_eq!(SessionExtras::read("{}"), None);
    }
}
