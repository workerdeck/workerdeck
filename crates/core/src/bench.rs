use crate::engine::Engine;
use crate::vt::VtScreen;
use std::collections::BTreeMap;
use std::time::Instant;

pub const STREAM_TAIL: usize = 2000;
pub const VISIBLE_LINES: usize = 60;

enum J {
    Num(f64),
    Str(String),
    Obj(BTreeMap<&'static str, J>),
}

fn write_json(j: &J, out: &mut String) {
    match j {
        J::Num(v) => {
            if v.fract() == 0.0 && v.abs() < 1e15 {
                out.push_str(&(*v as i64).to_string());
            } else {
                out.push_str(&v.to_string());
            }
        }
        J::Str(s) => {
            out.push('"');
            out.push_str(s);
            out.push('"');
        }
        J::Obj(map) => {
            out.push('{');
            for (i, (k, v)) in map.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                out.push('"');
                out.push_str(k);
                out.push_str("\":");
                write_json(v, out);
            }
            out.push('}');
        }
    }
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

fn ms(since: Instant) -> f64 {
    round1(since.elapsed().as_nanos() as f64 / 1_000_000.0)
}

fn percentiles(values: &[f64]) -> J {
    let mut sorted = values.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let at = |p: f64| {
        if sorted.is_empty() { 0.0 } else { round1(sorted[(sorted.len() - 1).min((sorted.len() as f64 * p) as usize)]) }
    };
    let mut m = BTreeMap::new();
    m.insert("p50", J::Num(at(0.5)));
    m.insert("p95", J::Num(at(0.95)));
    m.insert("p99", J::Num(at(0.99)));
    m.insert("max", J::Num(round1(sorted.last().copied().unwrap_or(0.0))));
    J::Obj(m)
}

pub fn split_lines(data: &[u8]) -> Vec<&[u8]> {
    data.split(|&b| b == b'\n').filter(|l| !l.is_empty()).collect()
}

pub fn chunked(text: &str, size: usize) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0usize;
    let mut count = 0usize;
    for (i, c) in text.char_indices() {
        count += 1;
        if count >= size {
            let end = i + c.len_utf8();
            out.push(&text[start..end]);
            start = end;
            count = 0;
        }
    }
    if start < text.len() {
        out.push(&text[start..]);
    }
    out
}

pub fn run(session_path: &str, shell_path: &str) -> String {
    let (Ok(session), Ok(shell)) = (std::fs::read(session_path), std::fs::read_to_string(shell_path)) else {
        return r#"{"error":"fixtures not found"}"#.into();
    };
    let mut result: BTreeMap<&'static str, J> = BTreeMap::new();
    result.insert("arm", J::Str("rust".into()));

    let lines = split_lines(&session);
    let split = lines.len().saturating_sub(STREAM_TAIL);
    let (replay, tail) = lines.split_at(split);
    let mut engine = Engine::default();

    let t0 = Instant::now();
    for line in replay {
        engine.ingest_line(line);
    }
    result.insert("w1_replay_ms", J::Num(ms(t0)));
    result.insert("w1_frames", J::Num(replay.len() as f64));
    result.insert("items", J::Num(engine.item_count() as f64));

    let t1 = Instant::now();
    engine.layout();
    result.insert("w2_cold_layout_ms", J::Num(ms(t1)));
    result.insert("rows", J::Num(engine.rows.len() as f64));

    let mut per_frame = Vec::with_capacity(tail.len());
    let mut ingest_only = Vec::with_capacity(tail.len());
    let mut rows_only = Vec::with_capacity(tail.len());
    let mut book_only = Vec::with_capacity(tail.len());
    let mut snap_only = Vec::with_capacity(tail.len());
    let mut bytes = 0usize;
    for line in tail {
        let a = Instant::now();
        engine.ingest_line(line);
        let b = Instant::now();
        let (r, k) = engine.layout_timed();
        rows_only.push(r);
        book_only.push(k);
        let c = Instant::now();
        let snap = engine.snapshot(VISIBLE_LINES);
        snap_only.push(c.elapsed().as_nanos() as f64 / 1000.0);
        bytes += snap.len();
        per_frame.push(a.elapsed().as_nanos() as f64 / 1000.0);
        ingest_only.push((b - a).as_nanos() as f64 / 1000.0);
    }
    result.insert("w3_stream_us", percentiles(&per_frame));
    result.insert("w3_ingest_us", percentiles(&ingest_only));
    result.insert("w3x_rows_us", percentiles(&rows_only));
    result.insert("w3x_book_us", percentiles(&book_only));
    result.insert("w3x_snapshot_us", percentiles(&snap_only));
    result.insert("w3_snapshot_bytes_avg", J::Num((bytes / tail.len().max(1)) as f64));

    let chunks = chunked(&shell, 4096);
    let reps = 10;
    let mut vt = VtScreen::new(120, 40, 1000);
    let t3 = Instant::now();
    for _ in 0..reps {
        for chunk in &chunks {
            vt.feed(chunk);
        }
    }
    let vt_ms = ms(t3);
    let mb = (shell.len() * reps) as f64 / 1_048_576.0;
    result.insert("w4_vt_mb_per_s", J::Num(round1(mb / (vt_ms / 1000.0))));

    for chunk in &chunks {
        engine.vt.feed(chunk);
    }
    let mut vt_snaps = Vec::with_capacity(200);
    for _ in 0..200 {
        let a = Instant::now();
        let snap = engine.vt_snapshot();
        std::hint::black_box(&snap);
        vt_snaps.push(a.elapsed().as_nanos() as f64 / 1000.0);
    }
    result.insert("w4_vt_snapshot_us", percentiles(&vt_snaps));

    let mut out = String::new();
    write_json(&J::Obj(result), &mut out);
    out
}

