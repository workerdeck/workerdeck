// What a session cost, and the evidence for it: `sessionCost` in `packages/ui/src/lib/session-cost.ts`, which the
// usage dialog reads. Our own figure (the gateway's `costUsd`, else the tokens priced here) wins over the engine's.
use crate::rest::{ByModel, CostBasis, TokenUsage};
use crate::vm::pricing::{
    CostBreakdown, PricingTable, UNPRICED_WARN_SHARE, canonical_model, cost_of, cost_of_by_model, rate_for, total_tokens,
    unknown_basis_models,
};

const GAP_SHARE: f64 = 0.02;

#[derive(Debug, Clone, PartialEq)]
pub struct SessionCostRow {
    pub model: String,
    pub usage: TokenUsage,
    pub tokens: f64,
    pub cost_usd: Option<f64>,
    pub cost_basis: Option<CostBasis>,
}

#[derive(Debug, Clone, PartialEq)]
pub struct SessionCost {
    pub display_usd: Option<f64>,
    pub computed_usd: Option<f64>,
    pub reported_usd: Option<f64>,
    pub breakdown: CostBreakdown,
    pub rows: Vec<SessionCostRow>,
    pub unpriced_share: f64,
    pub show_unpriced_warning: bool,
    pub unknown_basis_models: Vec<String>,
    pub gap_usd: Option<f64>,
}

pub fn session_cost(cost_usd: Option<f64>, total_cost_usd: Option<f64>, by_model: Option<&ByModel>, pricing: &PricingTable) -> SessionCost {
    let empty = ByModel::new();
    let by_model = by_model.unwrap_or(&empty);
    let breakdown = cost_of_by_model(by_model, pricing);
    let computed_usd = cost_usd.or(if breakdown.unpriced || by_model.is_empty() { None } else { Some(breakdown.total) });
    let mut rows: Vec<SessionCostRow> = by_model
        .iter()
        .map(|(model, usage)| SessionCostRow {
            model: canonical_model(model),
            usage: usage.clone(),
            tokens: total_tokens(usage),
            cost_usd: rate_for(Some(model), pricing).map(|_| cost_of(usage, Some(model), pricing).total),
            cost_basis: usage.cost_basis,
        })
        .collect();
    rows.sort_by(|a, b| b.tokens.total_cmp(&a.tokens));
    let gap = match (computed_usd, total_cost_usd) {
        (Some(computed), Some(reported)) => Some(reported - computed),
        _ => None,
    };
    let largest = computed_usd.unwrap_or(0.0).max(total_cost_usd.unwrap_or(0.0));
    let worth_showing = gap.is_some_and(|gap| gap.abs() > 0.01_f64.max(GAP_SHARE * largest));
    SessionCost {
        display_usd: computed_usd.or(total_cost_usd),
        computed_usd,
        reported_usd: total_cost_usd,
        unpriced_share: breakdown.unpriced_share,
        show_unpriced_warning: breakdown.unpriced_share > UNPRICED_WARN_SHARE,
        unknown_basis_models: unknown_basis_models(by_model),
        gap_usd: if worth_showing { gap } else { None },
        breakdown,
        rows,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::vm::pricing::default_pricing;

    fn usage(input: f64, output: f64) -> TokenUsage {
        TokenUsage { input, output, ..TokenUsage::default() }
    }

    #[test]
    fn the_gateway_figure_wins_and_rows_sort_by_tokens() {
        let mut by_model = ByModel::new();
        by_model.set("claude-haiku-4-5".to_owned(), usage(1_000.0, 0.0));
        by_model.set("claude-opus-4-6".to_owned(), usage(1_000_000.0, 100_000.0));
        let cost = session_cost(Some(3.0), Some(3.0), Some(&by_model), &default_pricing());
        assert_eq!(cost.display_usd, Some(3.0));
        assert_eq!(cost.rows[0].model, "claude-opus-4-6");
        assert!(cost.rows.iter().all(|row| row.cost_usd.is_some()));
        assert_eq!(cost.gap_usd, None);
    }

    #[test]
    fn without_a_gateway_figure_the_tokens_are_priced_here_and_a_gap_is_reported() {
        let mut by_model = ByModel::new();
        by_model.set("claude-opus-4-6".to_owned(), usage(1_000_000.0, 0.0));
        let cost = session_cost(None, Some(50.0), Some(&by_model), &default_pricing());
        let computed = cost.computed_usd.expect("priced");
        assert!(computed > 0.0);
        assert_eq!(cost.display_usd, Some(computed));
        assert_eq!(cost.gap_usd, Some(50.0 - computed));
    }

    #[test]
    fn an_unpriced_model_leaves_the_engine_figure_and_warns() {
        let mut by_model = ByModel::new();
        by_model.set("mystery-1".to_owned(), usage(1_000.0, 0.0));
        let cost = session_cost(None, Some(0.2), Some(&by_model), &default_pricing());
        assert_eq!(cost.computed_usd, None);
        assert_eq!(cost.display_usd, Some(0.2));
        assert!(cost.show_unpriced_warning);
        assert_eq!(cost.rows[0].cost_usd, None);
    }

    #[test]
    fn no_tokens_is_the_reported_figure_alone() {
        let cost = session_cost(None, None, None, &default_pricing());
        assert_eq!((cost.display_usd, cost.rows.len()), (None, 0));
    }
}
