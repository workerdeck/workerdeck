use crate::rest::SessionStatus;
use crate::vm::session_list::{SessionRow, SessionState};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use std::collections::HashMap;

pub const FACE_SWATCHES: [&str; 12] =
    ["blue", "indigo", "violet", "rose", "coral", "copper", "amber", "olive", "green", "mint", "teal", "steel"];
pub const FACE_TONES: [&str; 7] = ["wash", "base", "deep", "soft", "glow", "screen", "ink"];
pub const CONTEXT_WRAP_UP_DEFAULT: f64 = 0.4;

const PROJECT_SWATCHES: [&str; 8] = ["blue", "violet", "green", "copper", "rose", "teal", "olive", "indigo"];
const TILE_KINDS: [&str; 3] = ["soft", "squircle", "boxy"];
const ANTENNA_KINDS: [&str; 6] = ["none", "ball", "triangle", "square", "diamond", "twin"];
const VISOR_KINDS: [&str; 3] = ["none", "band", "inset"];
const EYES_KINDS: [&str; 4] = ["bar", "split", "segments", "slit"];
const MOUTH_KINDS: [&str; 4] = ["none", "grill", "vent", "speaker"];
const BLINK_SAMPLES: usize = 1000;
const MOTION_SAMPLES: usize = 240;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FaceLayer {
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct FaceTile {
    pub shape: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct ResolvedFace {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub backdrop: Option<String>,
    pub tile: FaceTile,
    pub antenna: FaceLayer,
    pub visor: FaceLayer,
    pub eyes: FaceLayer,
    pub mouth: FaceLayer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FaceState {
    Idle,
    Asleep,
    Starting,
    Working,
    Attention,
    Failed,
    Closed,
}

impl FaceState {
    fn name(self) -> &'static str {
        match self {
            FaceState::Idle => "idle",
            FaceState::Asleep => "asleep",
            FaceState::Starting => "starting",
            FaceState::Working => "working",
            FaceState::Attention => "attention",
            FaceState::Failed => "failed",
            FaceState::Closed => "closed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FaceTheme {
    Dark,
    Light,
}

pub fn fnv1a(key: &str) -> u32 {
    key.encode_utf16().fold(0x811c_9dc5u32, |hash, unit| (hash ^ unit as u32).wrapping_mul(0x0100_0193))
}

pub fn project_swatch(key: &str) -> &'static str {
    PROJECT_SWATCHES[(fnv1a(key) as usize) % PROJECT_SWATCHES.len()]
}

pub fn face_project_of(info: &crate::rest::SessionInfo) -> &'static str {
    project_swatch(info.project.as_ref().map(|p| p.root.as_str()).unwrap_or(&info.cwd))
}

fn is_swatch(name: &str) -> bool {
    FACE_SWATCHES.contains(&name)
}

fn is_tone(name: &str) -> bool {
    FACE_TONES.contains(&name)
}

fn known(kinds: &[&str], kind: Option<&Value>, fallback: &str) -> String {
    kind.and_then(Value::as_str).filter(|k| kinds.contains(k)).unwrap_or(fallback).to_owned()
}

fn color_of(slot: Option<&Value>) -> Option<String> {
    slot.and_then(|s| s.get("color")).and_then(Value::as_str).map(str::to_owned)
}

pub fn resolve_agent_face(face: Option<&Value>) -> ResolvedFace {
    let f = face.filter(|v| v.is_object());
    let slot = |name: &str| f.and_then(|f| f.get(name));
    let layer = |name: &str, kinds: &[&str], fallback: &str| {
        let held = slot(name).filter(|v| v.is_object());
        FaceLayer { kind: known(kinds, held.and_then(|h| h.get("kind")), fallback), color: color_of(held) }
    };
    ResolvedFace {
        backdrop: color_of(slot("backdrop")),
        tile: FaceTile { shape: known(&TILE_KINDS, slot("tile").and_then(|t| t.get("shape")), "soft"), color: color_of(slot("tile")) },
        antenna: layer("antenna", &ANTENNA_KINDS, "none"),
        visor: layer("visor", &VISOR_KINDS, "none"),
        eyes: layer("eyes", &EYES_KINDS, "bar"),
        mouth: layer("mouth", &MOUTH_KINDS, "none"),
    }
}

pub fn face_state_of(row: &SessionRow, state: Option<SessionState>) -> FaceState {
    let info = &row.info;
    match state.unwrap_or(row.state) {
        SessionState::Attention => FaceState::Attention,
        SessionState::Ended if info.status == SessionStatus::Failed => FaceState::Failed,
        SessionState::Ended => FaceState::Closed,
        SessionState::Working if info.status == SessionStatus::Starting => FaceState::Starting,
        SessionState::Working => FaceState::Working,
        SessionState::Idle if info.engine_asleep == Some(true) => FaceState::Asleep,
        SessionState::Idle => FaceState::Idle,
    }
}

fn hue(swatch: &str) -> f64 {
    match swatch {
        "indigo" => 278.0,
        "violet" => 302.0,
        "rose" => 355.0,
        "coral" => 32.0,
        "copper" => 58.0,
        "amber" => 82.0,
        "olive" => 120.0,
        "green" => 152.0,
        "mint" => 174.0,
        "teal" => 205.0,
        _ => 250.0,
    }
}

fn tone_values(theme: FaceTheme, tone: &str) -> (f64, f64) {
    match (theme, tone) {
        (FaceTheme::Dark, "wash") => (0.34, 0.05),
        (FaceTheme::Dark, "base") => (0.64, 0.095),
        (FaceTheme::Dark, "deep") => (0.48, 0.08),
        (FaceTheme::Dark, "soft") => (0.82, 0.05),
        (FaceTheme::Dark, "glow") => (0.86, 0.15),
        (FaceTheme::Dark, "screen") => (0.25, 0.025),
        (FaceTheme::Dark, _) => (0.23, 0.03),
        (FaceTheme::Light, "wash") => (0.91, 0.045),
        (FaceTheme::Light, "base") => (0.7, 0.11),
        (FaceTheme::Light, "deep") => (0.54, 0.1),
        (FaceTheme::Light, "soft") => (0.93, 0.04),
        (FaceTheme::Light, "glow") => (0.8, 0.16),
        (FaceTheme::Light, "screen") => (0.3, 0.03),
        (FaceTheme::Light, _) => (0.27, 0.035),
    }
}

fn overlay_color(theme: FaceTheme, name: &str) -> &'static str {
    match (theme, name) {
        (FaceTheme::Dark, "bubble") => "#f5a623",
        (FaceTheme::Dark, "danger") => "#f14c4c",
        (FaceTheme::Dark, "zz") => "#aab3c4",
        (FaceTheme::Dark, "spark") => "#ffd66b",
        (FaceTheme::Light, "bubble") => "#f0a020",
        (FaceTheme::Light, "danger") => "#d93036",
        (FaceTheme::Light, "zz") => "#7d8799",
        (FaceTheme::Light, "spark") => "#e0a91c",
        _ => "#1a1c22",
    }
}

fn fixed(value: f64, digits: usize) -> f64 {
    format!("{value:.digits$}").parse().unwrap_or(value)
}

#[derive(Debug, Clone, PartialEq)]
pub enum Paint {
    None,
    Oklch(f64, f64, f64),
    Hex(String),
}

impl Paint {
    fn tone(swatch: &str, tone: &str, theme: FaceTheme) -> Paint {
        let (l, c) = tone_values(theme, tone);
        Paint::Oklch(l, fixed(if swatch == "steel" { c * 0.18 } else { c }, 3), hue(swatch))
    }

    fn to_json(&self) -> Value {
        match self {
            Paint::None => json!("none"),
            Paint::Oklch(l, c, h) => json!(format!("oklch({l} {c:.3} {h})")),
            Paint::Hex(hex) => json!(hex),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub enum Seg {
    M(f64, f64),
    L(f64, f64),
    Q(f64, f64, f64, f64),
    Z,
}

impl Seg {
    fn to_json(self) -> Value {
        match self {
            Seg::M(x, y) => json!(["M", x, y]),
            Seg::L(x, y) => json!(["L", x, y]),
            Seg::Q(cx, cy, x, y) => json!(["Q", cx, cy, x, y]),
            Seg::Z => json!(["Z"]),
        }
    }
}

fn path_numbers(body: &str) -> Vec<f64> {
    let mut out = Vec::new();
    let bytes = body.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let start = i;
        if bytes[i] == b'-' {
            i += 1;
        }
        let digits = i;
        let mut dot = false;
        while i < bytes.len() && (bytes[i].is_ascii_digit() || (bytes[i] == b'.' && !dot)) {
            dot |= bytes[i] == b'.';
            i += 1;
        }
        if i > digits {
            out.extend(body[start..i].parse::<f64>().ok());
        } else {
            i = start + 1;
        }
    }
    out
}

pub fn absolute_path(d: &str) -> Vec<Seg> {
    let mut out = Vec::new();
    let (mut x, mut y, mut sx, mut sy) = (0.0, 0.0, 0.0, 0.0);
    let mut control: Option<(f64, f64)> = None;
    let starts: Vec<usize> = d.char_indices().filter(|(_, c)| "MmLlHhVvQqTtZz".contains(*c)).map(|(i, _)| i).collect();
    for (index, &at) in starts.iter().enumerate() {
        let op = d.as_bytes()[at] as char;
        let n = path_numbers(&d[at + 1..starts.get(index + 1).copied().unwrap_or(d.len())]);
        let rel = op.is_ascii_lowercase();
        let upper = op.to_ascii_uppercase();
        if upper == 'Z' {
            out.push(Seg::Z);
            (x, y) = (sx, sy);
            control = None;
            continue;
        }
        let step = match upper {
            'H' | 'V' => 1,
            'Q' => 4,
            _ => 2,
        };
        for (i, a) in n.chunks(step).enumerate() {
            if a.len() < step {
                break;
            }
            match upper {
                'H' => {
                    x = if rel { x + a[0] } else { a[0] };
                    out.push(Seg::L(x, y));
                    control = None;
                }
                'V' => {
                    y = if rel { y + a[0] } else { a[0] };
                    out.push(Seg::L(x, y));
                    control = None;
                }
                'Q' => {
                    let c = if rel { (x + a[0], y + a[1]) } else { (a[0], a[1]) };
                    (x, y) = if rel { (x + a[2], y + a[3]) } else { (a[2], a[3]) };
                    out.push(Seg::Q(c.0, c.1, x, y));
                    control = Some(c);
                }
                'T' => {
                    let c = control.map_or((x, y), |(cx, cy)| (2.0 * x - cx, 2.0 * y - cy));
                    (x, y) = if rel { (x + a[0], y + a[1]) } else { (a[0], a[1]) };
                    out.push(Seg::Q(c.0, c.1, x, y));
                    control = Some(c);
                }
                _ => {
                    (x, y) = if rel { (x + a[0], y + a[1]) } else { (a[0], a[1]) };
                    let r#move = upper == 'M' && i == 0;
                    out.push(if r#move { Seg::M(x, y) } else { Seg::L(x, y) });
                    if r#move {
                        (sx, sy) = (x, y);
                    }
                    control = None;
                }
            }
        }
    }
    out
}

#[derive(Debug, Clone, PartialEq)]
pub enum Attr {
    Num(f64),
    Str(String),
    Paint(Paint),
    Path(Vec<Seg>),
    Style(Vec<(&'static str, f64)>),
}

impl From<f64> for Attr {
    fn from(value: f64) -> Self {
        Attr::Num(value)
    }
}

impl From<&str> for Attr {
    fn from(value: &str) -> Self {
        Attr::Str(value.to_owned())
    }
}

impl From<String> for Attr {
    fn from(value: String) -> Self {
        Attr::Str(value)
    }
}

impl From<Paint> for Attr {
    fn from(value: Paint) -> Self {
        Attr::Paint(value)
    }
}

#[derive(Debug, Clone, PartialEq)]
pub struct FaceNode {
    pub tag: &'static str,
    pub attrs: Vec<(&'static str, Attr)>,
    pub children: Vec<FaceNode>,
}

impl FaceNode {
    fn attr(&self, name: &str) -> Option<&Attr> {
        self.attrs.iter().find(|(k, _)| *k == name).map(|(_, v)| v)
    }

    fn num(&self, name: &str) -> f64 {
        match self.attr(name) {
            Some(Attr::Num(n)) => *n,
            _ => 0.0,
        }
    }

    fn str(&self, name: &str) -> Option<&str> {
        match self.attr(name) {
            Some(Attr::Str(s)) => Some(s),
            _ => None,
        }
    }

    pub fn to_json(&self) -> Value {
        let attrs: Map<String, Value> = self
            .attrs
            .iter()
            .map(|(k, v)| {
                let value = match v {
                    Attr::Num(n) => json!(n),
                    Attr::Str(s) => json!(s),
                    Attr::Paint(p) => p.to_json(),
                    Attr::Path(segs) => Value::Array(segs.iter().map(|s| s.to_json()).collect()),
                    Attr::Style(decls) => Value::Object(decls.iter().map(|(k, v)| ((*k).to_owned(), json!(v))).collect()),
                };
                ((*k).to_owned(), value)
            })
            .collect();
        json!({ "tag": self.tag, "attrs": attrs, "children": self.children.iter().map(FaceNode::to_json).collect::<Vec<_>>() })
    }
}

fn el(tag: &'static str, attrs: Vec<(&'static str, Attr)>, children: Vec<FaceNode>) -> FaceNode {
    FaceNode { tag, attrs, children }
}

fn rect(attrs: Vec<(&'static str, Attr)>) -> FaceNode {
    el("rect", attrs, Vec::new())
}

fn path(attrs: Vec<(&'static str, Attr)>) -> FaceNode {
    el("path", attrs, Vec::new())
}

fn a(name: &'static str, value: impl Into<Attr>) -> (&'static str, Attr) {
    (name, value.into())
}

fn d(value: &str) -> (&'static str, Attr) {
    ("d", Attr::Path(absolute_path(value)))
}

fn rr(x: f64, y: f64, w: f64, h: f64, rx: f64) -> Vec<(&'static str, Attr)> {
    vec![a("x", x), a("y", y), a("width", w), a("height", h), a("rx", rx)]
}

fn with(mut attrs: Vec<(&'static str, Attr)>, more: Vec<(&'static str, Attr)>) -> Vec<(&'static str, Attr)> {
    attrs.extend(more);
    attrs
}

pub struct FaceOptions<'a> {
    pub face: &'a ResolvedFace,
    pub project: &'a str,
    pub state: FaceState,
    pub size: f64,
    pub id: &'a str,
    pub context: Option<f64>,
    pub threshold: Option<f64>,
    pub phase: Option<&'a str>,
    pub theme: FaceTheme,
}

pub fn face_radius_px(size: f64) -> f64 {
    if size == 40.0 || size == 32.0 { 4.0 } else { size * 0.1 }
}

fn wave_top(amp: f64) -> String {
    format!("M-8 0 q2 {} 4 0 t4 0{}", -amp, " t4 0".repeat(12))
}

fn phase_delay(phase: Option<&str>) -> f64 {
    phase.map_or(0.0, |p| -((fnv1a(p) % 7000) as f64) / 1000.0)
}

pub fn face_tree(o: &FaceOptions) -> FaceNode {
    let face = o.face;
    let theme = o.theme;
    let state = o.state;
    let color = |r: Option<&str>, tone: &str| -> Paint {
        let mut parts = r.unwrap_or("project").split('/');
        let name = parts.next().unwrap_or_default();
        let own = parts.next().unwrap_or_default();
        Paint::tone(if is_swatch(name) { name } else { o.project }, if is_tone(own) { own } else { tone }, theme)
    };
    let swatch_tone = |r: Option<&str>, tone: &str| color(Some(r.unwrap_or("project").split('/').next().unwrap_or_default()), tone);
    let overlay = |name: &str| Paint::Hex(overlay_color(theme, name).to_owned());
    let rx = fixed((face_radius_px(o.size) * 32.0) / o.size, 2);
    let small = o.size < 24.0;
    let pose = match state {
        FaceState::Asleep | FaceState::Closed => "closed",
        FaceState::Failed => "x",
        _ => "open",
    };
    let tile_color = face.tile.color.as_deref();
    let radius = match face.tile.shape.as_str() {
        "squircle" => 9.0,
        "boxy" => 3.5,
        _ => 6.0,
    };
    let tile = |more: Vec<(&'static str, Attr)>| rect(with(rr(3.0, 5.0, 26.0, 24.0, radius), more));
    let id = |suffix: &str| format!("{}-{suffix}", o.id);
    let url = |suffix: &str| format!("url(#{}-{suffix})", o.id);

    let antenna = || -> Vec<FaceNode> {
        let r = face.antenna.color.as_deref();
        let deep = swatch_tone(r, "deep");
        let glow = swatch_tone(r, "glow");
        let stem = || rect(with(rr(15.2, 1.5, 1.6, 5.0, 0.8), vec![a("fill", deep.clone())]));
        let led =
            |x: f64, y: f64, s: f64, rx: f64| rect(with(vec![a("class", "led")], with(rr(x, y, s, s, rx), vec![a("fill", glow.clone())])));
        match face.antenna.kind.as_str() {
            "ball" => vec![stem(), led(13.5, -1.0, 5.0, 2.5)],
            "square" => vec![stem(), led(13.7, -0.8, 4.6, 1.1)],
            "diamond" => vec![stem(), el("g", vec![a("transform", "rotate(45 16 1.5)")], vec![led(13.9, -0.6, 4.2, 1.0)])],
            "triangle" => vec![
                stem(),
                path(vec![
                    a("class", "led"),
                    d("M16 -1.2L19 3.4H13Z"),
                    a("fill", glow.clone()),
                    a("stroke", glow.clone()),
                    a("stroke-width", 1.4),
                    a("stroke-linejoin", "round"),
                ]),
            ],
            "twin" => [10.5, 21.5]
                .into_iter()
                .flat_map(|x: f64| {
                    [rect(with(rr(x - 0.7, 1.8, 1.4, 4.5, 0.7), vec![a("fill", deep.clone())])), led(x - 2.0, -0.6, 4.0, 2.0)]
                })
                .collect(),
            _ => Vec::new(),
        }
    };

    let visor = || -> Vec<FaceNode> {
        let fill = color(face.visor.color.as_deref(), "screen");
        match face.visor.kind.as_str() {
            "band" => vec![rect(vec![a("x", 0.0), a("y", 11.5), a("width", 32.0), a("height", 10.0), a("fill", fill)])],
            "inset" => vec![rect(with(rr(6.0, 11.0, 20.0, 11.0, 4.5), vec![a("fill", fill)]))],
            _ => Vec::new(),
        }
    };

    let eyes = || -> Vec<FaceNode> {
        let fill = color(face.eyes.color.as_deref(), "glow");
        if pose == "closed" {
            return vec![rect(with(rr(9.0, 16.0, 14.0, 1.4, 0.7), vec![a("fill", fill), a("opacity", 0.5)]))];
        }
        if pose == "x" {
            return [11.0, 21.0]
                .into_iter()
                .map(|x: f64| {
                    path(vec![
                        d(&format!("M{} 14.8l3.4 3.4M{} 14.8l-3.4 3.4", x - 1.7, x + 1.7)),
                        a("stroke", overlay("danger")),
                        a("stroke-width", 1.6),
                        a("stroke-linecap", "round"),
                    ])
                })
                .collect();
        }
        let painted = |shape: Vec<[f64; 5]>| -> Vec<FaceNode> {
            let shapes = || shape.iter().map(|&[x, y, w, h, r]| rr(x, y, w, h, r));
            let mut out: Vec<FaceNode> = shapes().map(|attrs| rect(with(attrs, vec![a("fill", fill.clone())]))).collect();
            if state == FaceState::Working {
                out.push(el("clipPath", vec![a("id", id("v"))], shapes().map(rect).collect()));
                out.push(el(
                    "g",
                    vec![a("clip-path", url("v"))],
                    vec![rect(vec![
                        a("class", "glint"),
                        a("x", 14.0),
                        a("y", 13.0),
                        a("width", 3.0),
                        a("height", 7.0),
                        a("fill", Paint::Hex("#ffffff".into())),
                        a("opacity", 0.6),
                    ])],
                ));
            }
            out
        };
        match face.eyes.kind.as_str() {
            "split" => painted(vec![[8.0, 14.3, 6.6, 4.4, 2.2], [17.4, 14.3, 6.6, 4.4, 2.2]]),
            "slit" => painted(vec![[7.0, 15.4, 18.0, 2.2, 1.1]]),
            "segments" => (0..4)
                .map(|i| {
                    let i = i as f64;
                    rect(with(
                        vec![a("class", "seg"), ("style", Attr::Style(vec![("--i", i)]))],
                        with(rr(8.1 + i * 4.2, 14.3, 3.2, 4.4, 1.3), vec![a("fill", fill.clone())]),
                    ))
                })
                .collect(),
            _ => painted(vec![[8.0, 14.3, 16.0, 4.4, 2.2]]),
        }
    };

    let mouth = || -> Vec<FaceNode> {
        let r = face.mouth.color.as_deref();
        let fill = color(r, "glow");
        let screen = swatch_tone(r, "screen");
        let slots = |body: [f64; 5], xs: &[f64], slot: [f64; 4], dx: f64| -> Vec<FaceNode> {
            let [x, y, w, h, rx] = body;
            std::iter::once(rect(with(rr(x, y, w, h, rx), vec![a("fill", screen.clone())])))
                .chain(xs.iter().map(|&x| {
                    let [y, w, h, rx] = slot;
                    rect(with(rr(x - dx, y, w, h, rx), vec![a("fill", fill.clone()), a("opacity", 0.85)]))
                }))
                .collect()
        };
        match face.mouth.kind.as_str() {
            "grill" => slots([11.5, 22.6, 9.0, 3.4, 1.2], &[13.4, 15.55, 17.7], [23.3, 0.9, 2.0, 0.45], 0.0),
            "vent" => slots([10.5, 22.8, 11.0, 3.0, 1.5], &[12.3, 14.2, 16.1, 18.0, 19.9], [23.6, 0.6, 1.4, 0.3], 0.3),
            "speaker" => [11.5, 14.5, 17.5, 20.5]
                .into_iter()
                .map(|x: f64| rect(with(rr(x - 0.9, 23.2, 1.8, 1.8, 0.9), vec![a("fill", screen.clone())])))
                .collect(),
            _ => Vec::new(),
        }
    };

    let status_overlay = || -> Vec<FaceNode> {
        match state {
            FaceState::Asleep => vec![el(
                "g",
                vec![
                    a("fill", Paint::None),
                    a("stroke", overlay("zz")),
                    a("stroke-width", 1.3),
                    a("stroke-linecap", "round"),
                    a("stroke-linejoin", "round"),
                ],
                vec![
                    path(vec![a("class", "z1"), d("M24 2.2h3.2l-3.2 3.4h3.2")]),
                    path(vec![a("class", "z2"), d("M28.4 -2.4h2.6l-2.6 2.8h2.6")]),
                ],
            )],
            FaceState::Attention => vec![el(
                "g",
                vec![a("class", "bubble")],
                vec![
                    rect(with(rr(20.5, -3.5, 12.5, 10.0, 5.0), vec![a("fill", overlay("bubble"))])),
                    path(vec![d("M22.6 5.4l-1.6 3.1 4.1-2.4z"), a("fill", overlay("bubble"))]),
                    rect(with(rr(26.0, -1.6, 1.6, 4.2, 0.8), vec![a("fill", overlay("ink"))])),
                    rect(with(rr(26.0, 3.3, 1.6, 1.6, 0.8), vec![a("fill", overlay("ink"))])),
                ],
            )],
            FaceState::Failed => vec![
                rect(with(rr(23.5, 23.5, 9.5, 9.5, 4.75), vec![a("fill", overlay("danger"))])),
                rect(with(rr(27.55, 25.4, 1.4, 3.6, 0.7), vec![a("fill", Paint::Hex("#fff".into()))])),
                rect(with(rr(27.55, 29.7, 1.4, 1.4, 0.7), vec![a("fill", Paint::Hex("#fff".into()))])),
            ],
            FaceState::Starting => {
                vec![path(vec![a("class", "spark"), d("M28 -1.5l1 2.6 2.6 1-2.6 1-1 2.6-1-2.6-2.6-1 2.6-1z"), a("fill", overlay("spark"))])]
            }
            FaceState::Working => vec![el(
                "g",
                Vec::new(),
                std::iter::once(rect(with(rr(20.0, -3.0, 12.0, 7.0, 3.5), vec![a("fill", color(Some("steel"), "screen"))])))
                    .chain([22.2, 25.1, 28.0].into_iter().map(|x: f64| {
                        rect(with(vec![a("class", "dot")], with(rr(x, -0.3, 1.8, 1.8, 0.9), vec![a("fill", color(Some("steel"), "soft"))])))
                    }))
                    .collect(),
            )],
            _ => Vec::new(),
        }
    };

    let liquid = || -> Vec<FaceNode> {
        let Some(context) = o.context else {
            return Vec::new();
        };
        let level = context.clamp(0.0, 1.0);
        let warn = level >= o.threshold.unwrap_or(CONTEXT_WRAP_UP_DEFAULT);
        let fill = if warn { color(Some("amber"), "base") } else { swatch_tone(face.backdrop.as_deref(), "deep") };
        let wave = |amp: f64, cls: &str, opacity: f64, paint: Paint| {
            path(vec![a("class", format!("wave {cls}")), d(&format!("{}V40H-8Z", wave_top(amp))), a("fill", paint), a("opacity", opacity)])
        };
        let back = if warn { wave(1.1, "back", 0.7, color(Some("amber"), "glow")) } else { wave(1.1, "back", 0.45, fill.clone()) };
        let mut tide = vec![back, wave(0.8, "front", if warn { 1.0 } else { 0.9 }, fill)];
        if warn {
            tide.push(path(vec![
                a("class", "wave crest"),
                d(&wave_top(0.8)),
                a("fill", Paint::None),
                a("stroke", color(Some("amber"), "glow")),
                a("stroke-width", 1.1),
            ]));
        }
        vec![
            el("clipPath", vec![a("id", id("f"))], vec![rect(rr(0.0, 0.0, 32.0, 32.0, rx))]),
            el(
                "g",
                vec![a("clip-path", url("f"))],
                vec![el("g", vec![a("class", "tide"), ("style", Attr::Style(vec![("translateY", fixed(32.0 * (1.0 - level), 2))]))], tide)],
            ),
        ]
    };

    let warn = o.context.is_some_and(|c| c >= o.threshold.unwrap_or(CONTEXT_WRAP_UP_DEFAULT));
    let mut children = vec![el("defs", Vec::new(), vec![el("clipPath", vec![a("id", id("t"))], vec![tile(Vec::new())])])];
    if state == FaceState::Attention && !small {
        children.push(rect(with(
            vec![a("class", "ring")],
            with(
                rr(-1.4, -1.4, 34.8, 34.8, fixed(rx + 1.4, 2)),
                vec![a("fill", Paint::None), a("stroke", overlay("bubble")), a("stroke-width", 1.2)],
            ),
        )));
    }
    children.push(rect(with(rr(0.0, 0.0, 32.0, 32.0, rx), vec![a("fill", color(face.backdrop.as_deref(), "wash"))])));
    children.extend(liquid());
    let mut body = antenna();
    body.push(tile(vec![a("fill", color(tile_color, "base"))]));
    body.push(el(
        "g",
        vec![a("clip-path", url("t"))],
        std::iter::once(rect(vec![
            a("x", 0.0),
            a("y", 25.5),
            a("width", 32.0),
            a("height", 9.0),
            a("fill", color(tile_color, "deep")),
            a("opacity", 0.35),
        ]))
        .chain(visor())
        .collect(),
    ));
    body.push(rect(with(rr(6.5, 7.4, 4.2, 1.5, 0.75), vec![a("fill", color(tile_color, "soft")), a("opacity", 0.55)])));
    body.push(el("g", vec![a("class", "eyes")], eyes()));
    body.extend(mouth());
    children.push(el("g", vec![a("transform", "translate(3.2 4.6) scale(.8)")], vec![el("g", vec![a("class", "body")], body)]));
    if !small {
        children.extend(status_overlay());
    }
    el(
        "svg",
        vec![
            a("class", format!("wd-face st-{}{}", state.name(), if warn { " warn" } else { "" })),
            ("style", Attr::Style(vec![("--d", phase_delay(o.phase))])),
            a("width", o.size),
            a("height", o.size),
            a("viewBox", "0 0 32 32"),
            a("aria-hidden", "true"),
        ],
        children,
    )
}

// What a native canvas draws: the tree flattened to push/pop groups and leaf shapes in the 32-unit view box, colours
// resolved to Display P3 with the state's CSS filters (closed grayscale, failed desaturated body) already applied.
#[derive(Debug, Clone, PartialEq)]
pub struct FaceDrawing {
    pub opacity: f64,
    pub ops: Vec<FaceOp>,
}

#[derive(Debug, Clone, PartialEq)]
pub enum FaceOp {
    Push(FaceGroup),
    Pop,
    Rect(FaceRect),
    Path(FacePath),
}

#[derive(Debug, Clone, PartialEq)]
pub struct FaceGroup {
    pub transform: [f64; 6],
    pub clip: Vec<FaceClip>,
    pub motions: Vec<FaceMotion>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FaceClip {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub radius: f64,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FaceStroke {
    pub color: u32,
    pub width: f64,
    pub round_cap: bool,
    pub round_join: bool,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FaceRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub radius: f64,
    pub fill: Option<u32>,
    pub stroke: Option<FaceStroke>,
    pub opacity: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub struct FacePath {
    pub segs: Vec<Seg>,
    pub fill: Option<u32>,
    pub stroke: Option<FaceStroke>,
    pub opacity: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MotionKind {
    Blink,
    Bob,
    Scan,
    Led,
    Glint,
    Seg,
    Dot,
    Breathe,
    Zz,
    Wake,
    Twinkle,
    Pop,
    Ring,
    Shake,
    Wave,
    Crest,
}

pub const MOTION_KINDS: [MotionKind; 16] = [
    MotionKind::Blink,
    MotionKind::Bob,
    MotionKind::Scan,
    MotionKind::Led,
    MotionKind::Glint,
    MotionKind::Seg,
    MotionKind::Dot,
    MotionKind::Breathe,
    MotionKind::Zz,
    MotionKind::Wake,
    MotionKind::Twinkle,
    MotionKind::Pop,
    MotionKind::Ring,
    MotionKind::Shake,
    MotionKind::Wave,
    MotionKind::Crest,
];

// One CSS animation on one element. Time is seconds since the state began; a positive delay holds the base pose,
// `iterations` 0 loops forever, and the transform pivots on (origin_x, origin_y) like `transform-box: fill-box`.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FaceMotion {
    pub kind: MotionKind,
    pub duration: f64,
    pub delay: f64,
    pub iterations: u32,
    pub reverse: bool,
    pub origin_x: f64,
    pub origin_y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
struct Inherit {
    fill: Option<Option<u32>>,
    stroke: Option<u32>,
    stroke_width: Option<f64>,
    round_cap: bool,
    round_join: bool,
}

const IDENTITY: [f64; 6] = [1.0, 0.0, 0.0, 1.0, 0.0, 0.0];

fn mul(m: [f64; 6], n: [f64; 6]) -> [f64; 6] {
    [
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5],
    ]
}

fn apply(m: [f64; 6], (x, y): (f64, f64)) -> (f64, f64) {
    (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])
}

fn parse_transform(value: &str) -> [f64; 6] {
    value.split(')').filter(|part| part.contains('(')).fold(IDENTITY, |m, part| {
        let (name, args) = part.split_once('(').unwrap_or_default();
        let n = path_numbers(args);
        let at = |i: usize, or: f64| n.get(i).copied().unwrap_or(or);
        let step = match name.trim() {
            "translate" => [1.0, 0.0, 0.0, 1.0, at(0, 0.0), at(1, 0.0)],
            "scale" => [at(0, 1.0), 0.0, 0.0, at(1, at(0, 1.0)), 0.0, 0.0],
            "rotate" => {
                let (s, c) = at(0, 0.0).to_radians().sin_cos();
                let (cx, cy) = (at(1, 0.0), at(2, 0.0));
                [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy]
            }
            _ => IDENTITY,
        };
        mul(m, step)
    })
}

type Bounds = Option<(f64, f64, f64, f64)>;

fn union(a: Bounds, b: Bounds) -> Bounds {
    match (a, b) {
        (Some(a), Some(b)) => Some((a.0.min(b.0), a.1.min(b.1), a.2.max(b.2), a.3.max(b.3))),
        (a, None) => a,
        (None, b) => b,
    }
}

fn points_bounds(m: [f64; 6], points: impl IntoIterator<Item = (f64, f64)>) -> Bounds {
    points.into_iter().map(|p| apply(m, p)).fold(None, |b, (x, y)| union(b, Some((x, y, x, y))))
}

fn node_transform(node: &FaceNode) -> [f64; 6] {
    let mut m = node.str("transform").map_or(IDENTITY, parse_transform);
    if let Some(Attr::Style(decls)) = node.attr("style")
        && let Some((_, ty)) = decls.iter().find(|(k, _)| *k == "translateY")
    {
        m = mul(m, [1.0, 0.0, 0.0, 1.0, 0.0, *ty]);
    }
    m
}

// The SVG `getBBox` of a node in its parent's space: geometry only, clips and strokes ignored.
fn bounds(node: &FaceNode, m: [f64; 6]) -> Bounds {
    let m = mul(m, node_transform(node));
    match node.tag {
        "rect" => {
            let (x, y, w, h) = (node.num("x"), node.num("y"), node.num("width"), node.num("height"));
            points_bounds(m, [(x, y), (x + w, y), (x, y + h), (x + w, y + h)])
        }
        "path" => match node.attr("d") {
            Some(Attr::Path(segs)) => points_bounds(
                m,
                segs.iter().flat_map(|s| match *s {
                    Seg::M(x, y) | Seg::L(x, y) => vec![(x, y)],
                    Seg::Q(cx, cy, x, y) => vec![(cx, cy), (x, y)],
                    Seg::Z => Vec::new(),
                }),
            ),
            _ => None,
        },
        "clipPath" | "defs" => None,
        _ => node.children.iter().fold(None, |b, child| union(b, bounds(child, m))),
    }
}

fn srgb_decode(v: f64) -> f64 {
    let sign = v.signum();
    let v = v.abs();
    sign * if v <= 0.04045 { v / 12.92 } else { ((v + 0.055) / 1.055).powf(2.4) }
}

fn srgb_encode(v: f64) -> f64 {
    let sign = v.signum();
    let v = v.abs();
    sign * if v <= 0.003_130_8 { v * 12.92 } else { 1.055 * v.powf(1.0 / 2.4) - 0.055 }
}

fn oklch_srgb(l: f64, c: f64, h: f64) -> [f64; 3] {
    let (sin, cos) = h.to_radians().sin_cos();
    let (a, b) = (c * cos, c * sin);
    let l_ = (l + 0.396_337_777_4 * a + 0.215_803_757_3 * b).powi(3);
    let m_ = (l - 0.105_561_345_8 * a - 0.063_854_172_8 * b).powi(3);
    let s_ = (l - 0.089_484_177_5 * a - 1.291_485_548 * b).powi(3);
    [
        srgb_encode(4.076_741_662_1 * l_ - 3.307_711_591_3 * m_ + 0.230_969_929_2 * s_),
        srgb_encode(-1.268_438_004_6 * l_ + 2.609_757_401_1 * m_ - 0.341_319_396_5 * s_),
        srgb_encode(-0.004_196_086_3 * l_ - 0.703_418_614_7 * m_ + 1.707_614_701 * s_),
    ]
}

fn hex_srgb(hex: &str) -> [f64; 3] {
    let digits = hex.trim_start_matches('#');
    let wide: String = if digits.len() == 3 { digits.chars().flat_map(|c| [c, c]).collect() } else { digits.to_owned() };
    let value = u32::from_str_radix(&wide, 16).unwrap_or(0);
    [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff].map(|c| c as f64 / 255.0)
}

// The CSS `saturate()` matrix; `grayscale(1)` is `saturate(0)`.
fn saturate([r, g, b]: [f64; 3], s: f64) -> [f64; 3] {
    [
        (0.213 + 0.787 * s) * r + (0.715 - 0.715 * s) * g + (0.072 - 0.072 * s) * b,
        (0.213 - 0.213 * s) * r + (0.715 + 0.285 * s) * g + (0.072 - 0.072 * s) * b,
        (0.213 - 0.213 * s) * r + (0.715 - 0.715 * s) * g + (0.072 + 0.928 * s) * b,
    ]
}

fn display_p3(srgb: [f64; 3]) -> u32 {
    let [r, g, b] = srgb.map(srgb_decode);
    let p3 = [
        0.822_461_968_7 * r + 0.177_538_031_3 * g,
        0.033_194_198_4 * r + 0.966_805_801_6 * g,
        0.017_082_630_9 * r + 0.072_397_440_7 * g + 0.910_519_928_4 * b,
    ];
    let [r, g, b] = p3.map(|c| (srgb_encode(c).clamp(0.0, 1.0) * 255.0).round() as u32);
    0xff00_0000 | (r << 16) | (g << 8) | b
}

struct Lower<'a> {
    state: FaceState,
    delay: f64,
    clips: HashMap<String, Vec<FaceClip>>,
    ops: &'a mut Vec<FaceOp>,
}

impl Lower<'_> {
    fn paint(&self, paint: &Paint, saturation: f64) -> Option<u32> {
        let srgb = match paint {
            Paint::None => return None,
            Paint::Oklch(l, c, h) => oklch_srgb(*l, *c, *h),
            Paint::Hex(hex) => hex_srgb(hex),
        };
        Some(display_p3(if saturation < 1.0 { saturate(srgb, saturation) } else { srgb }))
    }

    fn motions(&self, node: &FaceNode, index: usize) -> Vec<FaceMotion> {
        let classes: Vec<&str> = node.str("class").map(|c| c.split(' ').collect()).unwrap_or_default();
        let state = self.state;
        let d = self.delay;
        let origin = |bottom: bool| {
            let (x0, y0, x1, y1) = bounds(node, IDENTITY).unwrap_or_default();
            ((x0 + x1) / 2.0, if bottom { y1 } else { (y0 + y1) / 2.0 })
        };
        let motion = |kind, duration, delay, bottom| {
            let (origin_x, origin_y) = origin(bottom);
            FaceMotion { kind, duration, delay, iterations: 0, reverse: false, origin_x, origin_y }
        };
        let working = state == FaceState::Working;
        let mut out = Vec::new();
        for class in classes {
            match (class, state) {
                ("eyes", FaceState::Idle) => out.push(motion(MotionKind::Blink, 7.0, d, false)),
                ("eyes", FaceState::Working) => out.push(motion(MotionKind::Scan, 2.6, d, false)),
                ("eyes", FaceState::Starting) => out.push(motion(MotionKind::Wake, 1.8, 0.0, false)),
                ("body", FaceState::Working) => out.push(motion(MotionKind::Bob, 1.3, d, true)),
                ("body", FaceState::Asleep) => out.push(motion(MotionKind::Breathe, 4.5, d, true)),
                ("body", FaceState::Failed) => out.push(FaceMotion { iterations: 1, ..motion(MotionKind::Shake, 0.45, 0.0, true) }),
                ("led", FaceState::Working) => out.push(motion(MotionKind::Led, 0.9, 0.0, false)),
                ("glint", FaceState::Working) => out.push(motion(MotionKind::Glint, 1.6, 0.0, false)),
                ("seg", FaceState::Working) => out.push(motion(MotionKind::Seg, 1.2, index as f64 * 0.15, false)),
                ("dot", FaceState::Working) => out.push(motion(MotionKind::Dot, 1.2, (index as f64 - 1.0) * 0.15, false)),
                ("bubble", FaceState::Attention) => out.push(motion(MotionKind::Pop, 2.2, 0.0, false)),
                ("ring", FaceState::Attention) => out.push(motion(MotionKind::Ring, 1.6, 0.0, false)),
                ("z1", FaceState::Asleep) => out.push(motion(MotionKind::Zz, 3.6, 0.0, false)),
                ("z2", FaceState::Asleep) => out.push(motion(MotionKind::Zz, 3.6, 1.8, false)),
                ("spark", FaceState::Starting) => out.push(motion(MotionKind::Twinkle, 1.8, 0.0, false)),
                ("back", FaceState::Asleep | FaceState::Closed | FaceState::Failed) => {}
                ("back", _) => {
                    out.push(FaceMotion { reverse: true, ..motion(MotionKind::Wave, if working { 3.1 } else { 7.0 }, d, false) })
                }
                ("front", FaceState::Asleep | FaceState::Closed | FaceState::Failed) => {}
                ("front", _) => out.push(motion(MotionKind::Wave, if working { 2.2 } else { 5.0 }, d, false)),
                ("crest", FaceState::Asleep | FaceState::Closed | FaceState::Failed) => {}
                ("crest", _) => {
                    out.push(motion(MotionKind::Wave, if working { 2.2 } else { 5.0 }, d, false));
                    out.push(motion(MotionKind::Crest, 1.8, 0.0, false));
                }
                _ => {}
            }
        }
        out
    }

    fn stroke(&self, node: &FaceNode, inherit: &Inherit, saturation: f64) -> Option<FaceStroke> {
        let color = match node.attr("stroke") {
            Some(Attr::Paint(p)) => self.paint(p, saturation),
            _ => inherit.stroke,
        }?;
        Some(FaceStroke {
            color,
            width: if node.attr("stroke-width").is_some() { node.num("stroke-width") } else { inherit.stroke_width.unwrap_or(1.0) },
            round_cap: node.str("stroke-linecap").map_or(inherit.round_cap, |v| v == "round"),
            round_join: node.str("stroke-linejoin").map_or(inherit.round_join, |v| v == "round"),
        })
    }

    fn walk(&mut self, node: &FaceNode, index: usize, inherit: Inherit, saturation: f64) {
        if matches!(node.tag, "clipPath" | "defs") {
            return;
        }
        let classes = node.str("class").unwrap_or_default();
        let saturation = if self.state == FaceState::Failed && classes.split(' ').any(|c| c == "body") { 0.3 } else { saturation };
        let mut transform = node_transform(node);
        if self.state == FaceState::Attention && classes == "eyes" {
            let (_, y0, _, y1) = bounds(node, IDENTITY).unwrap_or_default();
            let cy = (y0 + y1) / 2.0;
            transform = mul(transform, [1.0, 0.0, 0.0, 1.35, 0.0, cy - 1.35 * cy]);
        }
        let clip = node
            .str("clip-path")
            .and_then(|url| url.strip_prefix("url(#")?.strip_suffix(')').map(str::to_owned))
            .and_then(|id| self.clips.get(&id).cloned())
            .unwrap_or_default();
        let motions = self.motions(node, index);
        let grouped = transform != IDENTITY || !clip.is_empty() || !motions.is_empty();
        if grouped {
            self.ops.push(FaceOp::Push(FaceGroup { transform, clip, motions }));
        }
        let fill = match node.attr("fill") {
            Some(Attr::Paint(p)) => Some(self.paint(p, saturation)),
            _ => inherit.fill,
        };
        let opacity = if node.attr("opacity").is_some() { node.num("opacity") } else { 1.0 };
        match node.tag {
            "rect" => {
                let stroke = self.stroke(node, &inherit, saturation);
                self.ops.push(FaceOp::Rect(FaceRect {
                    x: node.num("x"),
                    y: node.num("y"),
                    width: node.num("width"),
                    height: node.num("height"),
                    radius: node.num("rx"),
                    fill: fill.unwrap_or(None),
                    stroke,
                    opacity,
                }));
            }
            "path" => {
                let stroke = self.stroke(node, &inherit, saturation);
                let segs = match node.attr("d") {
                    Some(Attr::Path(segs)) => segs.clone(),
                    _ => Vec::new(),
                };
                self.ops.push(FaceOp::Path(FacePath { segs, fill: fill.unwrap_or(None), stroke, opacity }));
            }
            _ => {
                let inherit = Inherit {
                    fill,
                    stroke: match node.attr("stroke") {
                        Some(Attr::Paint(p)) => self.paint(p, saturation),
                        _ => inherit.stroke,
                    },
                    stroke_width: if node.attr("stroke-width").is_some() { Some(node.num("stroke-width")) } else { inherit.stroke_width },
                    round_cap: node.str("stroke-linecap").map_or(inherit.round_cap, |v| v == "round"),
                    round_join: node.str("stroke-linejoin").map_or(inherit.round_join, |v| v == "round"),
                };
                for (i, child) in node.children.iter().enumerate() {
                    self.walk(child, i, inherit, saturation);
                }
            }
        }
        if grouped {
            self.ops.push(FaceOp::Pop);
        }
    }
}

fn collect_clips(node: &FaceNode, out: &mut HashMap<String, Vec<FaceClip>>) {
    if node.tag == "clipPath"
        && let Some(id) = node.str("id")
    {
        let rects = node
            .children
            .iter()
            .map(|r| FaceClip { x: r.num("x"), y: r.num("y"), width: r.num("width"), height: r.num("height"), radius: r.num("rx") })
            .collect();
        out.insert(id.to_owned(), rects);
    }
    for child in &node.children {
        collect_clips(child, out);
    }
}

pub fn face_drawing(o: &FaceOptions) -> FaceDrawing {
    let tree = face_tree(o);
    let mut clips = HashMap::new();
    collect_clips(&tree, &mut clips);
    let mut ops = Vec::new();
    let closed = o.state == FaceState::Closed;
    let mut lower = Lower { state: o.state, delay: phase_delay(o.phase), clips, ops: &mut ops };
    for (i, child) in tree.children.iter().enumerate() {
        lower.walk(child, i, Inherit { fill: None, ..Inherit::default() }, if closed { 0.0 } else { 1.0 });
    }
    FaceDrawing { opacity: if closed { 0.55 } else { 1.0 }, ops }
}

#[derive(Debug, Clone, Copy, Default)]
struct Xf {
    tx: f64,
    ty: f64,
    sx: f64,
    sy: f64,
    rot: f64,
}

const NO_XF: Xf = Xf { tx: 0.0, ty: 0.0, sx: 1.0, sy: 1.0, rot: 0.0 };

fn tx(tx: f64) -> Option<Xf> {
    Some(Xf { tx, ..NO_XF })
}

fn ty(ty: f64) -> Option<Xf> {
    Some(Xf { ty, ..NO_XF })
}

fn sy(sy: f64) -> Option<Xf> {
    Some(Xf { sy, ..NO_XF })
}

fn sc(sx: f64, sy: f64) -> Option<Xf> {
    Some(Xf { sx, sy, ..NO_XF })
}

#[derive(Debug, Clone, Copy)]
enum Ease {
    Linear,
    Bezier(f64, f64, f64, f64),
    StepsJumpNone(u32),
}

const EASE: Ease = Ease::Bezier(0.25, 0.1, 0.25, 1.0);
const EASE_IN_OUT: Ease = Ease::Bezier(0.42, 0.0, 0.58, 1.0);
const EASE_OUT: Ease = Ease::Bezier(0.0, 0.0, 0.58, 1.0);

fn bezier(p1: f64, p2: f64, t: f64) -> f64 {
    3.0 * (1.0 - t).powi(2) * t * p1 + 3.0 * (1.0 - t) * t * t * p2 + t.powi(3)
}

fn ease(e: Ease, p: f64) -> f64 {
    match e {
        Ease::Linear => p,
        Ease::StepsJumpNone(n) => ((p * n as f64).floor() / (n as f64 - 1.0)).min(1.0),
        Ease::Bezier(x1, y1, x2, y2) => {
            let (mut lo, mut hi) = (0.0, 1.0);
            for _ in 0..40 {
                let mid = (lo + hi) / 2.0;
                if bezier(x1, x2, mid) < p {
                    lo = mid;
                } else {
                    hi = mid;
                }
            }
            bezier(y1, y2, (lo + hi) / 2.0)
        }
    }
}

type Key = (&'static [f64], Option<Xf>, Option<f64>);

struct Keyframes {
    ease: Ease,
    keys: Vec<Key>,
}

fn keyframes(kind: MotionKind) -> Keyframes {
    let (ease, keys): (Ease, Vec<Key>) = match kind {
        MotionKind::Blink => (EASE, vec![(&[0.0, 0.95, 1.0], sy(1.0), None), (&[0.965], sy(0.1), None)]),
        MotionKind::Bob => (EASE_IN_OUT, vec![(&[0.0, 1.0], ty(0.0), None), (&[0.5], ty(-0.9), None)]),
        MotionKind::Scan => (
            EASE_IN_OUT,
            vec![(&[0.0, 0.12], tx(0.0), None), (&[0.3, 0.45], tx(-1.6), None), (&[0.65, 0.8], tx(1.6), None), (&[1.0], tx(0.0), None)],
        ),
        MotionKind::Led => (Ease::StepsJumpNone(2), vec![(&[0.0], None, Some(1.0)), (&[1.0], None, Some(0.3))]),
        MotionKind::Glint => (EASE_IN_OUT, vec![(&[0.0], tx(-14.0), None), (&[0.6, 1.0], tx(14.0), None)]),
        MotionKind::Seg => (EASE_IN_OUT, vec![(&[0.0, 1.0], None, Some(0.35)), (&[0.4], None, Some(1.0))]),
        MotionKind::Dot => (EASE_IN_OUT, vec![(&[0.0, 0.6, 1.0], ty(0.0), Some(0.55)), (&[0.3], ty(-1.2), Some(1.0))]),
        MotionKind::Breathe => (EASE_IN_OUT, vec![(&[0.0, 1.0], sc(1.0, 1.0), None), (&[0.5], sc(1.015, 0.965), None)]),
        MotionKind::Zz => (
            EASE_IN_OUT,
            vec![
                (&[0.0], Some(Xf { ty: 2.0, sx: 0.6, sy: 0.6, ..NO_XF }), Some(0.0)),
                (&[0.25], None, Some(1.0)),
                (&[1.0], Some(Xf { tx: 3.0, ty: -5.0, sx: 1.1, sy: 1.1, rot: 0.0 }), Some(0.0)),
            ],
        ),
        MotionKind::Wake => (EASE_OUT, vec![(&[0.0, 0.4], sy(0.1), None), (&[0.55, 1.0], sy(1.0), None)]),
        MotionKind::Twinkle => {
            (EASE_IN_OUT, vec![(&[0.0, 1.0], sc(0.4, 0.4), Some(0.0)), (&[0.5], Some(Xf { rot: 90.0, ..NO_XF }), Some(1.0))])
        }
        MotionKind::Pop => (
            Ease::Bezier(0.3, 1.6, 0.5, 1.0),
            vec![
                (&[0.0], sc(0.85, 0.85), None),
                (&[0.08], sc(1.12, 1.12), None),
                (&[0.16, 0.55, 0.66, 1.0], Some(NO_XF), None),
                (&[0.6], ty(-1.4), None),
            ],
        ),
        MotionKind::Ring => (EASE_IN_OUT, vec![(&[0.0, 1.0], None, Some(0.25)), (&[0.5], None, Some(1.0))]),
        MotionKind::Shake => (
            EASE_IN_OUT,
            vec![
                (&[0.0, 1.0], tx(0.0), None),
                (&[0.2], tx(-1.2), None),
                (&[0.4], tx(1.2), None),
                (&[0.6], tx(-0.8), None),
                (&[0.8], tx(0.8), None),
            ],
        ),
        MotionKind::Wave => (Ease::Linear, vec![(&[0.0], tx(0.0), None), (&[1.0], tx(-8.0), None)]),
        MotionKind::Crest => (EASE_IN_OUT, vec![(&[0.0, 1.0], None, Some(0.55)), (&[0.5], None, Some(1.0))]),
    };
    Keyframes { ease, keys }
}

fn track<T: Copy>(frames: &Keyframes, pick: impl Fn(&Key) -> Option<T>) -> Vec<(f64, T)> {
    let mut out: Vec<(f64, T)> = frames.keys.iter().filter_map(|k| pick(k).map(|v| k.0.iter().map(move |&at| (at, v)))).flatten().collect();
    out.sort_by(|a, b| a.0.total_cmp(&b.0));
    out
}

fn at_track<T: Copy>(track: &[(f64, T)], p: f64, e: Ease, lerp: impl Fn(T, T, f64) -> T) -> Option<T> {
    let first = track.first()?;
    if p <= first.0 {
        return Some(first.1);
    }
    for pair in track.windows(2) {
        let ((a, va), (b, vb)) = (pair[0], pair[1]);
        if p <= b {
            let span = b - a;
            return Some(if span <= 0.0 { vb } else { lerp(va, vb, ease(e, (p - a) / span)) });
        }
    }
    track.last().map(|l| l.1)
}

fn lerp(a: f64, b: f64, t: f64) -> f64 {
    a + (b - a) * t
}

// Samples per cycle, each `[tx, ty, sx, sy, rotate degrees, opacity]`; a client looks them up by progress and lerps.
pub fn motion_samples(kind: MotionKind) -> Vec<[f64; 6]> {
    let frames = keyframes(kind);
    let transforms = track(&frames, |k| k.1);
    let opacities = track(&frames, |k| k.2);
    let n = if kind == MotionKind::Blink { BLINK_SAMPLES } else { MOTION_SAMPLES };
    (0..=n)
        .map(|i| {
            let p = i as f64 / n as f64;
            let xf = at_track(&transforms, p, frames.ease, |a, b, t| Xf {
                tx: lerp(a.tx, b.tx, t),
                ty: lerp(a.ty, b.ty, t),
                sx: lerp(a.sx, b.sx, t),
                sy: lerp(a.sy, b.sy, t),
                rot: lerp(a.rot, b.rot, t),
            })
            .unwrap_or(NO_XF);
            let opacity = at_track(&opacities, p, frames.ease, lerp).unwrap_or(1.0);
            [xf.tx, xf.ty, xf.sx, xf.sy, xf.rot, opacity]
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts(face: &ResolvedFace, state: FaceState) -> FaceOptions<'_> {
        FaceOptions {
            face,
            project: "blue",
            state,
            size: 40.0,
            id: "f",
            context: Some(0.6),
            threshold: None,
            phase: Some("a"),
            theme: FaceTheme::Dark,
        }
    }

    #[test]
    fn oklch_lands_on_known_srgb() {
        let [r, g, b] = oklch_srgb(0.627_955, 0.257_683, 29.233_885);
        assert!((r - 1.0).abs() < 1e-3 && g.abs() < 1e-3 && b.abs() < 1e-3, "{r} {g} {b}");
        assert_eq!(display_p3([1.0, 1.0, 1.0]), 0xffff_ffff);
        assert_eq!(display_p3(hex_srgb("#000")), 0xff00_0000);
    }

    #[test]
    fn closed_greys_every_colour_and_fades_the_whole_face() {
        let face = resolve_agent_face(None);
        let drawing = face_drawing(&opts(&face, FaceState::Closed));
        assert_eq!(drawing.opacity, 0.55);
        for op in &drawing.ops {
            if let FaceOp::Rect(FaceRect { fill: Some(c), .. }) = op {
                let [r, g, b] = [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];
                assert!(r.abs_diff(g) <= 2 && g.abs_diff(b) <= 2, "{c:08x}");
            }
        }
        assert!(drawing.ops.iter().all(|op| !matches!(op, FaceOp::Push(g) if !g.motions.is_empty())));
    }

    #[test]
    fn working_animates_the_body_from_its_feet_and_the_waves_faster() {
        let face = resolve_agent_face(Some(&json!({"v":1,"antenna":{"kind":"ball"},"eyes":{"kind":"segments"}})));
        let drawing = face_drawing(&opts(&face, FaceState::Working));
        let motions: Vec<FaceMotion> =
            drawing.ops.iter().filter_map(|op| if let FaceOp::Push(g) = op { Some(g.motions.clone()) } else { None }).flatten().collect();
        let bob = motions.iter().find(|m| m.kind == MotionKind::Bob).expect("bob");
        assert_eq!((bob.origin_x, bob.origin_y), (16.0, 34.5));
        assert_eq!(
            motions.iter().filter(|m| m.kind == MotionKind::Seg).map(|m| m.delay).collect::<Vec<_>>(),
            [0.0, 0.15, 0.3, 0.44999999999999996]
        );
        assert!(motions.iter().any(|m| m.kind == MotionKind::Wave && m.duration == 2.2));
        assert!(motions.iter().any(|m| m.kind == MotionKind::Wave && m.reverse && m.duration == 3.1));
        assert_eq!(motions.iter().filter(|m| m.kind == MotionKind::Dot).map(|m| m.delay).collect::<Vec<_>>(), [0.0, 0.15, 0.3]);
    }

    #[test]
    fn motion_tables_hit_their_keyframes() {
        let blink = motion_samples(MotionKind::Blink);
        assert_eq!(blink.len(), BLINK_SAMPLES + 1);
        assert!((blink[965][3] - 0.1).abs() < 1e-6 && blink[0][3] == 1.0);
        let led = motion_samples(MotionKind::Led);
        assert!(led[10][5] == 1.0 && (led[200][5] - 0.3).abs() < 1e-9);
        let zz = motion_samples(MotionKind::Zz);
        assert_eq!((zz[60][5], zz[0][1], zz[240][0]), (1.0, 2.0, 3.0));
        let pop = motion_samples(MotionKind::Pop);
        assert!(pop.iter().any(|s| s[2] > 1.12), "the pop overshoots");
    }
}
