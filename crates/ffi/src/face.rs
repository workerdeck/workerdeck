use wd_native::vm::face::{self as vm, FaceOptions, FaceTheme, MOTION_KINDS, MotionKind, ResolvedFace};
use wd_native::vm::session_list::SessionRow;

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum FaceState {
    Idle,
    Asleep,
    Starting,
    Working,
    Attention,
    Failed,
    Closed,
}

impl From<vm::FaceState> for FaceState {
    fn from(state: vm::FaceState) -> Self {
        match state {
            vm::FaceState::Idle => FaceState::Idle,
            vm::FaceState::Asleep => FaceState::Asleep,
            vm::FaceState::Starting => FaceState::Starting,
            vm::FaceState::Working => FaceState::Working,
            vm::FaceState::Attention => FaceState::Attention,
            vm::FaceState::Failed => FaceState::Failed,
            vm::FaceState::Closed => FaceState::Closed,
        }
    }
}

impl From<FaceState> for vm::FaceState {
    fn from(state: FaceState) -> Self {
        match state {
            FaceState::Idle => vm::FaceState::Idle,
            FaceState::Asleep => vm::FaceState::Asleep,
            FaceState::Starting => vm::FaceState::Starting,
            FaceState::Working => vm::FaceState::Working,
            FaceState::Attention => vm::FaceState::Attention,
            FaceState::Failed => vm::FaceState::Failed,
            FaceState::Closed => vm::FaceState::Closed,
        }
    }
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct FaceSlot {
    pub kind: String,
    pub color: Option<String>,
}

// An agent's face as a row carries it: the resolved recipe and everything the pose needs. Opaque to the app, which
// hands it back to `face_drawing` with the size and theme it draws at.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct FaceSpec {
    pub backdrop: Option<String>,
    pub tile: FaceSlot,
    pub antenna: FaceSlot,
    pub visor: FaceSlot,
    pub eyes: FaceSlot,
    pub mouth: FaceSlot,
    pub project: String,
    pub phase: String,
    pub state: FaceState,
    pub context: Option<f64>,
}

