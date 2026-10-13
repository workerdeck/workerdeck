use crate::cells;
use crate::expansion::{ExpansionKey, TermPress, TerminalExpansion};
use crate::markdown::{self, Block as MdBlock, ListItem};
use crate::rows::{Block, Leaf, Row, RunBlock, TaskBlock, is_peer_send, leaf_needs_blank, task_brief, task_child_items};
use crate::transcript::{CompactionItem, ImageRef, Item, NoticeLevel, ShellItem, ToolCall, ToolCallStatus};
use serde_json::Value;
use std::borrow::Cow;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Metrics {
    pub cell: f64,
    pub line: f64,
    pub width: f64,
    pub font_size: f64,
}

impl Metrics {
    pub fn columns(&self, gutter: usize, indent: usize, extra: f64) -> usize {
        let body = self.width - extra - (gutter + indent) as f64 * self.cell;
        let v = (body / self.cell + 1e-4).floor();
        if v <= 0.0 { 0 } else { v as usize }
    }
}

pub const NESTED_INDENT_CELLS: f64 = 2.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Tone {
    Fg = 0,
    Bright,
    Dim,
    Faint,
    Mark,
    Blue,
    Green,
    Red,
    Yellow,
    Magenta,
    Peer,
    DiffAdd,
    DiffRemove,
    DiffContext,
    DiffNumber,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Band {
    None,
    User,
    Output,
    DiffAdd,
    DiffRemove,
}

impl Tone {
    pub fn raw(self) -> &'static str {
        match self {
            Tone::Fg => "fg",
            Tone::Bright => "bright",
            Tone::Dim => "dim",
            Tone::Faint => "faint",
            Tone::Mark => "mark",
            Tone::Blue => "blue",
            Tone::Green => "green",
            Tone::Red => "red",
            Tone::Yellow => "yellow",
            Tone::Magenta => "magenta",
            Tone::Peer => "peer",
            Tone::DiffAdd => "diffAdd",
            Tone::DiffRemove => "diffRemove",
            Tone::DiffContext => "diffContext",
            Tone::DiffNumber => "diffNumber",
        }
    }
}

impl Band {
    pub fn raw(self) -> &'static str {
        match self {
            Band::None => "none",
            Band::User => "user",
            Band::Output => "output",
            Band::DiffAdd => "diffAdd",
            Band::DiffRemove => "diffRemove",
        }
    }
}

pub mod glyph {
    pub const PROMPT: &str = "❯";
    pub const BULLET: &str = "●";
    pub const OUTPUT: &str = "⎿";
    pub const THINKING: &str = "✻";
    pub const NOTICE: &str = "!";
    pub const PULSE_REST: &str = "⠿";
    pub const FILE: &str = "⤓";
    pub const PEER_IN: &str = "↦";
    pub const PEER_OUT: &str = "↤";
    pub const RECAP: &str = "※";
    pub const COMPACTION: &str = "≡";
    pub const COMPACTION_PENDING: &str = "⋯";
    pub const HUNK_GAP: &str = "⋮";
    pub const SHELL: &str = "$";
    pub const KILL: &str = "✕";
}

#[derive(Debug, Clone, PartialEq)]
pub struct TermLine {
    pub gutter: Cow<'static, str>,
    pub gutter_tone: Tone,
    pub text: String,
    pub attributed: Option<Vec<(usize, usize, u8)>>,
    pub tone: Tone,
    pub columns: usize,
    pub indent: usize,
    pub band: Band,
    pub bold: bool,
    pub italic: bool,
    pub nested: bool,
    pub pulsing: bool,
    pub in_open: bool,
    pub elapsed_since: Option<f64>,
    pub press: Option<TermPress>,
    pub image: Option<TermImageBox>,
}

pub const IMAGE_BOX_LINES: usize = 12;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TermImageBox {
    pub tool_use_id: String,
    pub source_seq: i64,
    pub part_index: i64,
    pub media_type: String,
    pub bytes: i64,
    pub lines: usize,
}

impl TermImageBox {
    pub fn key(&self) -> String {
        format!("{}/{}/{}", self.source_seq, self.tool_use_id, self.part_index)
    }
}

pub fn image_placeholder(bytes: i64) -> String {
    format!("image · {}", fmt_bytes(bytes as f64))
}

pub const IMAGE_UNAVAILABLE: &str = "image unavailable";

impl TermLine {
    fn plain(text: String, tone: Tone) -> Self {
        TermLine {
            gutter: Cow::Borrowed(""),
            gutter_tone: Tone::Dim,
            text,
            attributed: None,
            tone,
            columns: 2,
            indent: 0,
            band: Band::None,
            bold: false,
            italic: false,
            nested: false,
            pulsing: false,
            in_open: false,
            elapsed_since: None,
            press: None,
            image: None,
        }
    }
}

#[derive(Clone)]
pub struct Wrap {
    pub gutter: Cow<'static, str>,
    pub gutter_tone: Tone,
    pub tone: Tone,
    pub columns: usize,
    pub indent: usize,
    pub band: Band,
    pub bold: bool,
    pub italic: bool,
    pub nested: bool,
    pub pulsing: bool,
    pub press: Option<TermPress>,
    pub in_open: bool,
}

impl Default for Wrap {
    fn default() -> Self {
        Wrap {
            gutter: Cow::Borrowed(""),
            gutter_tone: Tone::Dim,
            tone: Tone::Fg,
            columns: 2,
            indent: 0,
            band: Band::None,
            bold: false,
            italic: false,
            nested: false,
            pulsing: false,
            press: None,
            in_open: false,
        }
    }
}

fn extra(m: &Metrics, nested: bool) -> f64 {
    if nested { NESTED_INDENT_CELLS * m.cell } else { 0.0 }
}

pub fn wrap_body(text: &str, m: &Metrics, o: &Wrap) -> Vec<TermLine> {
    let cols = m.columns(o.columns, o.indent, extra(m, o.nested));
    let ranges = cells::wrapped_ranges(text, cols);
    let mut out = Vec::with_capacity(ranges.len());
    for (offset, (s, e)) in ranges.into_iter().enumerate() {
        out.push(TermLine {
            gutter: if offset == 0 { o.gutter.clone() } else { Cow::Borrowed("") },
            gutter_tone: o.gutter_tone,
            text: text[s..e].to_owned(),
            attributed: None,
            tone: o.tone,
            columns: o.columns,
            indent: o.indent,
            band: o.band,
            bold: o.bold,
            italic: o.italic,
            nested: o.nested,
            pulsing: offset == 0 && o.pulsing,
            in_open: o.in_open,
            elapsed_since: None,
            press: o.press.clone(),
            image: None,
        });
    }
    out
}

