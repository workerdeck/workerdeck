// The slash commands and skills a session offers, read off the folded `capabilities` and `skills` events.
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SlashCommand {
    pub name: String,
    pub description: Option<String>,
    pub argument_hint: Option<String>,
    pub aliases: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Skill {
    pub name: String,
    pub description: Option<String>,
    pub short_description: Option<String>,
    pub display_name: Option<String>,
    pub default_prompt: Option<String>,
    pub scope: Option<String>,
    pub enabled: bool,
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

fn entries(list: Option<&Value>) -> impl Iterator<Item = (&Value, String)> {
    list.and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|entry| text(entry, "name").filter(|name| !name.is_empty()).map(|name| (entry, name)))
}

pub fn slash_commands(list: Option<&Value>) -> Vec<SlashCommand> {
    entries(list)
        .map(|(entry, name)| SlashCommand {
            name,
            description: text(entry, "description"),
            argument_hint: text(entry, "argumentHint"),
            aliases: entry
                .get("aliases")
                .and_then(Value::as_array)
                .map(|aliases| aliases.iter().filter_map(Value::as_str).map(str::to_owned).collect())
                .unwrap_or_default(),
        })
        .collect()
}

pub fn skills(list: Option<&Value>) -> Vec<Skill> {
    entries(list)
        .map(|(entry, name)| Skill {
            name,
            description: text(entry, "description"),
            short_description: text(entry, "shortDescription"),
            display_name: text(entry, "displayName"),
            default_prompt: text(entry, "defaultPrompt"),
            scope: text(entry, "scope"),
            enabled: entry.get("enabled").and_then(Value::as_bool).unwrap_or(true),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn commands_read_every_field_and_skip_nameless_entries() {
        let list = json!([
            { "name": "review", "description": "Review", "argumentHint": "<pr>", "aliases": ["r"] },
            { "name": "clear" },
            { "description": "no name" },
            "junk"
        ]);
        let commands = slash_commands(Some(&list));
        assert_eq!(commands.len(), 2);
        assert_eq!(commands[0].argument_hint.as_deref(), Some("<pr>"));
        assert_eq!(commands[0].aliases, vec!["r".to_owned()]);
        assert_eq!(commands[1], SlashCommand { name: "clear".into(), ..SlashCommand::default() });
        assert!(slash_commands(None).is_empty());
    }

    #[test]
    fn skills_default_to_enabled_and_keep_their_labels() {
        let list = json!([
            { "name": "pdf", "displayName": "PDF", "shortDescription": "s", "scope": "user", "enabled": false },
            { "name": "xlsx", "defaultPrompt": "Make a sheet" }
        ]);
        let skills = skills(Some(&list));
        assert_eq!((skills[0].display_name.as_deref(), skills[0].enabled), (Some("PDF"), false));
        assert_eq!((skills[1].default_prompt.as_deref(), skills[1].enabled), (Some("Make a sheet"), true));
    }
}
