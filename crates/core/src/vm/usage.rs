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

    fn info() -> RateLimitInfo {
        RateLimitInfo { status: String::new(), rate_limit_type: None, utilization: None, resets_at: None, is_using_overage: None }
    }
}