fn styled_body(styled: &markdown::Styled, m: &Metrics, o: &Wrap) -> Vec<TermLine> {
    let plain = &styled.plain;
    let cols = m.columns(o.columns, o.indent, extra(m, o.nested));
    let ranges = cells::wrapped_ranges(plain, cols);
    let mut out = Vec::with_capacity(ranges.len());
    let mut run_cursor = 0usize;
    for (offset, (s, e)) in ranges.into_iter().enumerate() {
        let mut runs = Vec::new();
        while run_cursor < styled.runs.len() && styled.runs[run_cursor].0 + styled.runs[run_cursor].1 <= s {
            run_cursor += 1;
        }
        let mut k = run_cursor;
        while k < styled.runs.len() && styled.runs[k].0 < e {
            let (rs, rl, intent) = styled.runs[k];
            let a = rs.max(s);
            let b = (rs + rl).min(e);
            if b > a {
                runs.push((a - s, b - a, intent));
            }
            k += 1;
        }
        out.push(TermLine {
            gutter: if offset == 0 { o.gutter.clone() } else { Cow::Borrowed("") },
            gutter_tone: o.gutter_tone,
            text: plain[s..e].to_owned(),
            attributed: Some(runs),
            tone: o.tone,
            columns: o.columns,
            indent: o.indent,
            band: Band::None,
            bold: o.bold,
            italic: false,
            nested: o.nested,
            pulsing: false,
            in_open: o.in_open,
            elapsed_since: None,
            press: o.press.clone(),
            image: None,
        });
    }
    out
}

fn inline_body(source: &str, m: &Metrics, o: &Wrap) -> Vec<TermLine> {
    styled_body(&markdown::inline(source), m, o)
}

pub fn fmt_cost(usd: Option<f64>) -> String {
    match usd {
        None => "-".into(),
        Some(v) if v.is_nan() => "-".into(),
        Some(0.0) => "$0.00".into(),
        Some(v) if v < 0.01 => "<$0.01".into(),
        Some(v) => format!("${v:.2}"),
    }
}

pub fn fmt_duration(ms: f64) -> String {
    if ms < 1000.0 {
        return format!("{}ms", ms.round() as i64);
    }
    let seconds = ms / 1000.0;
    if seconds < 60.0 {
        return format!("{seconds:.1}s");
    }
    let minutes = (seconds / 60.0) as i64;
    format!("{}m {}s", minutes, (seconds % 60.0).round() as i64)
}

pub fn fmt_bytes(count: f64) -> String {
    if count >= 1024.0 * 1024.0 {
        return format!("{:.1} MB", count / (1024.0 * 1024.0));
    }
    if count >= 1024.0 {
        return format!("{:.1} KB", count / 1024.0);
    }
    format!("{} B", count as i64)
}

pub fn fmt_tokens(count: f64) -> String {
    if count >= 1_000_000.0 {
        return format!("{:.1}M", count / 1_000_000.0);
    }
    if count >= 1000.0 {
        return format!("{:.1}k", count / 1000.0);
    }
    format!("{}", count as i64)
}

pub const COMPACTION_TEXT: &str = "context compacted · earlier turns summarised to fit the window";

pub fn fmt_compaction(item: &CompactionItem) -> String {
    if let Some(error) = &item.error {
        return format!("context compaction failed · {error}");
    }
    if item.pending == Some(true) {
        return "compacting context · summarising earlier turns to fit the window".into();
    }
    let mut parts = vec![COMPACTION_TEXT.to_owned()];
    if let Some(pre) = item.pre_tokens {
        parts.push(match item.post_tokens {
            Some(post) => format!("{} → {}", fmt_tokens(pre), fmt_tokens(post)),
            None => format!("from {}", fmt_tokens(pre)),
        });
    }
    if item.trigger.as_deref() == Some("auto") {
        parts.push("automatic".into());
    }
    parts.join(" · ")
}

pub fn peer_short_id(session_id: &str) -> String {
    match session_id.find(':') {
        Some(colon) if colon > 0 => format!("{}:{}", &session_id[..colon], cells::gprefix(&session_id[colon + 1..], 8)),
        _ => cells::gprefix(session_id, 8).to_owned(),
    }
}

pub fn peer_name(origin: &Value) -> String {
    let text = |key: &str| origin.get(key).and_then(Value::as_str);
    match (text("name"), text("hostId")) {
        (Some(name), Some(host)) => format!("{name}@{host}"),
        (Some(name), None) => name.to_owned(),
        (None, _) => peer_short_id(text("sessionId").unwrap_or("")),
    }
}

fn peer_styled(who: &str, text: &str) -> markdown::Styled {
    let head = format!("{who}:");
    let runs = vec![(0, head.len(), markdown::STRONG)];
    markdown::Styled { plain: format!("{head} {text}"), runs }
}

pub const SHELL_INLINE_LINES: usize = 8;
pub const SHELL_MISSING: &str = "output expired or not tracked by this gateway";

pub mod shell {
    use super::Value;
    use crate::transcript::ShellItem;

    fn text<'a>(shell: &'a Value, key: &str) -> Option<&'a str> {
        shell.get(key).and_then(Value::as_str)
    }

    pub const EXPAND_CHARS: usize = 100_000;
    pub const KILL_ACTION: &str = "✕ kill";

    pub fn id(item: &ShellItem) -> &str {
        text(&item.shell, "id").unwrap_or("")
    }

    pub fn running(item: &ShellItem) -> bool {
        text(&item.shell, "status") == Some("running")
    }

    pub fn exit_code(item: &ShellItem) -> Option<i64> {
        item.shell.get("exitCode").and_then(Value::as_f64).map(|code| code as i64)
    }

    pub fn failed(item: &ShellItem) -> bool {
        text(&item.shell, "status") == Some("exited") && exit_code(item) != Some(0)
    }

    pub fn label(item: &ShellItem) -> String {
        label_of(text(&item.shell, "label"), text(&item.shell, "command").unwrap_or(""))
    }

    pub fn label_of(label: Option<&str>, command: &str) -> String {
        match label {
            Some(label) if !label.is_empty() => label.to_owned(),
            _ => command.split('\n').next().unwrap_or("").to_owned(),
        }
    }

    pub fn status_text(item: &ShellItem) -> String {
        status_words(running(item), exit_code(item), text(&item.shell, "endReason"))
    }

    pub fn status_words(running: bool, exit_code: Option<i64>, end_reason: Option<&str>) -> String {
        if running {
            return "running".into();
        }
        if let Some(code) = exit_code {
            return format!("exit {code}");
        }
        match end_reason {
            Some("killed") => "killed",
            Some("timeout") => "timed out",
            Some("server_stopped") => "killed: the gateway stopped",
            Some("server_restarted") => "ended: the gateway restarted, the process may still be running",
            Some("spawn_failed") => "failed to start",
            _ => "ended",
        }
        .into()
    }

    pub fn header_text(item: &ShellItem) -> String {
        format!("{} · {}", label(item), status_text(item))
    }

    pub fn body_lines(item: &ShellItem, open: bool) -> Vec<&str> {
        let source: &str = if open { item.expanded.as_deref().unwrap_or(&item.text) } else { &item.text };
        if source.is_empty() {
            return Vec::new();
        }
        let lines = source.split('\n');
        if !open {
            return lines.collect();
        }
        let mut kept = Vec::new();
        let mut chars = 0usize;
        for line in lines {
            let count = crate::cells::gcount(line);
            if !kept.is_empty() && chars + count > EXPAND_CHARS {
                break;
            }
            kept.push(line);
            chars += count + 1;
        }
        kept
    }

    pub fn footer_text(item: &ShellItem, open: bool, shown: usize) -> Option<String> {
        if item.missing {
            return Some(super::SHELL_MISSING.to_owned());
        }
        if !open {
            return item.truncated.then(|| "… more output - expand to fetch it".to_owned());
        }
        if let Some(expanded) = &item.expanded {
            let total = expanded.split('\n').count();
            return (total > shown).then(|| format!("… +{} lines not shown", total - shown));
        }
        item.truncated.then(|| "… fetching the full output".to_owned())
    }
}

