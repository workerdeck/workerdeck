pub fn ago(epoch_ms: f64, now_ms: f64) -> String {
    elapsed((now_ms - epoch_ms) / 1000.0)
}

fn elapsed(seconds: f64) -> String {
    if seconds < 60.0 {
        return "just now".to_owned();
    }
    if seconds < 3600.0 {
        return format!("{}m", (seconds / 60.0) as i64);
    }
    if seconds < 86_400.0 {
        return format!("{}h", (seconds / 3600.0) as i64);
    }
    format!("{}d", (seconds / 86_400.0) as i64)
}

pub fn until(epoch_seconds: f64, now_ms: f64) -> Option<String> {
    let remaining = epoch_seconds - now_ms / 1000.0;
    if remaining <= 0.0 {
        return None;
    }
    if remaining < 3600.0 {
        return Some(format!("in {}m", (remaining / 60.0) as i64));
    }
    let hours = (remaining / 3600.0) as i64;
    let minutes = ((remaining - hours as f64 * 3600.0) / 60.0) as i64;
    if hours < 24 {
        return Some(if minutes == 0 { format!("in {hours}h") } else { format!("in {hours}h {minutes}m") });
    }
    Some(format!("in {}d {}h", hours / 24, hours % 24))
}
