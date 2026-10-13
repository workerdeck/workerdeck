use serde_json::json;
use std::path::Path;
use wd_native::controller::live::LiveSession;
use wd_native::planner::Metrics;
use wd_native::snapshot::{VERSION, shell_grid, transcript_layout, transcript_lines};

const METRICS: Metrics = Metrics { cell: 8.0, line: 16.0, width: 800.0, font_size: 13.0 };

struct Reader<'a> {
    bytes: &'a [u8],
    at: usize,
}

impl<'a> Reader<'a> {
    fn take(&mut self, n: usize) -> &'a [u8] {
        let slice = &self.bytes[self.at..self.at + n];
        self.at += n;
        slice
    }
    fn u8(&mut self) -> u8 {
        self.take(1)[0]
    }
    fn u16(&mut self) -> u16 {
        u16::from_le_bytes(self.take(2).try_into().unwrap())
    }
    fn u32(&mut self) -> u32 {
        u32::from_le_bytes(self.take(4).try_into().unwrap())
    }
    fn f32(&mut self) -> f32 {
        f32::from_le_bytes(self.take(4).try_into().unwrap())
    }
    fn str16(&mut self) -> String {
        let n = self.u16() as usize;
        String::from_utf8(self.take(n).to_vec()).unwrap()
    }
    fn str32(&mut self) -> String {
        let n = self.u32() as usize;
        String::from_utf8(self.take(n).to_vec()).unwrap()
    }
}

fn session() -> LiveSession {
    let mut live = LiveSession::new(0, true, "n".into(), METRICS);
    live.opened();
    live.received(
        &json!({"type": "attached", "protocolVersion": 1, "replayingFrom": 0, "acks": true,
            "session": {"id": "s1", "status": "running", "cwd": "/repo", "createdAt": 1, "lastSeq": 0, "pendingPermissionCount": 0}})
        .to_string(),
        0.0,
    );
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/conformance/subagent.events.jsonl");
    for line in std::fs::read_to_string(path).unwrap().lines().filter(|line| !line.is_empty()) {
        live.received(line, 0.0);
    }
    live.take_effects();
    live
}

#[test]
fn the_layout_carries_every_row_key_and_height_in_order() {
    let live = session();
    let view = live.view();
    let bytes = transcript_layout(view);
    let mut r = Reader { bytes: &bytes, at: 0 };
    assert_eq!(r.u8(), VERSION);
    assert_eq!(r.u32() as usize, view.rows().len());
    for index in 0..view.rows().len() {
        assert_eq!(r.str16(), view.rows().rows[index].key());
        assert_eq!(r.f32(), view.book().height(index) as f32);
        r.u8();
    }
    r.take(4 + 8);
    assert_eq!(r.at, bytes.len());
}

#[test]
fn lines_decode_to_the_planned_text_and_skip_nothing() {
    let live = session();
    let view = live.view();
    let rows = view.rows().len();
    let bytes = transcript_lines(view, 0, rows + 5);
    let mut r = Reader { bytes: &bytes, at: 0 };
    assert_eq!(r.u8(), VERSION);
    assert_eq!((r.u32(), r.u32() as usize), (0, rows));
    for index in 0..rows {
        let planned = view.plan(index);
        assert_eq!(r.u32() as usize, planned.len());
        for line in &planned {
            r.take(4);
            let flags = r.bytes[r.at - 1];
            r.take(4);
            assert_eq!(r.str16(), line.gutter);
            assert_eq!(r.str32(), line.text);
            let runs = r.u16() as usize;
            r.take(runs * 9);
            if flags & 0x80 != 0 {
                r.take(8);
            }
            if flags & 0x40 != 0 {
                r.str16();
                r.take(16);
                r.str16();
                r.take(8 + 2);
            }
        }
    }
    assert_eq!(r.at, bytes.len());
}

#[test]
fn the_shell_grid_reads_back_the_screen() {
    let mut live = session();
    live.open_shell("sh_1", None, 20, 4);
    live.received(
        &json!({"type": "shell_attached", "shellId": "sh_1", "cols": 20, "rows": 4, "scrollback": "hello\r\nworld",
            "shell": {"id": "sh_1", "sessionId": "s1", "ordinal": 2, "command": "bash", "label": "bash", "cwd": "/repo",
                "owner": "user", "status": "running", "startedAt": 1, "bytes": 0, "cols": 20, "rows": 4}})
        .to_string(),
        0.0,
    );
    let shell = live.shell("sh_1").unwrap();
    let bytes = shell_grid(shell, 0, 100);
    let mut r = Reader { bytes: &bytes, at: 0 };
    assert_eq!(r.u8(), VERSION);
    r.take(8);
    assert_eq!((r.u16(), r.u16(), r.u32()), (20, 4, 4));
    assert_eq!((r.u16(), r.u16()), (1, 5));
    assert_eq!(r.u8() & 0b1101, 0b1101);
    assert_eq!((r.str16(), r.str16()), ("#2 bash".to_owned(), "running".to_owned()));
    assert_eq!((r.u32(), r.u32()), (0, 4));
    let mut text = Vec::new();
    for _ in 0..4 {
        let runs = r.u16();
        let mut line = String::new();
        for _ in 0..runs {
            r.take(9);
            line.push_str(&r.str32());
        }
        text.push(line.trim_end().to_owned());
    }
    assert_eq!(text, ["hello", "world", "", ""]);
    assert_eq!(r.at, bytes.len());
}