pub fn fmt_grouped(count: i64) -> String {
    let digits = count.unsigned_abs().to_string();
    let n = digits.len();
    let mut out = String::with_capacity(n + n / 3 + 1);
    if count < 0 {
        out.push('-');
    }
    for (offset, c) in digits.chars().enumerate() {
        if offset > 0 && (n - offset).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

pub fn fmt_clip(text: &str, max: usize) -> String {
    if max == 0 || cells::gcount(text) <= max {
        return text.to_owned();
    }
    let mut s = cells::gprefix(text, max - 1).to_owned();
    s.push('…');
    s
}

pub fn tool_input_preview(input: &Value, max: usize) -> String {
    if input.is_null() {
        return String::new();
    }
    if let Value::Object(object) = input {
        for key in ["command", "file_path", "path", "url", "pattern", "query", "description"] {
            let Some(value) = object.get(key) else {
                continue;
            };
            if let Value::String(text) = value {
                return fmt_clip(text, max);
            }
            break;
        }
    }
    fmt_clip(&json_text(input), max)
}

fn json_text(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(b) => if *b { "true" } else { "false" }.into(),
        Value::Number(n) => {
            let v = n.as_f64().unwrap_or(0.0);
            if v == v.round() && v.abs() < 1e15 { (v as i64).to_string() } else { v.to_string() }
        }
        Value::String(s) => quoted(s),
        Value::Array(items) => format!("[{}]", items.iter().map(json_text).collect::<Vec<_>>().join(",")),
        Value::Object(fields) => {
            let mut keys: Vec<&String> = fields.keys().collect();
            keys.sort();
            let body: Vec<String> = keys.iter().map(|k| format!("{}:{}", quoted(k), json_text(&fields[*k]))).collect();
            format!("{{{}}}", body.join(","))
        }
    }
}

fn quoted(text: &str) -> String {
    let mut out = String::from("\"");
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

pub fn is_shell_tool(name: &str) -> bool {
    name == "Bash" || name == "CodexCommand"
}

pub fn is_mutating_tool(name: &str) -> bool {
    matches!(name, "Write" | "Edit" | "MultiEdit" | "NotebookEdit" | "Update" | "CodexFileChange")
}

pub const PREVIEW_LINES: usize = 4;
pub const PREVIEW_CHARS: usize = 400;

pub fn collapsed(lines: &[&str], cols: usize, total_chars: Option<i64>) -> (Vec<String>, Option<String>) {
    let budget = if cols > 0 { PREVIEW_LINES * cols - 1 } else { PREVIEW_CHARS };
    let mut shown: Vec<String> = Vec::new();
    let mut chars = 0usize;
    let mut cut_inside = false;
    for line in lines.iter().take(PREVIEW_LINES) {
        let count = cells::gcount(line);
        if shown.is_empty() && count > budget {
            let mut s = cells::gprefix(line, budget).to_owned();
            s.push('…');
            shown.push(s);
            chars = budget;
            cut_inside = true;
            break;
        }
        if !shown.is_empty() && chars + count > budget {
            break;
        }
        shown.push((*line).to_owned());
        chars += count + 1;
    }
    let held: i64 = lines.iter().map(|l| cells::gcount(l) as i64).sum::<i64>() + lines.len().saturating_sub(1) as i64;
    let whole = total_chars.unwrap_or(held);
    if cut_inside || whole > held {
        let more = format!("… +{} chars", fmt_grouped(whole - chars as i64));
        return (shown, Some(more));
    }
    let hidden = lines.len() - shown.len();
    let more = if hidden > 0 { Some(format!("… +{} line{}", hidden, if hidden == 1 { "" } else { "s" })) } else { None };
    (shown, more)
}

const ELAPSED_WIDEST_COUNT: usize = 10; // " · 59m 59s".count
const TAIL_LINE_COUNT: usize = 5;

fn call_busy(call: &ToolCall) -> bool {
    matches!(call.status, ToolCallStatus::Running | ToolCallStatus::Pending)
}

fn call_failed(call: &ToolCall) -> bool {
    call.status == ToolCallStatus::Failed || call.result.as_ref().is_some_and(|r| r.is_error)
}

fn tail_lines(call: &ToolCall) -> Vec<String> {
    match &call.live_tail {
        Some(tail) if !tail.is_empty() && call_busy(call) => {
            let all: Vec<&str> = tail.split('\n').collect();
            let from = all.len().saturating_sub(TAIL_LINE_COUNT);
            all[from..].iter().map(|s| (*s).to_owned()).collect()
        }
        _ => Vec::new(),
    }
}

fn elapsed_column(line: &TermLine) -> usize {
    cells::text_width(line.text.trim_end_matches(' '))
}

fn tool_family(name: &str) -> String {
    if is_shell_tool(name) {
        return "shell".into();
    }
    if let Some(rest) = name.strip_prefix("mcp__")
        && let Some(sep) = rest.find("__")
        && sep > 0
    {
        return rest[..sep].replace('_', "-");
    }
    name.to_lowercase()
}

fn run_summary(items: &[std::sync::Arc<ToolCall>], busy: bool) -> String {
    let verb = if busy { "Running " } else { "Ran " };
    let tail = if busy { "…" } else { "" };
    let total = items.len();
    let mut order: Vec<(String, usize)> = Vec::new();
    for item in items {
        let family = tool_family(&item.name);
        match order.iter_mut().find(|(f, _)| *f == family) {
            Some(entry) => entry.1 += 1,
            None => order.push((family, 1)),
        }
    }
    if order.len() == 1 && order[0].0 == "shell" {
        return format!("{verb}{total} shell command{}{tail}", if total == 1 { "" } else { "s" });
    }
    order.sort_by(|a, b| if a.1 == b.1 { a.0.cmp(&b.0) } else { b.1.cmp(&a.1) });
    let breakdown: Vec<String> = order.iter().map(|(f, c)| format!("{c} {f}")).collect();
    format!("{verb}{total} tool{} · {}{tail}", if total == 1 { "" } else { "s" }, breakdown.join(", "))
}

fn trimmed_non_empty(v: Option<&Value>) -> Option<String> {
    let s = v?.as_str()?.trim();
    if s.is_empty() { None } else { Some(s.to_owned()) }
}

pub fn task_identity(task: &ToolCall) -> String {
    let description = trimmed_non_empty(task.input.get("description"));
    let agent = trimmed_non_empty(task.input.get("subagent_type"));
    match (agent, description) {
        (Some(a), Some(d)) => format!("{a} · {}", fmt_clip(&d, 80)),
        (Some(a), None) => a,
        (None, Some(d)) => fmt_clip(&d, 80),
        (None, None) => tool_input_preview(&task.input, 80),
    }
}

fn task_busy(task: &ToolCall, children: &[Item]) -> bool {
    call_busy(task) || children.iter().any(|c| matches!(c, Item::ToolCall(call) if call_busy(call)))
}

pub fn task_summary(task: &ToolCall, children: &[Item]) -> String {
    let busy = task_busy(task, children);
    let calls = children.iter().filter(|c| matches!(c, Item::ToolCall(_))).count();
    let label = format!("{}({})", task.name, task_identity(task));
    if calls == 0 {
        return if busy { format!("{label} · working…") } else { format!("{label} · done") };
    }
    format!("{label} · {calls} tool{}{}", if calls == 1 { "" } else { "s" }, if busy { "…" } else { "" })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubagentStripLine {
    pub name: String,
    pub status: Option<&'static str>,
    pub busy: bool,
    pub failed: bool,
    pub tool_count: usize,
}

pub fn subagent_strip_line(task: Option<&ToolCall>, items: &[Item], fallback_label: &str) -> SubagentStripLine {
    let busy = task.is_some_and(|task| task_busy(task, items));
    let failed = task.is_some_and(call_failed);
    let status = task.map(|_| {
        if failed {
            "failed"
        } else if busy {
            "working…"
        } else {
            "done"
        }
    });
    SubagentStripLine {
        name: task.map_or_else(|| fallback_label.to_owned(), task_identity),
        status,
        busy,
        failed,
        tool_count: items.iter().filter(|item| matches!(item, Item::ToolCall(_))).count(),
    }
}

pub fn tool_tone(call: &ToolCall) -> Tone {
    if call_failed(call) {
        return Tone::Red;
    }
    if call.status == ToolCallStatus::Settled && is_mutating_tool(&call.name) {
        return Tone::Green;
    }
    match call.status {
        ToolCallStatus::Running | ToolCallStatus::Pending => Tone::Blue,
        ToolCallStatus::Deferred => Tone::Yellow,
        ToolCallStatus::Settled => Tone::Dim,
        ToolCallStatus::Failed => Tone::Red,
    }
}

pub fn plan(row: &Row, m: &Metrics) -> Vec<TermLine> {
    plan_with(row, m, &TerminalExpansion::default(), None)
}

pub fn plan_with(row: &Row, m: &Metrics, x: &TerminalExpansion, frame_parent_id: Option<&str>) -> Vec<TermLine> {
    match row {
        Row::Recap { label } => {
            wrap_body(&format!("{} {label}", glyph::RECAP), m, &Wrap { tone: Tone::Faint, columns: 0, ..Wrap::default() })
        }
        Row::Brief { id, text } => plan_brief(id, text, m, x, false, false),
        Row::Block(block) => plan_block(block, m, x, false, frame_parent_id),
    }
}

pub fn plan_block(block: &Block, m: &Metrics, x: &TerminalExpansion, in_open: bool, frame: Option<&str>) -> Vec<TermLine> {
    match block {
        Block::Item(leaf) => plan_item(&leaf.item, m, x, in_open, frame),
        Block::Run(leaf) => plan_run(leaf, m, x, in_open, frame),
        Block::Task(leaf) => plan_task(leaf, m, x, in_open),
    }
}

fn plan_leaf(leaf: &Leaf, m: &Metrics, x: &TerminalExpansion, in_open: bool) -> Vec<TermLine> {
    match leaf {
        Leaf::Item(block) => plan_item(&block.item, m, x, in_open, None),
        Leaf::Run(block) => plan_run(block, m, x, in_open, None),
    }
}

fn is_nested(parent: Option<&str>, frame: Option<&str>) -> bool {
    parent.is_some_and(|parent| Some(parent) != frame)
}

fn reserve_elapsed(mut lines: Vec<TermLine>, since: Option<f64>, m: &Metrics) -> Vec<TermLine> {
    let Some(since) = since else { return lines };
    let Some(last) = lines.last() else {
        return lines;
    };
    let cols = m.columns(last.columns, last.indent, extra(m, last.nested));
    if elapsed_column(last) + ELAPSED_WIDEST_COUNT <= cols {
        lines.last_mut().unwrap().elapsed_since = Some(since);
    } else {
        let mut line = TermLine::plain(String::new(), last.tone);
        line.columns = last.columns;
        line.indent = last.indent;
        line.band = last.band;
        line.nested = last.nested;
        line.press = last.press.clone();
        line.in_open = last.in_open;
        line.elapsed_since = Some(since);
        lines.push(line);
    }
    lines
}

fn plan_live_tail(tail: &[String], m: &Metrics, nested: bool, press: &Option<TermPress>, in_open: bool) -> Vec<TermLine> {
    let mut out = Vec::new();
    for (offset, line) in tail.iter().enumerate() {
        out.extend(wrap_body(
            if line.is_empty() { " " } else { line },
            m,
            &Wrap {
                gutter: Cow::Borrowed(if offset == 0 { glyph::OUTPUT } else { "" }),
                gutter_tone: Tone::Faint,
                tone: Tone::Faint,
                columns: 3,
                indent: 1,
                nested,
                press: press.clone(),
                in_open,
                ..Wrap::default()
            },
        ));
    }
    out
}

fn plan_run(block: &RunBlock, m: &Metrics, x: &TerminalExpansion, in_open: bool, frame: Option<&str>) -> Vec<TermLine> {
    let run = &block.run;
    let Some(key) = block.expansion_key() else {
        return run.first().map(|c| plan_tool_call(c, m, x, in_open, frame)).unwrap_or_default();
    };
    let busy = run.iter().any(|c| call_busy(c));
    let failed = run.last().is_some_and(|c| call_failed(c));
    let nested = is_nested(run[0].parent_tool_use_id.as_deref(), frame);
    let open = x.is_open(&key);
    let wash = in_open || open;
    let press = Some(TermPress::Toggle(key));
    let started = run.iter().filter(|c| call_busy(c)).filter_map(|c| c.ts).fold(None, |a: Option<f64>, t| Some(a.map_or(t, |a| a.min(t))));
    let mut lines = reserve_elapsed(
        wrap_body(
            &run_summary(run, busy),
            m,
            &Wrap {
                gutter: Cow::Borrowed(if busy { glyph::PULSE_REST } else { "" }),
                gutter_tone: Tone::Mark,
                tone: if failed { Tone::Red } else { Tone::Dim },
                nested,
                pulsing: busy,
                press: press.clone(),
                in_open: wash,
                ..Wrap::default()
            },
        ),
        started,
        m,
    );
    if !open {
        let tail = run.iter().rev().map(|c| tail_lines(c)).find(|t| !t.is_empty()).unwrap_or_default();
        lines.extend(plan_live_tail(&tail, m, nested, &press, wash));
        return lines;
    }
    for call in run {
        lines.extend(plan_tool_call(call, m, x, true, frame));
    }
    lines
}

fn plan_task(block: &TaskBlock, m: &Metrics, x: &TerminalExpansion, in_open: bool) -> Vec<TermLine> {
    let children = task_child_items(block);
    let busy = task_busy(&block.task, &children);
    let failed = call_failed(&block.task);
    let open = x.is_open(&block.expansion_key());
    let wash = in_open || open;
    let mut lines = wrap_body(
        &task_summary(&block.task, &children),
        m,
        &Wrap {
            gutter: Cow::Borrowed(if busy { glyph::PULSE_REST } else { glyph::BULLET }),
            gutter_tone: if failed {
                Tone::Red
            } else if busy {
                Tone::Mark
            } else {
                Tone::Dim
            },
            tone: if failed { Tone::Red } else { Tone::Green },
            pulsing: busy,
            press: Some(TermPress::OpenSubagent(block.task.id.to_string())),
            in_open: wash,
            ..Wrap::default()
        },
    );
    if !open {
        return lines;
    }
    let child_has_brief = children.iter().any(|c| matches!(c, Item::User { .. }));
    if !child_has_brief && let Some(brief) = task_brief(&block.task) {
        lines.extend(plan_brief(&block.task.id, &brief, m, x, true, true));
    }
    for (position, child) in block.children.iter().enumerate() {
        if position > 0 && leaf_needs_blank(&block.children[position - 1], child) {
            let mut blank = TermLine::plain(String::new(), Tone::Fg);
            blank.nested = true;
            blank.in_open = true;
            lines.push(blank);
        }
        lines.extend(plan_leaf(child, m, x, true));
    }
    lines
}

pub const BRIEF_LINES: usize = 4;

fn plan_brief(id: &str, text: &str, m: &Metrics, x: &TerminalExpansion, nested: bool, in_open: bool) -> Vec<TermLine> {
    let cols = m.columns(2, 0, extra(m, nested));
    let all = cells::wrapped(text, cols);
    let key = ExpansionKey::Brief(id.to_owned());
    let open = x.is_open(&key);
    let wash = in_open || open;
    let clipped = !open && all.len() > BRIEF_LINES;
    let press = (clipped || open).then_some(TermPress::Toggle(key));
    let shown = if clipped { &all[..BRIEF_LINES] } else { &all[..] };
    let mut lines: Vec<TermLine> = shown
        .iter()
        .enumerate()
        .map(|(offset, line)| {
            let mut out = TermLine::plain(if line.is_empty() { " ".to_owned() } else { line.clone() }, Tone::Dim);
            out.gutter = Cow::Borrowed(if offset == 0 { glyph::PROMPT } else { "" });
            out.nested = nested;
            out.press = press.clone();
            out.in_open = wash;
            out
        })
        .collect();
    if clipped {
        let hidden = all.len() - BRIEF_LINES;
        lines.extend(wrap_body(
            &format!("… +{hidden} line{}", if hidden == 1 { "" } else { "s" }),
            m,
            &Wrap { tone: Tone::Faint, nested, press, in_open: wash, ..Wrap::default() },
        ));
    }
    lines
}

fn plan_thinking(id: &str, text: &str, m: &Metrics, x: &TerminalExpansion, nested: bool, in_open: bool) -> Vec<TermLine> {
    let body = text.trim();
    let first = body.split('\n').next().unwrap_or("");
    let cols = m.columns(2, 0, extra(m, nested));
    let clipped = cells::clipped(first, cols);
    let key = ExpansionKey::Thinking(id.to_owned());
    let expandable = clipped != body;
    let open = expandable && x.is_open(&key);
    let press = expandable.then_some(TermPress::Toggle(key));
    if !open {
        let mut line = TermLine::plain(clipped, Tone::Dim);
        line.gutter = Cow::Borrowed(glyph::THINKING);
        line.gutter_tone = Tone::Dim;
        line.italic = true;
        line.nested = nested;
        line.press = press;
        line.in_open = in_open;
        return vec![line];
    }
    wrap_body(
        body,
        m,
        &Wrap {
            gutter: Cow::Borrowed(glyph::THINKING),
            gutter_tone: Tone::Dim,
            tone: Tone::Dim,
            italic: true,
            nested,
            press,
            in_open: true,
            ..Wrap::default()
        },
    )
}

fn plan_item(item: &Item, m: &Metrics, x: &TerminalExpansion, in_open: bool, frame: Option<&str>) -> Vec<TermLine> {
    let nested = is_nested(item.parent_tool_use_id().map(|p| &**p), frame);
    match item {
        Item::User { text, attachments, origin, .. } => {
            let mut lines = Vec::new();
            let band = if origin.is_some() { Band::None } else { Band::User };
            let names: Vec<&str> =
                attachments.as_deref().and_then(Value::as_array).into_iter().flatten().filter_map(|a| a.get("name")?.as_str()).collect();
            if !names.is_empty() {
                lines.extend(wrap_body(
                    &names.join(", "),
                    m,
                    &Wrap {
                        gutter: Cow::Borrowed(glyph::PROMPT),
                        gutter_tone: Tone::Dim,
                        tone: Tone::Dim,
                        band,
                        nested,
                        in_open,
                        ..Wrap::default()
                    },
                ));
            }
            if let Some(origin) = origin {
                let styled = peer_styled(&peer_name(origin), if text.is_empty() { " " } else { text });
                lines.extend(styled_body(
                    &styled,
                    m,
                    &Wrap {
                        gutter: Cow::Borrowed(glyph::PEER_IN),
                        gutter_tone: Tone::Peer,
                        tone: Tone::Peer,
                        nested,
                        in_open,
                        ..Wrap::default()
                    },
                ));
                return lines;
            }
            let gutter = if lines.is_empty() { glyph::PROMPT } else { "" };
            lines.extend(wrap_body(
                if text.is_empty() { " " } else { text },
                m,
                &Wrap {
                    gutter: Cow::Borrowed(gutter),
                    gutter_tone: Tone::Dim,
                    tone: Tone::Fg,
                    band: Band::User,
                    nested,
                    in_open,
                    ..Wrap::default()
                },
            ));
            lines
        }
        Item::AssistantText { text, .. } => plan_markdown(text, m, glyph::BULLET, Tone::Fg, nested, in_open),
        Item::Thinking { text, addressed: true, .. } => plan_markdown(text.trim(), m, glyph::BULLET, Tone::Fg, nested, in_open),
        Item::Thinking { id, text, .. } => plan_thinking(id, text, m, x, nested, in_open),
        Item::FileDelivered { path, bytes, description, .. } => {
            let mut body = format!("{path} · {}", fmt_bytes(*bytes));
            if let Some(description) = description.as_deref().filter(|d| !d.is_empty()) {
                body.push_str(" · ");
                body.push_str(description);
            }
            wrap_body(
                &body,
                m,
                &Wrap { gutter: Cow::Borrowed(glyph::FILE), gutter_tone: Tone::Blue, tone: Tone::Dim, in_open, ..Wrap::default() },
            )
        }
        Item::Compaction(item) => {
            let failed = item.error.is_some();
            wrap_body(
                &fmt_compaction(item),
                m,
                &Wrap {
                    gutter: Cow::Borrowed(if item.pending == Some(true) { glyph::COMPACTION_PENDING } else { glyph::COMPACTION }),
                    gutter_tone: if failed { Tone::Red } else { Tone::Yellow },
                    tone: if failed { Tone::Red } else { Tone::Faint },
                    nested,
                    in_open,
                    ..Wrap::default()
                },
            )
        }
        Item::Shell(item) => plan_shell(item, m, x, in_open),
        Item::ToolCall(call) => plan_tool_call(call, m, x, in_open, frame),
        Item::TurnResult { subtype, is_error, duration_ms, total_cost_usd, cost_usd, errors, .. } => {
            let head = format!(
                "{} · {} · {}",
                if *is_error { &**subtype } else { "done" },
                fmt_duration(*duration_ms),
                fmt_cost(Some(cost_usd.unwrap_or(*total_cost_usd)))
            );
            let mut lines =
                wrap_body(&head, m, &Wrap { tone: if *is_error { Tone::Red } else { Tone::Faint }, in_open, ..Wrap::default() });
            for message in errors.iter().flat_map(|e| e.iter()) {
                lines.extend(wrap_body(message, m, &Wrap { tone: Tone::Red, in_open, ..Wrap::default() }));
            }
            lines
        }
        Item::Notice { level, text, .. } => wrap_body(
            text,
            m,
            &Wrap {
                gutter: Cow::Borrowed(glyph::NOTICE),
                gutter_tone: if *level == NoticeLevel::Error { Tone::Red } else { Tone::Yellow },
                tone: if *level == NoticeLevel::Error { Tone::Red } else { Tone::Dim },
                in_open,
                ..Wrap::default()
            },
        ),
    }
}

fn plan_shell(item: &ShellItem, m: &Metrics, x: &TerminalExpansion, in_open: bool) -> Vec<TermLine> {
    let running = shell::running(item);
    let id = shell::id(item);
    let key = ExpansionKey::Shell(id.to_owned());
    let open = x.is_open(&key);
    let wash = in_open || open;
    let toggle = Some(TermPress::Toggle(key));
    let failed = shell::failed(item);
    let mut lines = wrap_body(
        &shell::header_text(item),
        m,
        &Wrap {
            gutter: Cow::Borrowed(glyph::SHELL),
            gutter_tone: if failed { Tone::Red } else { Tone::Magenta },
            tone: if failed { Tone::Red } else { Tone::Fg },
            band: Band::User,
            pulsing: running,
            press: if running { Some(TermPress::OpenShell(id.to_owned())) } else { toggle.clone() },
            in_open: wash,
            ..Wrap::default()
        },
    );
    let body = shell::body_lines(item, open);
    let shown = if open { &body[..] } else { &body[..body.len().min(SHELL_INLINE_LINES)] };
    for line in shown {
        lines.extend(wrap_body(
            if line.is_empty() { " " } else { line },
            m,
            &Wrap { tone: Tone::Dim, band: Band::Output, press: toggle.clone(), in_open: wash, ..Wrap::default() },
        ));
    }
    if let Some(footer) = shell::footer_text(item, open, shown.len()) {
        lines.extend(wrap_body(&footer, m, &Wrap { tone: Tone::Faint, press: toggle.clone(), in_open: wash, ..Wrap::default() }));
    }
    if running {
        lines.extend(wrap_body(
            shell::KILL_ACTION,
            m,
            &Wrap { tone: Tone::Red, press: Some(TermPress::KillShell(id.to_owned())), in_open: wash, ..Wrap::default() },
        ));
    }
    lines
}

pub const EXPANDED_CHARS: usize = 2000;

pub fn clip_to_chars<'a>(lines: &[&'a str], max: usize) -> Vec<&'a str> {
    let mut out = Vec::new();
    let mut chars = 0usize;
    for line in lines {
        let count = cells::gcount(line);
        if !out.is_empty() && chars + count > max {
            break;
        }
        out.push(*line);
        chars += count + 1;
    }
    out
}

