use crate::rest::{Entries, ProfileUsage, ProfileUsageWindow, RateLimitInfo};
use crate::vm::collate::locale_compare;
use serde::{Deserialize, Serialize};

pub const USAGE_STALE_AFTER_MS: f64 = 15.0 * 60_000.0;

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionUsage {
    #[serde(default)]
    pub rate_limits: Option<Entries<RateLimitInfo>>,
    #[serde(default)]
    pub updated_at: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindowRow {
    pub key: String,
    pub info: RateLimitInfo,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inferred_reset: Option<bool>,
}

pub fn merge_usage(session: &SessionUsage, profile: Option<&ProfileUsage>) -> ProfileUsage {
    let mut out = Entries::new();
    for (key, info) in session.rate_limits.iter().flat_map(Entries::iter) {
        out.set(
            key.clone(),
            ProfileUsageWindow { info: info.clone(), updated_at: session.updated_at.unwrap_or(0.0), inferred_reset: None },
        );
    }
    for (key, window) in profile.into_iter().flat_map(Entries::iter) {
        out.set(key.clone(), window.clone());
    }
    out
}

pub fn usage_is_stale(updated_at: Option<f64>, inferred_reset: bool, now: f64) -> bool {
    match updated_at {
        Some(at) if !inferred_reset => now - at > USAGE_STALE_AFTER_MS,
        _ => false,
    }
}

pub fn order_usage_windows(usage: Option<&ProfileUsage>) -> Vec<UsageWindowRow> {
    let all: Vec<UsageWindowRow> = usage
        .into_iter()
        .flat_map(Entries::iter)
        .filter(|(_, w)| w.info.utilization.is_some())
        .map(|(key, w)| UsageWindowRow {
            key: key.clone(),
            info: w.info.clone(),
            updated_at: Some(w.updated_at),
            inferred_reset: w.inferred_reset,
        })
        .collect();
    let mut out: Vec<UsageWindowRow> =
        ["five_hour", "seven_day"].iter().flat_map(|key| all.iter().filter(move |w| w.key == *key).cloned()).collect();
    let mut per_model: Vec<UsageWindowRow> = all.into_iter().filter(|w| w.key.starts_with("seven_day_")).collect();
    per_model.sort_by(|a, b| locale_compare(&a.key, &b.key));
    out.extend(per_model);
    out
}

pub fn usage_infos(usage: Option<&ProfileUsage>) -> Option<Entries<RateLimitInfo>> {
    let usage = usage?;
    Some(Entries(usage.iter().map(|(key, window)| (key.clone(), window.info.clone())).collect()))
}

// How alarming a reading is: `meterSeverity` in `packages/ui/src/lib/status.ts`. A number or a ring turns at 80/95,
// later than a bar's fill does.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum MeterSeverity {
    None,
    Warning,
    Error,
}

pub fn meter_severity(percentage: Option<f64>) -> MeterSeverity {
    match percentage {
        Some(p) if p >= 95.0 => MeterSeverity::Error,
        Some(p) if p >= 80.0 => MeterSeverity::Warning,
        _ => MeterSeverity::None,
    }
}

// A bar's fill turns earlier than a number or a ring: `meterTintClass`, 70/90.
pub fn bar_severity(percentage: f64) -> MeterSeverity {
    if percentage >= 90.0 {
        MeterSeverity::Error
    } else if percentage >= 70.0 {
        MeterSeverity::Warning
    } else {
        MeterSeverity::None
    }
}

// Three digits do not fit inside a ring, and a window that full says the same thing either way.
pub fn ring_label(percentage: f64) -> String {
    (percentage.round() as i64).clamp(0, 99).to_string()
}

pub fn fill(percentage: f64) -> f64 {
    (percentage / 100.0).clamp(0.0, 1.0)
}

fn title_words(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut boundary = true;
    for ch in text.chars() {
        let word = ch.is_ascii_alphanumeric() || ch == '_';
        out.extend(if boundary && word { ch.to_uppercase().collect::<Vec<_>>() } else { vec![ch] });
        boundary = !word;
    }
    out
}

// `formatRateLimitWindow`: 'five_hour' is "5h", 'seven_day_opus' "7d opus".
pub fn window_label(key: &str) -> String {
    match key {
        "five_hour" => "5h".to_owned(),
        "seven_day" => "7d".to_owned(),
        _ => match key.strip_prefix("seven_day_") {
            Some(model) => format!("7d {}", model.replace('_', " ")),
            None => key.replace('_', " "),
        },
    }
}

