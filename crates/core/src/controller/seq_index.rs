use crate::transcript::Item;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mark {
    pub seq: i64,
    pub item: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TranscriptSeqIndex {
    marks: Vec<Mark>,
}

impl TranscriptSeqIndex {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn is_empty(&self) -> bool {
        self.marks.is_empty()
    }

    pub fn len(&self) -> usize {
        self.marks.len()
    }

    pub fn note(&mut self, seq: i64, before: &[Item], after: &[Item]) {
        let tail_matches = match before.len().checked_sub(1) {
            None => true,
            Some(tail) => after.len() > tail && after[tail].id() == before[tail].id(),
        };
        if tail_matches {
            if after.len() > before.len() {
                self.append(seq, before.len());
            }
            return;
        }
        let first_changed = before.iter().zip(after).take_while(|(b, a)| a.id() == b.id()).count();
        self.marks.retain(|mark| mark.item < first_changed);
        if first_changed < after.len() {
            self.append(seq, first_changed);
        }
    }

    fn append(&mut self, seq: i64, item: usize) {
        if self.marks.last().is_some_and(|last| seq <= last.seq) {
            return;
        }
        self.marks.push(Mark { seq, item });
    }

    pub fn item_for_seq(&self, seq: i64) -> Option<usize> {
        let last = self.marks.last()?;
        if seq > last.seq {
            return None;
        }
        let at = self.marks.partition_point(|mark| mark.seq < seq);
        Some(self.marks[at].item)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeepLinkPlacement {
    Pending,
    Unplaceable,
    Item { index: usize, complete: bool },
}

pub fn deep_link_seq_survives(push_epoch: Option<i64>, session_epoch: Option<i64>) -> bool {
    push_epoch.unwrap_or(0) == session_epoch.unwrap_or(0)
}

pub fn deep_link_placement(item: Option<usize>, last_seq: i64, attach_last_seq: i64) -> DeepLinkPlacement {
    let complete = last_seq >= attach_last_seq;
    match item {
        Some(index) => DeepLinkPlacement::Item { index, complete },
        None if complete => DeepLinkPlacement::Unplaceable,
        None => DeepLinkPlacement::Pending,
    }
}