fn plan_image_box(image: &ImageRef, call_id: &str, first: bool, nested: bool, press: &Option<TermPress>, in_open: bool) -> Vec<TermLine> {
    let image_box = TermImageBox {
        tool_use_id: call_id.to_owned(),
        source_seq: image.source_seq,
        part_index: image.part_index as i64,
        media_type: image.media_type.to_string(),
        bytes: image.bytes as i64,
        lines: IMAGE_BOX_LINES,
    };
    (0..image_box.lines)
        .map(|offset| {
            let mut line = TermLine::plain(" ".to_owned(), Tone::Dim);
            line.gutter = Cow::Borrowed(if first && offset == 0 { glyph::OUTPUT } else { "" });
            line.columns = 3;
            line.indent = 1;
            line.nested = nested;
            line.press = press.clone();
            line.image = (offset == 0).then(|| image_box.clone());
            line.in_open = in_open;
            line
        })
        .collect()
}

fn plan_tool_call(call: &ToolCall, m: &Metrics, x: &TerminalExpansion, in_open: bool, frame: Option<&str>) -> Vec<TermLine> {
    if is_peer_send(call) {
        return plan_peer_send(call, m, x, in_open, frame);
    }
    let nested = is_nested(call.parent_tool_use_id.as_deref(), frame);
    let busy = call_busy(call);
    let tone = tool_tone(call);
    let open_key = ExpansionKey::Call(call.id.to_string());
    let expandable = call.result.as_ref().is_some_and(|r| !r.text.is_empty());
    let open = expandable && x.is_open(&open_key);
    let full = x.is_full(&call.id);
    let wash = in_open || open;
    let press = expandable.then_some(TermPress::Toggle(open_key));

    let todos = todos::preview(&call.name, &call.input);
    let input_preview = match &todos {
        Some(todos) => todos.summary.clone(),
        None => tool_input_preview(&call.input, 80),
    };
    let mut header = format!("{}({})", call.title.as_deref().unwrap_or(&call.name), input_preview);
    if call.title.is_some() && open {
        header.push_str(" · ");
        header.push_str(&call.name);
    }
    if let Some(backend) = call.backend.as_deref().filter(|b| *b != "server") {
        header.push_str(" · ");
        header.push_str(backend);
    }

    let mut lines = reserve_elapsed(
        wrap_body(
            &header,
            m,
            &Wrap {
                gutter: Cow::Borrowed(if busy { glyph::PULSE_REST } else { glyph::BULLET }),
                gutter_tone: tone,
                tone: Tone::Fg,
                bold: true,
                nested,
                pulsing: busy,
                press: press.clone(),
                in_open: wash,
                ..Wrap::default()
            },
        ),
        if busy { call.ts } else { None },
        m,
    );
    lines.extend(plan_live_tail(&tail_lines(call), m, nested, &press, wash));

    if let Some(images) = call.result.as_ref().and_then(|r| r.images.as_ref()) {
        for (offset, image) in images.iter().enumerate() {
            lines.extend(plan_image_box(image, &call.id, offset == 0, nested, &press, wash));
        }
    }

    if let Some(patch) = &call.patch
        && !open
    {
        lines.extend(plan_diff(patch, m, nested, press, wash));
        return lines;
    }

    if let Some(todos) = &todos
        && !open
    {
        for (offset, todo) in todos.shown.iter().enumerate() {
            lines.extend(wrap_body(
                &todos::line(todo),
                m,
                &Wrap {
                    gutter: Cow::Borrowed(if offset == 0 { glyph::OUTPUT } else { "" }),
                    gutter_tone: Tone::Dim,
                    tone: todos::tone(todo.status),
                    columns: 3,
                    indent: 1,
                    band: Band::Output,
                    nested,
                    press: press.clone(),
                    in_open: wash,
                    ..Wrap::default()
                },
            ));
        }
        if let Some(more) = &todos.more {
            lines.extend(wrap_body(
                more,
                m,
                &Wrap { tone: Tone::Faint, columns: 3, indent: 1, band: Band::Output, nested, press, in_open: wash, ..Wrap::default() },
            ));
        }
        return lines;
    }

    let Some(result) = &call.result else {
        return lines;
    };
    let text: &str = &result.text;
    if text.is_empty() {
        return lines;
    }
    let failed = call_failed(call);
    let preview_cols = m.columns(3, 1, extra(m, nested));
    let all: Vec<&str> = text.trim_end().split('\n').collect();
    let truncated = result.truncated;
    let total_chars = result.total_chars;
    let fetching = truncated && x.is_fetching(&call.id);

    let (shown, more, more_press): (Vec<String>, Option<String>, Option<TermPress>) = if open {
        let shown: Vec<&str> = if full { all.clone() } else { clip_to_chars(&all, EXPANDED_CHARS) };
        let hidden = all.len() - shown.len();
        let count = cells::gcount(text) as i64;
        let whole = total_chars.unwrap_or(count);
        let (more, more_press) = if fetching {
            (Some(format!("… fetching {} chars", fmt_grouped(whole))), None)
        } else if truncated {
            (
                Some(format!("… +{} chars - fetch the rest", fmt_grouped((whole - count).max(0)))),
                Some(TermPress::ExpandFull(call.id.to_string())),
            )
        } else if hidden > 0 {
            (
                Some(format!("… +{hidden} line{} - show all {} chars", if hidden == 1 { "" } else { "s" }, fmt_grouped(count))),
                Some(TermPress::ExpandFull(call.id.to_string())),
            )
        } else {
            (None, None)
        };
        (shown.into_iter().map(str::to_owned).collect(), more, more_press)
    } else {
        let (shown, more) = collapsed(&all, preview_cols, total_chars);
        (shown, more, press.clone())
    };

    for (offset, line) in shown.iter().enumerate() {
        lines.extend(wrap_body(
            if line.is_empty() { " " } else { line },
            m,
            &Wrap {
                gutter: Cow::Borrowed(if offset == 0 { glyph::OUTPUT } else { "" }),
                gutter_tone: if failed { Tone::Red } else { Tone::Dim },
                tone: if failed { Tone::Red } else { Tone::Dim },
                columns: 3,
                indent: 1,
                band: Band::Output,
                nested,
                press: press.clone(),
                in_open: wash,
                ..Wrap::default()
            },
        ));
    }
    if let Some(more) = more {
        lines.extend(wrap_body(
            &more,
            m,
            &Wrap {
                tone: Tone::Faint,
                columns: 3,
                indent: 1,
                band: Band::Output,
                nested,
                press: more_press,
                in_open: wash,
                ..Wrap::default()
            },
        ));
    }
    lines
}

