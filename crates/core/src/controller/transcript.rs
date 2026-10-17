use crate::book::{HeightBook, PlanCache};
use crate::expansion::{ExpansionKey, TermPress, TerminalExpansion, row_expansion_keys};
use crate::planner::{Metrics, TermLine, plan_with};
use crate::rows::{BuildOptions, Row, TerminalRows};
use crate::scrubber::{self, Cluster, Peek, Recap, ScrubberInput, build_clusters};
use crate::transcript::{Item, ShellItem, ToolCall};
use crate::vm::fmt::ago;
use crate::vm::recap::{CatchUp, catch_up, recap_line, summarize_since};
use serde_json::Value;
use std::sync::Arc;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reveal {
    pub row: usize,
    pub nonce: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    FetchResult { call_id: String },
    FetchShellOutput { shell_id: String },
    KillShell { shell_id: String },
    OpenSubagent { task_id: String },
    OpenShell { shell_id: String },
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Navigation {
    pub subagents: bool,
    pub shells: bool,
}

pub struct Update<'a> {
    pub items: &'a [Item],
    pub metrics: Metrics,
    pub pending_approvals: usize,
    pub frame_task: Option<&'a ToolCall>,
    pub hide_thinking: bool,
    pub now_ms: f64,
}

pub struct TranscriptView {
    rows: TerminalRows,
    book: HeightBook,
    prompt_rows: Vec<usize>,
    expansion: TerminalExpansion,
    reveal: Option<Reveal>,
    items: Vec<Item>,
    recap_at: Option<usize>,
    recap_since: Option<f64>,
    pending_approvals: usize,
    frame_parent_id: Option<String>,
    metrics: Metrics,
    cache: PlanCache,
}

impl TranscriptView {
    pub fn new(metrics: Metrics, frame_parent_id: Option<String>) -> Self {
        TranscriptView {
            rows: TerminalRows::build(&[]),
            book: HeightBook::empty(),
            prompt_rows: Vec::new(),
            expansion: TerminalExpansion::default(),
            reveal: None,
            items: Vec::new(),
            recap_at: None,
            recap_since: None,
            pending_approvals: 0,
            frame_parent_id,
            metrics,
            cache: PlanCache::new(),
        }
    }

    pub fn rows(&self) -> &TerminalRows {
        &self.rows
    }

    pub fn book(&self) -> &HeightBook {
        &self.book
    }

    pub fn prompt_rows(&self) -> &[usize] {
        &self.prompt_rows
    }

    pub fn expansion(&self) -> &TerminalExpansion {
        &self.expansion
    }

    pub fn reveal(&self) -> Option<Reveal> {
        self.reveal
    }

    pub fn item_count(&self) -> usize {
        self.items.len()
    }

    pub fn recap_row(&self) -> Option<usize> {
        self.rows.recap_row()
    }

    pub fn catch_up(&self) -> Option<CatchUp> {
        catch_up(self.items.len(), self.recap_at, self.rows.recap_row())
    }

    pub fn update(&mut self, update: Update) -> bool {
        let metrics_changed = update.metrics != self.metrics;
        let recap_changed = update.pending_approvals != self.pending_approvals;
        self.pending_approvals = update.pending_approvals;
        self.metrics = update.metrics;
        self.items = update.items.to_vec();
        self.resolve_fetched();
        let label = self.recap_at.and_then(|boundary| {
            let line = recap_line(&summarize_since(&self.items, self.pending_approvals, boundary))?;
            Some(match self.recap_since {
                Some(since) => format!("{line} · last here {}", ago(since, update.now_ms)),
                None => line,
            })
        });
        let rows = TerminalRows::build_with(
            &self.items,
            &BuildOptions {
                recap_at: label.as_ref().and(self.recap_at),
                recap_label: label.as_deref().unwrap_or(""),
                no_fold: false,
                frame_task: update.frame_task,
                hide_thinking: update.hide_thinking,
            },
        );
        if !metrics_changed && !recap_changed && rows.rows == self.rows.rows {
            return false;
        }
        self.rows = rows;
        self.prompt_rows = self.rows.prompt_rows();
        self.remeasure();
        self.cache.evict(&self.rows);
        true
    }

    pub fn set_recap(&mut self, boundary: Option<usize>, since_ms: Option<f64>) {
        self.recap_at = boundary;
        self.recap_since = since_ms;
    }

