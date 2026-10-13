struct ModelFamily {
    name: &'static str,
    joiner: Option<&'static str>,
}

fn model_family(token: &str) -> Option<ModelFamily> {
    let (name, joiner) = match token {
        "gpt" => ("GPT", Some("-")),
        "deepseek" => ("DeepSeek", None),
        "glm" => ("GLM", None),
        "qwen" => ("Qwen", None),
        "kimi" => ("Kimi", None),
        "llama" => ("Llama", None),
        "mistral" => ("Mistral", None),
        "grok" => ("Grok", None),
        _ => return None,
    };
    Some(ModelFamily { name, joiner })
}

pub fn friendly_model(id: Option<&str>) -> Option<String> {
    let id = id.filter(|id| !id.is_empty())?;
    let without_variant = id.split('[').next().unwrap_or(id).to_lowercase();
    let mut parts = without_variant.split('-').filter(|part| !part.is_empty());
    let mut first = parts.next();
    if first == Some("claude") {
        first = parts.next();
    }
    let Some(family_token) = first else {
        return Some(id.to_owned());
    };
    let family = model_family(family_token);
    let name = match &family {
        Some(family) => family.name.to_owned(),
        None if is_reasoning_series(family_token) => family_token.to_owned(),
        None => capitalized_first(family_token),
    };

    let mut version: Vec<&str> = Vec::new();
    let mut words: Vec<String> = Vec::new();
    for part in parts {
        if is_snapshot_date(part) {
            continue;
        }
        if is_version(part) {
            version.push(part);
        } else {
            words.push(capitalized_first(part));
        }
    }
    let versioned = if version.is_empty() {
        name
    } else {
        format!("{name}{}{}", family.and_then(|family| family.joiner).unwrap_or(" "), version.join("."))
    };
    Some(std::iter::once(versioned).chain(words).collect::<Vec<_>>().join(" "))
}

fn is_reasoning_series(token: &str) -> bool {
    token.len() > 1 && token.starts_with('o') && token[1..].bytes().all(|b| b.is_ascii_digit())
}

fn is_snapshot_date(token: &str) -> bool {
    token.len() == 8 && token.bytes().all(|b| b.is_ascii_digit())
}

fn is_version(token: &str) -> bool {
    let (major, minor) = match token.split_once('.') {
        Some((major, minor)) => (major, Some(minor)),
        None => (token, None),
    };
    let digits = |s: &str| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit());
    digits(major) && minor.is_none_or(digits)
}

fn capitalized_first(token: &str) -> String {
    let mut chars = token.chars();
    match chars.next() {
        Some(first) => first.to_uppercase().chain(chars).collect(),
        None => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn name(id: &str) -> Option<String> {
        friendly_model(Some(id))
    }

    #[test]
    fn the_documented_examples_verbatim() {
        assert_eq!(name("claude-opus-5[1m]").as_deref(), Some("Opus 5"));
        assert_eq!(name("claude-haiku-4-5-20251001").as_deref(), Some("Haiku 4.5"));
        assert_eq!(name("gpt-5.6-luna").as_deref(), Some("GPT-5.6 Luna"));
        assert_eq!(name("gpt-6-astra").as_deref(), Some("GPT-6 Astra"));
        assert_eq!(name("gemini-2.5-pro").as_deref(), Some("Gemini 2.5 Pro"));
        assert_eq!(name("o3-mini").as_deref(), Some("o3 Mini"));
    }

    #[test]
    fn an_unknown_family_is_capitalised_and_a_known_one_keeps_its_casing() {
        assert_eq!(name("deepseek-3.2").as_deref(), Some("DeepSeek 3.2"));
        assert_eq!(name("glm-4.6").as_deref(), Some("GLM 4.6"));
        assert_eq!(name("gpt-5").as_deref(), Some("GPT-5"));
        assert_eq!(name("sonoma-2").as_deref(), Some("Sonoma 2"));
    }

    #[test]
    fn nothing_in_nothing_out_and_an_unparseable_id_comes_back_whole() {
        assert_eq!(friendly_model(None), None);
        assert_eq!(name(""), None);
        assert_eq!(name("claude").as_deref(), Some("claude"));
        assert_eq!(name("[1m]").as_deref(), Some("[1m]"));
    }

    #[test]
    fn a_snapshot_date_is_dropped_and_a_version_is_not() {
        assert_eq!(name("claude-sonnet-4-20250514").as_deref(), Some("Sonnet 4"));
        assert_eq!(name("claude-sonnet-4-2025051").as_deref(), Some("Sonnet 4.2025051"));
    }

    #[test]
    fn malformed_versions_read_as_words() {
        assert_eq!(name("gpt-5.").as_deref(), Some("GPT 5."));
        assert_eq!(name("gpt-.5").as_deref(), Some("GPT .5"));
        assert_eq!(name("gpt-1.2.3").as_deref(), Some("GPT 1.2.3"));
        assert_eq!(name("claude--opus---5").as_deref(), Some("Opus 5"));
    }
}