pub fn peer_send_text(call: &ToolCall) -> &str {
    call.input.get("text").and_then(Value::as_str).unwrap_or("")
}

pub fn peer_one_line(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

pub struct PeerDelivery {
    pub session_id: String,
    pub name: Option<String>,
}

pub fn peer_delivered_to(text: &str) -> Option<PeerDelivery> {
    let rest = text.strip_prefix("Delivered to ")?;
    let line_end = rest.find('\n').unwrap_or(rest.len());
    let mut candidates: Vec<usize> = rest[..line_end].match_indices(" (").map(|(at, _)| at).filter(|&at| at > 0).collect();
    candidates.reverse();
    for at in candidates {
        let inner = &rest[at + 2..];
        let close = inner.find(['(', ')']).unwrap_or(inner.len());
        if close > 0 && inner[close..].starts_with(");") {
            return Some(PeerDelivery { session_id: inner[..close].to_owned(), name: Some(rest[..at].to_owned()) });
        }
    }
    let end = rest.find(|c: char| c == '(' || c == ')' || c.is_whitespace()).unwrap_or(rest.len());
    if end > 0 && rest[end..].starts_with(';') {
        return Some(PeerDelivery { session_id: rest[..end].to_owned(), name: None });
    }
    None
}

pub fn peer_send_target(call: &ToolCall) -> String {
    if let Some(result) = &call.result
        && !result.is_error
        && let Some(delivered) = peer_delivered_to(&result.text)
    {
        return delivered.name.unwrap_or_else(|| peer_short_id(&delivered.session_id));
    }
    if let Some(session_id) = call.input.get("sessionId").and_then(Value::as_str) {
        return peer_short_id(session_id);
    }
    "peer".to_owned()
}

fn plan_peer_send(call: &ToolCall, m: &Metrics, x: &TerminalExpansion, in_open: bool, frame: Option<&str>) -> Vec<TermLine> {
    let nested = is_nested(call.parent_tool_use_id.as_deref(), frame);
    let tone = if call_failed(call) { Tone::Red } else { Tone::Peer };
    let who = peer_send_target(call);
    let source: Vec<&str> = peer_send_text(call).split('\n').collect();
    let delivery = call.result.as_ref().map(|r| peer_one_line(&r.text)).unwrap_or_default();
    let closed = peer_styled(&who, &peer_one_line(peer_send_text(call)));
    let plain = &closed.plain;
    let cols = m.columns(2, 0, extra(m, nested));
    let clipped = cells::clipped(plain, cols);
    let expandable = clipped != *plain || source.len() > 1 || !delivery.is_empty();
    let key = ExpansionKey::Call(call.id.to_string());
    let open = expandable && x.is_open(&key);
    let press = expandable.then_some(TermPress::Toggle(key));
    let wash = in_open || open;

    if !open {
        let kept = if clipped != *plain { cells::gprefix(plain, cells::gcount(&clipped).saturating_sub(1)).len() } else { plain.len() };
        let runs = closed
            .runs
            .iter()
            .filter_map(|&(start, len, intent)| {
                let end = (start + len).min(kept);
                (end > start).then_some((start, end - start, intent))
            })
            .collect();
        let mut line = TermLine::plain(clipped, tone);
        line.gutter = Cow::Borrowed(glyph::PEER_OUT);
        line.gutter_tone = tone;
        line.attributed = Some(runs);
        line.nested = nested;
        line.press = press;
        line.in_open = wash;
        return vec![line];
    }

    let first = source.first().copied().unwrap_or("");
    let mut lines = styled_body(
        &peer_styled(&who, if first.is_empty() { " " } else { first }),
        m,
        &Wrap {
            gutter: Cow::Borrowed(glyph::PEER_OUT),
            gutter_tone: tone,
            tone,
            nested,
            press: press.clone(),
            in_open: wash,
            ..Wrap::default()
        },
    );
    for line in &source[1..] {
        lines.extend(wrap_body(
            if line.is_empty() { " " } else { line },
            m,
            &Wrap { tone, nested, press: press.clone(), in_open: wash, ..Wrap::default() },
        ));
    }
    if !delivery.is_empty() {
        lines.extend(wrap_body(&delivery, m, &Wrap { tone: Tone::Faint, nested, press, in_open: wash, ..Wrap::default() }));
    }
    lines
}

pub mod todos {
    use super::{Tone, Value};

    pub const PREVIEW_TODOS: usize = 8;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub enum Status {
        Pending,
        InProgress,
        Completed,
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct Entry {
        pub status: Status,
        pub text: String,
    }

    #[derive(Debug, Clone, PartialEq, Eq)]
    pub struct Preview {
        pub summary: String,
        pub shown: Vec<Entry>,
        pub more: Option<String>,
    }

    fn glyph(status: Status) -> &'static str {
        match status {
            Status::Pending => "☐",
            Status::InProgress => "◐",
            Status::Completed => "☒",
        }
    }

    pub fn tone(status: Status) -> Tone {
        match status {
            Status::Pending => Tone::Dim,
            Status::InProgress => Tone::Blue,
            Status::Completed => Tone::Faint,
        }
    }

    fn entry(value: &Value) -> Option<Entry> {
        let object = value.as_object()?;
        let status = match object.get("status")?.as_str()? {
            "pending" => Status::Pending,
            "in_progress" => Status::InProgress,
            "completed" => Status::Completed,
            _ => return None,
        };
        let content = object.get("content")?.as_str()?.trim();
        if content.is_empty() {
            return None;
        }
        let active = object.get("activeForm").and_then(Value::as_str).map(str::trim).unwrap_or("");
        let text = if status == Status::InProgress && !active.is_empty() { active } else { content };
        Some(Entry { status, text: text.to_owned() })
    }

    pub fn parse(input: &Value) -> Option<Vec<Entry>> {
        let items = input.get("todos")?.as_array()?;
        if items.is_empty() {
            return None;
        }
        items.iter().map(entry).collect()
    }

    pub fn preview(name: &str, input: &Value) -> Option<Preview> {
        if name != "TodoWrite" {
            return None;
        }
        let todos = parse(input)?;
        let done = todos.iter().filter(|todo| todo.status == Status::Completed).count();
        let hidden = todos.len().saturating_sub(PREVIEW_TODOS);
        let summary = format!("{done}/{} done", todos.len());
        let shown = todos.into_iter().take(PREVIEW_TODOS).collect();
        Some(Preview { summary, shown, more: (hidden > 0).then(|| format!("… +{hidden} more")) })
    }

    pub fn line(entry: &Entry) -> String {
        format!("{} {}", glyph(entry.status), entry.text)
    }
}

pub fn plan_diff(patch: &Value, m: &Metrics, nested: bool, press: Option<TermPress>, in_open: bool) -> Vec<TermLine> {
    let number = |hunk: &Value, key: &str| hunk.get(key).and_then(Value::as_f64).unwrap_or(0.0) as i64;
    let hunks: &[Value] = patch.get("hunks").and_then(Value::as_array).map_or(&[], Vec::as_slice);
    let numbered = hunks.iter().any(|hunk| number(hunk, "newStart") > 0);
    let mut widest = 1;
    if numbered {
        for hunk in hunks {
            widest =
                widest.max(number(hunk, "newStart") + number(hunk, "newLines")).max(number(hunk, "oldStart") + number(hunk, "oldLines"));
        }
    }
    let number_width = if numbered { widest.to_string().len() } else { 0 };
    let columns = if numbered { number_width + 3 } else { 2 };
    let mut lines = Vec::new();
    for (index, hunk) in hunks.iter().enumerate() {
        if index > 0 {
            let mut gap = TermLine::plain(String::new(), Tone::Faint);
            gap.gutter = Cow::Owned(format!("{} {}", " ".repeat(number_width), glyph::HUNK_GAP));
            gap.gutter_tone = Tone::Faint;
            gap.columns = columns;
            gap.indent = 2;
            gap.nested = nested;
            gap.press = press.clone();
            gap.in_open = in_open;
            lines.push(gap);
        }
        let mut old_number = number(hunk, "oldStart");
        let mut new_number = number(hunk, "newStart");
        for raw in hunk.get("lines").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            let marker = raw.chars().next().unwrap_or(' ');
            let body = &raw[marker.len_utf8().min(raw.len())..];
            let (tone, band, shown) = match marker {
                '+' => {
                    new_number += 1;
                    (Tone::DiffAdd, Band::DiffAdd, new_number - 1)
                }
                '-' => {
                    old_number += 1;
                    (Tone::DiffRemove, Band::DiffRemove, old_number - 1)
                }
                _ => {
                    new_number += 1;
                    old_number += 1;
                    (Tone::DiffContext, Band::None, new_number - 1)
                }
            };
            let gutter = if numbered { format!("{shown:>number_width$} {marker}") } else { marker.to_string() };
            lines.extend(wrap_body(
                if body.is_empty() { " " } else { body },
                m,
                &Wrap {
                    gutter: Cow::Owned(gutter),
                    gutter_tone: Tone::DiffNumber,
                    tone,
                    columns,
                    indent: 2,
                    band,
                    nested,
                    press: press.clone(),
                    in_open,
                    ..Wrap::default()
                },
            ));
        }
    }
    if patch.get("truncated").and_then(Value::as_bool) == Some(true) {
        lines.extend(wrap_body(
            "… hunks omitted",
            m,
            &Wrap { tone: Tone::Faint, columns, indent: 2, nested, press, in_open, ..Wrap::default() },
        ));
    }
    lines
}

