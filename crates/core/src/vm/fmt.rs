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

pub fn percent(value: f64) -> String {
    format!("{}%", value.round() as i64)
}

// The usage sheet's freshness line, finer than `ago`: a poll that just landed should say so.
pub fn ago_precise(epoch_ms: f64, now_ms: f64) -> String {
    let seconds = ((now_ms - epoch_ms) / 1000.0).max(0.0) as i64;
    let unit = |count: i64, one: &str| format!("{count} {one}{} ago", if count == 1 { "" } else { "s" });
    if seconds < 60 {
        unit(seconds, "sec")
    } else if seconds < 3600 {
        unit(seconds / 60, "min")
    } else {
        unit(seconds / 3600, "hour")
    }
}

pub fn resets(epoch_seconds: f64, now_ms: f64) -> Option<String> {
    until(epoch_seconds, now_ms).map(|until| format!("Resets {until}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn precise_ago_counts_seconds_minutes_and_hours() {
        assert_eq!(ago_precise(0.0, 1_000.0), "1 sec ago");
        assert_eq!(ago_precise(5_000.0, 1_000.0), "0 secs ago");
        assert_eq!(ago_precise(0.0, 180_000.0), "3 mins ago");
        assert_eq!(ago_precise(0.0, 3_600_000.0), "1 hour ago");
        assert_eq!(percent(41.5), "42%");
        assert_eq!(resets(3600.0 * 3.0, 0.0).as_deref(), Some("Resets in 3h"));
        assert_eq!(resets(10.0, 20_000.0), None);
    }
}