    pub fn press(&mut self, press: &TermPress, row: usize, navigation: Navigation) -> Vec<Effect> {
        match press {
            TermPress::KillShell(shell_id) => vec![Effect::KillShell { shell_id: shell_id.clone() }],
            TermPress::OpenShell(shell_id) if navigation.shells => vec![Effect::OpenShell { shell_id: shell_id.clone() }],
            TermPress::OpenShell(shell_id) => self.press(&TermPress::Toggle(ExpansionKey::Shell(shell_id.clone())), row, navigation),
            TermPress::OpenSubagent(task_id) if navigation.subagents => {
                vec![Effect::OpenSubagent { task_id: task_id.clone() }]
            }
            TermPress::OpenSubagent(task_id) => self.press(&TermPress::Toggle(ExpansionKey::Task(task_id.clone())), row, navigation),
            TermPress::ExpandFull(call_id) if self.truncated_call(call_id).is_some() => {
                if !self.expansion.begin_fetch(call_id) {
                    return Vec::new();
                }
                self.remeasure();
                vec![Effect::FetchResult { call_id: call_id.clone() }]
            }
            _ => {
                let subtree = self.rows.rows.get(row).map(row_expansion_keys).unwrap_or_default();
                let opened = self.expansion.apply(press, &subtree);
                self.remeasure();
                if !opened {
                    return Vec::new();
                }
                let mut effects = Vec::new();
                if let TermPress::Toggle(ExpansionKey::Shell(shell_id)) = press
                    && let Some(shell) = self.truncated_shell(shell_id)
                {
                    effects.push(Effect::FetchShellOutput { shell_id: shell_id_of(&shell) });
                }
                let nonce = self.reveal.map_or(1, |reveal| reveal.nonce + 1);
                self.reveal = Some(Reveal { row, nonce });
                effects
            }
        }
    }

    // The fetch failed: the row goes back to its head, and a later press may try again.
    pub fn fetch_failed(&mut self, call_id: &str) {
        if self.expansion.abandon_fetch(call_id) {
            self.remeasure();
        }
    }

    pub fn expand_everything(&mut self) {
        self.expansion = TerminalExpansion::everything(&self.rows.rows);
        self.remeasure();
    }

    pub fn plan(&self, index: usize) -> Vec<TermLine> {
        self.lines(index).as_ref().clone()
    }

    pub fn lines(&self, index: usize) -> Arc<Vec<TermLine>> {
        let Some(row) = self.rows.rows.get(index) else {
            return Arc::default();
        };
        self.cache
            .planned(row, &self.expansion)
            .unwrap_or_else(|| Arc::new(plan_with(row, &self.metrics, &self.expansion.subset(row), self.frame_parent_id.as_deref())))
    }

    pub fn gap_above(&self, index: usize) -> bool {
        self.rows.gap_before(index)
    }

    pub fn row_index_for_item(&self, index: usize) -> usize {
        self.rows.row_index_for_item(index)
    }

    pub fn row(&self, index: usize) -> Option<&Row> {
        self.rows.rows.get(index)
    }

    pub fn scrubber(&self, pending_approvals: usize, bookmarks: &[String], rail_h: f64, viewport_h: f64) -> Vec<Cluster> {
        let recap = self
            .recap_row()
            .map(|row_index| Recap { row_index, label: self.rows.rows[row_index].recap_label().unwrap_or_default().to_owned() });
        let input = ScrubberInput {
            items: &self.items,
            rows: &self.rows,
            book: &self.book,
            pending_approvals,
            bookmarks,
            recap,
            frame_parent_id: self.frame_parent_id.as_deref(),
            viewport_h,
        };
        build_clusters(&input, rail_h)
    }

    pub fn scrubber_peek(&self, cluster: &Cluster, y: f64, approval: Option<&Value>) -> Peek {
        let recap = self.recap_row().and_then(|row| self.rows.rows[row].recap_label());
        scrubber::peek(cluster, cluster.nearest_member(y).as_ref(), &self.items, approval, recap)
    }

    fn truncated_shell(&self, id: &str) -> Option<Arc<ShellItem>> {
        self.items.iter().find_map(|item| match item {
            Item::Shell(shell) if shell_id_of(shell) == id => (shell.truncated && shell.expanded.is_none()).then(|| shell.clone()),
            _ => None,
        })
    }

    fn truncated_call(&self, id: &str) -> Option<Arc<ToolCall>> {
        self.items.iter().find_map(|item| match item {
            Item::ToolCall(call) if &*call.id == id => call.result.as_ref().is_some_and(|result| result.truncated).then(|| call.clone()),
            _ => None,
        })
    }

    fn resolve_fetched(&mut self) {
        let landed: Vec<String> = self.expansion.pending.iter().filter(|id| self.truncated_call(id).is_none()).cloned().collect();
        for id in landed {
            self.expansion.finish_fetch(&id);
        }
    }

    fn remeasure(&mut self) {
        self.book = HeightBook::with(&self.rows, &self.metrics, Some(&mut self.cache), &self.expansion, self.frame_parent_id.as_deref());
    }
}

fn shell_id_of(shell: &ShellItem) -> String {
    shell.shell.get("id").and_then(|id| id.as_str()).unwrap_or_default().to_owned()
}