pub fn face_spec(row: &SessionRow) -> Option<FaceSpec> {
    let info = &row.info;
    let agent = info.agent.as_ref()?;
    let face = vm::resolve_agent_face(agent.face.as_ref());
    let slot = |layer: vm::FaceLayer| FaceSlot { kind: layer.kind, color: layer.color };
    Some(FaceSpec {
        backdrop: face.backdrop,
        tile: FaceSlot { kind: face.tile.shape, color: face.tile.color },
        antenna: slot(face.antenna),
        visor: slot(face.visor),
        eyes: slot(face.eyes),
        mouth: slot(face.mouth),
        project: vm::face_project_of(info).to_owned(),
        phase: agent.id.clone(),
        state: vm::face_state_of(row, None).into(),
        context: info.context_usage.as_ref().map(|c| c.percentage / 100.0),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum FaceMotionKind {
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

impl From<MotionKind> for FaceMotionKind {
    fn from(kind: MotionKind) -> Self {
        match kind {
            MotionKind::Blink => FaceMotionKind::Blink,
            MotionKind::Bob => FaceMotionKind::Bob,
            MotionKind::Scan => FaceMotionKind::Scan,
            MotionKind::Led => FaceMotionKind::Led,
            MotionKind::Glint => FaceMotionKind::Glint,
            MotionKind::Seg => FaceMotionKind::Seg,
            MotionKind::Dot => FaceMotionKind::Dot,
            MotionKind::Breathe => FaceMotionKind::Breathe,
            MotionKind::Zz => FaceMotionKind::Zz,
            MotionKind::Wake => FaceMotionKind::Wake,
            MotionKind::Twinkle => FaceMotionKind::Twinkle,
            MotionKind::Pop => FaceMotionKind::Pop,
            MotionKind::Ring => FaceMotionKind::Ring,
            MotionKind::Shake => FaceMotionKind::Shake,
            MotionKind::Wave => FaceMotionKind::Wave,
            MotionKind::Crest => FaceMotionKind::Crest,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct FaceMotion {
    pub kind: FaceMotionKind,
    pub duration: f64,
    pub delay: f64,
    pub iterations: u32,
    pub reverse: bool,
    pub origin_x: f64,
    pub origin_y: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct FaceClip {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub radius: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct FaceStroke {
    pub color: u32,
    pub width: f64,
    pub round_cap: bool,
    pub round_join: bool,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct FaceGroup {
    pub transform: Vec<f64>,
    pub clip: Vec<FaceClip>,
    pub motions: Vec<FaceMotion>,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
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

#[derive(Debug, Clone, Copy, PartialEq, uniffi::Enum)]
pub enum FaceSeg {
    Move { x: f64, y: f64 },
    Line { x: f64, y: f64 },
    Quad { cx: f64, cy: f64, x: f64, y: f64 },
    Close,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct FacePath {
    pub segs: Vec<FaceSeg>,
    pub fill: Option<u32>,
    pub stroke: Option<FaceStroke>,
    pub opacity: f64,
}

#[derive(Debug, Clone, PartialEq, uniffi::Enum)]
pub enum FaceOp {
    Push { group: FaceGroup },
    Pop,
    Rect { rect: FaceRect },
    Path { path: FacePath },
}

// Colours are ARGB in Display P3. Geometry is in the face's 32-unit view box; scale by size / 32.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct FaceDrawing {
    pub opacity: f64,
    pub ops: Vec<FaceOp>,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct FaceMotionTable {
    pub kind: FaceMotionKind,
    // Six floats per sample, `[tx, ty, sx, sy, rotate degrees, opacity]`, evenly spaced over one cycle, both ends included.
    pub samples: Vec<f32>,
}

fn stroke(s: vm::FaceStroke) -> FaceStroke {
    FaceStroke { color: s.color, width: s.width, round_cap: s.round_cap, round_join: s.round_join }
}

fn op(op: vm::FaceOp) -> FaceOp {
    match op {
        vm::FaceOp::Push(g) => FaceOp::Push {
            group: FaceGroup {
                transform: g.transform.to_vec(),
                clip: g.clip.into_iter().map(|c| FaceClip { x: c.x, y: c.y, width: c.width, height: c.height, radius: c.radius }).collect(),
                motions: g
                    .motions
                    .into_iter()
                    .map(|m| FaceMotion {
                        kind: m.kind.into(),
                        duration: m.duration,
                        delay: m.delay,
                        iterations: m.iterations,
                        reverse: m.reverse,
                        origin_x: m.origin_x,
                        origin_y: m.origin_y,
                    })
                    .collect(),
            },
        },
        vm::FaceOp::Pop => FaceOp::Pop,
        vm::FaceOp::Rect(r) => FaceOp::Rect {
            rect: FaceRect {
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
                radius: r.radius,
                fill: r.fill,
                stroke: r.stroke.map(stroke),
                opacity: r.opacity,
            },
        },
        vm::FaceOp::Path(p) => FaceOp::Path {
            path: FacePath {
                segs: p
                    .segs
                    .into_iter()
                    .map(|s| match s {
                        vm::Seg::M(x, y) => FaceSeg::Move { x, y },
                        vm::Seg::L(x, y) => FaceSeg::Line { x, y },
                        vm::Seg::Q(cx, cy, x, y) => FaceSeg::Quad { cx, cy, x, y },
                        vm::Seg::Z => FaceSeg::Close,
                    })
                    .collect(),
                fill: p.fill,
                stroke: p.stroke.map(stroke),
                opacity: p.opacity,
            },
        },
    }
}

// `show_context` fills the backdrop to the session's context use; the agent card shows it, smaller faces do not.
#[uniffi::export]
pub fn face_drawing(spec: FaceSpec, size: f64, dark: bool, show_context: bool) -> FaceDrawing {
    let slot = |s: FaceSlot| vm::FaceLayer { kind: s.kind, color: s.color };
    let face = ResolvedFace {
        backdrop: spec.backdrop,
        tile: vm::FaceTile { shape: spec.tile.kind, color: spec.tile.color },
        antenna: slot(spec.antenna),
        visor: slot(spec.visor),
        eyes: slot(spec.eyes),
        mouth: slot(spec.mouth),
    };
    let drawing = vm::face_drawing(&FaceOptions {
        face: &face,
        project: &spec.project,
        state: spec.state.into(),
        size,
        id: "f",
        context: spec.context.filter(|_| show_context),
        threshold: None,
        phase: Some(&spec.phase),
        theme: if dark { FaceTheme::Dark } else { FaceTheme::Light },
    });
    FaceDrawing { opacity: drawing.opacity, ops: drawing.ops.into_iter().map(op).collect() }
}

#[uniffi::export]
pub fn face_motion_tables() -> Vec<FaceMotionTable> {
    MOTION_KINDS
        .iter()
        .map(|&kind| FaceMotionTable {
            kind: kind.into(),
            samples: vm::motion_samples(kind).into_iter().flat_map(|s| s.map(|v| v as f32)).collect(),
        })
        .collect()
}
