use crate::book::HeightBook;
use crate::planner::{Tone, fmt_cost, fmt_duration, tool_input_preview};
use crate::rows::{TerminalRows, parent_tool_use_id};
use crate::transcript::{Item, NoticeLevel, ToolCallStatus};
use crate::vm::prompt::permission_prompt_model;
use serde_json::Value;
use std::collections::{HashMap, HashSet};

// Port of `packages/ui/src/components/agent/scrubber-marks.ts` and the pure half of `terminal/scrubber.tsx`.
// Every mark's item index goes through `row_index_for_item`, and the scale's denominator is `max(total, viewport)`.

pub const MIN_MARK: f64 = 2.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Lane {
    Left,
    Right,
    Full,
}

impl Lane {
    pub fn raw(self) -> &'static str {
        match self {
            Lane::Left => "l",
            Lane::Right => "r",
            Lane::Full => "f",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MarkKind {
    User,
    Subagent,
    Shell,
    Turn,
    TurnFailed,
    ToolFailed,
    Error,
    Approval,
    Recap,
    Bookmark,
}

impl MarkKind {
    pub fn raw(self) -> &'static str {
        match self {
            MarkKind::User => "user",
            MarkKind::Subagent => "subagent",
            MarkKind::Shell => "shell",
            MarkKind::Turn => "turn",
            MarkKind::TurnFailed => "turnFailed",
            MarkKind::ToolFailed => "toolFailed",
            MarkKind::Error => "error",
            MarkKind::Approval => "approval",
            MarkKind::Recap => "recap",
            MarkKind::Bookmark => "bookmark",
        }
    }

    pub fn lane(self) -> Lane {
        match self {
            MarkKind::User | MarkKind::Subagent | MarkKind::Shell => Lane::Left,
            MarkKind::Turn | MarkKind::TurnFailed | MarkKind::ToolFailed | MarkKind::Error => Lane::Right,
            MarkKind::Approval | MarkKind::Recap | MarkKind::Bookmark => Lane::Full,
        }
    }

    pub fn loudness(self) -> u8 {
        match self {
            MarkKind::Approval => 7,
            MarkKind::Error => 6,
            MarkKind::TurnFailed => 5,
            MarkKind::ToolFailed => 4,
            MarkKind::User => 3,
            MarkKind::Turn => 2,
            MarkKind::Bookmark | MarkKind::Subagent | MarkKind::Shell => 1,
            MarkKind::Recap => 0,
        }
    }

    pub fn name(self) -> &'static str {
        match self {
            MarkKind::User => "you",
            MarkKind::Subagent => "sub-agent",
            MarkKind::Shell => "shell",
            MarkKind::Turn => "response · turn end",
            MarkKind::TurnFailed => "turn failed",
            MarkKind::ToolFailed => "tool failed",
            MarkKind::Error => "error",
            MarkKind::Approval => "pending approval",
            MarkKind::Recap => "catch-up boundary",
            MarkKind::Bookmark => "bookmark",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mark {
    pub kind: MarkKind,
    // `None` for the recap seam, which is a row and not an item.
    pub item_index: Option<usize>,
    pub row_index: usize,
    pub turn_index: Option<usize>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Member {
    pub mark: Mark,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Cluster {
    pub lane: Lane,
    pub kind: MarkKind,
    pub y: f64,
    pub h: f64,
    pub marks: Vec<Member>,
}

impl Cluster {
    pub fn nearest_member(&self, y: f64) -> Option<Mark> {
        let mut best: Option<&Member> = None;
        for member in &self.marks {
            if best.is_none_or(|b| (member.y - y).abs() < (b.y - y).abs()) {
                best = Some(member);
            }
        }
        best.map(|member| member.mark)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct Recap {
    pub row_index: usize,
    pub label: String,
}

pub struct ScrubberInput<'a> {
    pub items: &'a [Item],
    pub rows: &'a TerminalRows,
    pub book: &'a HeightBook,
    pub pending_approvals: usize,
    pub bookmarks: &'a [String],
    pub recap: Option<Recap>,
    pub frame_parent_id: Option<&'a str>,
    pub viewport_h: f64,
}

pub fn rail_scale(rail_h: f64, total: f64, viewport_h: f64) -> f64 {
    if total > 0.0 { rail_h / total.max(viewport_h) } else { 0.0 }
}

// JS `Math.round`, which rounds half up rather than away from zero.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Band {
    pub top: f64,
    pub h: f64,
}

pub fn band(rail_h: f64, total: f64, viewport_h: f64, scroll_offset: f64) -> Band {
    let scale = rail_scale(rail_h, total, viewport_h);
    let h = rail_h.min(js_round(viewport_h * scale)).max(2.0);
    let top = (rail_h - h).min(js_round(scroll_offset * scale)).max(0.0);
    Band { top, h }
}

// A transcript shorter than its viewport sits at the viewport's foot on a phone, so its rail is pushed down by the
// empty space above it: add this to every rail `y` drawn, subtract it from every touch.
pub fn anchor_pad(rail_h: f64, total: f64, viewport_h: f64) -> f64 {
    if total <= 0.0 || total >= viewport_h { 0.0 } else { (rail_h - js_round(total * rail_scale(rail_h, total, viewport_h))).max(0.0) }
}

// Where a drag at `fraction` of the rail puts the top of the viewport: the point under the finger is centred.
pub fn scrub_offset(fraction: f64, total: f64, viewport_h: f64) -> f64 {
    let wanted = fraction.clamp(0.0, 1.0) * total.max(viewport_h) - viewport_h / 2.0;
    wanted.clamp(0.0, (total - viewport_h).max(0.0))
}

pub fn tool_call_failed(item: &Item) -> bool {
    match item {
        Item::ToolCall(call) => call.status == ToolCallStatus::Failed || call.result.as_ref().is_some_and(|r| r.is_error),
        _ => false,
    }
}

fn row_outcomes(items: &[Item], frame_parent_id: Option<&str>, rows: &TerminalRows) -> HashSet<usize> {
    let mut outcome: HashMap<usize, usize> = HashMap::new();
    for (index, item) in items.iter().enumerate() {
        if matches!(item, Item::ToolCall(_)) && parent_tool_use_id(item) == frame_parent_id {
            outcome.insert(rows.row_index_for_item(index), index);
        }
    }
    outcome.into_values().collect()
}

pub fn build_marks(input: &ScrubberInput) -> Vec<Mark> {
    let ScrubberInput { items, rows, frame_parent_id, .. } = *input;
    let at =
        |kind: MarkKind, index: usize| Mark { kind, item_index: Some(index), row_index: rows.row_index_for_item(index), turn_index: None };
    let subagent_parents: HashSet<&str> = items.iter().filter_map(parent_tool_use_id).collect();
    let outcomes = row_outcomes(items, frame_parent_id, rows);
    let mut marks = Vec::new();
    let (mut response, mut turn, mut failed): (Option<usize>, Option<usize>, bool) = (None, None, false);
    let close = |marks: &mut Vec<Mark>, response: &mut Option<usize>, turn: &mut Option<usize>, failed: &mut bool| {
        if let Some(anchor) = response.or(*turn) {
            let kind = if *failed { MarkKind::TurnFailed } else { MarkKind::Turn };
            marks.push(Mark { turn_index: *turn, ..at(kind, anchor) });
        }
        (*response, *turn, *failed) = (None, None, false);
    };
    for (index, item) in items.iter().enumerate() {
        if let Item::ToolCall(call) = item
            && subagent_parents.contains(&*call.id)
        {
            marks.push(at(MarkKind::Subagent, index));
        }
        let level = parent_tool_use_id(item) == frame_parent_id;
        match item {
            Item::User { .. } if level => {
                close(&mut marks, &mut response, &mut turn, &mut failed);
                marks.push(at(MarkKind::User, index));
            }
            Item::TurnResult { is_error, .. } => {
                turn = Some(index);
                failed = *is_error;
                close(&mut marks, &mut response, &mut turn, &mut failed);
            }
            Item::Notice { level: NoticeLevel::Error, .. } => marks.push(at(MarkKind::Error, index)),
            Item::Shell(_) => marks.push(at(MarkKind::Shell, index)),
            _ if tool_call_failed(item) && outcomes.contains(&index) => marks.push(at(MarkKind::ToolFailed, index)),
            Item::AssistantText { .. } | Item::Thinking { addressed: true, .. } if level => {
                if frame_parent_id.is_some() {
                    marks.push(at(MarkKind::Turn, index));
                } else {
                    response = Some(index);
                }
            }
            _ => {}
        }
    }
    close(&mut marks, &mut response, &mut turn, &mut failed);
    if !input.bookmarks.is_empty() {
        let index_by_id: HashMap<&str, usize> = items.iter().enumerate().map(|(index, item)| (item.id(), index)).collect();
        for id in input.bookmarks {
            if let Some(&index) = index_by_id.get(id.as_str()) {
                marks.push(at(MarkKind::Bookmark, index));
            }
        }
    }
    if let Some(recap) = &input.recap {
        marks.push(Mark { kind: MarkKind::Recap, item_index: None, row_index: recap.row_index, turn_index: None });
    }
    marks
}

fn place(mark: &Mark, input: &ScrubberInput, scale: f64, rail_h: f64) -> (f64, f64) {
    let within = mark.item_index.and_then(|index| input.rows.position(index));
    let row_h = input.book.height(mark.row_index);
    let h = if within.is_some() { MIN_MARK } else { MIN_MARK.max(js_round(row_h * scale)) };
    let offset = input.book.offset(mark.row_index) + within.map_or(0.0, |w| w.ordinal as f64 / w.count as f64 * row_h);
    ((rail_h - h).max(0.0).min(js_round(offset * scale)), h)
}

type Placed = (Mark, f64, f64);

pub fn cluster_marks(marks: Vec<Mark>, place: impl Fn(&Mark) -> (f64, f64)) -> Vec<Cluster> {
    let mut lanes: Vec<(Lane, Vec<Placed>)> = Vec::new();
    for mark in marks {
        let lane = mark.kind.lane();
        let (y, h) = place(&mark);
        match lanes.iter_mut().find(|(l, _)| *l == lane) {
            Some((_, list)) => list.push((mark, y, h)),
            None => lanes.push((lane, vec![(mark, y, h)])),
        }
    }
    let mut clusters: Vec<Cluster> = Vec::new();
    for (lane, mut list) in lanes {
        list.sort_by(|a, b| a.1.total_cmp(&b.1));
        let mut current: Option<usize> = None;
        for (mark, y, h) in list {
            if let Some(index) = current
                && y <= clusters[index].y + clusters[index].h + 1.0
            {
                let cluster = &mut clusters[index];
                cluster.h = cluster.h.max(y + h - cluster.y);
                if mark.kind.loudness() > cluster.kind.loudness() {
                    cluster.kind = mark.kind;
                }
                cluster.marks.push(Member { mark, y });
                continue;
            }
            clusters.push(Cluster { lane, kind: mark.kind, y, h, marks: vec![Member { mark, y }] });
            current = Some(clusters.len() - 1);
        }
    }
    clusters
}

pub fn approval_cluster(rail_h: f64) -> Cluster {
    Cluster { lane: Lane::Full, kind: MarkKind::Approval, y: (rail_h - MIN_MARK).max(0.0), h: MIN_MARK, marks: Vec::new() }
}

pub fn build_clusters(input: &ScrubberInput, rail_h: f64) -> Vec<Cluster> {
    let scale = rail_scale(rail_h, input.book.total_height(), input.viewport_h);
    let mut clusters = cluster_marks(build_marks(input), |mark| place(mark, input, scale, rail_h));
    if input.pending_approvals > 0 {
        clusters.push(approval_cluster(rail_h));
    }
    clusters
}

// The cluster a finger at rail-local `x` (0 at the rail's left edge, negative left of it) and `y` presses: the nearest
// within `slop` vertically, a vertical miss weighing twice a lane miss. Lanes split `rail_w` in half.
pub fn cluster_at(clusters: &[Cluster], x: f64, y: f64, rail_w: f64, slop: f64) -> Option<usize> {
    let lane_w = rail_w / 2.0;
    let mut best: Option<(usize, f64)> = None;
    for (index, cluster) in clusters.iter().enumerate() {
        let (min_x, width) = match cluster.lane {
            Lane::Left => (0.0, lane_w),
            Lane::Right => (lane_w, lane_w),
            Lane::Full => (0.0, rail_w),
        };
        let lane_miss = if x < min_x { min_x - x } else { (x - min_x - width).max(0.0) };
        let vertical = if y < cluster.y { cluster.y - y } else { (y - cluster.y - cluster.h).max(0.0) };
        if vertical > slop {
            continue;
        }
        let distance = vertical * 2.0 + lane_miss;
        if best.is_none_or(|(_, d)| distance < d) {
            best = Some((index, distance));
        }
    }
    best.map(|(index, _)| index)
}

#[derive(Debug, Clone, PartialEq)]
pub struct PeekLine {
    pub glyph: Option<&'static str>,
    pub text: String,
    pub tone: Tone,
    pub excerpt: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Peek {
    pub title: String,
    pub lines: Vec<PeekLine>,
}

fn line(text: impl Into<String>, tone: Tone, excerpt: bool) -> PeekLine {
    PeekLine { glyph: None, text: text.into(), tone, excerpt }
}

pub fn done_line(item: &Item) -> Option<String> {
    match item {
        Item::TurnResult { subtype, is_error, duration_ms, total_cost_usd, .. } => Some(format!(
            "{} · {} · {}",
            if *is_error { &**subtype } else { "done" },
            fmt_duration(*duration_ms),
            fmt_cost(Some(*total_cost_usd))
        )),
        _ => None,
    }
}

pub fn excerpt(item: &Item) -> String {
    match item {
        Item::User { text, .. } | Item::AssistantText { text, .. } | Item::Thinking { text, .. } | Item::Notice { text, .. } => {
            text.to_string()
        }
        Item::Shell(shell) => shell.shell.get("command").and_then(Value::as_str).unwrap_or_default().to_owned(),
        Item::ToolCall(call) => format!("{}({})", call.name, tool_input_preview(&call.input, 80)),
        Item::TurnResult { .. } => done_line(item).unwrap_or_default(),
        Item::FileDelivered { path, .. } => path.to_string(),
        Item::Compaction(_) => String::new(),
    }
}

pub fn peek(cluster: &Cluster, first: Option<&Mark>, items: &[Item], approval: Option<&Value>, recap_label: Option<&str>) -> Peek {
    let more = if cluster.marks.len() > 1 { format!(" · {} marks", cluster.marks.len()) } else { String::new() };
    let kind = first.map_or(cluster.kind, |mark| mark.kind);
    let title = format!("{}{more}", kind.name());
    let mut lines = Vec::new();
    if cluster.kind == MarkKind::Approval {
        if let Some(request) = approval {
            let field = |key: &str| request.get(key).and_then(Value::as_str);
            let name = field("displayName").or(field("toolName")).unwrap_or_default();
            let input = request.get("input").cloned().unwrap_or(Value::Null);
            lines.push(line(permission_prompt_model(request).heading, Tone::Bright, false));
            lines.push(line(format!("{name}({})", tool_input_preview(&input, 80)), Tone::Fg, true));
        }
        return Peek { title, lines };
    }
    if kind == MarkKind::Recap {
        if let Some(label) = recap_label {
            lines.push(line(format!("※ {label}"), Tone::Faint, false));
        }
        return Peek { title, lines };
    }
    let Some(first) = first else {
        return Peek { title, lines };
    };
    let item = first.item_index.and_then(|index| items.get(index));
    if matches!(first.kind, MarkKind::Turn | MarkKind::TurnFailed) {
        if let Some(Item::AssistantText { text, .. } | Item::Thinking { text, addressed: true, .. }) = item {
            lines.push(PeekLine { glyph: Some("● "), ..line(text.to_string(), Tone::Fg, true) });
        }
        if let Some(turn @ Item::TurnResult { is_error, errors, .. }) = first.turn_index.and_then(|index| items.get(index)) {
            lines.push(line(done_line(turn).unwrap_or_default(), if *is_error { Tone::Red } else { Tone::Faint }, false));
            for message in errors.iter().flat_map(|errors| errors.iter()) {
                lines.push(line(message.clone(), Tone::Red, false));
            }
        }
        return Peek { title, lines };
    }
    let Some(item) = item else {
        return Peek { title, lines };
    };
    let alarm = matches!(first.kind, MarkKind::Error | MarkKind::ToolFailed);
    let glyph = (first.kind == MarkKind::User).then_some("❯ ");
    lines.push(PeekLine { glyph, ..line(excerpt(item), if alarm { Tone::Red } else { Tone::Fg }, true) });
    if first.kind == MarkKind::ToolFailed
        && let Item::ToolCall(call) = item
        && let Some(failure) = call.result.as_ref().and_then(|r| r.text.split('\n').find(|l| !l.trim().is_empty()))
    {
        lines.push(line(failure, Tone::Red, true));
    }
    Peek { title, lines }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::transcript::{ToolCall, ToolCallResult};
    use serde_json::json;
    use std::sync::Arc;

    fn failed_bash(text: &str) -> Item {
        Item::ToolCall(Arc::new(ToolCall {
            id: "t1".into(),
            name: "Bash".into(),
            title: None,
            input: Arc::new(json!({ "command": "pnpm test" })),
            parent_tool_use_id: None,
            status: ToolCallStatus::Failed,
            result: Some(ToolCallResult {
                text: text.into(),
                is_error: true,
                truncated: false,
                total_chars: None,
                source_seq: None,
                images: None,
            }),
            ts: None,
            live_tail: None,
            patch: None,
            execution_id: None,
            backend: None,
            logs: None,
        }))
    }

    fn mark(kind: MarkKind, item_index: Option<usize>, turn_index: Option<usize>) -> Mark {
        Mark { kind, item_index, row_index: 0, turn_index }
    }

    fn cluster(kind: MarkKind, marks: &[Mark]) -> Cluster {
        Cluster { lane: kind.lane(), kind, y: 0.0, h: 2.0, marks: marks.iter().map(|&mark| Member { mark, y: 0.0 }).collect() }
    }

    #[test]
    fn the_scale_never_stretches_a_short_transcript_over_the_rail() {
        assert_eq!(rail_scale(100.0, 50.0, 200.0), 0.5);
        assert_eq!(rail_scale(100.0, 0.0, 200.0), 0.0);
        assert_eq!(band(100.0, 50.0, 200.0, 0.0), Band { top: 0.0, h: 100.0 });
        assert_eq!(band(100.0, 1000.0, 100.0, 450.0), Band { top: 45.0, h: 10.0 });
        assert_eq!(band(100.0, 100_000.0, 100.0, 99_900.0), Band { top: 98.0, h: 2.0 });
    }

    #[test]
    fn a_short_transcript_rail_sits_at_the_foot() {
        assert_eq!(anchor_pad(100.0, 50.0, 200.0), 75.0);
        assert_eq!(anchor_pad(100.0, 300.0, 200.0), 0.0);
        assert_eq!(anchor_pad(100.0, 0.0, 200.0), 0.0);
    }

    #[test]
    fn a_scrub_centres_the_finger_and_stays_in_range() {
        assert_eq!(scrub_offset(0.5, 1000.0, 100.0), 450.0);
        assert_eq!(scrub_offset(0.0, 1000.0, 100.0), 0.0);
        assert_eq!(scrub_offset(1.0, 1000.0, 100.0), 900.0);
        assert_eq!(scrub_offset(0.7, 50.0, 100.0), 0.0);
    }

    #[test]
    fn a_failed_tool_peeks_its_first_said_line() {
        let items = [failed_bash("\n  \nError: 3 tests failed\nmore")];
        let first = mark(MarkKind::ToolFailed, Some(0), None);
        let peek = peek(&cluster(MarkKind::ToolFailed, &[first]), Some(&first), &items, None, None);
        assert_eq!(peek.title, "tool failed");
        let first = peek.lines.first().expect("line");
        assert_eq!((first.text.as_str(), first.tone), ("Bash(pnpm test)", Tone::Red));
        let failure = peek.lines.get(1).expect("failure");
        assert_eq!((failure.text.as_str(), failure.tone), ("Error: 3 tests failed", Tone::Red));
    }

    #[test]
    fn a_turn_peeks_its_answer_and_done_line() {
        let items = [
            Item::AssistantText { id: "a".into(), text: "All green.".into(), streaming: false, parent_tool_use_id: None },
            Item::TurnResult {
                id: "r".into(),
                subtype: "error_max_turns".into(),
                is_error: true,
                duration_ms: 1500.0,
                total_cost_usd: 0.25,
                cost_usd: None,
                errors: Some(Arc::new(vec!["out of turns".into()])),
            },
        ];
        let first = mark(MarkKind::TurnFailed, Some(0), Some(1));
        let peek = peek(&cluster(MarkKind::TurnFailed, &[first, mark(MarkKind::User, Some(0), None)]), Some(&first), &items, None, None);
        assert_eq!(peek.title, "turn failed · 2 marks");
        let lines: Vec<(&str, Option<&str>, Tone)> = peek.lines.iter().map(|l| (l.text.as_str(), l.glyph, l.tone)).collect();
        assert_eq!(
            lines,
            [("All green.", Some("● "), Tone::Fg), ("error_max_turns · 1.5s · $0.25", None, Tone::Red), ("out of turns", None, Tone::Red)]
        );
    }

    #[test]
    fn approval_and_recap_peek_without_a_mark() {
        let request = json!({ "id": "p", "toolName": "Bash", "input": { "command": "rm -rf build" } });
        let approval = peek(&approval_cluster(100.0), None, &[], Some(&request), None);
        assert_eq!(approval.title, "pending approval");
        assert_eq!(approval.lines.last().map(|l| l.text.as_str()), Some("Bash(rm -rf build)"));
        let recap = peek(&cluster(MarkKind::Recap, &[mark(MarkKind::Recap, None, None)]), None, &[], None, Some("3 turns"));
        assert_eq!(recap.lines.first().map(|l| l.text.as_str()), Some("※ 3 turns"));
    }

    #[test]
    fn a_press_finds_the_nearest_lane_within_slop() {
        let clusters = [
            Cluster { lane: Lane::Left, kind: MarkKind::User, y: 10.0, h: 2.0, marks: Vec::new() },
            Cluster { lane: Lane::Right, kind: MarkKind::Turn, y: 10.0, h: 2.0, marks: Vec::new() },
            Cluster { lane: Lane::Full, kind: MarkKind::Bookmark, y: 40.0, h: 2.0, marks: Vec::new() },
        ];
        assert_eq!(cluster_at(&clusters, 2.0, 11.0, 12.0, 8.0), Some(0));
        assert_eq!(cluster_at(&clusters, 10.0, 11.0, 12.0, 8.0), Some(1));
        assert_eq!(cluster_at(&clusters, -10.0, 16.0, 12.0, 8.0), Some(0));
        assert_eq!(cluster_at(&clusters, 6.0, 36.0, 12.0, 8.0), Some(2));
        assert_eq!(cluster_at(&clusters, 6.0, 25.0, 12.0, 8.0), None);
    }

    #[test]
    fn the_nearest_member_answers_a_tap() {
        let mut c = cluster(MarkKind::User, &[mark(MarkKind::User, Some(0), None), mark(MarkKind::Subagent, Some(4), None)]);
        c.marks[1].y = 20.0;
        assert_eq!(c.nearest_member(14.0).map(|m| m.kind), Some(MarkKind::Subagent));
        assert_eq!(c.nearest_member(9.0).map(|m| m.kind), Some(MarkKind::User));
    }
}
