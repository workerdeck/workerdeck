use crate::transcript::Item;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Mark {
    pub seq: i64,
    pub item: usize,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TranscriptSeqIndex {
    marks: Vec<Mark>,
    ids: Vec<String>,
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
        self.note_with(seq, before.len(), |i| before[i].id(), after);
    }

    // `note` against the ids this index saw last instead of a copy of the items: an append or an in-place update
    // costs nothing, and only a tail that changed identity rebuilds the mirror.
    pub fn observe(&mut self, seq: i64, after: &[Item]) {
        let mut ids = std::mem::take(&mut self.ids);
        if self.note_with(seq, ids.len(), |i| &ids[i], after) {
            ids = after.iter().map(|item| item.id().to_owned()).collect();
        } else {
            let known = ids.len();
            ids.extend(after[known..].iter().map(|item| item.id().to_owned()));
        }
        self.ids = ids;
    }

    fn note_with<'a>(&mut self, seq: i64, before_len: usize, before_id: impl Fn(usize) -> &'a str, after: &[Item]) -> bool {
        let tail_matches = match before_len.checked_sub(1) {
            None => true,
            Some(tail) => after.len() > tail && after[tail].id() == before_id(tail),
        };
        if tail_matches {
            if after.len() > before_len {
                self.append(seq, before_len);
            }
            return false;
        }
        let first_changed = (0..before_len.min(after.len())).take_while(|&i| after[i].id() == before_id(i)).count();
        self.marks.retain(|mark| mark.item < first_changed);
        if first_changed < after.len() {
            self.append(seq, first_changed);
        }
        true
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
