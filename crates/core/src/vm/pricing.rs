use crate::rest::{ByModel, CostBasis, Entries, TokenUsage};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const PRICING_AS_OF: &str = "2026-10-08";
pub const PRICING_SOURCES: &str = "platform.claude.com and developers.openai.com list prices, bundled";
pub const UNPRICED_WARN_SHARE: f64 = 0.005;
pub const PRICING_STALE_DAYS: i64 = 90;

const MTOK: f64 = 1_000_000.0;
const DAY_MS: f64 = 86_400_000.0;
const WEEKS_PER_MONTH: f64 = 52.0 / 12.0;

pub fn pricing_note() -> String {
    format!(
        "List rates as of {PRICING_AS_OF}. A subscription is a flat fee, so this is what the same tokens would have cost on the pay-as-you-go API, not a bill."
    )
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelRate {
    pub input: f64,
    pub output: f64,
    pub cache_write5m: f64,
    pub cache_write1h: f64,
    pub cache_read: f64,
}

#[derive(Debug, Clone, Copy, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CostBreakdown {
    pub input: f64,
    pub output: f64,
    pub cache_write: f64,
    pub cache_read: f64,
    pub total: f64,
    pub unpriced: bool,
    pub unpriced_tokens: f64,
    pub unpriced_share: f64,
}

