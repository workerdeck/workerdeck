use crate::list::{SessionList, engine_name};
use crate::{HttpCall, Mode, ModePicker, ModelPicker, Sharing};
use std::sync::{Arc, Mutex, MutexGuard};
use wd_native::rest::{PermissionMode, Sharing as WireSharing};
use wd_native::vm::create_form::{self as core, AgentSeed, Fields};

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CreateFormFields {
    pub cwd: String,
    pub profile: Option<String>,
    pub permission_mode: Mode,
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

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct FormProfile {
    pub name: String,
    pub engine: String,
    pub unavailable: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct FormLead {
    pub agent_id: String,
    pub name: String,
}

// Everything the form draws besides its fields. `has_catalog` opens the model sheet; otherwise `model_options` is a
// plain picker, and with neither the model is typed.
#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct CreateFormState {
    pub is_agent: bool,
    pub title: String,
    pub submit_label: String,
    pub profiles: Vec<FormProfile>,
    pub shows_profile_picker: bool,
    pub needs_profiles: bool,
    pub mode_label: String,
    pub model_label: String,
    pub has_catalog: bool,
    pub model_options: Vec<String>,
    pub effort_options: Vec<String>,
    pub setting_sources: bool,
    pub budgets: bool,
    pub resume: bool,
    pub list_sessions: bool,
    pub shows_fork: bool,
    pub can_submit: bool,
    pub leads: Vec<FormLead>,
    pub shows_sharing: bool,
    pub sharing: Sharing,
}

fn sharing_out(sharing: WireSharing) -> Sharing {
    if sharing == WireSharing::Shared { Sharing::Shared } else { Sharing::Private }
}

fn sharing_in(sharing: Sharing) -> WireSharing {
    match sharing {
        Sharing::Private => WireSharing::Private,
        Sharing::Shared => WireSharing::Shared,
    }
}

impl From<&Fields> for CreateFormFields {
    fn from(f: &Fields) -> Self {
        Self {
            cwd: f.cwd.clone(),
            profile: f.profile.clone(),
            permission_mode: Mode::from_wire(f.permission_mode).unwrap_or(Mode::Default),
            model: f.model.clone(),
            prompt: f.prompt.clone(),
            user_settings: f.user_settings,
            project_settings: f.project_settings,
            local_settings: f.local_settings,
            partial_messages: f.partial_messages,
            max_turns: f.max_turns.clone(),
            max_budget_usd: f.max_budget_usd.clone(),
            resume: f.resume.clone(),
            fork_session: f.fork_session,
            reasoning_effort: f.reasoning_effort.clone(),
            agent_name: f.agent_name.clone(),
            brief: f.brief.clone(),
            lead: f.lead.clone(),
            sharing: f.sharing.map(sharing_out),
        }
    }
}

impl From<CreateFormFields> for Fields {
    fn from(f: CreateFormFields) -> Self {
        Self {
            cwd: f.cwd,
            profile: f.profile,
            permission_mode: PermissionMode::from(f.permission_mode),
            model: f.model,
            prompt: f.prompt,
            user_settings: f.user_settings,
            project_settings: f.project_settings,
            local_settings: f.local_settings,
            partial_messages: f.partial_messages,
            max_turns: f.max_turns,
            max_budget_usd: f.max_budget_usd,
            resume: f.resume,
            fork_session: f.fork_session,
            reasoning_effort: f.reasoning_effort,
            agent_name: f.agent_name,
            brief: f.brief,
            lead: f.lead,
            sharing: f.sharing.map(sharing_in),
        }
    }
}

// The create session / create agent form. An agent form re-reads its seed from the list's gateway meta whenever the
// profile changes, and hands that list the `/profiles` body it is fed.
#[derive(uniffi::Object)]
pub struct CreateForm {
    inner: Mutex<core::CreateForm>,
    seeding: Option<(Arc<SessionList>, String)>,
}

impl CreateForm {
    fn form(&self) -> MutexGuard<'_, core::CreateForm> {
        self.inner.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn reseed(&self) -> impl FnOnce(Option<&str>) -> Option<AgentSeed> + '_ {
        move |profile| self.seeding.as_ref().and_then(|(list, host)| list.form_seed(host, profile))
    }
}

