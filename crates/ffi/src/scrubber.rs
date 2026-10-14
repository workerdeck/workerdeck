// The overview rail as records: clusters for a Canvas to paint, a peek for the one under the finger, and the band
// and scrub arithmetic so the app never re-derives the scale. `lane` and `kind` are the web's names (`l`, `turnFailed`).
use wd_native::scrubber::{self, Cluster, Lane, Mark, MarkKind, Member, Peek};

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ScrubMark {
    pub kind: String,
    pub item_index: Option<u32>,
    pub row_index: u32,
    pub turn_index: Option<u32>,
    pub y: f64,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ScrubCluster {
    pub lane: String,
    pub kind: String,
    pub y: f64,
    pub h: f64,
    pub marks: Vec<ScrubMark>,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ScrubPeekLine {
    pub glyph: Option<String>,
    pub text: String,
    pub tone: String,
    pub excerpt: bool,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ScrubPeek {
    pub title: String,
    pub lines: Vec<ScrubPeekLine>,
}

#[derive(Debug, Clone, Copy, PartialEq, uniffi::Record)]
pub struct ScrubBand {
    pub top: f64,
    pub h: f64,
}

const KINDS: [MarkKind; 10] = [
    MarkKind::User,
    MarkKind::Subagent,
    MarkKind::Shell,
    MarkKind::Turn,
    MarkKind::TurnFailed,
    MarkKind::ToolFailed,
    MarkKind::Error,
    MarkKind::Approval,
    MarkKind::Recap,
    MarkKind::Bookmark,
];

fn kind_of(raw: &str) -> MarkKind {
    KINDS.into_iter().find(|kind| kind.raw() == raw).unwrap_or(MarkKind::Turn)
}

fn lane_of(raw: &str) -> Lane {
    [Lane::Left, Lane::Right, Lane::Full].into_iter().find(|lane| lane.raw() == raw).unwrap_or(Lane::Full)
}

impl From<&Cluster> for ScrubCluster {
    fn from(cluster: &Cluster) -> Self {
        ScrubCluster {
            lane: cluster.lane.raw().to_owned(),
            kind: cluster.kind.raw().to_owned(),
            y: cluster.y,
            h: cluster.h,
            marks: cluster
                .marks
                .iter()
                .map(|member| ScrubMark {
                    kind: member.mark.kind.raw().to_owned(),
                    item_index: member.mark.item_index.map(|i| i as u32),
                    row_index: member.mark.row_index as u32,
                    turn_index: member.mark.turn_index.map(|i| i as u32),
                    y: member.y,
                })
                .collect(),
        }
    }
}

impl From<&ScrubCluster> for Cluster {
    fn from(cluster: &ScrubCluster) -> Self {
        Cluster {
            lane: lane_of(&cluster.lane),
            kind: kind_of(&cluster.kind),
            y: cluster.y,
            h: cluster.h,
            marks: cluster
                .marks
                .iter()
                .map(|mark| Member {
                    mark: Mark {
                        kind: kind_of(&mark.kind),
                        item_index: mark.item_index.map(|i| i as usize),
                        row_index: mark.row_index as usize,
                        turn_index: mark.turn_index.map(|i| i as usize),
                    },
                    y: mark.y,
                })
                .collect(),
        }
    }
}

impl From<Peek> for ScrubPeek {
    fn from(peek: Peek) -> Self {
        ScrubPeek {
            title: peek.title,
            lines: peek
                .lines
                .into_iter()
                .map(|line| ScrubPeekLine {
                    glyph: line.glyph.map(str::to_owned),
                    text: line.text,
                    tone: line.tone.raw().to_owned(),
                    excerpt: line.excerpt,
                })
                .collect(),
        }
    }
}

// The row a tap on `cluster` at rail `y` lands on; `None` for the approval pin, which means "go to the bottom".
#[uniffi::export]
pub fn scrub_target(cluster: ScrubCluster, y: f64) -> Option<u32> {
    Cluster::from(&cluster).nearest_member(y).map(|mark| mark.row_index as u32)
}

#[uniffi::export]
pub fn scrub_band(rail_h: f64, total: f64, viewport_h: f64, scroll_offset: f64) -> ScrubBand {
    let band = scrubber::band(rail_h, total, viewport_h, scroll_offset);
    ScrubBand { top: band.top, h: band.h }
}

// The scroll offset (top of the viewport, from the transcript's top) a drag at `fraction` of the rail asks for.
#[uniffi::export]
pub fn scrub_offset(fraction: f64, total: f64, viewport_h: f64) -> f64 {
    scrubber::scrub_offset(fraction, total, viewport_h)
}

// Which of `clusters` a finger at rail-local `x`, `y` presses (see the core's `cluster_at`).
#[uniffi::export]
pub fn scrub_hit(clusters: Vec<ScrubCluster>, x: f64, y: f64, rail_w: f64, slop: f64) -> Option<u32> {
    let clusters: Vec<Cluster> = clusters.iter().map(Cluster::from).collect();
    scrubber::cluster_at(&clusters, x, y, rail_w, slop).map(|index| index as u32)
}

// How far a bottom-anchored transcript shorter than its viewport pushes its rail down.
#[uniffi::export]
pub fn scrub_pad(rail_h: f64, total: f64, viewport_h: f64) -> f64 {
    scrubber::anchor_pad(rail_h, total, viewport_h)
}
