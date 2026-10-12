use crate::vm::text::{collapse_whitespace, js_trim, utf16_len};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const STATUS_LABEL_TEXT_MAX: usize = 80;
pub const STATUS_LABEL_EMOJI_MAX: usize = 16;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct StatusLabelInput {
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub emoji: Option<String>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum StatusLabelRead {
    Clear,
    Set(StatusLabelInput),
    Refused(String),
}

pub fn read_status_label_input(input: Option<&Value>) -> StatusLabelRead {
    let input = match input {
        Some(Value::Null) => return StatusLabelRead::Clear,
        Some(value @ (Value::Object(_) | Value::Array(_))) => value,
        _ => return StatusLabelRead::Refused("statusLabel must be an object or null".into()),
    };
    let Some(text) = input.get("text").and_then(Value::as_str) else {
        return StatusLabelRead::Refused("statusLabel.text must be a string".into());
    };
    let emoji = match input.get("emoji") {
        None => None,
        Some(Value::String(emoji)) => Some(emoji.as_str()),
        Some(_) => return StatusLabelRead::Refused("statusLabel.emoji must be a string".into()),
    };
    let line = js_trim(&collapse_whitespace(text)).to_owned();
    if line.is_empty() {
        return StatusLabelRead::Clear;
    }
    if utf16_len(&line) > STATUS_LABEL_TEXT_MAX {
        return StatusLabelRead::Refused(format!("statusLabel.text is longer than {STATUS_LABEL_TEXT_MAX} characters"));
    }
    let mark = emoji.map(js_trim).filter(|m| !m.is_empty());
    if let Some(mark) = mark
        && utf16_len(mark) > STATUS_LABEL_EMOJI_MAX
    {
        return StatusLabelRead::Refused(format!("statusLabel.emoji is longer than {STATUS_LABEL_EMOJI_MAX} characters"));
    }
    StatusLabelRead::Set(StatusLabelInput { text: line, emoji: mark.map(str::to_owned) })
}