#[uniffi::export]
impl CreateForm {
    #[uniffi::constructor(default(resume = None))]
    pub fn session(cwd: String, resume: Option<String>) -> Arc<Self> {
        Arc::new(Self { inner: Mutex::new(core::CreateForm::new(cwd, resume, None, None)), seeding: None })
    }

    // A plain session form when the gateway has not said it runs agents.
    #[uniffi::constructor(default(lead = None))]
    pub fn agent(cwd: String, list: Arc<SessionList>, host_id: String, lead: Option<String>) -> Arc<Self> {
        let seed = list.form_seed(&host_id, None);
        Arc::new(Self { inner: Mutex::new(core::CreateForm::new(cwd, None, seed, lead)), seeding: Some((list, host_id)) })
    }

    pub fn fields(&self) -> CreateFormFields {
        self.form().fields().into()
    }

    // Answers the fields as the form keeps them: a profile change adopts that profile's defaults.
    pub fn update(&self, fields: CreateFormFields) -> CreateFormFields {
        let mut form = self.form();
        form.update(fields.into(), self.reseed());
        form.fields().into()
    }

    pub fn state(&self) -> CreateFormState {
        let form = self.form();
        let caps = form.capabilities();
        let agent = form.agent();
        CreateFormState {
            is_agent: form.is_agent(),
            title: form.title().to_owned(),
            submit_label: if form.is_agent() { "Create" } else { "Start" }.to_owned(),
            profiles: form
                .profiles()
                .iter()
                .map(|p| FormProfile {
                    name: p.name.clone(),
                    engine: engine_name(p.resolved_engine()),
                    unavailable: p.available == Some(false),
                })
                .collect(),
            shows_profile_picker: form.shows_profile_picker(),
            needs_profiles: form.needs_profiles(),
            mode_label: form.mode_label().to_owned(),
            model_label: form.model_label(),
            has_catalog: !form.catalog().is_empty(),
            model_options: form.model_options(),
            effort_options: form.effort_options(),
            setting_sources: caps.setting_sources,
            budgets: caps.budgets,
            resume: caps.resume,
            list_sessions: caps.list_sessions,
            shows_fork: form.shows_fork(),
            can_submit: form.can_submit(),
            leads: agent
                .map(|a| a.leads.iter().map(|l| FormLead { agent_id: l.agent_id.clone(), name: l.name.clone() }).collect())
                .unwrap_or_default(),
            shows_sharing: form.shows_sharing(),
            sharing: sharing_out(form.sharing()),
        }
    }

    // The body of `GET /profiles`; false when it is not a profiles answer.
    pub fn set_profiles(&self, body: String) -> bool {
        if let Some((list, host)) = &self.seeding {
            list.set_profiles(host.clone(), body.clone());
        }
        let mut form = self.form();
        form.set_profiles(&body, self.reseed())
    }

    pub fn set_profiles_unavailable(&self) {
        self.form().set_profiles_unavailable();
    }

    pub fn resume_candidates_call(&self) -> HttpCall {
        self.form().resume_candidates_call().into()
    }

    pub fn adopt_stored_session(&self, session_id: String, cwd: Option<String>, custom_title: Option<String>, summary: String) {
        self.form().adopt_stored_session(session_id, cwd, custom_title, summary);
    }

    pub fn model_picker(&self) -> ModelPicker {
        self.form().model_picker().into()
    }

    pub fn mode_picker(&self) -> ModePicker {
        self.form().mode_picker().into()
    }

    // `POST /agents` for an agent form, else `POST /sessions`.
    pub fn call(&self) -> HttpCall {
        self.form().call().into()
    }
}
