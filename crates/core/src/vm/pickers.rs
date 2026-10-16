use crate::rest::{ModelOption, PermissionMode};
use crate::transcript::TranscriptState;
use crate::vm::model_menu::{model_matches, model_menu};
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PickerRow {
    pub value: Option<String>,
    pub title: String,
    pub summary: Option<String>,
    pub selected: bool,
    pub is_default: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ModelPicker {
    pub title: String,
    pub main: Vec<PickerRow>,
    pub more: Vec<PickerRow>,
    pub efforts: Vec<PickerRow>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ModeRow {
    pub mode: PermissionMode,
    pub title: String,
    pub summary: String,
    pub selected: bool,
    pub is_default: bool,
    pub disabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct ModePicker {
    pub rows: Vec<ModeRow>,
}

pub struct PickerSource<'a> {
    pub state: &'a TranscriptState,
    pub init_model: Option<&'a str>,
    pub catalog: &'a [ModelOption],
}

impl PickerSource<'_> {
    // The `capabilities` event is the CLI's own answer, so it wins; codex never sends one and falls back to the
    // profile's catalog.
    pub fn models(&self) -> Vec<ModelOption> {
        let reported: Vec<ModelOption> =
            self.state.models.as_deref().and_then(Value::as_array).map(|rows| decode_models(rows)).unwrap_or_default();
        if reported.is_empty() { self.catalog.to_vec() } else { reported }
    }

    pub fn default_model(&self) -> Option<&str> {
        self.state.default_model.as_deref().or(self.init_model)
    }

    pub fn effective_model(&self) -> Option<&str> {
        self.state.model.as_deref().or_else(|| self.default_model())
    }

    pub fn current_effort(&self) -> Option<&str> {
        self.state.effort.as_ref()?.as_deref()
    }

    // Empty unless the session reported a concrete effort, so a model that takes none offers no control.
    pub fn effort_options(&self, models: &[ModelOption]) -> Vec<String> {
        if self.current_effort().is_none() {
            return Vec::new();
        }
        let row_efforts =
            self.effective_model().and_then(|model| models.iter().find(|row| model_matches(row, model))?.reasoning_efforts.clone());
        row_efforts.or_else(|| self.state.capabilities.as_ref()?.reasoning_efforts.clone()).unwrap_or_default()
    }

    pub fn shown_effort(&self) -> Option<String> {
        if self.effort_options(&self.models()).is_empty() { None } else { self.current_effort().map(str::to_owned) }
    }
}

fn decode_models(rows: &[Value]) -> Vec<ModelOption> {
    rows.iter().filter_map(|row| serde_json::from_value(row.clone()).ok()).collect()
}

pub fn model_picker(source: &PickerSource) -> ModelPicker {
    let models = source.models();
    let menu = model_menu(&models, source.default_model());
    let current = source.effective_model();
    let selected = current.and_then(|id| menu.more.iter().find(|row| model_matches(row, id)));
    let mut main = menu.main.clone();
    if let Some(selected) = selected.filter(|row| !main.contains(row)) {
        main.push(selected.clone());
    }
    let row = |option: &ModelOption| PickerRow {
        value: if Some(option) == menu.default_row.as_ref() { None } else { Some(option.value.clone()) },
        title: option.display_name.clone(),
        summary: option.description.clone().filter(|text| !text.is_empty()),
        selected: Some(option) == selected,
        is_default: Some(option) == menu.default_row.as_ref(),
    };
    let more = menu.more.iter().filter(|option| !main.contains(option)).map(row).collect();
    let efforts = effort_rows(&source.effort_options(&models), source.current_effort());
    ModelPicker {
        title: if efforts.is_empty() { "Select model" } else { "Select model and effort" }.to_owned(),
        main: main.iter().map(row).collect(),
        more,
        efforts,
    }
}

// "Default" is never checked: the session reports the effort it resolved to, not that it came from the default.
fn effort_rows(efforts: &[String], current: Option<&str>) -> Vec<PickerRow> {
    if efforts.is_empty() {
        return Vec::new();
    }
    let default = PickerRow {
        value: None,
        title: "Default".to_owned(),
        summary: Some("Whatever this model uses by default".to_owned()),
        selected: false,
        is_default: false,
    };
    let levels = efforts.iter().map(|effort| PickerRow {
        value: Some(effort.clone()),
        title: capitalized(effort),
        summary: None,
        selected: Some(effort.as_str()) == current,
        is_default: false,
    });
    std::iter::once(default).chain(levels).collect()
}

fn capitalized(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map(|first| first.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

pub fn mode_wire(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Default => "default",
        PermissionMode::AcceptEdits => "acceptEdits",
        PermissionMode::BypassPermissions => "bypassPermissions",
        PermissionMode::Plan => "plan",
        PermissionMode::DontAsk => "dontAsk",
        PermissionMode::Auto => "auto",
        PermissionMode::Unknown => "",
    }
}

pub fn mode_label(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Default => "Manual",
        PermissionMode::AcceptEdits => "Accept edits",
        PermissionMode::BypassPermissions => "Bypass permissions",
        PermissionMode::Plan => "Plan",
        PermissionMode::DontAsk => "Don't ask",
        PermissionMode::Auto => "Auto",
        PermissionMode::Unknown => "",
    }
}

pub fn mode_summary(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Default => "Always ask before making changes",
        PermissionMode::AcceptEdits => "Automatically accept all file edits",
        PermissionMode::BypassPermissions => "Skip every approval - the agent is unsupervised",
        PermissionMode::Plan => "Create a plan before making changes",
        PermissionMode::DontAsk => "Never ask - deny anything not pre-approved",
        PermissionMode::Auto => "The agent handles permission decisions",
        PermissionMode::Unknown => "",
    }
}

