use crate::Mode;
use wd_native::rest::PermissionMode;
use wd_native::vm::pickers;

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct PickerRow {
    pub value: Option<String>,
    pub title: String,
    pub summary: Option<String>,
    pub selected: bool,
    pub is_default: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ModelPicker {
    pub title: String,
    pub main: Vec<PickerRow>,
    pub more: Vec<PickerRow>,
    pub efforts: Vec<PickerRow>,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ModeRow {
    pub mode: Mode,
    pub title: String,
    pub summary: String,
    pub selected: bool,
    pub is_default: bool,
    pub disabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, uniffi::Record)]
pub struct ModePicker {
    pub rows: Vec<ModeRow>,
}

impl From<pickers::PickerRow> for PickerRow {
    fn from(row: pickers::PickerRow) -> Self {
        Self { value: row.value, title: row.title, summary: row.summary, selected: row.selected, is_default: row.is_default }
    }
}

fn rows(rows: Vec<pickers::PickerRow>) -> Vec<PickerRow> {
    rows.into_iter().map(Into::into).collect()
}

impl From<pickers::ModelPicker> for ModelPicker {
    fn from(picker: pickers::ModelPicker) -> Self {
        Self { title: picker.title, main: rows(picker.main), more: rows(picker.more), efforts: rows(picker.efforts) }
    }
}

impl From<pickers::ModePicker> for ModePicker {
    fn from(picker: pickers::ModePicker) -> Self {
        let rows = picker
            .rows
            .into_iter()
            .filter_map(|row| {
                Some(ModeRow {
                    mode: Mode::from_wire(row.mode)?,
                    title: row.title,
                    summary: row.summary,
                    selected: row.selected,
                    is_default: row.is_default,
                    disabled: row.disabled,
                })
            })
            .collect();
        Self { rows }
    }
}

impl Mode {
    fn from_wire(mode: PermissionMode) -> Option<Self> {
        Some(match mode {
            PermissionMode::Default => Mode::Default,
            PermissionMode::AcceptEdits => Mode::AcceptEdits,
            PermissionMode::BypassPermissions => Mode::BypassPermissions,
            PermissionMode::Plan => Mode::Plan,
            PermissionMode::DontAsk => Mode::DontAsk,
            PermissionMode::Auto => Mode::Auto,
            PermissionMode::Unknown => return None,
        })
    }
}
