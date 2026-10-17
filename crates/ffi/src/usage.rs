// The session's meters for a native app: the context reading, the plan windows (the account's reading from
// `GET /v1/profiles` merged over the transcript's own), and what the session cost. The rules are `vm::usage`,
// `vm::pricing` and `vm::session_cost`; the platform only fetches the profiles body and draws.
use crate::Session;
use serde_json::Value;
use wd_native::planner::{fmt_cost, fmt_tokens};
use wd_native::rest::{ByModel, Entries, ProfileEngine, ProfileUsage, RateLimitInfo};
use wd_native::vm::fmt;
use wd_native::vm::pricing::{
    PRICING_AS_OF, PricingTable, SubscriptionComparison, default_pricing, merge_pricing, pricing_age_note, pricing_note,
};
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
    pub label: String,
    pub long_label: String,
    pub initial: String,
    pub percent_text: String,
    pub used_text: String,
    pub fill: f64,
    pub bar_severity: Severity,
    // The elapsed share of the window, drawn as a marker over the bar.
    pub pace: Option<f64>,
    pub reset_text: Option<String>,
    pub fresh_text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ContextSlice {
    pub name: String,
    pub tokens: i64,
    pub color: String,
    pub tokens_text: String,
    pub fill: f64,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct ContextView {
    pub total_tokens: i64,
    pub max_tokens: i64,
    pub percentage: f64,
    pub model: Option<String>,
    pub categories: Vec<ContextSlice>,
    pub severity: Severity,
    pub ring_label: String,
    pub percent_text: String,
    pub used_text: String,
    pub fill: f64,
    pub bar_severity: Severity,
    pub accessibility_label: String,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct CostModelRow {
    pub model: String,
    pub tokens: f64,
    pub cost_usd: Option<f64>,
    pub text: String,
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
    pub display_text: String,
    pub input_text: String,
    pub output_text: String,
    pub cache_write_text: String,
    pub cache_read_text: String,
    pub unpriced_text: Option<String>,
    pub unknown_basis_text: Option<String>,
    pub gap_text: Option<String>,
}

#[derive(Debug, Clone, PartialEq, uniffi::Record)]
pub struct SpendView {
    pub week_usd: f64,
    pub month_usd: f64,
    pub monthly_usd: Option<f64>,
    pub weekly_share_usd: Option<f64>,
    pub ratio: Option<f64>,
    pub week_text: String,
    pub month_text: String,
    pub ratio_text: Option<String>,
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
    pub engine_name: String,
    pub windows_empty_text: String,
    // The status line's reading: the windows' rings spoken, else the session's cost when it has one.
    pub hud_label: String,
    pub hud_cost_text: Option<String>,
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

fn capitalized(text: &str) -> String {
    let mut chars = text.chars();
    chars.next().map(|first| first.to_uppercase().chain(chars).collect()).unwrap_or_default()
}

// A subscription is a flat fee, so the ratio is leverage, not a bill.
fn ratio_text(ratio: f64, weekly_share_usd: f64, monthly_usd: f64) -> String {
    let times = if ratio >= 10.0 { format!("{}x", ratio.round() as i64) } else { format!("{ratio:.1}x") };
    format!(
        "{times} the {} weekly share of your {} a month. A subscription is a flat fee, so this is leverage, not a bill.",
        fmt_cost(Some(weekly_share_usd)),
        fmt_cost(Some(monthly_usd))
    )
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
            let stale = usage::usage_is_stale(w.updated_at, inferred, now_ms);
            let utilization = w.info.utilization.unwrap_or(0.0);
            let updated_at = w.updated_at.filter(|at| *at > 0.0);
            UsageWindowView {
                label: usage::window_label(&w.key),
                long_label: usage::window_label_long(&w.key),
                initial: usage::window_initial(&w.key),
                percent_text: fmt::percent(utilization),
                used_text: format!("{} used", fmt::percent(utilization)),
                fill: usage::fill(utilization),
                bar_severity: usage::bar_severity(utilization).into(),
                pace: usage::pace(&w.key, w.info.resets_at, now_ms),
                reset_text: w.info.resets_at.and_then(|at| fmt::resets(at, now_ms)),
                fresh_text: if inferred {
                    Some("window reset \u{00B7} nothing reported since".to_owned())
                } else {
                    updated_at.map(|at| format!("{}{}", if stale { "last reported " } else { "" }, fmt::ago_precise(at, now_ms)))
                },
                stale,
                severity: usage::meter_severity(w.info.utilization).into(),
                key: w.key,
                utilization,
                status: w.info.status,
                resets_at: w.info.resets_at,
                overage: w.info.is_using_overage == Some(true),
                updated_at,
                inferred_reset: inferred,
            }
        })
        .collect::<Vec<UsageWindowView>>();
    let context = state.context_usage.as_ref().map(|c| ContextView {
        ring_label: usage::ring_label(c.percentage),
        percent_text: fmt::percent(c.percentage),
        used_text: format!("{} / {}", fmt_tokens(c.total_tokens as f64), fmt_tokens(c.max_tokens as f64)),
        fill: usage::fill(c.percentage),
        bar_severity: usage::bar_severity(c.percentage).into(),
        accessibility_label: format!("Context {} used", fmt::percent(c.percentage)),
        total_tokens: c.total_tokens,
        max_tokens: c.max_tokens,
        percentage: c.percentage,
        model: c.model.clone(),
        categories: c
            .categories
            .iter()
            .map(|(name, tokens, color)| ContextSlice {
                name: name.clone(),
                tokens: *tokens,
                color: color.clone(),
                tokens_text: fmt_tokens(*tokens as f64),
                fill: (*tokens as f64 / c.max_tokens.max(1) as f64).clamp(0.0, 1.0),
            })
            .collect(),
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
        week_text: fmt_cost(Some(s.week_usd)),
        month_text: fmt_cost(Some(s.month_usd)),
        ratio_text: s.subscription.map(|c| ratio_text(c.ratio, c.weekly_share_usd, c.monthly_usd)),
        week_usd: s.week_usd,
        month_usd: s.month_usd,
        monthly_usd: s.subscription.map(|c| c.monthly_usd),
        weekly_share_usd: s.subscription.map(|c| c.weekly_share_usd),
        ratio: s.subscription.map(|c| c.ratio),
    });
    let note = pricing_note();
    let engine_label = if claude { "Claude Code".to_owned() } else { capitalized(&engine) };
    let hud_label = windows.iter().take(3).map(|w| format!("{} {}", w.label, w.percent_text)).collect::<Vec<_>>().join(", ");
    let hud_cost_text = cost.display_usd.filter(|usd| windows.is_empty() && *usd > 0.0).map(|usd| fmt_cost(Some(usd)));
    let windows_empty_text = if claude {
        "No plan windows reported. API-key profiles have none, and a subscription account reports them once any of its sessions has run a turn.".to_owned()
    } else {
        format!("Plan windows are a claude.ai subscription thing; this session runs on the {engine} engine.")
    };
    SessionUsageView {
        engine_name: engine_label.clone(),
        windows_empty_text,
        hud_label,
        hud_cost_text,
        profile,
        subscription_type: state.subscription_type.clone(),
        rate_limits: capabilities.map_or(claude, |c| c.rate_limits),
        context_usage: capabilities.map_or(claude, |c| c.context_usage),
        context,
        windows,
        cost: CostView {
            display_text: cost.display_usd.map_or_else(|| "none".to_owned(), |usd| fmt_cost(Some(usd))),
            input_text: fmt_cost(Some(cost.breakdown.input)),
            output_text: fmt_cost(Some(cost.breakdown.output)),
            cache_write_text: fmt_cost(Some(cost.breakdown.cache_write)),
            cache_read_text: fmt_cost(Some(cost.breakdown.cache_read)),
            unpriced_text: cost.show_unpriced_warning.then(|| {
                format!(
                    "{}% of these tokens ran on a model with no bundled rate, so the total is an understatement rather than an estimate.",
                    (cost.unpriced_share * 100.0).round() as i64
                )
            }),
            unknown_basis_text: (!cost.unknown_basis_models.is_empty()).then(|| {
                format!(
                    "{engine_label} matched no rate table of its own to {}, so the figure it reports for those tokens is a guess rather than a rate.",
                    cost.unknown_basis_models.join(", ")
                )
            }),
            gap_text: cost
                .gap_usd
                .and(cost.reported_usd)
                .map(|reported| format!("{engine_label} reports {} for the same tokens.", fmt_cost(Some(reported)))),
            display_usd: cost.display_usd,
            reported_usd: cost.reported_usd,
            input: cost.breakdown.input,
            output: cost.breakdown.output,
            cache_write: cost.breakdown.cache_write,
            cache_read: cost.breakdown.cache_read,
            rows: cost
                .rows
                .into_iter()
                .map(|r| CostModelRow {
                    text: format!("{} \u{00B7} {}", fmt_tokens(r.tokens), r.cost_usd.map_or_else(|| "no rate".to_owned(), |usd| fmt_cost(Some(usd)))),
                    model: r.model,
                    tokens: r.tokens,
                    cost_usd: r.cost_usd,
                })
                .collect(),
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

// A ring or a number over a 0-100 reading, for a list row that holds only the percentage.
#[uniffi::export]
pub fn meter_severity(percentage: f64) -> Severity {
    usage::meter_severity(Some(percentage)).into()
}

#[uniffi::export]
pub fn ring_label(percentage: f64) -> String {
    usage::ring_label(percentage)
}

#[uniffi::export]
pub fn percent_text(value: f64) -> String {
    fmt::percent(value)
}