pub type PricingTable = Entries<ModelRate>;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct PricingMerge {
    pub pricing: PricingTable,
    pub overrides: PricingTable,
    pub dropped: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubscriptionComparison {
    pub weekly_usd: f64,
    pub monthly_usd: f64,
    pub weekly_share_usd: f64,
    pub ratio: f64,
}

fn anthropic(input: f64, output: f64, cache_read: Option<f64>) -> ModelRate {
    ModelRate { input, output, cache_write5m: input * 1.25, cache_write1h: input * 2.0, cache_read: cache_read.unwrap_or(input * 0.1) }
}

fn openai(input: f64, output: f64, cache_read: f64) -> ModelRate {
    ModelRate { input, output, cache_write5m: input, cache_write1h: input, cache_read }
}

pub fn default_pricing() -> PricingTable {
    let rows = [
        ("claude-fable-5-1", anthropic(10.0, 50.0, Some(0.25))),
        ("claude-fable-5", anthropic(10.0, 50.0, None)),
        ("claude-mythos-5-1", anthropic(10.0, 50.0, Some(0.25))),
        ("claude-mythos-5", anthropic(10.0, 50.0, None)),
        ("claude-opus-5-5", anthropic(4.0, 20.0, Some(0.2))),
        ("claude-opus-5", anthropic(5.0, 25.0, None)),
        ("claude-opus-4-8", anthropic(5.0, 25.0, None)),
        ("claude-opus-4-7", anthropic(5.0, 25.0, None)),
        ("claude-opus-4-6", anthropic(5.0, 25.0, None)),
        ("claude-opus-4-5", anthropic(5.0, 25.0, None)),
        ("claude-sonnet-5-5", anthropic(2.0, 10.0, Some(0.1))),
        ("claude-sonnet-5", anthropic(2.0, 10.0, None)),
        ("claude-sonnet-4-6", anthropic(3.0, 15.0, None)),
        ("claude-sonnet-4-5", anthropic(3.0, 15.0, None)),
        ("claude-haiku-5-5", anthropic(0.1, 0.5, None)),
        ("claude-haiku-4-5", anthropic(1.0, 5.0, None)),
        ("gpt-6-astra", openai(10.0, 50.0, 1.0)),
        ("gpt-6-sol", openai(2.0, 10.0, 0.2)),
        ("gpt-6-luna", openai(0.1, 0.5, 0.01)),
        ("gpt-5.6-sol", openai(4.0, 20.0, 0.4)),
        ("gpt-5.6-terra", openai(2.0, 12.0, 0.2)),
        ("gpt-5.6-luna", openai(0.2, 1.2, 0.02)),
        ("gpt-5.5", openai(5.0, 30.0, 0.5)),
        ("gpt-5.4", openai(2.5, 15.0, 0.25)),
        ("gpt-5.2", openai(1.75, 14.0, 0.175)),
        ("gpt-5.1", openai(1.25, 10.0, 0.125)),
        ("gpt-5", openai(1.25, 10.0, 0.125)),
    ];
    Entries(rows.into_iter().map(|(model, rate)| (model.to_owned(), rate)).collect())
}

fn rate_from_input(value: &Value) -> Option<ModelRate> {
    let raw = value.as_object()?;
    let field = |name: &str| raw.get(name).and_then(Value::as_f64).filter(|v| v.is_finite() && *v >= 0.0);
    Some(ModelRate {
        input: field("input")?,
        output: field("output")?,
        cache_write5m: field("cacheWrite5m")?,
        cache_write1h: field("cacheWrite1h")?,
        cache_read: field("cacheRead")?,
    })
}

pub fn merge_pricing(overrides: &Value, base: &PricingTable) -> PricingMerge {
    let mut accepted = Entries::new();
    let mut dropped = Vec::new();
    let entries: Vec<(String, &Value)> = match overrides {
        Value::Object(map) => map.iter().map(|(model, value)| (model.clone(), value)).collect(),
        Value::Array(items) => items.iter().enumerate().map(|(index, value)| (index.to_string(), value)).collect(),
        _ => Vec::new(),
    };
    for (model, value) in entries {
        let key = canonical_model(&model);
        match rate_from_input(value) {
            Some(rate) if !key.is_empty() => accepted.set(key, rate),
            _ => dropped.push(model),
        }
    }
    let mut pricing = base.clone();
    for (model, rate) in accepted.iter() {
        pricing.set(model.clone(), *rate);
    }
    PricingMerge { pricing, overrides: accepted, dropped }
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn parse_date(text: &str) -> Option<f64> {
    let bytes = text.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return None;
    }
    let num = |range: std::ops::Range<usize>| {
        text.get(range).filter(|s| s.bytes().all(|b| b.is_ascii_digit())).and_then(|s| s.parse::<i64>().ok())
    };
    let (year, month, day) = (num(0..4)?, num(5..7)?, num(8..10)?);
    if !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    Some(days_from_civil(year, month, day) as f64 * DAY_MS)
}

pub fn pricing_age_days(now: f64, as_of: &str) -> i64 {
    parse_date(as_of).map(|dated| ((now - dated) / DAY_MS).floor() as i64).unwrap_or(0)
}

pub fn pricing_age_note(now: f64, as_of: &str) -> Option<String> {
    let days = pricing_age_days(now, as_of);
    if days <= PRICING_STALE_DAYS {
        return None;
    }
    Some(format!("This rate table is {days} days old, so check the vendor's current list prices before you trust the total."))
}

fn strip_bracket_suffix(text: &str) -> &str {
    let Some(inner) = text.strip_suffix(']') else {
        return text;
    };
    let from = inner.rfind(']').map(|i| i + 1).unwrap_or(0);
    match inner[from..].find('[') {
        Some(at) => &text[..from + at],
        None => text,
    }
}

fn strip_anthropic_prefix(text: &str) -> &str {
    let parts: Vec<&str> = text.split('.').collect();
    let mut cut = None;
    let mut offset = 0;
    for part in parts.iter().take(parts.len().saturating_sub(1)) {
        if part.is_empty() || !part.bytes().all(|b| b.is_ascii_lowercase()) {
            break;
        }
        offset += part.len() + 1;
        if *part == "anthropic" {
            cut = Some(offset);
        }
    }
    cut.map(|at| &text[at..]).unwrap_or(text)
}

fn strip_date_suffix(text: &str) -> &str {
    let bytes = text.as_bytes();
    if bytes.len() >= 9 {
        let tail = &bytes[bytes.len() - 8..];
        let sep = bytes[bytes.len() - 9];
        if tail.iter().all(u8::is_ascii_digit) && (sep == b'@' || sep == b'-') {
            return &text[..text.len() - 9];
        }
    }
    text
}

fn strip_version_suffix(text: &str) -> &str {
    let Some(at) = text.rfind("-v") else {
        return text;
    };
    let rest = &text[at + 2..];
    match rest.split_once(':') {
        Some((major, minor))
            if !major.is_empty()
                && !minor.is_empty()
                && major.bytes().all(|b| b.is_ascii_digit())
                && minor.bytes().all(|b| b.is_ascii_digit()) =>
        {
            &text[..at]
        }
        _ => text,
    }
}

pub fn canonical_model(model: &str) -> String {
    let bare = model.rsplit('/').next().unwrap_or(model).to_lowercase();
    let step = strip_bracket_suffix(&bare);
    let step = strip_anthropic_prefix(step);
    let step = strip_date_suffix(step);
    strip_version_suffix(step).to_owned()
}

pub fn rate_for(model: Option<&str>, pricing: &PricingTable) -> Option<ModelRate> {
    model.filter(|m| !m.is_empty()).and_then(|m| pricing.get(&canonical_model(m)).copied())
}

pub fn empty_token_usage() -> TokenUsage {
    TokenUsage::default()
}

pub fn total_tokens(usage: &TokenUsage) -> f64 {
    usage.input + usage.output + usage.cache_write5m + usage.cache_write1h + usage.cache_read
}

fn basis_rank(basis: CostBasis) -> u8 {
    match basis {
        CostBasis::List => 0,
        CostBasis::Managed => 1,
        CostBasis::Unknown => 2,
    }
}

pub fn worse_basis(a: Option<CostBasis>, b: Option<CostBasis>) -> Option<CostBasis> {
    match (a, b) {
        (None, b) => b,
        (a, None) => a,
        (Some(a), Some(b)) => Some(if basis_rank(a) >= basis_rank(b) { a } else { b }),
    }
}

pub fn add_token_usage(into: &TokenUsage, add: &TokenUsage) -> TokenUsage {
    TokenUsage {
        input: into.input + add.input,
        output: into.output + add.output,
        cache_write5m: into.cache_write5m + add.cache_write5m,
        cache_write1h: into.cache_write1h + add.cache_write1h,
        cache_read: into.cache_read + add.cache_read,
        cost_basis: worse_basis(into.cost_basis, add.cost_basis),
    }
}

pub fn unknown_basis_models(by_model: &ByModel) -> Vec<String> {
    by_model.iter().filter(|(_, usage)| usage.cost_basis == Some(CostBasis::Unknown)).map(|(model, _)| canonical_model(model)).collect()
}

pub fn merge_by_model(into: &ByModel, add: &ByModel) -> ByModel {
    let mut out = into.clone();
    for (model, usage) in add.iter() {
        let merged = add_token_usage(out.get(model).unwrap_or(&TokenUsage::default()), usage);
        out.set(model.clone(), merged);
    }
    out
}

pub fn by_model_total_tokens(by_model: &ByModel) -> f64 {
    by_model.values().fold(0.0, |total, usage| total + total_tokens(usage))
}

fn positive(value: Option<&Value>) -> f64 {
    value.and_then(Value::as_f64).filter(|v| v.is_finite() && *v > 0.0).unwrap_or(0.0)
}

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|v| v != 0.0 && !v.is_nan()),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

