use crate::planner::{self, Metrics};
use crate::rows::{Row, TerminalRows};
use std::collections::HashMap;

pub struct PlanCache {
    entries: HashMap<String, (Row, usize)>,
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

    fn cached(&self, row: &Row) -> Option<usize> {
        let (stored, lines) = self.entries.get(&*row.key())?;
        if stored == row { Some(*lines) } else { None }
    }

    fn store(&mut self, row: &Row, lines: usize) {
        self.entries.insert(row.key().into_owned(), (row.clone(), lines));
    }
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
        let lines = line_counts(rows, metrics, cache);
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
}

fn line_counts(rows: &TerminalRows, metrics: &Metrics, mut cache: Option<&mut PlanCache>) -> Vec<usize> {
    let count = rows.len();
    if count == 0 {
        return Vec::new();
    }
    let mut lines = vec![usize::MAX; count];
    let misses: Vec<usize> = match cache.as_deref_mut() {
        None => (0..count).collect(),
        Some(cache) => {
            cache.begin_epoch(*metrics);
            let mut missed = Vec::new();
            for (i, (row, line)) in rows.rows.iter().zip(lines.iter_mut()).enumerate() {
                match cache.cached(row) {
                    Some(hit) => *line = hit,
                    None => missed.push(i),
                }
            }
            missed
        }
    };

    if misses.len() >= PARALLEL_PLAN_THRESHOLD {
        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(1).max(1);
        let chunk = misses.len().div_ceil(threads);
        let results: Vec<Vec<(usize, usize)>> = std::thread::scope(|scope| {
            let handles: Vec<_> = misses
                .chunks(chunk)
                .map(|slice| {
                    scope.spawn(move || slice.iter().map(|&i| (i, planner::plan(&rows.rows[i], metrics).len())).collect::<Vec<_>>())
                })
                .collect();
            handles.into_iter().map(|h| h.join().unwrap()).collect()
        });
        for part in results {
            for (i, n) in part {
                lines[i] = n;
            }
        }
    } else {
        for &i in &misses {
            lines[i] = planner::plan(&rows.rows[i], metrics).len();
        }
    }

    if let Some(cache) = cache {
        for &i in &misses {
            cache.store(&rows.rows[i], lines[i]);
        }
    }
    lines
}
