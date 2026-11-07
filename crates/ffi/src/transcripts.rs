// The last few closed sessions' transcripts, newest last, shared by every Session in the process: reopening one resumes
// after its last seq instead of replaying the whole log over a slow link. With a directory set, each kept transcript is
// also written there, so the next launch of the app starts from it too.
use std::path::{Path, PathBuf};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Mutex, MutexGuard};
use wd_native::controller::live::TranscriptSnapshot;

// A big session's snapshot holds ~1 MB of heap and under 1 MB on disk.
const CACHED_SESSIONS: usize = 16;
const SUFFIX: &str = ".transcript.json";

static MEMORY: Mutex<Vec<(String, TranscriptSnapshot)>> = Mutex::new(Vec::new());
static DISK: Mutex<Option<Disk>> = Mutex::new(None);

struct Disk {
    dir: PathBuf,
    build: String,
    writes: Sender<(String, TranscriptSnapshot)>,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

// `build` names the app build: a transcript written by another one is dropped, never read.
#[uniffi::export]
pub fn set_transcript_store(dir: String, build: String) {
    let dir = PathBuf::from(dir);
    if std::fs::create_dir_all(&dir).is_err() {
        return;
    }
    let (writes, queue) = channel::<(String, TranscriptSnapshot)>();
    let (target, stamp) = (dir.clone(), build.clone());
    std::thread::spawn(move || {
        for (key, snapshot) in queue {
            write(&target, &stamp, &key, &snapshot);
        }
    });
    *lock(&DISK) = Some(Disk { dir, build, writes });
}

pub(crate) fn take(key: &str) -> Option<TranscriptSnapshot> {
    {
        let mut memory = lock(&MEMORY);
        if let Some(at) = memory.iter().position(|(k, _)| k == key) {
            return Some(memory.remove(at).1);
        }
    }
    let disk = lock(&DISK);
    let disk = disk.as_ref()?;
    let path = file(&disk.dir, key);
    let bytes = std::fs::read(&path).ok()?;
    let snapshot = TranscriptSnapshot::decode(&bytes, &disk.build, key);
    if snapshot.is_none() {
        let _ = std::fs::remove_file(&path);
    }
    snapshot
}

pub(crate) fn keep(key: String, snapshot: TranscriptSnapshot) {
    if let Some(disk) = lock(&DISK).as_ref() {
        let _ = disk.writes.send((key.clone(), snapshot.clone()));
    }
    let mut memory = lock(&MEMORY);
    memory.retain(|(k, _)| *k != key);
    memory.push((key, snapshot));
    let over = memory.len().saturating_sub(CACHED_SESSIONS);
    memory.drain(..over);
}

fn file(dir: &Path, key: &str) -> PathBuf {
    let hash = key.bytes().fold(0xcbf2_9ce4_8422_2325_u64, |hash, byte| (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3));
    dir.join(format!("{hash:016x}{SUFFIX}"))
}

fn write(dir: &Path, build: &str, key: &str, snapshot: &TranscriptSnapshot) {
    let path = file(dir, key);
    let partial = path.with_extension("partial");
    if std::fs::write(&partial, snapshot.encode(build, key)).is_err() || std::fs::rename(&partial, &path).is_err() {
        let _ = std::fs::remove_file(&partial);
        return;
    }
    prune(dir);
}

fn prune(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let mut files: Vec<(std::time::SystemTime, PathBuf)> = entries
        .filter_map(|entry| {
            let entry = entry.ok()?;
            entry.file_name().to_str()?.ends_with(SUFFIX).then_some(())?;
            Some((entry.metadata().ok()?.modified().ok()?, entry.path()))
        })
        .collect();
    files.sort_by_key(|(modified, _)| std::cmp::Reverse(*modified));
    for (_, path) in files.into_iter().skip(CACHED_SESSIONS) {
        let _ = std::fs::remove_file(path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use wd_native::controller::live::LiveSession;
    use wd_native::planner::Metrics;

    fn snapshot() -> TranscriptSnapshot {
        let mut live = LiveSession::new(0, true, "n".into(), Metrics { cell: 8.0, line: 16.0, width: 800.0, font_size: 13.0 }, None);
        live.opened();
        live.received(
            r#"{"type":"attached","protocolVersion":2,"replayingFrom":0,"session":{"id":"s1","status":"idle","cwd":"/r","createdAt":1,"lastSeq":1,"epoch":1,"pendingPermissionCount":0}}"#,
            0.0,
        );
        live.received(
            r#"{"type":"event","event":{"seq":1,"ts":1,"type":"user_message","message":{"role":"user","content":"hi"},"parentToolUseId":null,"uuid":"u1"}}"#,
            0.0,
        );
        live.snapshot().expect("a snapshot")
    }

    #[test]
    fn a_kept_transcript_survives_the_process_and_another_build_drops_it() {
        let dir = std::env::temp_dir().join(format!("wd-transcripts-{}", std::process::id()));
        set_transcript_store(dir.to_string_lossy().into_owned(), "b1".into());
        keep("gw disk".into(), snapshot());
        let path = file(&dir, "gw disk");
        for _ in 0..200 {
            if path.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        lock(&MEMORY).retain(|(k, _)| k != "gw disk");
        assert_eq!(take("gw disk").map(|s| s.last_seq()), Some(1));

        set_transcript_store(dir.to_string_lossy().into_owned(), "b2".into());
        assert!(take("gw disk").is_none());
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn the_file_name_is_stable_per_key() {
        let dir = Path::new("/d");
        assert_eq!(file(dir, "gw s1"), file(dir, "gw s1"));
        assert_ne!(file(dir, "gw s1"), file(dir, "gw s2"));
        assert!(file(dir, "gw s1").to_str().unwrap().ends_with(SUFFIX));
    }
}
