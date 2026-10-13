use crate::expansion::TerminalExpansion;
use crate::planner::{self, Metrics, TermLine};
use crate::rows::{Row, TerminalRows};
use std::collections::{HashMap, HashSet};
use std::sync::Arc;

struct Entry {
    row: Row,
    expansion: TerminalExpansion,
    lines: Arc<Vec<TermLine>>,
}

pub struct PlanCache {
    entries: HashMap<String, Entry>,
    epoch: Option<Metrics>,
}

impl Default for PlanCache {
    fn default() -> Self {
        Self::new()
    }
}

impl PlanCache {
    pub fn new() -> Self {
        PlanCache { entries: HashMap::new(), epoch: None }
    }

    fn begin_epoch(&mut self, metrics: Metrics) {
        if self.epoch != Some(metrics) {
            self.entries.clear();
            self.epoch = Some(metrics);
        }
    }

    fn cached(&self, row: &Row, subset: &TerminalExpansion) -> Option<&Arc<Vec<TermLine>>> {
        let entry = self.entries.get(&*row.key())?;
        (entry.row == *row && entry.expansion == *subset).then_some(&entry.lines)
    }

    // The lines the book measured, for a renderer: planning is pure, so a row the book has seen is never planned twice.
    pub fn planned(&self, row: &Row, expansion: &TerminalExpansion) -> Option<Arc<Vec<TermLine>>> {
        self.cached(row, &subset_for(expansion, row)).cloned()
    }

    fn store(&mut self, row: &Row, subset: TerminalExpansion, lines: Arc<Vec<TermLine>>) {
        self.entries.insert(row.key().into_owned(), Entry { row: row.clone(), expansion: subset, lines });
    }

    pub fn line_count(&mut self, row: &Row, metrics: &Metrics, expansion: &TerminalExpansion) -> usize {
        self.begin_epoch(*metrics);
        let subset = subset_for(expansion, row);
        if let Some(hit) = self.cached(row, &subset) {
            return hit.len();
        }
        let lines = Arc::new(planner::plan_with(row, metrics, &subset, None));
        let count = lines.len();
        self.store(row, subset, lines);
        count
    }

    // Amortized: a stale entry is harmless (a hit compares the whole row), so the sweep waits until the cache has
    // clearly outgrown the rows instead of hashing every key on every update.
    pub fn evict(&mut self, rows: &TerminalRows) {
        if self.entries.len() <= rows.len() * 2 + 64 {
            return;
        }
        let live: HashSet<String> = rows.rows.iter().map(|row| row.key().into_owned()).collect();
        self.entries.retain(|key, _| live.contains(key));
    }
}

fn subset_for(expansion: &TerminalExpansion, row: &Row) -> TerminalExpansion {
    if expansion.is_empty() { TerminalExpansion::default() } else { expansion.subset(row) }
}

pub const PARALLEL_PLAN_THRESHOLD: usize = 256;

pub struct HeightBook {
    pub heights: Vec<f64>,
    pub offsets: Vec<f64>,
}

impl HeightBook {
    pub fn empty() -> Self {
        HeightBook { heights: Vec::new(), offsets: vec![0.0] }
    }

    pub fn new(rows: &TerminalRows, metrics: &Metrics, cache: Option<&mut PlanCache>) -> Self {
        Self::with(rows, metrics, cache, &TerminalExpansion::default(), None)
    }

    pub fn with(
        rows: &TerminalRows,
        metrics: &Metrics,
        cache: Option<&mut PlanCache>,
        expansion: &TerminalExpansion,
        frame_parent_id: Option<&str>,
    ) -> Self {
        let lines = line_counts(rows, metrics, cache, expansion, frame_parent_id);
        let n = rows.len();
        let mut heights = vec![0.0; n];
        let mut offsets = vec![0.0; n + 1];
        for i in 0..n {
            let gap = if rows.gap_before(i) { 1 } else { 0 };
            heights[i] = (lines[i] + gap) as f64 * metrics.line;
            offsets[i + 1] = offsets[i] + heights[i];
        }
        HeightBook { heights, offsets }
    }

    pub fn total_height(&self) -> f64 {
        *self.offsets.last().unwrap_or(&0.0)
    }

    pub fn offset(&self, index: usize) -> f64 {
        if index < self.offsets.len() { self.offsets[index] } else { self.total_height() }
    }

    pub fn len(&self) -> usize {
        self.heights.len()
    }

    pub fn is_empty(&self) -> bool {
        self.heights.is_empty()
    }

    pub fn height(&self, index: usize) -> f64 {
        self.heights.get(index).copied().unwrap_or(0.0)
    }

    pub fn row_index_at_offset(&self, offset: f64) -> usize {
        if self.heights.is_empty() {
            return 0;
        }
        let (mut low, mut high) = (0, self.heights.len() - 1);
        while low < high {
            let mid = (low + high).div_ceil(2);
            if self.offsets[mid] <= offset {
                low = mid;
            } else {
                high = mid - 1;
            }
        }
        low
    }
}

fn line_counts(
    rows: &TerminalRows,
    metrics: &Metrics,
    mut cache: Option<&mut PlanCache>,
    expansion: &TerminalExpansion,
    frame_parent_id: Option<&str>,
) -> Vec<usize> {
    let count = rows.len();
    if count == 0 {
        return Vec::new();
    }
    let subsets: Vec<TerminalExpansion> = rows.rows.iter().map(|row| subset_for(expansion, row)).collect();
    let plan = |i: usize| Arc::new(planner::plan_with(&rows.rows[i], metrics, &subsets[i], frame_parent_id));
    let mut lines = vec![usize::MAX; count];
    let mut planned: Vec<Option<Arc<Vec<TermLine>>>> = vec![None; count];
    let misses: Vec<usize> = match cache.as_deref_mut() {
        None => (0..count).collect(),
        Some(cache) => {
            cache.begin_epoch(*metrics);
            let mut missed = Vec::new();
            for (i, (row, line)) in rows.rows.iter().zip(lines.iter_mut()).enumerate() {
                match cache.cached(row, &subsets[i]) {
                    Some(hit) => *line = hit.len(),
                    None => missed.push(i),
                }
            }
            missed
        }
    };

    if misses.len() >= PARALLEL_PLAN_THRESHOLD {
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1).max(1);
        let chunk = misses.len().div_ceil(threads);
        let results: Vec<Vec<(usize, Arc<Vec<TermLine>>)>> = std::thread::scope(|scope| {
            let handles: Vec<_> = misses
                .chunks(chunk)
                .map(|slice| {
                    let plan = &plan;
                    scope.spawn(move || slice.iter().map(|&i| (i, plan(i))).collect::<Vec<_>>())
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        for part in results {
            for (i, plan) in part {
                lines[i] = plan.len();
                planned[i] = Some(plan);
            }
        }
    } else {
        for &i in &misses {
            let plan = plan(i);
            lines[i] = plan.len();
            planned[i] = Some(plan);
        }
    }

    if let Some(cache) = cache {
        for &i in &misses {
            if let Some(plan) = planned[i].take() {
                cache.store(&rows.rows[i], subsets[i].clone(), plan);
            }
        }
    }
    lines
}
