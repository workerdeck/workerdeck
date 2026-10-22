use crate::rest::calls::{self, HttpCall, NewAgent, NewSession, SdkSessionQuery, SessionAgent, SettingSource};
use crate::rest::{AgentConfig, EngineCapabilities, ModelOption, PermissionMode, ProfileEngine, ProfileInfo, Sharing};
use crate::vm::model_menu::model_matches;
use crate::vm::pickers::{ModePicker, ModelPicker, PickerRow, mode_label, mode_rows};
use serde_json::{Map, Value, json};

const RESUME_CANDIDATES: u32 = 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SeedLead {
    pub agent_id: String,
    pub name: String,
    pub owner: Option<String>,
}

// What the gateway says about a new agent under the chosen profile: the leads it could join, whether it may be
// shared and what it gets by default, and the owner it will carry.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct AgentSeed {
    pub leads: Vec<SeedLead>,
    pub allow_shared: bool,
    pub shared: bool,
    pub owner: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Fields {
    pub cwd: String,
    pub profile: Option<String>,
    pub permission_mode: PermissionMode,
    pub model: String,
    pub prompt: String,
    pub user_settings: bool,
    pub project_settings: bool,
    pub local_settings: bool,
    pub partial_messages: bool,
    pub max_turns: String,
    pub max_budget_usd: String,
    pub resume: String,
    pub fork_session: bool,
    pub reasoning_effort: String,
    pub agent_name: String,
    pub brief: String,
    pub lead: Option<String>,
    pub sharing: Option<Sharing>,
}