pub fn token_usage_from_wire(usage: &Value) -> TokenUsage {
    if !usage.is_object() {
        return TokenUsage::default();
    }
    let split = usage.get("cache_creation").filter(|s| truthy(s));
    let write1h = positive(split.and_then(|s| s.get("ephemeral_1h_input_tokens")));
    let write5m = match split {
        Some(split) => positive(split.get("ephemeral_5m_input_tokens")),
        None => positive(usage.get("cache_creation_input_tokens")),
    };
    TokenUsage {
        input: positive(usage.get("input_tokens")),
        output: positive(usage.get("output_tokens")),
        cache_write5m: write5m,
        cache_write1h: write1h,
        cache_read: positive(usage.get("cache_read_input_tokens")),
        cost_basis: None,
    }
}

fn unpriced_breakdown(tokens: f64) -> CostBreakdown {
    CostBreakdown {
        unpriced: true,
        unpriced_tokens: tokens,
        unpriced_share: if tokens > 0.0 { 1.0 } else { 0.0 },
        ..CostBreakdown::default()
    }
}

pub fn cost_of(usage: &TokenUsage, model: Option<&str>, pricing: &PricingTable) -> CostBreakdown {
    let Some(rate) = rate_for(model, pricing) else {
        return unpriced_breakdown(total_tokens(usage));
    };
    let input = (usage.input / MTOK) * rate.input;
    let output = (usage.output / MTOK) * rate.output;
    let cache_write = (usage.cache_write5m / MTOK) * rate.cache_write5m + (usage.cache_write1h / MTOK) * rate.cache_write1h;
    let cache_read = (usage.cache_read / MTOK) * rate.cache_read;
    CostBreakdown { input, output, cache_write, cache_read, total: input + output + cache_write + cache_read, ..CostBreakdown::default() }
}

pub fn cost_of_by_model(by_model: &ByModel, pricing: &PricingTable) -> CostBreakdown {
    let mut acc = CostBreakdown::default();
    let mut any_priced = false;
    let mut tokens = 0.0;
    for (model, usage) in by_model.iter() {
        tokens += total_tokens(usage);
        let cost = cost_of(usage, Some(model), pricing);
        if cost.unpriced {
            acc.unpriced_tokens += cost.unpriced_tokens;
            continue;
        }
        any_priced = true;
        acc.input += cost.input;
        acc.output += cost.output;
        acc.cache_write += cost.cache_write;
        acc.cache_read += cost.cache_read;
        acc.total += cost.total;
    }
    acc.unpriced = !any_priced && !by_model.is_empty();
    acc.unpriced_share = if tokens > 0.0 { acc.unpriced_tokens / tokens } else { 0.0 };
    acc
}

pub fn unpriced_models(by_model: &ByModel, pricing: &PricingTable) -> Vec<String> {
    by_model.keys().filter(|model| rate_for(Some(model), pricing).is_none()).cloned().collect()
}

pub fn metered_cost(cost: &CostBreakdown) -> f64 {
    cost.input + cost.output + cost.cache_write
}

pub fn subscription_comparison(weekly_usd: f64, monthly_usd: f64) -> Option<SubscriptionComparison> {
    if monthly_usd.is_nan() || monthly_usd <= 0.0 || !weekly_usd.is_finite() || weekly_usd < 0.0 {
        return None;
    }
    let weekly_share_usd = monthly_usd / WEEKS_PER_MONTH;
    Some(SubscriptionComparison { weekly_usd, monthly_usd, weekly_share_usd, ratio: weekly_usd / weekly_share_usd })
}
