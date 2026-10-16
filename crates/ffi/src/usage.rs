// The session's meters for a native app: the context reading, the plan windows (the account's reading from
// `GET /v1/profiles` merged over the transcript's own), and what the session cost. The rules are `vm::usage`,
// `vm::pricing` and `vm::session_cost`; the platform only fetches the profiles body and draws.
use crate::Session;
use serde_json::Value;
use wd_native::rest::{ByModel, Entries, ProfileEngine, ProfileUsage, RateLimitInfo};
use wd_native::vm::pricing::{PRICING_AS_OF, PricingTable, SubscriptionComparison, default_pricing, merge_pricing, pricing_age_note, pricing_note};
use wd_native::vm::session_cost::session_cost;
use wd_native::vm::usage::{self, SessionUsage};

#[derive(Debug, Clone, Copy, PartialEq, Eq, uniffi::Enum)]
pub enum Severity {
    None,
    Warning,
    Error,
}

impl From<usage::MeterSeverity> for Severity {
    fn from(severity: usage::MeterSeverity) -> Self {
        match severity {
            usage::MeterSeverity::None => Severity::None,
            usage::MeterSeverity::Warning => Severity::Warning,
            usage::MeterSeverity::Error => Severity::Error,
        }
    }
}

// One plan window, in reading order. `updated_at` is the reading's own time (0: a transcript with no clock).
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct UsageWindowView {
    pub key: String,
    pub utilization: f64,
    pub status: String,
    pub resets_at: Option<f64>,
    pub overage: bool,
    pub updated_at: Option<f64>,
    pub inferred_reset: bool,
    pub stale: bool,
    pub severity: Severity,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ContextSlice {
    pub name: String,
    pub tokens: i64,
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ContextView {
    pub total_tokens: i64,
    pub max_tokens: i64,
    pub percentage: f64,
    pub model: Option<String>,
    pub categories: Vec<ContextSlice>,
    pub severity: Severity,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct CostModelRow {
    pub model: String,
    pub tokens: f64,
    pub cost_usd: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct CostView {
    pub display_usd: Option<f64>,
    pub reported_usd: Option<f64>,
    pub input: f64,
    pub output: f64,
    pub cache_write: f64,
    pub cache_read: f64,
    pub rows: Vec<CostModelRow>,
    pub unpriced_share: f64,
    pub show_unpriced_warning: bool,
    pub unknown_basis_models: Vec<String>,
    pub gap_usd: Option<f64>,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct SpendView {
    pub week_usd: f64,
    pub month_usd: f64,
    pub monthly_usd: Option<f64>,
    pub weekly_share_usd: Option<f64>,
    pub ratio: Option<f64>,
}

// `profile` and `rate_limits` say whether polling `GET /v1/profiles` is worth it: an engine without plan windows, or
// a session without a profile, has nothing to ask for.
#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct SessionUsageView {
    pub engine: String,
    pub profile: Option<String>,
    pub subscription_type: Option<String>,
    pub rate_limits: bool,
    pub context_usage: bool,
    pub context: Option<ContextView>,
    pub windows: Vec<UsageWindowView>,
    pub cost: CostView,
    pub spend: Option<SpendView>,
    pub pricing_note: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct Spend {
    week_usd: f64,
    month_usd: f64,
    #[serde(default)]
    subscription: Option<SubscriptionComparison>,
}

// The profile rows of a `GET /v1/profiles` body, kept raw so one row that does not decode loses only itself.
pub(crate) fn profile_rows(body: &str) -> Option<Vec<Value>> {
    let answer = serde_json::from_str::<Value>(body).ok()?;
    answer.get("profiles")?.as_array().cloned()
}

fn profile_row<'a>(rows: &'a [Value], name: &str) -> Option<&'a Value> {
    rows.iter().find(|row| row.get("name").and_then(Value::as_str) == Some(name))
}

fn engine_name(engine: ProfileEngine) -> String {
    serde_json::to_value(engine).ok().and_then(|v| v.as_str().map(str::to_owned)).unwrap_or_else(|| "claude".to_owned())
}

pub(crate) fn usage_view(live: &wd_native::controller::live::LiveSession, profiles: Option<&[Value]>, now_ms: f64) -> SessionUsageView {
    let state = live.state();
    let info = live.session_info();
    let engine = state.engine.or(info.and_then(|i| i.engine)).map_or_else(|| "claude".to_owned(), engine_name);
    let claude = engine == "claude";
    let capabilities = state.capabilities.as_ref();
    let profile = info.and_then(|i| i.profile.clone());
    let row = profile.as_deref().and_then(|name| profile_row(profiles?, name));
    let account: Option<ProfileUsage> = row.and_then(|r| serde_json::from_value(r.get("usage")?.clone()).ok());
    let mut limits = Entries::new();
    for (key, value) in &state.rate_limits {
        if let Ok(info) = serde_json::from_value::<RateLimitInfo>((**value).clone()) {
            limits.set(key.clone(), info);
        }
    }
    let session = SessionUsage { rate_limits: Some(limits), updated_at: state.rate_limits_updated_at };
    let merged = usage::merge_usage(&session, account.as_ref());
    let windows = usage::order_usage_windows(Some(&merged))
        .into_iter()
        .map(|w| {
            let inferred = w.inferred_reset == Some(true);
            UsageWindowView {
                stale: usage::usage_is_stale(w.updated_at, inferred, now_ms),
                severity: usage::meter_severity(w.info.utilization).into(),
                key: w.key,
                utilization: w.info.utilization.unwrap_or(0.0),
                status: w.info.status,
                resets_at: w.info.resets_at,
                overage: w.info.is_using_overage == Some(true),
                updated_at: w.updated_at.filter(|at| *at > 0.0),
                inferred_reset: inferred,
            }
        })
        .collect();
    let context = state.context_usage.as_ref().map(|c| ContextView {
        total_tokens: c.total_tokens,
        max_tokens: c.max_tokens,
        percentage: c.percentage,
        model: c.model.clone(),
        categories: c.categories.iter().map(|(name, tokens, color)| ContextSlice { name: name.clone(), tokens: *tokens, color: color.clone() }).collect(),
        severity: usage::meter_severity(Some(c.percentage)).into(),
    });
    let pricing: PricingTable = match live.pricing_overrides() {
        Some(overrides) => merge_pricing(overrides, &default_pricing()).pricing,
        None => default_pricing(),
    };
    let by_model: Option<ByModel> = state.usage_by_model.as_ref().and_then(|v| serde_json::from_value((**v).clone()).ok());
    let reported = (state.total_cost_usd > 0.0).then_some(state.total_cost_usd);
    let cost = session_cost(state.cost_usd, reported, by_model.as_ref(), &pricing);
    let spend = row.and_then(|r| serde_json::from_value::<Spend>(r.get("spend")?.clone()).ok()).map(|s| SpendView {
        week_usd: s.week_usd,
        month_usd: s.month_usd,
        monthly_usd: s.subscription.map(|c| c.monthly_usd),
        weekly_share_usd: s.subscription.map(|c| c.weekly_share_usd),
        ratio: s.subscription.map(|c| c.ratio),
    });
    let note = pricing_note();
    SessionUsageView {
        profile,
        subscription_type: state.subscription_type.clone(),
        rate_limits: capabilities.map_or(claude, |c| c.rate_limits),
        context_usage: capabilities.map_or(claude, |c| c.context_usage),
        context,
        windows,
        cost: CostView {
            display_usd: cost.display_usd,
            reported_usd: cost.reported_usd,
            input: cost.breakdown.input,
            output: cost.breakdown.output,
            cache_write: cost.breakdown.cache_write,
            cache_read: cost.breakdown.cache_read,
            rows: cost.rows.into_iter().map(|r| CostModelRow { model: r.model, tokens: r.tokens, cost_usd: r.cost_usd }).collect(),
            unpriced_share: cost.unpriced_share,
            show_unpriced_warning: cost.show_unpriced_warning,
            unknown_basis_models: cost.unknown_basis_models,
            gap_usd: cost.gap_usd,
        },
        spend,
        pricing_note: match pricing_age_note(now_ms, PRICING_AS_OF) {
            Some(age) => format!("{note} {age}"),
            None => note,
        },
        engine,
    }
}

#[uniffi::export]
impl Session {
    // The body of `GET /v1/profiles`, as received; the session's own profile row is read from it at `usage` time.
    // False when the body is not a profiles list, which leaves the last reading in place.
    pub fn set_profiles(&self, body: String) -> bool {
        let Some(rows) = profile_rows(&body) else { return false };
        *self.profiles.lock().unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(rows);
        true
    }

    pub fn usage(&self, now_ms: f64) -> SessionUsageView {
        let profiles = self.profiles.lock().unwrap_or_else(|poisoned| poisoned.into_inner()).clone();
        usage_view(&self.live(), profiles.as_deref(), now_ms)
    }
}
