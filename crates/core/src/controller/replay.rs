pub const STALL_SECONDS: f64 = 1.5;
pub const CEILING_SECONDS: f64 = 20.0;

pub fn initial_replay_target(replaying_from: i64, session_last_seq: i64) -> Option<i64> {
    (replaying_from == 0 && session_last_seq > 0).then_some(session_last_seq)
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ReplayHold {
    pub target: i64,
    pub seq: i64,
    pub started_at: f64,
    pub progressed_at: f64,
}

impl ReplayHold {
    pub fn new(target: i64, seq: i64, now: f64) -> Self {
        ReplayHold { target, seq, started_at: now, progressed_at: now }
    }

    pub fn landed(&self) -> bool {
        self.seq >= self.target
    }

    pub fn advance(&mut self, last_seq: i64, now: f64) -> bool {
        if last_seq <= self.seq {
            return false;
        }
        self.seq = last_seq;
        self.progressed_at = now;
        true
    }

    pub fn deadline(&self) -> f64 {
        (self.progressed_at + STALL_SECONDS).min(self.started_at + CEILING_SECONDS)
    }

    pub fn expired(&self, now: f64) -> bool {
        now >= self.deadline()
    }
}
