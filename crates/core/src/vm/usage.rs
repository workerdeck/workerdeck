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
