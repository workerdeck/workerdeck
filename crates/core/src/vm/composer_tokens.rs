// The prompt tokens `@file`, `/command`, `$skill` and `#session`, and the suggestion list that completes them. Offsets
// are UTF-16 units, what both platforms' text views count in.
use crate::rest::calls::{self, HttpCall};
use crate::rest::error::{Answer, RestErrorKind};
use crate::rest::files::HostMatches;
use crate::vm::composer_lists::{Skill, SlashCommand};
use crate::vm::peer_mentions::{PEER_MENTION_SIGIL, PROMPT_SENTENCE_TAIL, is_peer_mention_body, peer_mention_key, peer_mention_slug};
use serde::Deserialize;
use serde_json::Value;
use std::collections::HashSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenKind {
    File,
    Command,
    Skill,
    Session,
}

impl TokenKind {
    pub fn sigil(self) -> char {
        match self {
            TokenKind::File => '@',
            TokenKind::Command => '/',
            TokenKind::Skill => '$',
            TokenKind::Session => PEER_MENTION_SIGIL,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PromptToken {
    pub kind: TokenKind,
    pub start: usize,
    pub end: usize,
    pub text: String,
}

impl PromptToken {
    pub fn query(&self) -> &str {
        &self.text[1..]
    }
}

// `$name` and `#Name` are prose far more often than tokens, so both style only for a name this client holds.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TokenNames {
    pub skills: HashSet<String>,
    pub sessions: HashSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DraftEdit {
    pub text: String,
    pub cursor: usize,
}

struct Draft {
    chars: Vec<char>,
    units: Vec<usize>,
}

impl Draft {
    fn new(text: &str) -> Self {
        let chars: Vec<char> = text.chars().collect();
        let mut units = Vec::with_capacity(chars.len() + 1);
        let mut at = 0;
        units.push(0);
        for ch in &chars {
            at += ch.len_utf16();
            units.push(at);
        }
        Self { chars, units }
    }

    fn index_of(&self, unit: usize) -> usize {
        self.units.partition_point(|u| *u <= unit).saturating_sub(1)
    }

    fn slice(&self, from: usize, to: usize) -> String {
        self.chars[from..to].iter().collect()
    }

    fn word_end(&self, start: usize) -> usize {
        let mut index = start;
        while index < self.chars.len() && !self.chars[index].is_whitespace() {
            index += 1;
        }
        index
    }

    fn word_start(&self, cursor: usize) -> usize {
        let mut index = cursor;
        while index > 0 && !self.chars[index - 1].is_whitespace() {
            index -= 1;
        }
        index
    }

    fn token(&self, kind: TokenKind, from: usize, to: usize) -> PromptToken {
        PromptToken { kind, start: self.units[from], end: self.units[to], text: self.slice(from, to) }
    }
}

fn trigger_kind(ch: char) -> Option<TokenKind> {
    match ch {
        '@' => Some(TokenKind::File),
        '/' => Some(TokenKind::Command),
        PEER_MENTION_SIGIL => Some(TokenKind::Session),
        _ => None,
    }
}

// A command name may not hold a `/`, so a pasted absolute path is never a command; `:` spells namespaced skills.
fn is_command_char(ch: char) -> bool {
    ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.' | ':')
}

pub fn scan(text: &str, names: &TokenNames) -> Vec<PromptToken> {
    let draft = Draft::new(text);
    let mut tokens = Vec::new();
    let mut index = 0;
    while index < draft.chars.len() {
        if draft.chars[index].is_whitespace() {
            index += 1;
            continue;
        }
        let word_end = draft.word_end(index);
        let first = draft.chars[index];
        let kind = if first == '$' { Some(TokenKind::Skill) } else { trigger_kind(first) };
        if let Some(kind) = kind {
            let mut end = word_end;
            while end > index && PROMPT_SENTENCE_TAIL.contains(&draft.chars[end - 1]) {
                end -= 1;
            }
            let body = draft.slice(index + 1, end);
            let keep = !body.is_empty()
                && match kind {
                    TokenKind::File => true,
                    TokenKind::Command => body.chars().all(is_command_char),
                    TokenKind::Skill => names.skills.contains(&body),
                    TokenKind::Session => is_peer_mention_body(&body) && names.sessions.contains(&peer_mention_key(&body)),
                };
            if keep {
                tokens.push(draft.token(kind, index, end));
            }
        }
        index = word_end;
    }
    tokens
}

// A token is finished once something follows it; the word still being typed at the end stays plain, so the draft
// does not flicker between styled and plain on every keystroke.
pub fn confirmed(text: &str, names: &TokenNames) -> Vec<PromptToken> {
    let length = text.encode_utf16().count();
    scan(text, names).into_iter().filter(|token| token.end < length).collect()
}

// The token the cursor sits in. Permissive on purpose: a bare `@` counts, and a half-typed command is not
// charset-checked. The whole word comes back even mid-word, so accepting replaces what was typed.
pub fn active(text: &str, cursor: usize) -> Option<PromptToken> {
    let draft = Draft::new(text);
    let cursor = draft.index_of(cursor);
    let start = draft.word_start(cursor);
    let kind = trigger_kind(*draft.chars.get(start)?)?;
    let end = draft.word_end(start);
    (cursor > start && cursor <= end).then(|| draft.token(kind, start, end))
}

fn splice(text: &str, token: &PromptToken, with: &str) -> String {
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut out = String::from_utf16_lossy(&units[..token.start]);
    out.push_str(with);
    out.push_str(&String::from_utf16_lossy(&units[token.end..]));
    out
}

// `value` comes without its sigil. A trailing space closes the list; mid-message the space already there is reused.
pub fn apply(value: &str, token: &PromptToken, text: &str) -> DraftEdit {
    let following = text.encode_utf16().nth(token.end).and_then(|unit| char::from_u32(unit.into())).filter(|ch| ch.is_whitespace());
    let replacement = format!("{}{}{}", token.kind.sigil(), value, if following.is_some() { "" } else { " " });
    let cursor = token.start + replacement.encode_utf16().count() + usize::from(following.is_some());
    DraftEdit { text: splice(text, token, &replacement), cursor }
}

// A literal, sigil included and nothing appended: a skill pick types prose, not a token.
pub fn replace_literal(literal: &str, token: &PromptToken, text: &str) -> DraftEdit {
    DraftEdit { text: splice(text, token, literal), cursor: token.start + literal.encode_utf16().count() }
}

// Text the composer is handed from elsewhere (a file path, a quote) lands as its own word with a space after.
pub fn insert(draft: &str, text: &str) -> DraftEdit {
    let separator = if draft.is_empty() || draft.ends_with(' ') { "" } else { " " };
    let tail = if text.ends_with(' ') { "" } else { " " };
    let next = format!("{draft}{separator}{text}{tail}");
    DraftEdit { cursor: next.encode_utf16().count(), text: next }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PeerSession {
    pub id: String,
    pub slug: String,
    pub label: String,
    pub detail: String,
}

#[derive(Deserialize)]
struct SessionsBody {
    sessions: Vec<Value>,
}

fn field<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str).filter(|text| !text.is_empty())
}

fn time(value: &Value) -> f64 {
    value.get("lastActivityAt").and_then(Value::as_f64).or_else(|| value.get("createdAt").and_then(Value::as_f64)).unwrap_or(0.0)
}

// The body of `GET /v1/sessions` as `#` offers it: this session dropped, newest first, an agent's session by its agent's
// name (the web's `peerSessionOption`). None for another shape.
pub fn peer_sessions(body: &str, excluding: &str) -> Option<Vec<PeerSession>> {
    let mut rows: Vec<Value> = serde_json::from_str::<SessionsBody>(body)
        .ok()?
        .sessions
        .into_iter()
        .filter(|row| field(row, "id").is_some_and(|id| id != excluding))
        .collect();
    rows.sort_by(|a, b| time(b).total_cmp(&time(a)));
    Some(
        rows.iter()
            .map(|row| {
                let id = field(row, "id").unwrap_or_default();
                let title = row.get("agent").and_then(|agent| field(agent, "name")).or_else(|| field(row, "title"));
                let project = row.get("project").and_then(|p| field(p, "name"));
                PeerSession {
                    id: id.to_owned(),
                    slug: peer_mention_slug(title, id),
                    label: title.map_or_else(|| id.chars().take(8).collect(), str::to_owned),
                    detail: [field(row, "engine"), project, field(row, "status")]
                        .into_iter()
                        .flatten()
                        .collect::<Vec<_>>()
                        .join(" \u{00B7} "),
                }
            })
            .collect(),
    )
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileMatch {
    pub path: String,
    pub relative: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Suggestion {
    File(FileMatch),
    Command(SlashCommand),
    Skill(Skill),
    Session(PeerSession),
}

pub const SKILL_HINT: &str = "Inserts a message you can edit";

impl Suggestion {
    pub fn id(&self) -> String {
        match self {
            Suggestion::File(m) => format!("@{}", m.relative),
            Suggestion::Command(c) => format!("/{}", c.name),
            Suggestion::Skill(s) => format!("skill:{}", s.name),
            Suggestion::Session(p) => format!("session:{}", p.id),
        }
    }

    // What replaces the token, without its sigil; a skill types its whole literal, the engine's opener or `$name`.
    pub fn value(&self) -> String {
        match self {
            Suggestion::File(m) => m.relative.clone(),
            Suggestion::Command(c) => c.name.clone(),
            Suggestion::Skill(s) => {
                let opener = s.default_prompt.as_deref().map(str::trim).unwrap_or_default();
                let base = if opener.is_empty() { format!("${}", s.name) } else { opener.to_owned() };
                if base.ends_with(' ') { base } else { base + " " }
            }
            Suggestion::Session(p) => p.slug.clone(),
        }
    }
}

fn prefixed<'a>(mut words: impl Iterator<Item = &'a str>, needle: &str) -> bool {
    needle.is_empty() || words.any(|word| word.to_lowercase().starts_with(needle))
}

// The name, its aliases and a namespaced command's bare name: "wrapup" finds "dev:wrapup".
fn command_matches(command: &SlashCommand, needle: &str) -> bool {
    prefixed(
        std::iter::once(command.name.as_str()).chain(command.aliases.iter().map(String::as_str)).chain(command.name.split(':')),
        needle,
    )
}

fn skill_matches(skill: &Skill, needle: &str) -> bool {
    prefixed(std::iter::once(skill.name.as_str()).chain(skill.name.split(['-', ':', '_'])), needle)
}

fn peer_matches(peer: &PeerSession, needle: &str) -> bool {
    prefixed([peer.slug.as_str(), peer.label.as_str()].into_iter().chain(peer.slug.split('-')), needle)
}

pub const LIST_LIMIT: usize = 20;
pub const FILE_LIMIT: u32 = 8;
pub const FILE_DEBOUNCE_MS: u32 = 150;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompletionStep {
    Unchanged,
    Changed,
    // Wait `delay_ms`, then perform `call` if `generation` is still current and hand the answer to `files_answered`.
    Search { generation: u64, delay_ms: u32, call: HttpCall },
}

// `/` filters commands and skills, `#` the gateway's other sessions, `@` searches the host filesystem; a 404 switches
// file search off for the screen, since a gateway without host files will not grow them while it is open.
#[derive(Debug, Clone, Default)]
pub struct Completion {
    pub commands: Vec<SlashCommand>,
    pub skills: Vec<Skill>,
    pub peers: Vec<PeerSession>,
    pub cwd: Option<String>,
    suggestions: Vec<Suggestion>,
    active: bool,
    files_unsupported: bool,
    last_query: Option<String>,
    generation: u64,
}

impl Completion {
    pub fn suggestions(&self) -> &[Suggestion] {
        &self.suggestions
    }

    pub fn is_open(&self) -> bool {
        self.active && !self.suggestions.is_empty()
    }

    pub fn names(&self) -> TokenNames {
        TokenNames {
            skills: self.skills.iter().map(|s| s.name.clone()).collect(),
            sessions: self.peers.iter().map(|p| peer_mention_key(&p.slug)).collect(),
        }
    }

    pub fn set_cwd(&mut self, cwd: Option<String>) {
        if cwd != self.cwd {
            self.cwd = cwd;
            self.files_unsupported = false;
            self.cancel();
        }
    }

    // Answers whether anything the list draws changed.
    pub fn cancel(&mut self) -> bool {
        let changed = self.active || !self.suggestions.is_empty();
        self.generation += 1;
        self.last_query = None;
        self.suggestions.clear();
        self.active = false;
        changed
    }

    fn show(&mut self, suggestions: Vec<Suggestion>) -> CompletionStep {
        self.generation += 1;
        self.last_query = None;
        let changed = !self.active || suggestions != self.suggestions;
        self.active = true;
        self.suggestions = suggestions;
        if changed { CompletionStep::Changed } else { CompletionStep::Unchanged }
    }

    fn closed(&mut self) -> CompletionStep {
        if self.cancel() { CompletionStep::Changed } else { CompletionStep::Unchanged }
    }

    pub fn update(&mut self, text: &str, cursor: usize) -> CompletionStep {
        let Some(token) = active(text, cursor) else {
            return self.closed();
        };
        let needle = token.query().to_lowercase();
        match token.kind {
            TokenKind::Command => {
                let commands = self.commands.iter().filter(|c| command_matches(c, &needle)).cloned().map(Suggestion::Command);
                let skills = self.skills.iter().filter(|s| s.enabled && skill_matches(s, &needle)).cloned().map(Suggestion::Skill);
                let list = commands.chain(skills).take(LIST_LIMIT).collect();
                self.show(list)
            }
            TokenKind::Session => {
                let list =
                    self.peers.iter().filter(|p| peer_matches(p, &needle)).take(LIST_LIMIT).cloned().map(Suggestion::Session).collect();
                self.show(list)
            }
            TokenKind::File => self.search(token.query()),
            TokenKind::Skill => self.closed(),
        }
    }

    fn search(&mut self, query: &str) -> CompletionStep {
        let Some(cwd) = self.cwd.clone().filter(|_| !self.files_unsupported) else {
            return self.closed();
        };
        if self.last_query.as_deref() == Some(query) {
            return CompletionStep::Unchanged;
        }
        self.generation += 1;
        self.last_query = Some(query.to_owned());
        self.active = true;
        CompletionStep::Search {
            generation: self.generation,
            delay_ms: FILE_DEBOUNCE_MS,
            call: calls::find_host_files(&cwd, query, Some(FILE_LIMIT)),
        }
    }

    pub fn is_current(&self, generation: u64) -> bool {
        generation == self.generation
    }

    // Answers whether the list changed; a stale answer is dropped.
    pub fn files_answered(&mut self, generation: u64, answer: Answer<'_>) -> bool {
        if !self.is_current(generation) {
            return false;
        }
        match answer.read::<HostMatches>() {
            Ok(found) => {
                self.suggestions = found
                    .matches
                    .into_iter()
                    .take(FILE_LIMIT as usize)
                    .map(|m| Suggestion::File(FileMatch { path: m.path, relative: m.relative }))
                    .collect();
            }
            Err(error) if error.kind == RestErrorKind::NotFound => {
                self.files_unsupported = true;
                self.cancel();
            }
            Err(_) => self.suggestions.clear(),
        }
        true
    }

    // The token is re-read from the draft as it is now: a range remembered from when the list was built would corrupt
    // a draft that moved on.
    pub fn accept(&mut self, index: usize, text: &str, cursor: usize) -> Option<DraftEdit> {
        let suggestion = self.suggestions.get(index)?.clone();
        self.cancel();
        let token = active(text, cursor)?;
        Some(match suggestion {
            Suggestion::Skill(_) => replace_literal(&suggestion.value(), &token, text),
            _ => apply(&suggestion.value(), &token, text),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn end(text: &str) -> Option<PromptToken> {
        active(text, text.encode_utf16().count())
    }

    fn query(text: &str) -> Option<String> {
        end(text).map(|t| t.query().to_owned())
    }

    fn names(skills: &[&str], sessions: &[&str]) -> TokenNames {
        TokenNames {
            skills: skills.iter().map(|s| (*s).to_owned()).collect(),
            sessions: sessions.iter().map(|s| (*s).to_owned()).collect(),
        }
    }

    fn texts(tokens: Vec<PromptToken>) -> Vec<String> {
        tokens.into_iter().map(|t| t.text).collect()
    }

    fn kinds(tokens: Vec<PromptToken>) -> Vec<TokenKind> {
        tokens.into_iter().map(|t| t.kind).collect()
    }

    #[test]
    fn finds_the_token_at_the_end_of_the_draft() {
        assert_eq!(query("look at @src/Ses").as_deref(), Some("src/Ses"));
        assert_eq!(query("@").as_deref(), Some(""));
        assert_eq!(end("@README.md").map(|t| t.kind), Some(TokenKind::File));
    }

    #[test]
    fn stops_at_whitespace_and_needs_a_word_start() {
        assert_eq!(end("@src/index.ts "), None);
        assert_eq!(end("@notes\nnow explain"), None);
        assert_eq!(query("first @a then @b").as_deref(), Some("b"));
        assert_eq!(end("mail toby@example.com"), None);
        assert_eq!(end("x@y"), None);
        assert_eq!(end(""), None);
        assert_eq!(end("trailing space "), None);
        assert_eq!(end("and/or"), None);
        assert_eq!(end("issue#42"), None);
    }

    #[test]
    fn commands_and_sessions_open_anywhere_a_word_starts() {
        assert_eq!(end("  /comm").map(|t| t.kind), Some(TokenKind::Command));
        assert_eq!(query("run /comm").as_deref(), Some("comm"));
        assert_eq!(end("commit what #Ast").map(|t| (t.kind, t.query().to_owned())), Some((TokenKind::Session, "Ast".to_owned())));
        assert_eq!(end("$scr"), None);
        assert_eq!(end("please $scr"), None);
    }

    #[test]
    fn skills_and_sessions_style_only_when_listed() {
        assert!(scan("echo $PATH and $5.00", &names(&["scratch-notes"], &[])).is_empty());
        assert!(scan("$scratch-notes jot this down", &TokenNames::default()).is_empty());
        assert_eq!(kinds(scan("$scratch-notes jot", &names(&["scratch-notes"], &[]))), vec![TokenKind::Skill]);
        let sessions = names(&[], &["astra", "fix-login-bug"]);
        assert!(scan("ask #Astra about it", &TokenNames::default()).is_empty());
        assert_eq!(texts(scan("ask #Astra about it", &sessions)), vec!["#Astra"]);
        assert_eq!(kinds(scan("ask #fix_login_bug", &sessions)), vec![TokenKind::Session]);
        assert!(scan("#ff0000 and #1", &sessions).is_empty());
        assert_eq!(texts(scan("ask #Astra.", &sessions)), vec!["#Astra"]);
    }

    #[test]
    fn scans_sent_text_without_punctuation_paths_or_bare_sigils() {
        let none = TokenNames::default();
        assert_eq!(texts(scan("/review compare @one.md with @src/two.ts please", &none)), vec!["/review", "@one.md", "@src/two.ts"]);
        assert_eq!(texts(scan("check @a.ts, @b.ts and @c.ts!", &none)), vec!["@a.ts", "@b.ts", "@c.ts"]);
        assert!(scan("just an @ sign", &none).is_empty());
        assert!(scan("/Users/atomic/projects is where", &none).is_empty());
        assert!(scan("it lives in /Users/atomic/projects", &none).is_empty());
        assert!(scan("mail toby@example.com", &none).is_empty());
        let token = &scan("see @README.md.", &none)[0];
        assert_eq!((token.start, token.end), (4, 14));
    }

    #[test]
    fn confirmed_leaves_the_word_being_typed_alone() {
        let none = TokenNames::default();
        assert_eq!(texts(confirmed("look at @src/a.ts ", &none)), vec!["@src/a.ts"]);
        assert!(confirmed("look at @src/a", &none).is_empty());
        assert_eq!(texts(confirmed("@one.md and @tw", &none)), vec!["@one.md"]);
        assert_eq!(texts(confirmed("/review the @file.ts now", &none)), vec!["/review", "@file.ts"]);
    }

    #[test]
    fn reads_the_token_around_a_cursor() {
        let text = "look at @src/Ses and then stop";
        assert_eq!(active(text, 13).map(|t| t.query().to_owned()).as_deref(), Some("src/Ses"));
        assert_eq!(active(text, 20), None);
        assert_eq!(active(text, 8), None);
    }

    #[test]
    fn applying_replaces_the_token_and_reuses_a_following_space() {
        let draft = "look at @src/Ses";
        let edit = apply("src/List.swift", &end(draft).unwrap(), draft);
        assert_eq!(edit, DraftEdit { text: "look at @src/List.swift ".into(), cursor: 24 });
        let draft = "compare @one.md and @tw here";
        let edit = apply("two.md", &active(draft, 23).unwrap(), draft);
        assert_eq!(edit, DraftEdit { text: "compare @one.md and @two.md here".into(), cursor: 28 });
        assert_eq!(apply("commit-message", &end("/comm").unwrap(), "/comm").text, "/commit-message ");
        assert_eq!(apply("Astra", &end("what #Ast").unwrap(), "what #Ast").text, "what #Astra ");
    }

    #[test]
    fn offsets_count_utf16_units() {
        let draft = "\u{1F600} @sr";
        let token = end(draft).unwrap();
        assert_eq!((token.start, token.end), (3, 6));
        assert_eq!(apply("src", &token, draft), DraftEdit { text: "\u{1F600} @src ".into(), cursor: 8 });
    }

    #[test]
    fn a_skill_replaces_the_token_with_literal_text() {
        let text = "please /scr";
        let edit = replace_literal("$scratch-notes ", &end(text).unwrap(), text);
        assert_eq!(edit, DraftEdit { text: "please $scratch-notes ".into(), cursor: 22 });
        assert!(scan(&edit.text, &TokenNames::default()).is_empty());
    }

    #[test]
    fn insert_lands_as_its_own_word() {
        assert_eq!(insert("", "@a.ts").text, "@a.ts ");
        assert_eq!(insert("see", "@a.ts"), DraftEdit { text: "see @a.ts ".into(), cursor: 10 });
        assert_eq!(insert("see ", "x ").text, "see x ");
    }

    fn command(name: &str, aliases: &[&str]) -> SlashCommand {
        SlashCommand { name: name.into(), aliases: aliases.iter().map(|a| (*a).to_owned()).collect(), ..SlashCommand::default() }
    }

    fn skill(name: &str, prompt: Option<&str>, enabled: bool) -> Skill {
        Skill { name: name.into(), default_prompt: prompt.map(str::to_owned), enabled, ..Skill::default() }
    }

    fn ids(completion: &Completion) -> Vec<String> {
        completion.suggestions().iter().map(Suggestion::id).collect()
    }

    #[test]
    fn slash_filters_commands_then_enabled_skills() {
        let mut c = Completion {
            commands: vec![command("dev:wrapup", &[]), command("review", &["r"])],
            skills: vec![skill("scratch-notes", None, true), skill("off", None, false)],
            ..Completion::default()
        };
        assert_eq!(c.update("/wr", 3), CompletionStep::Changed);
        assert_eq!(ids(&c), vec!["/dev:wrapup"]);
        c.update("/r", 2);
        assert_eq!(ids(&c), vec!["/review"]);
        c.update("/notes", 6);
        assert_eq!(ids(&c), vec!["skill:scratch-notes"]);
        c.update("/", 1);
        assert_eq!(ids(&c), vec!["/dev:wrapup", "/review", "skill:scratch-notes"]);
        assert_eq!(c.update("/", 1), CompletionStep::Unchanged);
        assert_eq!(c.update("hi", 2), CompletionStep::Changed);
        assert!(!c.is_open());
    }

    #[test]
    fn accepting_a_skill_types_its_opener() {
        let mut c =
            Completion { skills: vec![skill("xlsx", Some(" Make a sheet "), true), skill("pdf", None, true)], ..Completion::default() };
        c.update("do /xl", 6);
        assert_eq!(c.accept(0, "do /xl", 6).unwrap().text, "do Make a sheet ");
        assert!(!c.is_open());
        c.update("/pd", 3);
        assert_eq!(c.accept(0, "/pd", 3).unwrap(), DraftEdit { text: "$pdf ".into(), cursor: 5 });
    }

    #[test]
    fn file_search_is_debounced_single_flight_and_switches_off_on_404() {
        let mut c = Completion::default();
        assert_eq!(c.update("@a", 2), CompletionStep::Unchanged);
        c.set_cwd(Some("/w".into()));
        let CompletionStep::Search { generation, call, .. } = c.update("@a", 2) else { panic!() };
        assert_eq!(call.path, "/fs/find?path=%2Fw&q=a&limit=8");
        assert_eq!(c.update("@a", 2), CompletionStep::Unchanged);
        let CompletionStep::Search { generation: next, .. } = c.update("@ab", 3) else { panic!() };
        let body = r#"{"base":"/w","matches":[{"path":"/w/ab.ts","relative":"ab.ts"}]}"#;
        assert!(!c.files_answered(generation, Answer::new(200, Some("application/json"), body)));
        assert!(c.files_answered(next, Answer::new(200, Some("application/json"), body)));
        assert_eq!(ids(&c), vec!["@ab.ts"]);
        assert_eq!(c.accept(0, "@ab", 3).unwrap().text, "@ab.ts ");
        let CompletionStep::Search { generation, .. } = c.update("@x", 2) else { panic!() };
        c.files_answered(generation, Answer::new(404, Some("application/json"), r#"{"error":"nope"}"#));
        assert_eq!(c.update("@y", 2), CompletionStep::Unchanged);
        assert!(!c.is_open());
    }

    #[test]
    fn peers_come_newest_first_without_this_session() {
        let body = r#"{"sessions":[
            {"id":"a","title":"Fix login bug","createdAt":1,"status":"idle","engine":"claude","project":{"name":"wd"}},
            {"id":"me","createdAt":9,"status":"idle"},
            {"id":"b7c1d9e2-aaaa","createdAt":2,"lastActivityAt":5,"status":"running"},
            {"id":"c","title":"Long session title","agent":{"id":"x","name":"WD-Lead"},"createdAt":0,"status":"idle"}]}"#;
        let peers = peer_sessions(body, "me").unwrap();
        assert_eq!(peers.iter().map(|p| p.slug.as_str()).collect::<Vec<_>>(), vec!["b7c1d9e2", "Fix-login-bug", "WD-Lead"]);
        assert_eq!(peers[2].label, "WD-Lead");
        assert_eq!(peers[1].detail, "claude \u{00B7} wd \u{00B7} idle");
        assert_eq!(peers[0].label, "b7c1d9e2");
        assert_eq!(peer_sessions("<html>", "me"), None);
        let mut c = Completion { peers, ..Completion::default() };
        c.update("#log", 4);
        assert_eq!(ids(&c), vec!["session:a"]);
        assert!(c.names().sessions.contains("fix-login-bug"));
    }
}
