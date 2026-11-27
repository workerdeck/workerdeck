// The list drag's pure resolution, ported from `packages/ui/src/lib/row-drag.ts` and the placement half of
// `team-drop.ts`. Goldens: `list-drag.*`.
use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DragRowKind {
    Row,
    Heading,
    Empty,
    Pinned,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DragRow {
    pub key: String,
    pub lane: String,
    pub kind: DragRowKind,
    pub top: f64,
    pub height: f64,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct Slot {
    pub lane: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Refusal {
    pub key: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct DragTarget {
    pub slot: Slot,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub join: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub leave: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refusal: Option<Refusal>,
}

// `true` joins the target's team, a string is why it may not; a key absent from the map leads no team at all.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum Joinable {
    Yes(bool),
    No(String),
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TeamBlock {
    pub lane: String,
    pub lead: String,
    #[serde(rename = "leadLane")]
    pub lead_lane: String,
    pub top: f64,
    pub bottom: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionDragContext {
    pub dragged: String,
    pub origin: Slot,
    pub reorder: bool,
    #[serde(default)]
    pub joinable: HashMap<String, Joinable>,
    #[serde(default)]
    pub team: Option<TeamBlock>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DropZone {
    Before,
    Join,
    After,
}

pub fn drop_zone(offset_y: f64, height: f64) -> DropZone {
    if height <= 0.0 {
        return DropZone::Join;
    }
    let at = offset_y / height;
    if at < 0.25 {
        DropZone::Before
    } else if at > 0.75 {
        DropZone::After
    } else {
        DropZone::Join
    }
}

pub fn same_slot(a: &Slot, b: &Slot) -> bool {
    a.lane == b.lane && a.before == b.before
}

fn hit_at<'a>(rows: &'a [DragRow], y: f64, dragged: &str) -> Option<&'a DragRow> {
    let others: Vec<&DragRow> = rows.iter().filter(|row| row.key != dragged).collect();
    let first = others.iter().copied().fold(None::<&DragRow>, |best, row| match best {
        Some(b) if b.top <= row.top => Some(b),
        _ => Some(row),
    });
    let last = others.iter().copied().fold(None::<&DragRow>, |best, row| match best {
        Some(b) if b.top + b.height >= row.top + row.height => Some(b),
        _ => Some(row),
    });
    if let Some(first) = first
        && y < first.top
    {
        return Some(first);
    }
    if let Some(last) = last
        && y >= last.top + last.height
    {
        return Some(last);
    }
    others.into_iter().find(|row| y >= row.top && y < row.top + row.height)
}

fn lane_rows<'a>(rows: &'a [DragRow], lane: &str, dragged: &str) -> Vec<&'a DragRow> {
    rows.iter().filter(|row| row.lane == lane && row.key != dragged && matches!(row.kind, DragRowKind::Row | DragRowKind::Pinned)).collect()
}

fn next_in(rows: &[DragRow], hit: &DragRow, dragged: &str) -> Option<String> {
    let lane = lane_rows(rows, &hit.lane, dragged);
    let at = lane.iter().position(|row| std::ptr::eq(*row, hit));
    let next = match at {
        Some(i) => lane.get(i + 1),
        None => lane.first(),
    };
    next.map(|row| row.key.clone())
}

fn first_in(rows: &[DragRow], lane: &str, dragged: &str) -> Option<String> {
    lane_rows(rows, lane, dragged).first().map(|row| row.key.clone())
}

pub fn origin_slot(rows: &[DragRow], key: &str) -> Option<Slot> {
    let me = rows.iter().find(|row| row.key == key)?;
    let lane: Vec<&DragRow> =
        rows.iter().filter(|row| row.lane == me.lane && matches!(row.kind, DragRowKind::Row | DragRowKind::Pinned)).collect();
    let at = lane.iter().position(|row| std::ptr::eq(*row, me));
    let before = match at {
        Some(i) => lane.get(i + 1),
        None => lane.first(),
    };
    Some(Slot { lane: me.lane.clone(), before: before.map(|row| row.key.clone()) })
}

fn halves(rows: &[DragRow], hit: &DragRow, y: f64, dragged: &str) -> Slot {
    if hit.kind == DragRowKind::Pinned {
        return Slot { lane: hit.lane.clone(), before: Some(hit.key.clone()) };
    }
    let upper = y < hit.top + hit.height / 2.0;
    Slot { lane: hit.lane.clone(), before: if upper { Some(hit.key.clone()) } else { next_in(rows, hit, dragged) } }
}

fn slot_only(slot: Slot) -> DragTarget {
    DragTarget { slot, ..DragTarget::default() }
}

// Hit-testing runs against layout positions, never animated ones, and a pointer over no row keeps the last answer,
// so moving the gap can never flip it back.
pub fn session_target(rows: &[DragRow], y: f64, current: &DragTarget, ctx: &SessionDragContext) -> DragTarget {
    let hit = hit_at(rows, y, &ctx.dragged);
    let dragged = ctx.dragged.as_str();
    if let Some(team) = &ctx.team {
        let leave_at = |row: &DragRow, slot: Slot| -> DragTarget {
            if ctx.reorder {
                let slot = if row.kind == DragRowKind::Empty { Slot { lane: row.lane.clone(), before: None } } else { slot };
                DragTarget { slot, leave: Some(true), ..DragTarget::default() }
            } else {
                DragTarget { slot: ctx.origin.clone(), leave: Some(true), ..DragTarget::default() }
            }
        };
        if y >= team.top && y < team.bottom {
            let Some(hit) = hit else { return current.clone() };
            if hit.lane == team.lane {
                return slot_only(halves(rows, hit, y, dragged));
            }
            if hit.key == team.lead {
                return if drop_zone(y - hit.top, hit.height) == DropZone::Before {
                    leave_at(hit, Slot { lane: hit.lane.clone(), before: Some(hit.key.clone()) })
                } else {
                    slot_only(Slot { lane: team.lane.clone(), before: first_in(rows, &team.lane, dragged) })
                };
            }
            return current.clone();
        }
        let Some(hit) = hit else {
            if current.leave == Some(true) {
                return current.clone();
            }
            let lead = rows.iter().find(|row| row.key == team.lead);
            return match lead {
                Some(lead) if ctx.reorder => DragTarget {
                    slot: Slot { lane: team.lead_lane.clone(), before: next_in(rows, lead, dragged) },
                    leave: Some(true),
                    ..DragTarget::default()
                },
                _ => DragTarget { slot: ctx.origin.clone(), leave: Some(true), ..DragTarget::default() },
            };
        };
        if hit.kind == DragRowKind::Heading {
            return leave_at(hit, Slot { lane: hit.lane.clone(), before: first_in(rows, &hit.lane, dragged) });
        }
        if hit.kind == DragRowKind::Row && drop_zone(y - hit.top, hit.height) == DropZone::Join {
            match ctx.joinable.get(&hit.key) {
                Some(Joinable::Yes(true)) => {
                    return DragTarget { slot: current.slot.clone(), join: Some(hit.key.clone()), ..DragTarget::default() };
                }
                Some(Joinable::No(message)) if !ctx.reorder => {
                    return DragTarget {
                        slot: current.slot.clone(),
                        leave: Some(true),
                        refusal: Some(Refusal { key: hit.key.clone(), message: message.clone() }),
                        ..DragTarget::default()
                    };
                }
                _ => {}
            }
        }
        return leave_at(hit, halves(rows, hit, y, dragged));
    }

    let Some(hit) = hit else { return current.clone() };
    if hit.kind == DragRowKind::Empty {
        return if ctx.reorder { slot_only(Slot { lane: hit.lane.clone(), before: None }) } else { current.clone() };
    }
    if hit.kind == DragRowKind::Heading {
        return if ctx.reorder {
            slot_only(Slot { lane: hit.lane.clone(), before: first_in(rows, &hit.lane, dragged) })
        } else {
            current.clone()
        };
    }
    let verdict = if hit.kind == DragRowKind::Row { ctx.joinable.get(&hit.key) } else { None };
    if let Some(verdict) = verdict
        && drop_zone(y - hit.top, hit.height) == DropZone::Join
    {
        match verdict {
            Joinable::Yes(true) => {
                return DragTarget { slot: current.slot.clone(), join: Some(hit.key.clone()), ..DragTarget::default() };
            }
            Joinable::No(message) if !ctx.reorder => {
                return DragTarget {
                    slot: current.slot.clone(),
                    refusal: Some(Refusal { key: hit.key.clone(), message: message.clone() }),
                    ..DragTarget::default()
                };
            }
            _ => {}
        }
    }
    if ctx.reorder { slot_only(halves(rows, hit, y, dragged)) } else { slot_only(current.slot.clone()) }
}

pub fn group_slot(rows: &[DragRow], y: f64, current: &Slot, dragged: &str) -> Slot {
    match hit_at(rows, y, dragged) {
        Some(hit) => halves(rows, hit, y, dragged),
        None => current.clone(),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SiblingOrder {
    pub index: usize,
    pub order: f64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Placement {
    pub order: f64,
    pub siblings: Vec<SiblingOrder>,
}

// The mover lands at `index` among the team's other members (their current `order`s, in drawn order); the team is
// renumbered densely from 0 and only the members whose order changes are listed.
pub fn place_member(others: &[Option<f64>], index: usize) -> Placement {
    let siblings = others
        .iter()
        .enumerate()
        .map(|(i, order)| (i, *order, if i < index { i } else { i + 1 } as f64))
        .filter(|(_, order, next)| *order != Some(*next))
        .map(|(index, _, order)| SiblingOrder { index, order })
        .collect();
    Placement { order: index as f64, siblings }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(key: &str, lane: &str, top: f64) -> DragRow {
        DragRow { key: key.into(), lane: lane.into(), kind: DragRowKind::Row, top, height: 36.0 }
    }

    #[test]
    fn a_member_reorders_inside_its_team_by_halves() {
        let rows = vec![row("lead", "g", 0.0), row("a", "team:lead", 40.0), row("b", "team:lead", 80.0), row("c", "team:lead", 120.0)];
        let ctx = SessionDragContext {
            dragged: "a".into(),
            origin: Slot { lane: "team:lead".into(), before: Some("b".into()) },
            reorder: false,
            joinable: HashMap::new(),
            team: Some(TeamBlock { lane: "team:lead".into(), lead: "lead".into(), lead_lane: "g".into(), top: 0.0, bottom: 156.0 }),
        };
        let current = DragTarget { slot: ctx.origin.clone(), ..DragTarget::default() };
        let got = session_target(&rows, 130.0, &current, &ctx);
        assert_eq!(got.slot, Slot { lane: "team:lead".into(), before: Some("c".into()) });
        let got = session_target(&rows, 150.0, &current, &ctx);
        assert_eq!(got.slot, Slot { lane: "team:lead".into(), before: None });
    }

    #[test]
    fn placing_renumbers_only_what_moves() {
        let got = place_member(&[Some(0.0), Some(1.0), Some(2.0)], 1);
        assert_eq!(got.order, 1.0);
        assert_eq!(got.siblings, vec![SiblingOrder { index: 1, order: 2.0 }, SiblingOrder { index: 2, order: 3.0 }]);
    }
}
