use crate::cells;
use crate::markdown::{self, Block, ListItem};
use crate::rows::{Leaf, Row, RunBlock, TaskBlock};
use crate::transcript::{Item, NoticeLevel, ToolCall, ToolCallStatus};
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
}

pub mod glyph {
    pub const PROMPT: &str = "❯";
    pub const BULLET: &str = "●";
    pub const OUTPUT: &str = "⎿";
    pub const THINKING: &str = "✻";
    pub const NOTICE: &str = "!";
    pub const PULSE_REST: &str = "⠿";
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
}

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
            in_open: false,
            elapsed_since: None,
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
            in_open: false,
            elapsed_since: None,
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

fn task_summary(task: &ToolCall, children: &[Item]) -> String {
    let busy = call_busy(task) || children.iter().any(|c| matches!(c, Item::ToolCall(call) if call_busy(call)));
    let calls = children.iter().filter(|c| matches!(c, Item::ToolCall(_))).count();
    let description = trimmed_non_empty(task.input.get("description"));
    let agent = trimmed_non_empty(task.input.get("subagent_type"));
    let identity = match (agent, description) {
        (Some(a), Some(d)) => format!("{a} · {}", fmt_clip(&d, 80)),
        (Some(a), None) => a,
        (None, Some(d)) => fmt_clip(&d, 80),
        (None, None) => tool_input_preview(&task.input, 80),
    };
    let label = format!("{}({identity})", task.name);
    if calls == 0 {
        return if busy { format!("{label} · working…") } else { format!("{label} · done") };
    }
    format!("{label} · {calls} tool{}{}", if calls == 1 { "" } else { "s" }, if busy { "…" } else { "" })
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
    match row {
        Row::Item(leaf) => plan_item(&leaf.item, m),
        Row::Run(leaf) => plan_run(leaf, m),
        Row::Task(leaf) => plan_task(leaf, m),
    }
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
        line.in_open = last.in_open;
        line.elapsed_since = Some(since);
        lines.push(line);
    }
    lines
}

fn plan_live_tail(tail: &[String], m: &Metrics, nested: bool) -> Vec<TermLine> {
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
                ..Wrap::default()
            },
        ));
    }
    out
}

fn plan_run(block: &RunBlock, m: &Metrics) -> Vec<TermLine> {
    let run = &block.run;
    if run.len() <= 1 {
        return run.first().map(|c| plan_tool_call(c, m)).unwrap_or_default();
    }
    let busy = run.iter().any(|c| call_busy(c));
    let failed = run.last().is_some_and(|c| call_failed(c));
    let nested = run[0].parent_tool_use_id.is_some();
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
                ..Wrap::default()
            },
        ),
        started,
        m,
    );
    let tail = run.iter().rev().map(|c| tail_lines(c)).find(|t| !t.is_empty()).unwrap_or_default();
    lines.extend(plan_live_tail(&tail, m, nested));
    lines
}

fn plan_task(block: &TaskBlock, m: &Metrics) -> Vec<TermLine> {
    let children: Vec<Item> = block
        .children
        .iter()
        .flat_map(|leaf| match leaf {
            Leaf::Item(c) => vec![c.item.clone()],
            Leaf::Run(c) => c.run.iter().map(|call| Item::ToolCall(call.clone())).collect(),
        })
        .collect();
    let busy = call_busy(&block.task) || children.iter().any(|c| matches!(c, Item::ToolCall(call) if call_busy(call)));
    let failed = call_failed(&block.task);
    wrap_body(
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
            ..Wrap::default()
        },
    )
}

fn plan_thinking(text: &str, m: &Metrics, nested: bool) -> Vec<TermLine> {
    let body = text.trim();
    let first = body.split('\n').next().unwrap_or("");
    let cols = m.columns(2, 0, extra(m, nested));
    let clipped = cells::clipped(first, cols);
    let mut line = TermLine::plain(clipped, Tone::Dim);
    line.gutter = Cow::Borrowed(glyph::THINKING);
    line.gutter_tone = Tone::Dim;
    line.italic = true;
    line.nested = nested;
    vec![line]
}

