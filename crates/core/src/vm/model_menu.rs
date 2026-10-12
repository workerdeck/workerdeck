use crate::rest::ModelOption;
use crate::vm::text::{collapse_whitespace, js_trim};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelMenu {
    pub main: Vec<ModelOption>,
    pub more: Vec<ModelOption>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_row: Option<ModelOption>,
}

fn version_at(chars: &[char], at: usize) -> Option<usize> {
    let digits = |from: usize| chars[from..].iter().take_while(|c| c.is_ascii_digit()).count();
    let mut end = at;
    if chars[end] == '-' || chars[end].is_whitespace() {
        if end + 1 < chars.len() && chars[end + 1].is_ascii_digit() {
            end += 1;
        } else if !chars[end].is_ascii_digit() {
            return None;
        }
    }
    let run = digits(end);
    if run == 0 {
        return None;
    }
    end += run;
    while end + 1 < chars.len() && (chars[end] == '.' || chars[end] == '-') && chars[end + 1].is_ascii_digit() {
        end += 1 + digits(end + 1);
    }
    Some(end)
}

pub fn model_line(model: &ModelOption) -> String {
    let chars: Vec<char> = model.display_name.chars().collect();
    let mut out = String::new();
    let mut at = 0;
    while at < chars.len() {
        match version_at(&chars, at) {
            Some(end) => {
                out.push(' ');
                at = end;
            }
            None => {
                out.push(chars[at]);
                at += 1;
            }
        }
    }
    js_trim(&collapse_whitespace(&out)).to_lowercase()
}

fn drop_variant(id: &str) -> &str {
    match (id.ends_with(']'), id.find('[')) {
        (true, Some(at)) => &id[..at],
        _ => id,
    }
}

pub fn model_matches(model: &ModelOption, id: &str) -> bool {
    let bare = drop_variant(id);
    model.value == id || model.value == bare || model.resolved_model.as_deref().is_some_and(|resolved| drop_variant(resolved) == bare)
}

pub fn model_menu(models: &[ModelOption], default_model: Option<&str>) -> ModelMenu {
    let rows: Vec<&ModelOption> = models.iter().filter(|m| m.value != "default").collect();
    let default_index = default_model.and_then(|id| rows.iter().position(|m| model_matches(m, id)));
    let mut seen = HashSet::new();
    let newest: Vec<usize> = (0..rows.len()).filter(|&index| seen.insert(model_line(rows[index]))).collect();
    let main: Vec<ModelOption> = default_index
        .into_iter()
        .chain(newest.into_iter().filter(|index| Some(*index) != default_index))
        .map(|index| rows[index].clone())
        .collect();
    ModelMenu { main, more: rows.iter().map(|m| (*m).clone()).collect(), default_row: default_index.map(|index| rows[index].clone()) }
}