pub fn mode_picker(state: &TranscriptState, default_mode: Option<PermissionMode>, can_bypass: Option<bool>) -> ModePicker {
    let declared: Vec<PermissionMode> = state.capabilities.as_ref().map(|caps| caps.permission_modes.clone()).unwrap_or_default();
    let current = state.permission_mode.as_deref();
    mode_rows(&declared, |mode| current == Some(mode_wire(mode)), default_mode, can_bypass)
}

// Only the modes the engine declares, bypass pinned last; the CLI refuses to switch into bypass unless the session
// was spawned for it, so it is greyed with the reason rather than hidden. An unknown `can_bypass` offers it.
pub fn mode_rows(
    declared: &[PermissionMode],
    is_current: impl Fn(PermissionMode) -> bool,
    default_mode: Option<PermissionMode>,
    can_bypass: Option<bool>,
) -> ModePicker {
    let declared: Vec<PermissionMode> = declared.iter().copied().filter(|mode| *mode != PermissionMode::Unknown).collect();
    let bypass = PermissionMode::BypassPermissions;
    let ordered = declared.iter().filter(|mode| **mode != bypass).chain(declared.iter().filter(|mode| **mode == bypass));
    let rows = ordered
        .map(|&mode| {
            let disabled = mode == bypass && can_bypass == Some(false);
            ModeRow {
                mode,
                title: mode_label(mode).to_owned(),
                summary: if disabled { "Only available to a session started in this mode" } else { mode_summary(mode) }.to_owned(),
                selected: is_current(mode),
                is_default: default_mode == Some(mode),
                disabled,
            }
        })
        .collect();
    ModePicker { rows }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::rest::EngineCapabilities;
    use serde_json::json;
    use std::sync::Arc;

    fn option(value: &str, name: &str, efforts: Option<&[&str]>) -> Value {
        let mut row = json!({ "value": value, "displayName": name, "description": format!("{name} desc") });
        if let Some(efforts) = efforts {
            row["reasoningEfforts"] = json!(efforts);
        }
        row
    }

    fn state(models: Vec<Value>) -> TranscriptState {
        TranscriptState { models: Some(Arc::new(Value::Array(models))), ..TranscriptState::default() }
    }

    fn caps(modes: &[PermissionMode], efforts: Option<&[&str]>) -> EngineCapabilities {
        EngineCapabilities {
            permission_modes: modes.to_vec(),
            reasoning_efforts: efforts.map(|e| e.iter().map(|s| s.to_string()).collect()),
            ..EngineCapabilities::default()
        }
    }

    fn titles(rows: &[PickerRow]) -> Vec<&str> {
        rows.iter().map(|row| row.title.as_str()).collect()
    }

    #[test]
    fn the_menu_leads_with_the_default_then_the_newest_of_each_line_and_moves_the_rest_to_more() {
        let mut state = state(vec![
            json!({ "value": "default", "displayName": "Default" }),
            option("fable", "Fable 5", None),
            option("opus", "Opus 5.5", None),
            option("claude-opus-4-1", "Opus 4.1", None),
        ]);
        state.default_model = Some("opus".to_owned());
        let picker = model_picker(&PickerSource { state: &state, init_model: None, catalog: &[] });
        assert_eq!(titles(&picker.main), ["Opus 5.5", "Fable 5"]);
        assert_eq!(titles(&picker.more), ["Opus 4.1"]);
        assert_eq!(picker.main[0].value, None);
        assert!(picker.main[0].is_default && picker.main[0].selected);
        assert_eq!(picker.main[1].value.as_deref(), Some("fable"));
        assert_eq!(picker.main[1].summary.as_deref(), Some("Fable 5 desc"));
        assert_eq!(picker.title, "Select model");
        assert!(picker.efforts.is_empty());
    }

    #[test]
    fn an_older_model_in_force_joins_the_main_list_checked() {
        let mut state = state(vec![option("opus", "Opus 5.5", None), option("claude-opus-4-1", "Opus 4.1", None)]);
        state.model = Some("claude-opus-4-1".to_owned());
        let picker = model_picker(&PickerSource { state: &state, init_model: None, catalog: &[] });
        assert_eq!(titles(&picker.main), ["Opus 5.5", "Opus 4.1"]);
        assert!(picker.main[1].selected && !picker.main[0].selected);
        assert!(picker.more.is_empty());
    }

    #[test]
    fn without_reported_models_the_catalog_is_offered_and_the_init_model_names_the_default() {
        let catalog: Vec<ModelOption> = serde_json::from_value(json!([option("gpt-5.6", "GPT-5.6", Some(&["low", "high"]))])).unwrap();
        let mut state = TranscriptState { effort: Some(Some("high".to_owned())), ..TranscriptState::default() };
        let source = PickerSource { state: &state, init_model: Some("gpt-5.6"), catalog: &catalog };
        let picker = model_picker(&source);
        assert_eq!(titles(&picker.main), ["GPT-5.6"]);
        assert!(picker.main[0].is_default && picker.main[0].selected);
        assert_eq!(picker.title, "Select model and effort");
        assert_eq!(titles(&picker.efforts), ["Default", "Low", "High"]);
        assert_eq!(picker.efforts.iter().map(|row| row.selected).collect::<Vec<_>>(), [false, false, true]);
        assert_eq!(picker.efforts[0].value, None);
        assert_eq!(source.shown_effort().as_deref(), Some("high"));
        state.effort = Some(None);
        let source = PickerSource { state: &state, init_model: Some("gpt-5.6"), catalog: &catalog };
        assert!(model_picker(&source).efforts.is_empty());
        assert_eq!(source.shown_effort(), None);
    }

    #[test]
    fn efforts_fall_back_to_the_engine_set_when_the_model_row_has_none() {
        let mut state = state(vec![option("opus", "Opus 5.5", None)]);
        state.model = Some("opus".to_owned());
        state.effort = Some(Some("medium".to_owned()));
        state.capabilities = Some(caps(&[], Some(&["low", "medium"])));
        let picker = model_picker(&PickerSource { state: &state, init_model: None, catalog: &[] });
        assert_eq!(titles(&picker.efforts), ["Default", "Low", "Medium"]);
    }

    #[test]
    fn modes_follow_the_engine_with_bypass_last_and_greyed_when_the_session_cannot_gain_it() {
        use PermissionMode::*;
        let mut state = TranscriptState { permission_mode: Some("plan".to_owned()), ..TranscriptState::default() };
        state.capabilities = Some(caps(&[Default, BypassPermissions, AcceptEdits, Plan, Unknown], None));
        let picker = mode_picker(&state, Some(Default), Some(false));
        let modes: Vec<PermissionMode> = picker.rows.iter().map(|row| row.mode).collect();
        assert_eq!(modes, [Default, AcceptEdits, Plan, BypassPermissions]);
        assert!(picker.rows[0].is_default && !picker.rows[0].selected);
        assert!(picker.rows[2].selected);
        let bypass = &picker.rows[3];
        assert!(bypass.disabled);
        assert_eq!(bypass.summary, "Only available to a session started in this mode");
        assert!(!mode_picker(&state, None, None).rows[3].disabled);
        assert_eq!(picker.rows[1].title, "Accept edits");
        assert!(mode_picker(&TranscriptState::default(), None, None).rows.is_empty());
    }
}