fn plan_item(item: &Item, m: &Metrics) -> Vec<TermLine> {
    let nested = item.parent_tool_use_id().is_some();
    match item {
        Item::User { text, .. } => wrap_body(
            if text.is_empty() { " " } else { text },
            m,
            &Wrap {
                gutter: Cow::Borrowed(glyph::PROMPT),
                gutter_tone: Tone::Dim,
                tone: Tone::Fg,
                band: Band::User,
                nested,
                ..Wrap::default()
            },
        ),
        Item::AssistantText { text, .. } => plan_markdown(text, m, glyph::BULLET, Tone::Fg, nested),
        Item::Thinking { text, .. } => plan_thinking(text, m, nested),
        Item::ToolCall(call) => plan_tool_call(call, m),
        Item::TurnResult { subtype, is_error, duration_ms, total_cost_usd, cost_usd, errors, .. } => {
            let head = format!(
                "{} · {} · {}",
                if *is_error { &**subtype } else { "done" },
                fmt_duration(*duration_ms),
                fmt_cost(Some(cost_usd.unwrap_or(*total_cost_usd)))
            );
            let mut lines = wrap_body(&head, m, &Wrap { tone: if *is_error { Tone::Red } else { Tone::Faint }, ..Wrap::default() });
            for message in errors.iter().flat_map(|e| e.iter()) {
                lines.extend(wrap_body(message, m, &Wrap { tone: Tone::Red, ..Wrap::default() }));
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
                ..Wrap::default()
            },
        ),
    }
}

fn plan_tool_call(call: &ToolCall, m: &Metrics) -> Vec<TermLine> {
    let nested = call.parent_tool_use_id.is_some();
    let busy = call_busy(call);
    let tone = tool_tone(call);
    let input_preview = tool_input_preview(&call.input, 80);
    let header = format!("{}({})", call.title.as_deref().unwrap_or(&call.name), input_preview);

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
                ..Wrap::default()
            },
        ),
        if busy { call.ts } else { None },
        m,
    );
    lines.extend(plan_live_tail(&tail_lines(call), m, nested));

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
    let (shown, more) = collapsed(&all, preview_cols, result.total_chars);

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
                ..Wrap::default()
            },
        ));
    }
    if let Some(more) = more {
        lines.extend(wrap_body(
            &more,
            m,
            &Wrap { tone: Tone::Faint, columns: 3, indent: 1, band: Band::Output, nested, ..Wrap::default() },
        ));
    }
    lines
}

fn plan_markdown(source: &str, m: &Metrics, gutter: &'static str, gutter_tone: Tone, nested: bool) -> Vec<TermLine> {
    let mut lines: Vec<TermLine> = Vec::new();
    let mut first = true;
    let mut emit = |produced: Vec<TermLine>, lines: &mut Vec<TermLine>| {
        if produced.is_empty() {
            return;
        }
        if !first {
            let mut blank = TermLine::plain(String::new(), Tone::Fg);
            blank.nested = nested;
            lines.push(blank);
        }
        first = false;
        lines.extend(produced);
    };

    for block in markdown::parse(source) {
        match block {
            Block::Prose(text) => emit(inline_body(&text, m, &Wrap { tone: Tone::Fg, nested, ..Wrap::default() }), &mut lines),
            Block::Heading(_, text) => {
                emit(inline_body(&text, m, &Wrap { tone: Tone::Bright, bold: true, nested, ..Wrap::default() }), &mut lines)
            }
            Block::Blockquote(text) => {
                emit(inline_body(&text, m, &Wrap { tone: Tone::Dim, indent: 1, nested, ..Wrap::default() }), &mut lines)
            }
            Block::ThematicBreak => {
                let mut line = TermLine::plain(String::new(), Tone::Faint);
                line.nested = nested;
                emit(vec![line], &mut lines);
            }
            Block::Code { text, .. } => {
                let mut produced = Vec::new();
                for line in text.split('\n') {
                    produced.extend(wrap_body(
                        if line.is_empty() { " " } else { line },
                        m,
                        &Wrap { tone: Tone::Dim, indent: 1, band: Band::Output, nested, ..Wrap::default() },
                    ));
                }
                if produced.is_empty() {
                    let mut line = TermLine::plain(" ".into(), Tone::Dim);
                    line.band = Band::Output;
                    line.nested = nested;
                    produced.push(line);
                }
                emit(produced, &mut lines);
            }
            Block::List(items) => emit(plan_list(&items, m, nested), &mut lines),
        }
    }

    if lines.is_empty() {
        let mut line = TermLine::plain(String::new(), Tone::Fg);
        line.gutter = Cow::Borrowed(gutter);
        line.gutter_tone = gutter_tone;
        line.nested = nested;
        return vec![line];
    }
    lines[0].gutter = Cow::Borrowed(gutter);
    lines[0].gutter_tone = gutter_tone;
    lines
}

fn plan_list(items: &[ListItem], m: &Metrics, nested: bool) -> Vec<TermLine> {
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
            &Wrap { tone: Tone::Fg, columns: gutter_cells, indent, gutter: marker, gutter_tone: Tone::Faint, nested, ..Wrap::default() },
        ));
    }
    lines
}