fn plan_markdown(source: &str, m: &Metrics, gutter: &'static str, gutter_tone: Tone, nested: bool, in_open: bool) -> Vec<TermLine> {
    let mut lines: Vec<TermLine> = Vec::new();
    let mut first = true;
    let mut emit = |produced: Vec<TermLine>, lines: &mut Vec<TermLine>| {
        if produced.is_empty() {
            return;
        }
        if !first {
            let mut blank = TermLine::plain(String::new(), Tone::Fg);
            blank.nested = nested;
            blank.in_open = in_open;
            lines.push(blank);
        }
        first = false;
        lines.extend(produced);
    };

    for block in markdown::parse(source) {
        match block {
            MdBlock::Prose(text) => emit(inline_body(&text, m, &Wrap { tone: Tone::Fg, nested, in_open, ..Wrap::default() }), &mut lines),
            MdBlock::Heading(_, text) => {
                emit(inline_body(&text, m, &Wrap { tone: Tone::Bright, bold: true, nested, in_open, ..Wrap::default() }), &mut lines)
            }
            MdBlock::Blockquote(text) => {
                emit(inline_body(&text, m, &Wrap { tone: Tone::Dim, indent: 1, nested, in_open, ..Wrap::default() }), &mut lines)
            }
            MdBlock::ThematicBreak => {
                let mut line = TermLine::plain(String::new(), Tone::Faint);
                line.nested = nested;
                line.in_open = in_open;
                emit(vec![line], &mut lines);
            }
            MdBlock::Code { text, .. } => {
                let mut produced = Vec::new();
                for line in text.split('\n') {
                    produced.extend(wrap_body(
                        if line.is_empty() { " " } else { line },
                        m,
                        &Wrap { tone: Tone::Dim, indent: 1, band: Band::Output, nested, in_open, ..Wrap::default() },
                    ));
                }
                if produced.is_empty() {
                    let mut line = TermLine::plain(" ".into(), Tone::Dim);
                    line.band = Band::Output;
                    line.nested = nested;
                    line.in_open = in_open;
                    produced.push(line);
                }
                emit(produced, &mut lines);
            }
            MdBlock::List(items) => emit(plan_list(&items, m, nested, in_open), &mut lines),
        }
    }

    if lines.is_empty() {
        let mut line = TermLine::plain(String::new(), Tone::Fg);
        line.gutter = Cow::Borrowed(gutter);
        line.gutter_tone = gutter_tone;
        line.nested = nested;
        line.in_open = in_open;
        return vec![line];
    }
    lines[0].gutter = Cow::Borrowed(gutter);
    lines[0].gutter_tone = gutter_tone;
    lines
}

fn plan_list(items: &[ListItem], m: &Metrics, nested: bool, in_open: bool) -> Vec<TermLine> {
    let mut lines = Vec::new();
    let mut gutter_at_depth: Vec<usize> = Vec::new();
    for item in items {
        let gutter_cells = if item.ordinal.is_some() { 3 } else { 2 };
        gutter_at_depth.truncate(item.depth);
        while gutter_at_depth.len() < item.depth {
            gutter_at_depth.push(2);
        }
        gutter_at_depth.push(gutter_cells);
        let indent: usize = gutter_at_depth[..item.depth].iter().sum();
        let marker: Cow<'static, str> = match item.ordinal {
            Some(n) => Cow::Owned(format!("{n}.")),
            None => Cow::Borrowed("-"),
        };
        lines.extend(inline_body(
            &item.text,
            m,
            &Wrap {
                tone: Tone::Fg,
                columns: gutter_cells,
                indent,
                gutter: marker,
                gutter_tone: Tone::Faint,
                nested,
                in_open,
                ..Wrap::default()
            },
        ));
    }
    lines
}