// `formatRateLimitWindowLong`: 'five_hour' is "5-hour session", 'seven_day_fable' "Weekly \u{00B7} Fable".
pub fn window_label_long(key: &str) -> String {
    match key {
        "five_hour" => "5-hour session".to_owned(),
        "seven_day" => "Weekly".to_owned(),
        "seven_day_oauth_apps" => "Weekly \u{00B7} apps".to_owned(),
        _ => match key.strip_prefix("seven_day_") {
            Some(model) => format!("Weekly \u{00B7} {}", title_words(&model.replace('_', " "))),
            None => title_words(&key.replace('_', " ")),
        },
    }
}

// The ring's letter: S for the session window, W for the weekly, a per-model weekly its model's initial.
pub fn window_initial(key: &str) -> String {
    match key {
        "five_hour" => "S".to_owned(),
        "seven_day" => "W".to_owned(),
        _ => key.strip_prefix("seven_day_").and_then(|m| m.chars().next()).map_or_else(|| "?".to_owned(), |c| c.to_uppercase().collect()),
    }
}

// Derived from the key, never reported: the CLI sends a reset time and a share, not a duration.
pub fn window_seconds(key: &str) -> Option<f64> {
    if key == "five_hour" {
        Some(5.0 * 3600.0)
    } else if key.starts_with("seven_day") {
        Some(7.0 * 86_400.0)
    } else {
        None
    }
}

// The elapsed share of the window, where usage would sit if it were spent evenly.
pub fn pace(key: &str, resets_at: Option<f64>, now_ms: f64) -> Option<f64> {
    let duration = window_seconds(key)?;
    let remaining = resets_at? - now_ms / 1000.0;
    (remaining > 0.0 && remaining < duration).then(|| (duration - remaining) / duration)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn severity_turns_at_eighty_and_ninety_five() {
        assert_eq!(meter_severity(None), MeterSeverity::None);
        assert_eq!(meter_severity(Some(79.9)), MeterSeverity::None);
        assert_eq!(meter_severity(Some(80.0)), MeterSeverity::Warning);
        assert_eq!(meter_severity(Some(94.9)), MeterSeverity::Warning);
        assert_eq!(meter_severity(Some(95.0)), MeterSeverity::Error);
    }

    #[test]
    fn a_transcript_reading_without_a_clock_is_dated_zero() {
        let mut limits = Entries::new();
        limits.set("five_hour".to_owned(), RateLimitInfo { status: "allowed".into(), utilization: Some(10.0), ..info() });
        let merged = merge_usage(&SessionUsage { rate_limits: Some(limits), updated_at: None }, None);
        assert_eq!(merged.get("five_hour").map(|w| w.updated_at), Some(0.0));
    }

    #[test]
    fn window_keys_read_short_long_and_as_a_letter() {
        assert_eq!(window_label("seven_day_opus"), "7d opus");
        assert_eq!(window_label_long("seven_day_fable_max"), "Weekly \u{00B7} Fable Max");
        assert_eq!(window_label_long("seven_day_oauth_apps"), "Weekly \u{00B7} apps");
        assert_eq!(window_label_long("odd_key"), "Odd Key");
        assert_eq!(
            (window_initial("five_hour"), window_initial("seven_day_opus"), window_initial("x")),
            ("S".into(), "O".into(), "?".into())
        );
        assert_eq!(pace("five_hour", Some(3.0 * 3600.0), 0.0), Some(0.4));
        assert_eq!(pace("five_hour", Some(6.0 * 3600.0), 0.0), None);
        assert_eq!(pace("odd", Some(10.0), 0.0), None);
        assert_eq!((ring_label(99.6), ring_label(-3.0)), ("99".into(), "0".into()));
        assert_eq!(
            (bar_severity(69.9), bar_severity(70.0), bar_severity(90.0)),
            (MeterSeverity::None, MeterSeverity::Warning, MeterSeverity::Error)
        );
    }

    fn info() -> RateLimitInfo {
        RateLimitInfo { status: String::new(), rate_limit_type: None, utilization: None, resets_at: None, is_using_overage: None }
    }
}