impl Fields {
    fn new(cwd: String, resume: String, lead: Option<String>) -> Self {
        Self {
            cwd,
            profile: None,
            permission_mode: PermissionMode::Default,
            model: String::new(),
            prompt: String::new(),
            user_settings: true,
            project_settings: true,
            local_settings: false,
            partial_messages: true,
            max_turns: String::new(),
            max_budget_usd: String::new(),
            resume,
            fork_session: false,
            reasoning_effort: String::new(),
            agent_name: String::new(),
            brief: String::new(),
            lead,
            sharing: None,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StoredPick {
    session_id: String,
    title: Option<String>,
}

// The create session / create agent form: profile -> engine -> capability record -> legal modes, models and efforts.
#[derive(Debug, Clone, PartialEq)]
pub struct CreateForm {
    fields: Fields,
    agent: Option<AgentSeed>,
    profiles: Vec<ProfileInfo>,
    profiles_unavailable: bool,
    picked: Option<StoredPick>,
}

fn trimmed(text: &str) -> &str {
    text.trim()
}

fn non_empty(text: &str) -> Option<String> {
    let text = text.trim();
    (!text.is_empty()).then(|| text.to_owned())
}

impl CreateForm {
    pub fn new(cwd: String, resume: Option<String>, agent: Option<AgentSeed>, lead: Option<String>) -> Self {
        let lead = if agent.is_some() { lead } else { None };
        Self {
            fields: Fields::new(cwd, resume.unwrap_or_default(), lead),
            agent,
            profiles: Vec::new(),
            profiles_unavailable: false,
            picked: None,
        }
    }

    pub fn fields(&self) -> &Fields {
        &self.fields
    }

    pub fn agent(&self) -> Option<&AgentSeed> {
        self.agent.as_ref()
    }

    pub fn is_agent(&self) -> bool {
        self.agent.is_some()
    }

    // A profile change adopts the new profile's defaults; every other edit is taken as typed.
    pub fn update(&mut self, fields: Fields, reseed: impl FnOnce(Option<&str>) -> Option<AgentSeed>) {
        let profile_changed = fields.profile != self.fields.profile;
        self.fields = fields;
        if profile_changed {
            self.apply_profile_defaults(reseed);
        }
    }

    pub fn profiles(&self) -> &[ProfileInfo] {
        &self.profiles
    }

    pub fn needs_profiles(&self) -> bool {
        self.profiles.is_empty() && !self.profiles_unavailable
    }

    // The body of `GET /profiles`. False when it is not a profiles answer.
    pub fn set_profiles(&mut self, body: &str, reseed: impl FnOnce(Option<&str>) -> Option<AgentSeed>) -> bool {
        let Ok(answer) = serde_json::from_str::<Value>(body) else { return false };
        let Some(rows) = answer.get("profiles").and_then(Value::as_array) else { return false };
        self.profiles = rows.iter().filter_map(|row| serde_json::from_value(row.clone()).ok()).collect();
        if self.fields.profile.is_none() {
            self.fields.profile = self.profiles.first().map(|p| p.name.clone());
        }
        self.apply_profile_defaults(reseed);
        true
    }

    // A gateway predating profiles answers 404: not an error, the form just never names one.
    pub fn set_profiles_unavailable(&mut self) {
        self.profiles_unavailable = true;
    }

    pub fn selected_profile(&self) -> Option<&ProfileInfo> {
        let name = self.fields.profile.as_deref()?;
        self.profiles.iter().find(|p| p.name == name)
    }

    pub fn engine(&self) -> ProfileEngine {
        self.selected_profile().map_or(ProfileEngine::Claude, ProfileInfo::resolved_engine)
    }

    pub fn capabilities(&self) -> EngineCapabilities {
        self.selected_profile().map_or_else(|| self.engine().capabilities(), ProfileInfo::resolved_capabilities)
    }

    pub fn available_modes(&self) -> Vec<PermissionMode> {
        self.capabilities().permission_modes.into_iter().filter(|m| *m != PermissionMode::Unknown).collect()
    }

    // A provider profile's declared ids; empty means the model is typed.
    pub fn model_options(&self) -> Vec<String> {
        self.selected_profile().and_then(|p| p.provider.as_ref()?.models.clone()).unwrap_or_default()
    }

    pub fn catalog(&self) -> &[ModelOption] {
        self.selected_profile().and_then(|p| p.models.as_deref()).unwrap_or_default()
    }

    pub fn default_model(&self) -> Option<&str> {
        self.selected_profile()?.default_model.as_deref()
    }

    fn catalog_row(&self, model: &str) -> Option<&ModelOption> {
        let model = trimmed(model);
        if model.is_empty() {
            return None;
        }
        self.catalog().iter().find(|row| model_matches(row, model))
    }

    // The chosen catalog row's efforts when it declares them, else the record's; empty hides the control.
    pub fn effort_options(&self) -> Vec<String> {
        if let Some(efforts) = self.catalog_row(&self.fields.model).and_then(|row| row.reasoning_efforts.clone()) {
            return efforts;
        }
        self.capabilities().reasoning_efforts.unwrap_or_default()
    }

    pub fn model_label(&self) -> String {
        let model = trimmed(&self.fields.model);
        if model.is_empty() {
            return "Profile default".to_owned();
        }
        self.catalog_row(model).map_or_else(|| model.to_owned(), |row| row.display_name.clone())
    }

    pub fn mode_label(&self) -> &'static str {
        mode_label(self.fields.permission_mode)
    }

    pub fn shows_profile_picker(&self) -> bool {
        self.profiles.len() > 1
    }

    fn host_cwd(&self) -> bool {
        self.capabilities().host_cwd != Some(false)
    }

    pub fn can_submit(&self) -> bool {
        !self.host_cwd() || !self.fields.cwd.trim().is_empty()
    }

    pub fn shows_fork(&self) -> bool {
        let caps = self.capabilities();
        caps.resume && caps.fork_session.unwrap_or(self.engine() == ProfileEngine::Claude)
    }

    pub fn sharing(&self) -> Sharing {
        self.fields
            .sharing
            .or_else(|| self.agent.as_ref().map(|a| if a.shared { Sharing::Shared } else { Sharing::Private }))
            .unwrap_or(Sharing::Private)
    }

    pub fn shows_sharing(&self) -> bool {
        self.agent.as_ref().is_some_and(|a| a.allow_shared) && self.fields.lead.is_none()
    }

    pub fn title(&self) -> &'static str {
        if self.agent.is_some() {
            "New agent"
        } else if self.fields.resume.is_empty() {
            "New session"
        } else {
            "Resume session"
        }
    }

    // The profile's declared defaults, then every sticky choice snapped back into what this engine accepts: a mode,
    // model or effort from another profile must not survive into a request this one would refuse.
    fn apply_profile_defaults(&mut self, reseed: impl FnOnce(Option<&str>) -> Option<AgentSeed>) {
        if self.agent.is_some()
            && let Some(seed) = reseed(self.fields.profile.as_deref())
        {
            self.agent = Some(seed);
        }
        let Some(profile) = self.selected_profile().cloned() else { return };
        let caps = profile.resolved_capabilities();
        let defaults = profile.defaults.as_ref();
        if self.fields.model.is_empty()
            && let Some(model) = defaults.and_then(|d| d.model.clone())
        {
            self.fields.model = model;
        }
        match defaults.and_then(|d| d.permission_mode).filter(|mode| caps.permission_modes.contains(mode)) {
            Some(mode) => self.fields.permission_mode = mode,
            None if !caps.permission_modes.contains(&self.fields.permission_mode) => {
                self.fields.permission_mode = caps.default_permission_mode
            }
            None => {}
        }
        let options = self.model_options();
        if !options.is_empty() {
            if !options.contains(&self.fields.model) {
                self.fields.model = profile.provider.as_ref().and_then(|p| p.model.clone()).unwrap_or_else(|| options[0].clone());
            }
        } else if !self.catalog().is_empty() && !self.fields.model.trim().is_empty() && self.catalog_row(&self.fields.model).is_none() {
            self.fields.model.clear();
        }
        if !self.fields.reasoning_effort.is_empty() && !self.effort_options().contains(&self.fields.reasoning_effort) {
            self.fields.reasoning_effort.clear();
        }
    }

    // Scoped like the other clients' pickers: to the cwd field's directory (blank lists the whole store) and to the
    // chosen profile, so the gateway lists that engine's store.
    pub fn resume_candidates_call(&self) -> HttpCall {
        calls::list_sdk_sessions(&SdkSessionQuery {
            dir: non_empty(&self.fields.cwd),
            limit: Some(RESUME_CANDIDATES),
            offset: None,
            profile: if self.profiles_unavailable { None } else { self.fields.profile.clone() },
        })
    }

    // The thread lives in its recorded directory, so that becomes the cwd; its title rides the create, since a
    // resumed session never sends the first prompt a derived title would read.
    pub fn adopt_stored_session(&mut self, session_id: String, cwd: Option<String>, custom_title: Option<String>, summary: String) {
        if let Some(cwd) = cwd.filter(|c| !c.is_empty()) {
            self.fields.cwd = cwd;
        }
        let title = custom_title.unwrap_or(summary);
        self.picked = Some(StoredPick { session_id: session_id.clone(), title: non_empty(&title) });
        self.fields.resume = session_id;
    }

    pub fn model_picker(&self) -> ModelPicker {
        let current = non_empty(&self.fields.model);
        let default_model = self.default_model();
        let row = |option: &ModelOption| PickerRow {
            value: Some(option.value.clone()),
            title: option.display_name.clone(),
            summary: option.description.clone(),
            selected: current.as_deref().is_some_and(|id| model_matches(option, id)),
            is_default: default_model.is_some_and(|id| model_matches(option, id)),
        };
        let catalog = self.catalog();
        ModelPicker {
            title: "Select model".to_owned(),
            main: catalog.iter().filter(|o| o.primary.unwrap_or(true)).map(row).collect(),
            more: catalog.iter().filter(|o| !o.primary.unwrap_or(true)).map(row).collect(),
            efforts: Vec::new(),
        }
    }

    // Creating a session is exactly when bypass can be chosen, so it is never greyed here.
    pub fn mode_picker(&self) -> ModePicker {
        let default_mode = self.selected_profile().and_then(|p| p.defaults.as_ref()?.permission_mode).unwrap_or(PermissionMode::Default);
        mode_rows(&self.available_modes(), |mode| mode == self.fields.permission_mode, Some(default_mode), Some(true))
    }

    pub fn session_request(&self) -> NewSession {
        let f = &self.fields;
        let caps = self.capabilities();
        let resume = trimmed(&f.resume);
        let is_resume = caps.resume && !resume.is_empty();
        let stored_title = self.picked.as_ref().filter(|p| is_resume && p.session_id == resume).and_then(|p| p.title.clone());
        let sources = [
            (f.user_settings, SettingSource::User),
            (f.project_settings, SettingSource::Project),
            (f.local_settings, SettingSource::Local),
        ];
        let effort = &f.reasoning_effort;
        NewSession {
            cwd: self.host_cwd().then(|| f.cwd.trim().to_owned()),
            profile: if self.profiles_unavailable { None } else { f.profile.clone() },
            prompt: non_empty(&f.prompt),
            permission_mode: Some(f.permission_mode),
            allow_dangerously_skip_permissions: (f.permission_mode == PermissionMode::BypassPermissions).then_some(true),
            setting_sources: caps.setting_sources.then(|| sources.iter().filter(|(on, _)| *on).map(|(_, s)| *s).collect()),
            model: non_empty(&f.model),
            max_turns: if caps.budgets { f.max_turns.trim().parse().ok() } else { None },
            max_budget_usd: if caps.budgets { f.max_budget_usd.trim().parse::<f64>().ok().filter(|v| v.is_finite()) } else { None },
            resume: is_resume.then(|| resume.to_owned()),
            fork_session: (is_resume && self.shows_fork() && f.fork_session).then_some(true),
            reasoning_effort: (!effort.is_empty() && self.effort_options().contains(effort)).then(|| effort.clone()),
            include_partial_messages: Some(f.partial_messages),
            meta: stored_title.map(|title| Map::from_iter([("title".to_owned(), json!(title))])),
            agent: non_empty(&f.agent_name)
                .filter(|_| self.agent.is_none())
                .map(|name| SessionAgent { name: Some(name), ..SessionAgent::default() }),
        }
    }

    pub fn session_call(&self) -> HttpCall {
        calls::create_session(&self.session_request())
    }

    // A member follows its lead, so sharing goes only with an explicit choice and no team; joining a lead of another
    // owner says so, or the gateway refuses it.
    pub fn agent_request(&self) -> NewAgent {
        let session = self.session_request();
        let f = &self.fields;
        let seed = self.agent.as_ref();
        let lead = f.lead.as_ref().and_then(|id| seed?.leads.iter().find(|l| l.agent_id == *id));
        let cross_owner = lead.is_some_and(|lead| lead.owner != seed.and_then(|s| s.owner.clone()));
        NewAgent {
            name: non_empty(&f.agent_name),
            config: Some(AgentConfig {
                cwd: session.cwd,
                profile: session.profile,
                model: session.model,
                reasoning_effort: session.reasoning_effort,
                permission_mode: session.permission_mode,
                brief: non_empty(&f.brief),
                ..Default::default()
            }),
            prompt: session.prompt,
            lead: f.lead.clone(),
            sharing: f.sharing.filter(|_| f.lead.is_none() && seed.is_some_and(|s| s.allow_shared)),
            cross_owner: cross_owner.then_some(true),
        }
    }

    pub fn agent_call(&self) -> HttpCall {
        calls::create_agent(&self.agent_request())
    }

    pub fn call(&self) -> HttpCall {
        if self.agent.is_some() { self.agent_call() } else { self.session_call() }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PROFILES: &str = r#"{"profiles":[
        {"name":"main","engine":"claude","defaults":{"permissionMode":"plan"},
         "models":[{"value":"opus","displayName":"Opus","resolvedModel":"claude-opus-5","reasoningEfforts":["low","high"]},
                   {"value":"sonnet","displayName":"Sonnet"},
                   {"value":"haiku","displayName":"Haiku","primary":false}],
         "defaultModel":"claude-opus-5"},
        {"name":"cx","engine":"codex","models":[{"value":"gpt-5","displayName":"GPT-5"}]},
        {"name":"local","engine":"provider","provider":{"id":"openai","model":"m2","models":["m1","m2"]}},
        {"name":"bare","engine":"provider","provider":{"id":"openai"}},
        {"name":"auto","engine":"claude","defaults":{"model":"sonnet","permissionMode":"auto"}},
        {"name":"cxplan","engine":"codex","defaults":{"permissionMode":"plan"}}
    ]}"#;