pub fn dump(session_path: &str) -> String {
    let Ok(session) = std::fs::read(session_path) else {
        return String::new();
    };
    let mut engine = Engine::default();
    for line in split_lines(&session) {
        engine.ingest_line(line);
    }
    engine.layout();
    let mut out = String::new();
    for row in &engine.rows.rows {
        for line in crate::planner::plan(row, &engine.metrics) {
            out.push_str(&line.gutter);
            out.push('|');
            out.push_str(&line.text);
            out.push('\n');
        }
    }
    out
}

pub fn dump_vt(shell_path: &str) -> String {
    let Ok(shell) = std::fs::read_to_string(shell_path) else {
        return String::new();
    };
    let mut vt = VtScreen::new(120, 40, 1000);
    for chunk in chunked(&shell, 4096) {
        vt.feed(chunk);
    }
    let mut out = String::new();
    for index in 0..vt.total_rows() {
        let line = vt.line(index);
        let mut text = String::new();
        for cell in line.iter().filter(|c| !c.continuation) {
            match &cell.text {
                crate::vt::CellText::None => text.push(' '),
                crate::vt::CellText::Char(c) => text.push(*c),
                crate::vt::CellText::Cluster(s) => text.push_str(s),
            }
        }
        out.push_str(text.trim_end_matches(' '));
        out.push('\n');
    }
    out
}

const ATTACHED: &str = r#"{"type":"attached","protocolVersion":2,"replayingFrom":0,"session":{"id":"s1","status":"running","cwd":"/w","createdAt":1,"lastSeq":0,"pendingPermissionCount":0}}"#;
const VISIBLE_ROWS: usize = 20;

// The FFI workload without the FFI: what `LiveSession` itself costs per frame, so a device run can tell binding
// overhead from core cost.
pub fn run_live(session_path: &str) -> String {
    use crate::controller::live::{Effect, LiveSession};
    use crate::planner::Metrics;
    use crate::snapshot::{transcript_layout, transcript_lines};
    let data = std::fs::read_to_string(session_path).expect("fixture");
    let lines: Vec<&str> = data.lines().filter(|line| !line.is_empty()).collect();
    let (replay, tail) = lines.split_at(lines.len() - STREAM_TAIL);
    let mut live = LiveSession::new(0, true, "bench".into(), Metrics { cell: 19.8, line: 44.0, width: 1080.0, font_size: 32.0 }, None);
    live.opened();
    live.received(ATTACHED, 0.0);
    live.take_effects();
    let t = Instant::now();
    for line in replay {
        live.received(line, 0.0);
    }
    live.take_effects();
    let replay_ms = t.elapsed().as_secs_f64() * 1e3;
    let (mut frame, mut ingest, mut snap) = (Vec::new(), Vec::new(), Vec::new());
    for line in tail {
        let a = Instant::now();
        live.received(line, 0.0);
        let effects = live.take_effects();
        let b = Instant::now();
        if effects.iter().any(|e| matches!(e, Effect::Changed(c) if c.transcript)) {
            let rows = live.view().rows().len();
            let _ = transcript_layout(live.view());
            let _ = transcript_lines(live.view(), rows.saturating_sub(VISIBLE_ROWS), rows);
        }
        let c = Instant::now();
        frame.push((c - a).as_secs_f64() * 1e6);
        ingest.push((b - a).as_secs_f64() * 1e6);
        snap.push((c - b).as_secs_f64() * 1e6);
    }
    let mut out = BTreeMap::new();
    out.insert("replay_ms", J::Num((replay_ms * 10.0).round() / 10.0));
    out.insert("frame_us", percentiles(&frame));
    out.insert("ingest_us", percentiles(&ingest));
    out.insert("snapshot_us", percentiles(&snap));
    let mut s = String::new();
    write_json(&J::Obj(out), &mut s);
    s
}
