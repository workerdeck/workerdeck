use crate::planner::shell::{label_of, status_words};
use crate::protocol::ShellAttachedFrame;
use crate::rest::{ShellEndReason, ShellInfo, ShellStatus};
use crate::vt::{VtKey, VtScreen};

pub const MIN_COLS: u32 = 20;
pub const MIN_ROWS: u32 = 4;
pub const SCROLLBACK_LINES: usize = 1000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShellPhase {
    Connecting,
    Live,
    Ended(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ShellAction {
    Attach { cols: u32, rows: u32 },
    Write(String),
    Resize { cols: u32, rows: u32 },
    Detach,
}

// One open shell as a screen: the emulator, the record, and the PTY's two directions. The bytes never touch the
// transcript; `revision` bumps whenever the grid, the phase or the record changes.
pub struct ShellSession {
    shell_id: String,
    shell: Option<ShellInfo>,
    phase: ShellPhase,
    screen: VtScreen,
    cols: u32,
    rows: u32,
    attached: bool,
    revision: u64,
}

impl ShellSession {
    pub fn new(shell_id: String, shell: Option<ShellInfo>, cols: u32, rows: u32) -> Self {
        let cols = cols.max(MIN_COLS);
        let rows = rows.max(MIN_ROWS);
        ShellSession {
            shell_id,
            shell,
            phase: ShellPhase::Connecting,
            screen: VtScreen::new(cols as usize, rows as usize, SCROLLBACK_LINES),
            cols,
            rows,
            attached: false,
            revision: 0,
        }
    }

    pub fn shell_id(&self) -> &str {
        &self.shell_id
    }

    pub fn shell(&self) -> Option<&ShellInfo> {
        self.shell.as_ref()
    }

    pub fn phase(&self) -> &ShellPhase {
        &self.phase
    }

    pub fn screen(&self) -> &VtScreen {
        &self.screen
    }

    pub fn size(&self) -> (u32, u32) {
        (self.cols, self.rows)
    }

    pub fn is_attached(&self) -> bool {
        self.attached
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    // The record says the process is alive. Not the same as being able to type at it: a stream dropped for
    // backpressure leaves a running shell this screen no longer watches.
    pub fn is_running(&self) -> bool {
        self.shell.as_ref().is_some_and(|shell| shell.status == ShellStatus::Running)
    }

    pub fn can_type(&self) -> bool {
        self.is_running() && self.phase == ShellPhase::Live
    }

    pub fn title(&self) -> String {
        self.shell.as_ref().map_or_else(|| "Shell".into(), title)
    }

    pub fn status_text(&self) -> String {
        if let Some(shell) = self.shell.as_ref().filter(|shell| shell.status == ShellStatus::Exited) {
            return status_text(shell);
        }
        match &self.phase {
            ShellPhase::Connecting => "connecting…".into(),
            ShellPhase::Live => "running".into(),
            ShellPhase::Ended(reason) => reason.clone(),
        }
    }

    pub fn start(&mut self) -> Option<ShellAction> {
        if self.attached {
            return None;
        }
        self.attached = true;
        Some(ShellAction::Attach { cols: self.cols, rows: self.rows })
    }

    // Leaving the screen stops the stream and never the process.
    pub fn stop(&mut self) -> Option<ShellAction> {
        std::mem::take(&mut self.attached).then_some(ShellAction::Detach)
    }

    // An unchanged size sends nothing: every resize reaches the process as SIGWINCH.
    pub fn resize(&mut self, cols: u32, rows: u32) -> Option<ShellAction> {
        let cols = cols.max(MIN_COLS);
        let rows = rows.max(MIN_ROWS);
        if cols == self.cols && rows == self.rows {
            return None;
        }
        self.cols = cols;
        self.rows = rows;
        self.screen.resize(cols as usize, rows as usize);
        self.revision += 1;
        self.attached.then_some(ShellAction::Resize { cols, rows })
    }

    pub fn key(&self, key: VtKey) -> Option<ShellAction> {
        self.write(self.screen.encode(key))
    }

    pub fn text(&self, text: &str) -> Option<ShellAction> {
        self.write(text.to_owned())
    }

    pub fn paste(&self, text: &str) -> Option<ShellAction> {
        self.write(self.screen.encode_paste(text))
    }

    fn write(&self, data: String) -> Option<ShellAction> {
        (self.can_type() && !data.is_empty()).then_some(ShellAction::Write(data))
    }

    // The size the gateway settled on wins: it is this attach's size unless another client attached in the same
    // breath, and a grid that does not match the process wraps every line in the wrong column.
    pub fn attached(&mut self, frame: &ShellAttachedFrame) -> Option<ShellAction> {
        self.phase = match frame.shell.status {
            ShellStatus::Running => ShellPhase::Live,
            ShellStatus::Exited | ShellStatus::Unknown => ShellPhase::Ended("ended".into()),
        };
        self.shell = Some(frame.shell.clone());
        self.cols = frame.cols.max(1) as u32;
        self.rows = frame.rows.max(1) as u32;
        self.screen.resize(self.cols as usize, self.rows as usize);
        self.output(&frame.scrollback)
    }

    // A program's queries (cursor position, device attributes) are answered by typing back into the PTY.
    pub fn output(&mut self, data: &str) -> Option<ShellAction> {
        self.screen.feed(data);
        self.revision += 1;
        let response = self.screen.take_responses();
        (!response.is_empty()).then_some(ShellAction::Write(response))
    }

    pub fn detached(&mut self, reason: String) {
        self.attached = false;
        self.phase = ShellPhase::Ended(reason);
        self.revision += 1;
    }

    // An attach is per socket, so a reconnect leaves a watching screen attached to nothing.
    pub fn reconnected(&self) -> Option<ShellAction> {
        self.attached.then_some(ShellAction::Attach { cols: self.cols, rows: self.rows })
    }

    // The record is the authority on why a stream ended; the detach reason is only how this socket found out.
    pub fn set_record(&mut self, shell: Option<ShellInfo>) {
        if let Some(shell) = shell {
            self.shell = Some(shell);
            self.revision += 1;
        }
    }
}

pub fn label(shell: &ShellInfo) -> String {
    label_of(Some(&shell.label), &shell.command)
}

pub fn title(shell: &ShellInfo) -> String {
    format!("#{} {}", shell.ordinal, label(shell))
}

pub fn status_text(shell: &ShellInfo) -> String {
    let end_reason = shell.end_reason.map(|reason| match reason {
        ShellEndReason::Exit => "exit",
        ShellEndReason::Killed => "killed",
        ShellEndReason::Timeout => "timeout",
        ShellEndReason::ServerStopped => "server_stopped",
        ShellEndReason::ServerRestarted => "server_restarted",
        ShellEndReason::SpawnFailed => "spawn_failed",
        ShellEndReason::Unknown => "unknown",
    });
    status_words(shell.status == ShellStatus::Running, shell.exit_code.map(i64::from), end_reason)
}