    fn none(_: Option<&str>) -> Option<AgentSeed> {
        None
    }

    fn form() -> CreateForm {
        let mut form = CreateForm::new("  /repo  ".into(), None, None, None);
        assert!(form.set_profiles(PROFILES, none));
        form
    }

    fn pick(form: &mut CreateForm, profile: &str) {
        let mut fields = form.fields().clone();
        fields.profile = Some(profile.into());
        form.update(fields, none);
    }

    fn edit(form: &mut CreateForm, change: impl FnOnce(&mut Fields)) {
        let mut fields = form.fields().clone();
        change(&mut fields);
        form.update(fields, none);
    }

    fn body(call: HttpCall) -> Value {
        serde_json::from_str(call.body.as_deref().unwrap()).unwrap()
    }

    fn seed() -> AgentSeed {
        AgentSeed {
            leads: vec![
                SeedLead { agent_id: "a1".into(), name: "Lead".into(), owner: Some("tobias".into()) },
                SeedLead { agent_id: "a2".into(), name: "Other".into(), owner: Some("dan".into()) },
            ],
            allow_shared: true,
            shared: true,
            owner: Some("tobias".into()),
        }
    }

    #[test]
    fn the_static_records_follow_the_protocol_table() {
        let claude = ProfileEngine::Claude.capabilities();
        assert_eq!(claude.permission_modes.len(), 6);
        assert_eq!(claude.background_tasks, Some(true));
        let codex = ProfileEngine::Codex.capabilities();
        assert!(!codex.permission_modes.contains(&PermissionMode::Plan));
        assert_eq!((codex.fork_session, codex.background_tasks, codex.engine_sleep), (Some(false), None, Some(true)));
        let provider = ProfileEngine::Provider.capabilities();
        assert_eq!((provider.host_cwd, provider.engine_sleep, provider.reasoning_efforts), (Some(false), Some(false), None));
        assert_eq!(ProfileEngine::Unknown.capabilities(), claude);
    }

