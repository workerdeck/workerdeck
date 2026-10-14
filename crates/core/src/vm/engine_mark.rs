#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum EngineMark {
    Claude,
    Codex,
    Gemini,
    Deepseek,
    Moonshot,
}

pub fn engine_mark(engine: &str, model: Option<&str>) -> Option<EngineMark> {
    match engine {
        "claude" => return Some(EngineMark::Claude),
        "codex" => return Some(EngineMark::Codex),
        _ => {}
    }
    let id = model.unwrap_or_default().to_lowercase();
    if id.is_empty() {
        return None;
    }
    Some(if id.contains("gemini") {
        EngineMark::Gemini
    } else if id.contains("deepseek") {
        EngineMark::Deepseek
    } else if id.contains("moonshot") || id.contains("kimi") {
        EngineMark::Moonshot
    } else if id.contains("claude") {
        EngineMark::Claude
    } else if id.starts_with("gpt") || id.starts_with("o1") || id.starts_with("o3") || id.contains("openai") {
        EngineMark::Codex
    } else {
        return None;
    })
}

impl EngineMark {
    pub fn tints_mark(self) -> bool {
        matches!(self, EngineMark::Claude | EngineMark::Codex)
    }

    // OpenAI's guidelines forbid colouring their mark's companion text, so only Claude's model name wears the vendor colour.
    pub fn tints_name(self) -> bool {
        self == EngineMark::Claude
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_engine_wins_then_the_model_id_names_the_vendor() {
        let cases = [
            ("claude", Some("gpt-5"), Some(EngineMark::Claude)),
            ("codex", None, Some(EngineMark::Codex)),
            ("ai-sdk", Some("models/Gemini-2.5-pro"), Some(EngineMark::Gemini)),
            ("ai-sdk", Some("deepseek-chat"), Some(EngineMark::Deepseek)),
            ("ai-sdk", Some("kimi-k2"), Some(EngineMark::Moonshot)),
            ("ai-sdk", Some("anthropic/claude-opus"), Some(EngineMark::Claude)),
            ("ai-sdk", Some("o3-mini"), Some(EngineMark::Codex)),
            ("ai-sdk", Some("llama-4"), None),
            ("ai-sdk", None, None),
        ];
        for (engine, model, mark) in cases {
            assert_eq!(engine_mark(engine, model), mark, "{engine} {model:?}");
        }
    }

    #[test]
    fn only_claude_tints_its_name_and_only_the_two_engines_tint_their_mark() {
        assert!(EngineMark::Claude.tints_mark() && EngineMark::Claude.tints_name());
        assert!(EngineMark::Codex.tints_mark() && !EngineMark::Codex.tints_name());
        assert!(!EngineMark::Gemini.tints_mark() && !EngineMark::Gemini.tints_name());
    }
}
