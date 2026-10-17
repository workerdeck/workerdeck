use crate::transcript::{Item, NoticeLevel, ToolCallStatus};
use crate::vm::collate::locale_compare;
use serde::Serialize;

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecapSummary {
    pub turns: usize,
    pub replies: usize,
    pub tools: usize,
    pub tool_names: Vec<String>,
    pub files: usize,
    pub errors: usize,
    pub pending: usize,
    pub any: bool,
}

pub fn summarize_since(items: &[Item], pending_approvals: usize, from_index: usize) -> RecapSummary {
    let mut summary = RecapSummary { pending: pending_approvals, ..RecapSummary::default() };
    let mut counts: Vec<(String, usize)> = Vec::new();
    for item in &items[from_index.min(items.len())..] {
        match item {
            Item::TurnResult { is_error, .. } => {
                summary.turns += 1;
                summary.errors += usize::from(*is_error);
            }
            Item::AssistantText { .. } => summary.replies += 1,
            Item::ToolCall(call) => {
                summary.tools += 1;
                match counts.iter_mut().find(|(name, _)| **name == *call.name) {
                    Some((_, count)) => *count += 1,
                    None => counts.push((call.name.to_string(), 1)),
                }
                let failed = call.status == ToolCallStatus::Failed || call.result.as_ref().is_some_and(|r| r.is_error);
                summary.errors += usize::from(failed);
            }
            Item::FileDelivered { .. } => summary.files += 1,
            Item::Notice { level: NoticeLevel::Error, .. } => summary.errors += 1,
            _ => {}
        }
    }
    counts.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| locale_compare(&a.0, &b.0)));
    summary.tool_names = counts.into_iter().map(|(name, _)| name).collect();
    summary.any = summary.turns + summary.replies + summary.tools + summary.files + summary.errors + summary.pending > 0;
    summary
}

fn plural(count: usize, one: &str, many: Option<&str>) -> String {
    match (count, many) {
        (1, _) => format!("{count} {one}"),
        (_, Some(many)) => format!("{count} {many}"),
        (_, None) => format!("{count} {one}s"),
    }
}

pub fn recap_line(summary: &RecapSummary) -> Option<String> {
    if !summary.any {
        return None;
    }
    let mut parts = Vec::new();
    if summary.turns > 0 {
        parts.push(plural(summary.turns, "turn", None));
    } else if summary.replies > 0 {
        parts.push(plural(summary.replies, "reply", Some("replies")));
    }
    if summary.tools > 0 {
        let named = summary.tool_names.iter().take(3).cloned().collect::<Vec<_>>().join(", ");
        let rest = summary.tool_names.len().saturating_sub(3);
        let more = if rest > 0 { format!(", +{rest}") } else { String::new() };
        let suffix = if named.is_empty() { String::new() } else { format!(" ({named}{more})") };
        parts.push(format!("{}{suffix}", plural(summary.tools, "tool call", None)));
    }
    if summary.files > 0 {
        parts.push(plural(summary.files, "file", None));
    }
    if summary.errors > 0 {
        parts.push(plural(summary.errors, "error", None));
    }
    if summary.pending > 0 {
        parts.push(format!("{} waiting", plural(summary.pending, "approval", None)));
    }
    Some(parts.join(" · "))
}

// The bar over a session reopened with something unread: how many items landed below the seam, where it is, and the
// sentence. None once nothing is new or the seam is gone.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CatchUp {
    pub count: usize,
    pub row: usize,
    pub text: String,
}

pub fn catch_up(item_count: usize, boundary: Option<usize>, recap_row: Option<usize>) -> Option<CatchUp> {
    let count = item_count.saturating_sub(boundary?);
    let row = recap_row?;
    (count > 0).then(|| CatchUp { count, row, text: format!("{} since you were last here", plural(count, "new row", Some("new rows"))) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catch_up_needs_a_seam_and_something_new() {
        assert_eq!(catch_up(12, Some(10), Some(4)), Some(CatchUp { count: 2, row: 4, text: "2 new rows since you were last here".into() }));
        assert_eq!(catch_up(11, Some(10), Some(4)).unwrap().text, "1 new row since you were last here");
        assert_eq!(catch_up(10, Some(10), Some(4)), None);
        assert_eq!(catch_up(12, Some(10), None), None);
        assert_eq!(catch_up(12, None, Some(4)), None);
    }
}