    #[test]
    fn the_first_profile_is_chosen_and_its_defaults_adopted() {
        let form = form();
        assert_eq!(form.fields().profile.as_deref(), Some("main"));
        assert_eq!(form.fields().permission_mode, PermissionMode::Plan);
        assert!(form.shows_profile_picker());
        assert_eq!(form.mode_label(), "Plan");
        assert!(!form.needs_profiles());
    }

    #[test]
    fn a_body_that_is_not_a_profiles_answer_is_refused() {
        let mut form = CreateForm::new(String::new(), None, None, None);
        assert!(!form.set_profiles("<html>", none));
        assert!(!form.set_profiles(r#"{"sessions":[]}"#, none));
        assert!(form.needs_profiles());
        form.set_profiles_unavailable();
        assert!(!form.needs_profiles());
        assert_eq!(form.engine(), ProfileEngine::Claude);
        assert_eq!(form.capabilities(), ProfileEngine::Claude.capabilities());
    }

    #[test]
    fn a_mode_the_new_engine_lacks_falls_back_to_its_default() {
        let mut form = form();
        pick(&mut form, "cx");
        assert_eq!(form.fields().permission_mode, PermissionMode::Default);
        assert_eq!(form.available_modes(), ProfileEngine::Codex.capabilities().permission_modes);
    }

    #[test]
    fn a_mode_the_new_engine_has_survives_the_switch() {
        let mut form = form();
        pick(&mut form, "cx");
        edit(&mut form, |f| f.permission_mode = PermissionMode::AcceptEdits);
        pick(&mut form, "local");
        assert_eq!(form.fields().permission_mode, PermissionMode::Default);
        edit(&mut form, |f| f.permission_mode = PermissionMode::DontAsk);
        pick(&mut form, "bare");
        assert_eq!(form.fields().permission_mode, PermissionMode::DontAsk);
    }

    #[test]
    fn a_profile_default_mode_wins_only_when_the_engine_offers_it() {
        let mut form = form();
        pick(&mut form, "auto");
        assert_eq!(form.fields().permission_mode, PermissionMode::Auto);
        assert_eq!(form.fields().model, "sonnet");
        pick(&mut form, "cxplan");
        assert_eq!(form.fields().permission_mode, PermissionMode::Auto);
        edit(&mut form, |f| f.permission_mode = PermissionMode::Plan);
        pick(&mut form, "cxplan");
        pick(&mut form, "main");
        pick(&mut form, "cxplan");
        assert_eq!(form.fields().permission_mode, PermissionMode::Default);
    }

    #[test]
    fn an_empty_model_takes_the_profile_default() {
        let mut form = CreateForm::new("/r".into(), None, None, None);
        let body = r#"{"profiles":[{"name":"auto","defaults":{"model":"sonnet"},"models":[{"value":"sonnet","displayName":"Sonnet"}]}]}"#;
        form.set_profiles(body, none);
        assert_eq!(form.fields().model, "sonnet");
        assert_eq!(form.model_label(), "Sonnet");
        assert!(!form.shows_profile_picker());
    }

    #[test]
    fn a_provider_model_snaps_into_its_declared_ids() {
        let mut form = form();
        pick(&mut form, "local");
        assert_eq!(form.model_options(), ["m1", "m2"]);
        assert_eq!(form.fields().model, "m2");
        edit(&mut form, |f| f.model = "m1".into());
        pick(&mut form, "bare");
        assert_eq!(form.fields().model, "m1");
        assert!(form.model_options().is_empty());
        pick(&mut form, "local");
        assert_eq!(form.fields().model, "m1");
    }

    #[test]
    fn a_provider_without_a_model_snaps_to_its_first_id() {
        let mut form = CreateForm::new("/r".into(), None, None, None);
        form.set_profiles(r#"{"profiles":[{"name":"p","engine":"provider","provider":{"id":"x","models":["a","b"]}}]}"#, none);
        assert_eq!(form.fields().model, "a");
    }

    #[test]
    fn a_catalog_model_the_next_catalog_lacks_is_dropped() {
        let mut form = form();
        edit(&mut form, |f| f.model = "opus".into());
        pick(&mut form, "cx");
        assert_eq!(form.fields().model, "");
        edit(&mut form, |f| f.model = "gpt-5".into());
        pick(&mut form, "main");
        assert_eq!(form.fields().model, "");
    }

    #[test]
    fn efforts_come_from_the_catalog_row_then_the_record() {
        let mut form = form();
        assert_eq!(form.effort_options(), ["low", "medium", "high", "xhigh", "max"]);
        edit(&mut form, |f| f.model = "claude-opus-5[1m]".into());
        assert_eq!(form.effort_options(), ["low", "high"]);
        assert_eq!(form.model_label(), "Opus");
        edit(&mut form, |f| f.model = "custom-id".into());
        assert_eq!(form.model_label(), "custom-id");
        pick(&mut form, "local");
        assert!(form.effort_options().is_empty());
    }

    #[test]
    fn an_effort_the_new_profile_lacks_is_cleared() {
        let mut form = form();
        edit(&mut form, |f| f.reasoning_effort = "max".into());
        pick(&mut form, "cx");
        assert_eq!(form.fields().reasoning_effort, "");
        edit(&mut form, |f| f.reasoning_effort = "high".into());
        pick(&mut form, "main");
        assert_eq!(form.fields().reasoning_effort, "high");
    }

    #[test]
    fn a_session_request_trims_and_omits() {
        let mut form = form();
        edit(&mut form, |f| {
            f.prompt = "  hi  ".into();
            f.model = " opus ".into();
            f.max_turns = " 5 ".into();
            f.max_budget_usd = "2.5".into();
            f.local_settings = true;
            f.reasoning_effort = "high".into();
        });
        let sent = body(form.session_call());
        assert_eq!(
            sent,
            json!({
                "cwd": "/repo", "profile": "main", "prompt": "hi", "permissionMode": "plan",
                "settingSources": ["user", "project", "local"], "model": "opus", "maxTurns": 5,
                "maxBudgetUsd": 2.5, "reasoningEffort": "high", "includePartialMessages": true
            })
        );
        edit(&mut form, |f| {
            f.prompt = "   ".into();
            f.max_turns = "lots".into();
            f.user_settings = false;
            f.project_settings = false;
            f.local_settings = false;
            f.partial_messages = false;
        });
        let sent = body(form.session_call());
        assert_eq!(sent.get("prompt"), None);
        assert_eq!(sent.get("maxTurns"), None);
        assert_eq!(sent["settingSources"], json!([]));
        assert_eq!(sent["includePartialMessages"], json!(false));
    }

    #[test]
    fn bypass_is_preauthorized() {
        let mut form = form();
        edit(&mut form, |f| f.permission_mode = PermissionMode::BypassPermissions);
        assert_eq!(body(form.session_call())["allowDangerouslySkipPermissions"], json!(true));
    }

    #[test]
    fn fields_the_record_forswears_are_not_sent() {
        let mut form = form();
        pick(&mut form, "cx");
        edit(&mut form, |f| {
            f.max_turns = "5".into();
            f.max_budget_usd = "1".into();
            f.resume = "t1".into();
            f.fork_session = true;
        });
        let sent = body(form.session_call());
        for key in ["settingSources", "maxTurns", "maxBudgetUsd", "forkSession"] {
            assert_eq!(sent.get(key), None, "{key}");
        }
        assert_eq!(sent["resume"], json!("t1"));
        assert!(!form.shows_fork());
        pick(&mut form, "local");
        let sent = body(form.session_call());
        assert_eq!((sent.get("cwd"), sent.get("resume")), (None, None));
    }

    #[test]
    fn a_resume_forks_only_on_claude_and_only_when_asked() {
        let mut form = form();
        edit(&mut form, |f| f.fork_session = true);
        assert_eq!(body(form.session_call()).get("forkSession"), None);
        edit(&mut form, |f| f.resume = " t1 ".into());
        let sent = body(form.session_call());
        assert_eq!((sent["resume"].clone(), sent["forkSession"].clone()), (json!("t1"), json!(true)));
        assert!(form.shows_fork());
        assert_eq!(form.title(), "Resume session");
    }

    #[test]
    fn a_picked_stored_session_brings_its_directory_and_title() {
        let mut form = form();
        form.adopt_stored_session("t1".into(), Some("/elsewhere".into()), None, " Fix the bug ".into());
        assert_eq!((form.fields().cwd.as_str(), form.fields().resume.as_str()), ("/elsewhere", "t1"));
        assert_eq!(body(form.session_call())["meta"], json!({ "title": "Fix the bug" }));
        form.adopt_stored_session("t2".into(), Some(String::new()), Some("Named".into()), "summary".into());
        assert_eq!(form.fields().cwd, "/elsewhere");
        assert_eq!(body(form.session_call())["meta"], json!({ "title": "Named" }));
        edit(&mut form, |f| f.resume = "t3".into());
        assert_eq!(body(form.session_call()).get("meta"), None);
        form.adopt_stored_session("t4".into(), None, Some("  ".into()), "s".into());
        assert_eq!(body(form.session_call()).get("meta"), None);
    }

    #[test]
    fn resume_candidates_follow_the_cwd_and_profile() {
        let mut form = form();
        assert_eq!(form.resume_candidates_call().path, "/sdk-sessions?dir=%2Frepo&limit=20&profile=main");
        edit(&mut form, |f| f.cwd = "  ".into());
        assert_eq!(form.resume_candidates_call().path, "/sdk-sessions?limit=20&profile=main");
        let mut old = CreateForm::new(String::new(), None, None, None);
        old.set_profiles_unavailable();
        assert_eq!(old.resume_candidates_call().path, "/sdk-sessions?limit=20");
        assert_eq!(body(old.session_call()).get("profile"), None);
    }

    #[test]
    fn a_cwd_is_required_only_on_a_host_engine() {
        let mut form = form();
        assert!(form.can_submit());
        edit(&mut form, |f| f.cwd = " ".into());
        assert!(!form.can_submit());
        pick(&mut form, "local");
        assert!(form.can_submit());
    }

    #[test]
    fn the_pickers_show_the_catalog_and_the_engine_modes() {
        let mut form = form();
        edit(&mut form, |f| f.model = "sonnet".into());
        let models = form.model_picker();
        let titles = |rows: &[PickerRow]| rows.iter().map(|r| r.title.clone()).collect::<Vec<_>>();
        assert_eq!((titles(&models.main), titles(&models.more)), (vec!["Opus".to_owned(), "Sonnet".to_owned()], vec!["Haiku".to_owned()]));
        assert!(models.main[0].is_default && !models.main[0].selected);
        assert!(models.main[1].selected);
        assert!(models.efforts.is_empty());
        let modes = form.mode_picker();
        assert_eq!(modes.rows.last().map(|r| r.mode), Some(PermissionMode::BypassPermissions));
        assert!(modes.rows.iter().all(|r| !r.disabled));
        assert!(modes.rows.iter().all(|r| r.is_default == (r.mode == PermissionMode::Plan)));
        assert!(modes.rows.iter().any(|r| r.selected && r.mode == PermissionMode::Plan));
        pick(&mut form, "cx");
        assert_eq!(form.mode_picker().rows.len(), 4);
    }

    #[test]
    fn an_agent_request_carries_the_session_fields_as_config() {
        let mut form = CreateForm::new("/repo".into(), None, Some(seed()), None);
        form.set_profiles(PROFILES, none);
        edit(&mut form, |f| {
            f.agent_name = "  Ada ".into();
            f.brief = " standing ".into();
            f.prompt = "go".into();
        });
        assert_eq!(form.title(), "New agent");
        assert_eq!(form.sharing(), Sharing::Shared);
        assert_eq!(
            body(form.call()),
            json!({
                "name": "Ada",
                "config": { "cwd": "/repo", "profile": "main", "permissionMode": "plan", "brief": "standing" },
                "prompt": "go"
            })
        );
    }

    #[test]
    fn an_agent_shares_only_by_explicit_choice_outside_a_team() {
        let mut form = CreateForm::new("/repo".into(), None, Some(seed()), None);
        edit(&mut form, |f| f.sharing = Some(Sharing::Private));
        assert_eq!(body(form.call())["sharing"], json!("private"));
        assert!(form.shows_sharing());
        edit(&mut form, |f| f.lead = Some("a1".into()));
        assert!(!form.shows_sharing());
        let sent = body(form.call());
        assert_eq!((sent.get("sharing"), sent["lead"].clone(), sent.get("crossOwner")), (None, json!("a1"), None));
        let mut closed = CreateForm::new("/repo".into(), None, Some(AgentSeed { allow_shared: false, ..seed() }), None);
        edit(&mut closed, |f| f.sharing = Some(Sharing::Shared));
        assert_eq!(body(closed.call()).get("sharing"), None);
    }

    #[test]
    fn joining_another_owners_lead_says_so() {
        let mut form = CreateForm::new("/repo".into(), None, Some(seed()), Some("a2".into()));
        assert_eq!(form.fields().lead.as_deref(), Some("a2"));
        assert_eq!(body(form.call())["crossOwner"], json!(true));
        edit(&mut form, |f| f.lead = Some("gone".into()));
        assert_eq!(body(form.call()).get("crossOwner"), None);
    }

    #[test]
    fn a_profile_change_reseeds_the_agent() {
        let mut form = CreateForm::new("/repo".into(), None, Some(seed()), None);
        form.set_profiles(PROFILES, |profile| {
            assert_eq!(profile, Some("main"));
            None
        });
        assert_eq!(form.agent(), Some(&seed()));
        let mut fields = form.fields().clone();
        fields.profile = Some("cx".into());
        form.update(fields, |profile| Some(AgentSeed { shared: false, owner: profile.map(str::to_owned), ..seed() }));
        assert_eq!(form.sharing(), Sharing::Private);
        assert_eq!(form.agent().and_then(|a| a.owner.as_deref()), Some("cx"));
        let mut plain = CreateForm::new("/r".into(), None, None, Some("a1".into()));
        plain.set_profiles(PROFILES, |_| Some(seed()));
        assert!(!plain.is_agent());
        assert_eq!(plain.fields().lead, None);
    }
}
